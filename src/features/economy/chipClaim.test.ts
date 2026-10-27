import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RepliableInteraction } from "discord.js";

// ── /claim's reply ──────────────────────────────────────────────────────────
// Private every time, routed to the chips switch when the server has chips off, and a failed ledger
// read answered rather than thrown. The wallet logic is chipWallet.test.ts's.

const mocks = vi.hoisted(() => ({ findConfig: vi.fn(), claimChips: vi.fn(), offerSwitchFix: vi.fn() }));

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findConfig } }));
// The launcher's own tests prove an admin gets the panel and a member the notice.
vi.mock("@features/command-buttons/adminCommandLauncher.js", () => ({ offerSwitchFix: mocks.offerSwitchFix }));
vi.mock("./chipWallet.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("./chipWallet.js")>()), claimChips: mocks.claimChips }));

import { runChipClaim } from "./chipClaim.js";
import { economyCopy } from "./economyCopy.js";
import { getPluginCopy } from "@base/copy/getCopy.js";

type Reply = { embeds: Array<{ data: { description?: string } }>; flags?: number };

function interaction(guildId: string | null = "g1") {
	const reply = vi.fn(async () => undefined);
	return { fake: { guildId, user: { id: "u1" }, reply } as unknown as RepliableInteraction, reply };
}

const textOf = (reply: ReturnType<typeof vi.fn>): string => (reply.mock.calls[0][0] as Reply).embeds[0].data.description ?? "";

beforeEach(() => {
	mocks.findConfig.mockReset().mockResolvedValue({ chipEconomyEnabled: true });
	mocks.claimChips.mockReset();
	mocks.offerSwitchFix.mockReset();
});

describe("runChipClaim", () => {
	it("pays the first claim privately and names the balance", async () => {
		mocks.claimChips.mockResolvedValue({ kind: "first", amount: 25_000, balance: 25_000 });
		const { fake, reply } = interaction();

		await runChipClaim(fake);

		expect(textOf(reply)).toContain("**25,000 chips**");
		expect((reply.mock.calls[0][0] as Reply).flags).toBeDefined();
		expect(mocks.claimChips).toHaveBeenCalledWith({ guildId: "g1", userId: "u1" });
	});

	it("names when the next claim opens during the cooldown", async () => {
		mocks.claimChips.mockResolvedValue({ kind: "cooldown", balance: 25_000, nextClaimAt: new Date("2026-10-26T12:00:00Z") });
		const { fake, reply } = interaction();

		await runChipClaim(fake);

		expect(textOf(reply)).toContain("<t:1793016000:R>");
	});

	// 2026-10 item 257, owner item 10: chips off routes to the switch, the arcade panel for
	// an admin and the copyable command for a member, worded from the guild's own pack.
	it("routes chips off to the arcade switch with the guild's config, paying nothing", async () => {
		const config = { chipEconomyEnabled: false, pluginId: "general-events", adminRoleId: "r1" };
		mocks.findConfig.mockResolvedValue(config);
		const { fake, reply } = interaction();

		await runChipClaim(fake);

		expect(mocks.offerSwitchFix).toHaveBeenCalledWith(
			fake,
			{ launchId: "arcade", title: getPluginCopy(config).error.title, memberSections: [...economyCopy.claim.economyOffForMember] },
			config
		);
		expect(reply).not.toHaveBeenCalled();
		expect(mocks.claimChips).not.toHaveBeenCalled();
	});

	it("gives a member the switch's command as copyable inline code, and asks them to send it to an admin", () => {
		const [, command] = economyCopy.claim.economyOffForMember;
		expect(command).toContain("`/arcade chips toggle enabled:True`");
		expect(command).toContain("admin");
	});

	it("answers a failed ledger read instead of throwing", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		mocks.claimChips.mockRejectedValue(new Error("db down"));
		const { fake, reply } = interaction();

		await expect(runChipClaim(fake)).resolves.toBeUndefined();
		expect(textOf(reply)).toContain("could not reach");
	});

	it("only works inside a server", async () => {
		const { fake, reply } = interaction(null);
		await runChipClaim(fake);
		expect(textOf(reply)).toContain("inside one");
	});
});
