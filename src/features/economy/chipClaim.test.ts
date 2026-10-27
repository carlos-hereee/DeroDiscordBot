import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ButtonInteraction, ModalSubmitInteraction } from "discord.js";

// ── the daily claim round (2026-10 item 257, Phase 3a) ──────────────────────
// The press opens the throw modal after the chips switch and the cooldown; the Submit
// lets Dero throw and pays 2x, 1.5x or 1x the daily base on chips (where chips are on)
// and on Dero coins, posts the reveal in 💬dero-commands, and never touches the luck
// board. The chip and coin stores are mocked, so the amounts asserted are the real math
// of claimChips and awardForClaim.

const mocks = vi.hoisted(() => ({
	findConfig: vi.fn(),
	openSettingsPanel: vi.fn(),
	claimFirst: vi.fn(),
	claimDaily: vi.fn(),
	findChipWallet: vi.fn(),
	insertAward: vi.fn(),
	credit: vi.fn(),
	hasClaim: vi.fn(),
	recordLuckResult: vi.fn(),
	renderRpsCard: vi.fn(),
}));

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findConfig } }));
// Mocked so the chips off test can prove the press never opens the arcade panel.
vi.mock("@features/command-buttons/adminCommandLauncher.js", () => ({ openSettingsPanel: mocks.openSettingsPanel }));
vi.mock("@db/stores/chipWalletStore.js", () => ({ chipWalletStore: { claimFirst: mocks.claimFirst, claimDaily: mocks.claimDaily, findOne: mocks.findChipWallet } }));
vi.mock("@db/stores/deroCoinStore.js", () => ({ deroCoinStore: { insertAward: mocks.insertAward, credit: mocks.credit, hasClaim: mocks.hasClaim } }));
vi.mock("@features/ratings/luckStats.js", () => ({ recordLuckResult: mocks.recordLuckResult }));
vi.mock("@features/games/rpsRenderer.js", () => ({ renderRpsCard: mocks.renderRpsCard }));

import { playClaimRound, runChipClaim } from "./chipClaim.js";
import { economyCopy } from "./economyCopy.js";

// pickDeroThrow takes RPS_CHOICES[floor(rng * 3)], so 0 makes Dero throw rock.
const DERO_THROWS_ROCK = (): number => 0;
const LAST_CLAIM = new Date("2020-01-01T00:00:00Z");

type Sent = { embeds: Array<{ data: { description?: string } }>; allowedMentions?: { parse: string[] } };

function press() {
	const showModal = vi.fn(async () => undefined);
	const fake = {
		guildId: "g1",
		id: "press1",
		user: { id: "u1" },
		deferred: false,
		replied: false,
		isButton: () => true,
		isStringSelectMenu: () => false,
		isChatInputCommand: () => false,
		showModal,
		reply: vi.fn(async () => undefined),
	};
	return { fake: fake as unknown as ButtonInteraction, showModal };
}

function submit(memberThrow: string, channel: { send: ReturnType<typeof vi.fn> } | null = { send: vi.fn(async () => ({ id: "m1" })) }) {
	const followUp = vi.fn(async () => undefined);
	const fake = {
		guildId: "g1",
		id: "submit1",
		user: { id: "u1", username: "silent", globalName: "Silent" },
		deferred: false,
		replied: false,
		client: { user: { id: "dero" }, channels: { fetch: vi.fn(async () => (channel ? { ...channel, isSendable: () => true } : null)) } },
		isModalSubmit: () => true,
		isFromMessage: () => true,
		isStringSelectMenu: () => false,
		inCachedGuild: () => false,
		fields: { getStringSelectValues: () => [memberThrow] },
		deferUpdate: vi.fn(async () => undefined),
		deferReply: vi.fn(async () => undefined),
		editReply: vi.fn(async () => undefined),
		deleteReply: vi.fn(async () => undefined),
		followUp,
		reply: vi.fn(async () => undefined),
	};
	return { fake: fake as unknown as ModalSubmitInteraction, followUp, deferUpdate: fake.deferUpdate };
}

const descriptionOf = (send: ReturnType<typeof vi.fn>): string => (send.mock.calls[0][0] as Sent).embeds[0].data.description ?? "";

beforeEach(() => {
	for (const mock of Object.values(mocks)) mock.mockReset();
	mocks.findConfig.mockResolvedValue({ chipEconomyEnabled: true, commandOutputChannelId: "commands" });
	mocks.openSettingsPanel.mockResolvedValue(false);
	// A wallet that claimed long ago: the daily claim is open.
	mocks.findChipWallet.mockResolvedValue({ balance: 30_000, lastClaimAt: LAST_CLAIM });
	mocks.claimFirst.mockResolvedValue(null);
	mocks.claimDaily.mockImplementation(async (_key: unknown, amount: number) => ({ balance: 30_000 + amount }));
	mocks.insertAward.mockResolvedValue(true);
	mocks.hasClaim.mockResolvedValue(false);
	mocks.renderRpsCard.mockResolvedValue(null);
});

describe("runChipClaim, the press", () => {
	it("opens the throw modal when the claim is open", async () => {
		const { fake, showModal } = press();
		await runChipClaim(fake);
		const modal = (showModal.mock.calls[0] as unknown as [{ data: { custom_id: string; title: string } }])[0];
		expect(modal.data.custom_id).toBe("dailyclaim:throw");
		expect(modal.data.title).toBe(economyCopy.round.modalTitle);
	});

	it("says when the next claim opens instead of a round while the chips cooldown runs", async () => {
		mocks.findChipWallet.mockResolvedValue({ balance: 30_000, lastClaimAt: new Date() });
		const { fake, showModal } = press();
		await runChipClaim(fake);
		const modal = (showModal.mock.calls[0] as unknown as [{ data: { custom_id: string } }])[0];
		expect(modal.data.custom_id).toMatch(/^notice:/);
	});

	// Owner decision 2026-10-27: with chips off an admin plays the round like a member, and
	// the card's chips off line is what points at the switch. The launcher answers as if
	// the presser were an admin, and the press still never reaches it.
	it("plays the round for an admin too when chips are off, opening no settings panel", async () => {
		mocks.findConfig.mockResolvedValue({ chipEconomyEnabled: false });
		mocks.openSettingsPanel.mockResolvedValue(true);
		const { fake, showModal } = press();
		await runChipClaim(fake);
		expect(mocks.openSettingsPanel).not.toHaveBeenCalled();
		expect((showModal.mock.calls[0] as unknown as [{ data: { custom_id: string } }])[0].data.custom_id).toBe("dailyclaim:throw");
	});

	it("lets a member play for coins when chips are off, gated by today's coin claim", async () => {
		mocks.findConfig.mockResolvedValue({ chipEconomyEnabled: false });
		const { fake, showModal } = press();
		await runChipClaim(fake);
		expect(mocks.hasClaim).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-\d{2}-\d{2}:g1$/), "u1");
		expect((showModal.mock.calls[0] as unknown as [{ data: { custom_id: string } }])[0].data.custom_id).toBe("dailyclaim:throw");
	});
});

describe("playClaimRound, the Submit", () => {
	it.each([
		["paper", "won", 2_000, 20],
		["rock", "tie", 1_500, 15],
		["scissors", "lost", 1_000, 10],
	])("throwing %s against Dero's rock (%s) pays %i chips and %i coins", async (memberThrow, _outcome, chips, coins) => {
		const channel = { send: vi.fn(async () => ({ id: "m1" })) };
		const { fake, deferUpdate } = submit(memberThrow, channel);

		await playClaimRound(fake, DERO_THROWS_ROCK);

		expect(deferUpdate).toHaveBeenCalled();
		expect(mocks.claimDaily).toHaveBeenCalledWith({ guildId: "g1", userId: "u1" }, chips, expect.any(Date), expect.any(Date));
		expect(mocks.insertAward).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1", guildId: "g1", amount: coins, source: "claim" }));
		expect(mocks.credit).toHaveBeenCalledWith("u1", coins);
		expect(descriptionOf(channel.send)).toContain(`<@u1>`);
		expect((channel.send.mock.calls[0][0] as Sent).allowedMentions).toEqual({ parse: [] });
	});

	// Risk R11: the first claim's 25,000 is the base the multiplier applies to.
	it("doubles the first claim's 25,000 on a win", async () => {
		mocks.claimFirst.mockImplementation(async (_key: unknown, amount: number) => ({ balance: amount }));
		const { fake } = submit("paper");
		await playClaimRound(fake, DERO_THROWS_ROCK);
		expect(mocks.claimFirst).toHaveBeenCalledWith({ guildId: "g1", userId: "u1" }, 50_000, expect.any(Date));
		expect(mocks.claimDaily).not.toHaveBeenCalled();
	});

	it("pays coins only with chips off, and the card names the command for an admin", async () => {
		mocks.findConfig.mockResolvedValue({ chipEconomyEnabled: false, commandOutputChannelId: "commands" });
		const channel = { send: vi.fn(async () => ({ id: "m1" })) };
		const { fake } = submit("paper", channel);

		await playClaimRound(fake, DERO_THROWS_ROCK);

		expect(mocks.claimFirst).not.toHaveBeenCalled();
		expect(mocks.claimDaily).not.toHaveBeenCalled();
		expect(mocks.credit).toHaveBeenCalledWith("u1", 20);
		expect(descriptionOf(channel.send)).toContain("`/arcade chips toggle enabled:True`");
	});

	it("pays the coins once when a second Submit lands the same day", async () => {
		mocks.insertAward.mockResolvedValue(false);
		const channel = { send: vi.fn(async () => ({ id: "m1" })) };
		const { fake } = submit("paper", channel);

		await playClaimRound(fake, DERO_THROWS_ROCK);

		expect(mocks.credit).not.toHaveBeenCalled();
		expect(descriptionOf(channel.send)).toContain("paid already");
	});

	it("plays no round and pays nothing while the cooldown runs, and says when it opens", async () => {
		mocks.findChipWallet.mockResolvedValue({ balance: 30_000, lastClaimAt: new Date() });
		const { fake, followUp } = submit("paper");

		await playClaimRound(fake, DERO_THROWS_ROCK);

		expect(mocks.claimDaily).not.toHaveBeenCalled();
		expect(mocks.insertAward).not.toHaveBeenCalled();
		expect((followUp.mock.calls[0] as unknown as [{ content: string }])[0].content).toContain("next claim opens");
	});

	it("never records the round on the luck board", async () => {
		const { fake } = submit("paper");
		await playClaimRound(fake, DERO_THROWS_ROCK);
		expect(mocks.recordLuckResult).not.toHaveBeenCalled();
	});

	it("answers privately with the card when the server has no commands channel yet", async () => {
		mocks.findConfig.mockResolvedValue({ chipEconomyEnabled: true, commandOutputChannelId: null });
		const { fake, followUp } = submit("paper", null);

		await playClaimRound(fake, DERO_THROWS_ROCK);

		const answer = (followUp.mock.calls[0] as unknown as [{ embeds: Array<{ data: { description?: string } }> }])[0];
		expect(answer.embeds[1].data.description).toBe(economyCopy.round.noCommandsChannel);
		expect(mocks.credit).toHaveBeenCalledWith("u1", 20);
	});
});
