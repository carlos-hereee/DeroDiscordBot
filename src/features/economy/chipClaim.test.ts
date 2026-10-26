import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RepliableInteraction } from "discord.js";

// ── /claim's reply ──────────────────────────────────────────────────────────
// Private every time, refused when the server has chips off, and a failed ledger
// read answered rather than thrown. The wallet logic is chipWallet.test.ts's.

const mocks = vi.hoisted(() => ({ findConfig: vi.fn(), claimChips: vi.fn() }));

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findConfig } }));
vi.mock("./chipWallet.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("./chipWallet.js")>()), claimChips: mocks.claimChips }));

import { runChipClaim } from "./chipClaim.js";

type Reply = { embeds: Array<{ data: { description?: string } }>; flags?: number };

function interaction(guildId: string | null = "g1") {
	const reply = vi.fn(async () => undefined);
	return { fake: { guildId, user: { id: "u1" }, reply } as unknown as RepliableInteraction, reply };
}

const textOf = (reply: ReturnType<typeof vi.fn>): string => (reply.mock.calls[0][0] as Reply).embeds[0].data.description ?? "";

beforeEach(() => {
	mocks.findConfig.mockReset().mockResolvedValue({ chipEconomyEnabled: true });
	mocks.claimChips.mockReset();
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

	it("refuses when the server has chips off, paying nothing", async () => {
		mocks.findConfig.mockResolvedValue({ chipEconomyEnabled: false });
		const { fake, reply } = interaction();

		await runChipClaim(fake);

		expect(textOf(reply)).toContain("switched off");
		expect(mocks.claimChips).not.toHaveBeenCalled();
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
