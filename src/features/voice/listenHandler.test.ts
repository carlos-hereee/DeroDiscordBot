import { describe, it, expect, vi, beforeEach } from "vitest";
import { MessageFlags, type AttachmentBuilder, type ButtonInteraction } from "discord.js";
import { TtsError } from "./ttsProvider.js";
import { voiceCopy } from "./voiceCopy.js";

// ── Listen handler matrix ──────────────────────────────────────────────────
// The handler is the only path from a click to a paid call, so every gate is
// asserted by what it did NOT call as much as by what it replied. Fakes: the
// config store, the spend meter and the provider. The clip cache and the
// cooldowns are the real module scope ones, so every case uses its own guild,
// user and text unless it is testing exactly that sharing.

const mocks = vi.hoisted(() => ({
	findByGuildId: vi.fn(),
	tryReserve: vi.fn(),
	refund: vi.fn(),
	synthesize: vi.fn(),
}));

vi.mock("@db/stores/deroVoiceConfigStore.js", () => ({
	deroVoiceConfigStore: { findByGuildId: mocks.findByGuildId },
}));
vi.mock("./spendMeter.js", () => ({ tryReserve: mocks.tryReserve, refund: mocks.refund }));
vi.mock("./elevenLabsTts.js", () => ({
	elevenLabsTts: { modelId: "test-model", synthesize: mocks.synthesize },
}));

import { handleListen, deliverClip } from "./listenHandler.js";

const VOICE_ID = "abcDEF1234567890wxyz";
const READY = { enabled: true, listenEnabled: true, voiceId: VOICE_ID, monthlyCapUsd: 25 };
const AUDIO = Buffer.from([1, 2, 3, 4]);
const RESERVATION = { guildId: "g", month: "2026-10", cents: 1, ttsChars: 10 };

let seq = 0;

function click(options: { guildId?: string | null; userId?: string; content?: string; description?: string | null } = {}) {
	seq += 1;
	return {
		guildId: options.guildId === undefined ? `guild-${seq}` : options.guildId,
		user: { id: options.userId ?? `user-${seq}` },
		message: {
			content: options.content ?? `Fresh words number ${seq}.`,
			embeds: options.description ? [{ description: options.description }] : [],
		},
		deferReply: vi.fn(async () => undefined),
		editReply: vi.fn(async () => undefined),
	} as unknown as ButtonInteraction & { deferReply: ReturnType<typeof vi.fn>; editReply: ReturnType<typeof vi.fn> };
}

const lastReply = (interaction: { editReply: ReturnType<typeof vi.fn> }) =>
	interaction.editReply.mock.calls.at(-1)?.[0] as { content?: string; files?: AttachmentBuilder[] };

beforeEach(() => {
	vi.spyOn(console, "info").mockImplementation(() => undefined);
	mocks.findByGuildId.mockReset().mockResolvedValue(READY);
	mocks.tryReserve.mockReset().mockResolvedValue({ status: "ok", reservation: RESERVATION });
	mocks.refund.mockReset().mockResolvedValue(undefined);
	mocks.synthesize.mockReset().mockResolvedValue({ bytes: AUDIO, format: "mp3" });
});

describe("the gates before any spend", () => {
	it("defers privately before anything else", async () => {
		const interaction = click();
		await handleListen(interaction);
		expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
	});

	it("refuses when voice is disabled, with zero meter and provider calls", async () => {
		mocks.findByGuildId.mockResolvedValue({ ...READY, enabled: false });
		const interaction = click();
		await handleListen(interaction);

		expect(lastReply(interaction)).toEqual({ content: voiceCopy.listen.voiceOff });
		expect(mocks.tryReserve).not.toHaveBeenCalled();
		expect(mocks.synthesize).not.toHaveBeenCalled();
	});

	it("refuses when Listen is off", async () => {
		mocks.findByGuildId.mockResolvedValue({ ...READY, listenEnabled: false });
		const interaction = click();
		await handleListen(interaction);

		expect(lastReply(interaction)).toEqual({ content: voiceCopy.listen.listenOff });
		expect(mocks.synthesize).not.toHaveBeenCalled();
	});

	it("refuses when no voice is set, or the guild never set voice up", async () => {
		mocks.findByGuildId.mockResolvedValue({ ...READY, voiceId: null });
		const noVoice = click();
		await handleListen(noVoice);
		expect(lastReply(noVoice)).toEqual({ content: voiceCopy.listen.notSetUp });

		mocks.findByGuildId.mockResolvedValue(null);
		const noRow = click();
		await handleListen(noRow);
		expect(lastReply(noRow)).toEqual({ content: voiceCopy.listen.notSetUp });
		expect(mocks.synthesize).not.toHaveBeenCalled();
	});

	it("says there is nothing to read when the post cleans down to nothing", async () => {
		const interaction = click({ content: "<:dero:112233445566778899> https://www.companyuno.com" });
		await handleListen(interaction);

		expect(lastReply(interaction)).toEqual({ content: voiceCopy.listen.nothingToRead });
		expect(mocks.tryReserve).not.toHaveBeenCalled();
	});

	it("reads the first embed's description when the content is empty", async () => {
		const interaction = click({ content: "", description: "The stars say yes." });
		await handleListen(interaction);
		expect(mocks.synthesize).toHaveBeenCalledWith({ voiceId: VOICE_ID, text: "The stars say yes.", format: "mp3" });
	});
});

describe("cooldowns", () => {
	it("refuses a second fresh render by the same member, with the seconds left", async () => {
		const first = click({ guildId: "cool-guild-a", userId: "cool-user-a", content: "First post." });
		await handleListen(first);
		const second = click({ guildId: "cool-guild-a", userId: "cool-user-a", content: "Second post." });
		await handleListen(second);

		expect(lastReply(second)?.content).toBe(voiceCopy.listen.cooldown(15));
		expect(mocks.synthesize).toHaveBeenCalledTimes(1);
		expect(mocks.tryReserve).toHaveBeenCalledTimes(1);
	});

	it("refuses a second fresh render in the same guild by another member", async () => {
		await handleListen(click({ guildId: "cool-guild-b", userId: "cool-user-b1", content: "One post." }));
		const other = click({ guildId: "cool-guild-b", userId: "cool-user-b2", content: "Another post." });
		await handleListen(other);

		expect(lastReply(other)?.content).toBe(voiceCopy.listen.cooldown(3));
		expect(mocks.synthesize).toHaveBeenCalledTimes(1);
	});
});

describe("spend and the provider", () => {
	it("refuses at the cap with zero provider calls", async () => {
		mocks.tryReserve.mockResolvedValue({ status: "capReached" });
		const interaction = click();
		await handleListen(interaction);

		expect(lastReply(interaction)).toEqual({ content: voiceCopy.listen.capReached });
		expect(mocks.synthesize).not.toHaveBeenCalled();
	});

	it("reserves the estimate for the cleaned text before rendering", async () => {
		const interaction = click({ content: "Twelve chars" });
		await handleListen(interaction);
		expect(mocks.tryReserve).toHaveBeenCalledWith(interaction.guildId, 1, { ttsChars: 12 });
	});

	it("refunds a failed render and does not burn the cooldown", async () => {
		mocks.synthesize.mockRejectedValueOnce(new TtsError("providerDown", 503));
		const failed = click({ guildId: "fail-guild", userId: "fail-user", content: "Will fail." });
		await handleListen(failed);

		expect(mocks.refund).toHaveBeenCalledWith(RESERVATION);
		expect(lastReply(failed)).toEqual({ content: voiceCopy.listen.providerTrouble });

		// The same member, straight away, gets a render rather than a cooldown.
		const retry = click({ guildId: "fail-guild", userId: "fail-user", content: "Will work." });
		await handleListen(retry);
		expect(mocks.synthesize).toHaveBeenCalledTimes(2);
		expect(lastReply(retry)?.files).toHaveLength(1);
	});
});

describe("the clip cache", () => {
	it("replays a cached clip with zero provider calls and zero meter calls", async () => {
		await handleListen(click({ guildId: "cache-guild", userId: "cache-user", content: "Say this twice." }));
		mocks.synthesize.mockClear();
		mocks.tryReserve.mockClear();

		// Same member, same post, inside the cooldown: a replay is free, so it is
		// neither cooled down nor metered.
		const replay = click({ guildId: "cache-guild", userId: "cache-user", content: "Say this twice." });
		await handleListen(replay);

		expect(mocks.synthesize).not.toHaveBeenCalled();
		expect(mocks.tryReserve).not.toHaveBeenCalled();
		expect(lastReply(replay)?.files).toHaveLength(1);
	});
});

describe("delivery", () => {
	it("sends exactly one private attachment named dero-listen.mp3", async () => {
		const interaction = click();
		await handleListen(interaction);

		const reply = lastReply(interaction);
		expect(reply.files).toHaveLength(1);
		expect(reply.files?.[0].name).toBe("dero-listen.mp3");
		expect(interaction.editReply).toHaveBeenCalledTimes(1);
	});

	it("adds a line when the post was cut short", async () => {
		const interaction = click();
		await deliverClip(interaction, { bytes: AUDIO, format: "mp3", truncated: true });
		expect(lastReply(interaction).content).toBe(voiceCopy.listen.truncated);
	});

	it("never puts the spoken text in a log line", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		info.mockClear();
		await handleListen(click({ content: "A secret only the post holds." }));

		const logged = info.mock.calls.flat().join(" ");
		expect(logged).toContain("outcome=rendered");
		expect(logged).not.toContain("secret");
	});
});
