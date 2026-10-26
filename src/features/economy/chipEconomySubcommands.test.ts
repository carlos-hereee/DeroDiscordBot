import { describe, it, expect, vi, beforeEach } from "vitest";
import { SlashCommandSubcommandGroupBuilder, type EmbedBuilder, type RepliableInteraction } from "discord.js";
import type { CommandOptionReader } from "@handlers/commandOptions.js";

// ── /arcade chips (2026-10 item 250 Phase 5) ────────────────────────────────
// The switch is idempotent and logs only a real change; a grant needs chips on; status
// lists the vault's newest grants first. The grant itself is vaultGrant.test.ts's.

const mocks = vi.hoisted(() => ({
	findConfig: vi.fn(),
	update: vi.fn(),
	readVault: vi.fn(),
	runVaultGrant: vi.fn(),
	emitFor: vi.fn(),
}));

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findConfig, update: mocks.update } }));
vi.mock("@features/economy/serverVault.js", () => ({ readVault: mocks.readVault }));
vi.mock("@features/economy/vaultGrant.js", () => ({ runVaultGrant: mocks.runVaultGrant }));
vi.mock("@features/setup/adminLog.js", () => ({ adminLog: { emitFor: mocks.emitFor } }));

import { addChipSubcommands, runChipSubcommand } from "./chipEconomySubcommands.js";

type Options = { sub: string; enabled?: boolean; amount?: number };

async function replyText(options: Options): Promise<string> {
	const reply = vi.fn(async () => undefined);
	const interaction = {
		guildId: "g1",
		user: { id: "admin" },
		client: {},
		reply,
	} as unknown as RepliableInteraction;
	const reader = {
		getSubcommand: () => options.sub,
		getBoolean: () => options.enabled,
		getInteger: () => options.amount,
		getUser: () => ({ id: "u2", bot: false }),
	} as unknown as CommandOptionReader;
	await runChipSubcommand(interaction, reader);
	const embed = (reply.mock.calls[0] as unknown as [{ embeds: EmbedBuilder[] }] | undefined)?.[0].embeds[0];
	return embed?.data.description ?? "";
}

beforeEach(() => {
	for (const mock of Object.values(mocks)) mock.mockReset();
	mocks.findConfig.mockResolvedValue({ guildId: "g1" });
	mocks.update.mockResolvedValue({ guildId: "g1" });
});

describe("/arcade chips", () => {
	it("offers status, toggle and grant, and grant caps its amount", () => {
		const json = addChipSubcommands(new SlashCommandSubcommandGroupBuilder().setName("chips").setDescription("chips")).toJSON();
		expect((json.options ?? []).map((option) => option.name)).toEqual(["status", "toggle", "grant"]);
		const grant = (json.options ?? []).find((option) => option.name === "grant") as { options?: Array<{ name: string; max_value?: number; min_value?: number }> };
		expect(grant.options?.find((option) => option.name === "amount")).toMatchObject({ min_value: 1, max_value: 1_000_000 });
	});

	it("turns chips off once, logs it, and repeats idempotently", async () => {
		expect(await replyText({ sub: "toggle", enabled: false })).toContain("Chip economy: **OFF**");
		expect(mocks.update).toHaveBeenCalledWith("g1", { chipEconomyEnabled: false });
		expect(mocks.emitFor).toHaveBeenCalledWith(expect.anything(), "g1", "config.change", { subject: "Chip economy", detail: "off" });

		mocks.findConfig.mockResolvedValue({ guildId: "g1", chipEconomyEnabled: false });
		expect(await replyText({ sub: "toggle", enabled: false })).toContain("already **OFF**");
		expect(mocks.update).toHaveBeenCalledTimes(1);
	});

	it("refuses a grant while chips are off", async () => {
		mocks.findConfig.mockResolvedValue({ guildId: "g1", chipEconomyEnabled: false });
		expect(await replyText({ sub: "grant", amount: 500 })).toContain("switched off");
		expect(mocks.runVaultGrant).not.toHaveBeenCalled();
	});

	it("hands a grant to the vault with the member and amount", async () => {
		await replyText({ sub: "grant", amount: 500 });
		expect(mocks.runVaultGrant).toHaveBeenCalledWith(expect.anything(), "g1", { id: "u2", bot: false }, 500);
	});

	it("shows the vault and its newest grants first", async () => {
		mocks.readVault.mockResolvedValue({
			balance: 97_000,
			lastAwardMonth: "2026-10",
			grantHistory: [
				{ userId: "old", amount: 1_000, at: new Date("2026-10-01T00:00:00Z"), byAdminId: "admin" },
				{ userId: "new", amount: 2_000, at: new Date("2026-10-20T00:00:00Z"), byAdminId: "admin" },
			],
		});
		const text = await replyText({ sub: "status" });
		expect(text).toContain("Server vault: **97,000 chips**");
		expect(text.indexOf("<@new>")).toBeLessThan(text.indexOf("<@old>"));
	});
});
