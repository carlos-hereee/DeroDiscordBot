import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AttachmentBuilder, ButtonInteraction } from "discord.js";
import { voiceCopy } from "./voiceCopy.js";

// ── Listen in the call ─────────────────────────────────────────────────────
// The delivery decision, split from listenHandler.test.ts by concern: a press
// from a member in Dero's own voice channel plays there (rendered as 24 kHz PCM
// under its own cache key); a press from anyone else gets the private mp3
// exactly as before. Fakes: the config store, the spend meter, the provider and
// the session map. The clip cache, the resampler and callSpeech are real, so
// every case uses its own guild and text unless it is testing the replay.

const mocks = vi.hoisted(() => ({
	findByGuildId: vi.fn(),
	tryReserve: vi.fn(),
	refund: vi.fn(),
	synthesize: vi.fn(),
	sessionGet: vi.fn(),
}));

vi.mock("@db/stores/deroVoiceConfigStore.js", () => ({ deroVoiceConfigStore: { findByGuildId: mocks.findByGuildId } }));
vi.mock("./spendMeter.js", () => ({ tryReserve: mocks.tryReserve, refund: mocks.refund }));
// The budget line's ending follows coverage; these suites read the uncovered one.
vi.mock("@features/entitlements/serverPlanAccess.js", () => ({ isServerCovered: async () => false }));
vi.mock("./elevenLabsTts.js", () => ({ elevenLabsTts: { modelId: "test-model", synthesize: mocks.synthesize } }));
vi.mock("./voiceSessions.js", () => ({ voiceSessions: { get: mocks.sessionGet } }));

import { handleListen } from "./listenHandler.js";

const VOICE_ID = "abcDEF1234567890wxyz";
const READY = { enabled: true, listenEnabled: true, voiceId: VOICE_ID, monthlyCapUsd: 25 };
const RESERVATION = { guildId: "g", month: "2026-10", cents: 1, ttsChars: 10 };
const PCM_24K = Buffer.from([0x10, 0x00, 0x20, 0x00]);
const MP3 = Buffer.from([9, 9, 9]);
const DERO_CHANNEL = "vc-dero";

let seq = 0;

interface ClickOptions {
	guildId?: string;
	userId?: string;
	content?: string;
	voiceChannelId?: string | null;
	cached?: boolean;
}

function click({ guildId, userId, content, voiceChannelId = DERO_CHANNEL, cached = true }: ClickOptions = {}) {
	seq += 1;
	return {
		guildId: guildId ?? `call-guild-${seq}`,
		user: { id: userId ?? `call-user-${seq}` },
		message: { content: content ?? `Call words number ${seq}.`, embeds: [] },
		inCachedGuild: () => cached,
		member: { voice: { channelId: voiceChannelId } },
		deferReply: vi.fn(async () => undefined),
		editReply: vi.fn(async () => undefined),
	} as unknown as ButtonInteraction & { editReply: ReturnType<typeof vi.fn> };
}

const lastReply = (interaction: { editReply: ReturnType<typeof vi.fn> }) =>
	interaction.editReply.mock.calls.at(-1)?.[0] as { content?: string; files?: AttachmentBuilder[] };

let speak: ReturnType<typeof vi.fn>;
let session: { channelId: string; speaker: { speak: ReturnType<typeof vi.fn> } };

beforeEach(() => {
	vi.spyOn(console, "info").mockImplementation(() => undefined);
	speak = vi.fn(() => "playing");
	session = { channelId: DERO_CHANNEL, speaker: { speak } };
	mocks.findByGuildId.mockReset().mockResolvedValue(READY);
	mocks.tryReserve.mockReset().mockResolvedValue({ status: "ok", reservation: RESERVATION });
	mocks.refund.mockReset().mockResolvedValue(undefined);
	mocks.synthesize.mockReset().mockImplementation(async ({ format }: { format: string }) => ({
		bytes: format === "pcm24k" ? PCM_24K : MP3,
		format,
	}));
	mocks.sessionGet.mockReset().mockImplementation(() => session);
});

describe("a member in Dero's voice channel", () => {
	it("hears the post in the call, rendered as PCM, and is told where privately", async () => {
		const interaction = click();
		await handleListen(interaction);

		expect(mocks.synthesize).toHaveBeenCalledWith(expect.objectContaining({ format: "pcm24k" }));
		expect(speak).toHaveBeenCalledTimes(1);
		const [pcm, priority] = speak.mock.calls[0] as [Buffer, string];
		expect(priority).toBe("listen");
		expect(pcm.length).toBe(PCM_24K.length * 4);
		expect(lastReply(interaction)).toEqual({ content: voiceCopy.listen.playingInCall(DERO_CHANNEL) });
	});

	it("replays the same post in the call from the cache, with no meter or provider call", async () => {
		await handleListen(click({ guildId: "replay-guild", userId: "replay-user", content: "Play this twice." }));
		mocks.synthesize.mockClear();
		mocks.tryReserve.mockClear();

		const replay = click({ guildId: "replay-guild", userId: "replay-user", content: "Play this twice." });
		await handleListen(replay);
		expect(mocks.synthesize).not.toHaveBeenCalled();
		expect(mocks.tryReserve).not.toHaveBeenCalled();
		expect(speak).toHaveBeenCalledTimes(2);
	});

	it("keeps the call clip and the private mp3 under separate cache keys", async () => {
		await handleListen(click({ guildId: "keys-guild", content: "One post, two places." }));
		mocks.sessionGet.mockReturnValue(null);
		const privately = click({ guildId: "keys-guild-2", content: "One post, two places." });
		await handleListen(privately);

		expect(mocks.synthesize.mock.calls.map((call) => (call[0] as { format: string }).format)).toEqual(["pcm24k", "mp3"]);
		expect(lastReply(privately).files).toHaveLength(1);
	});

	it("adds the cut short line to the private note when the post was long", async () => {
		const interaction = click({ content: "This is one sentence of a long post. ".repeat(30) });
		await handleListen(interaction);
		expect(lastReply(interaction).content).toBe(`${voiceCopy.listen.playingInCall(DERO_CHANNEL)}\n${voiceCopy.listen.truncated}`);
	});

	it("says the call is too busy when the speaker drops the clip", async () => {
		speak.mockReturnValue("dropped");
		const interaction = click();
		await handleListen(interaction);
		expect(lastReply(interaction)).toEqual({ content: voiceCopy.listen.callQueueFull });
	});

	it("refuses at the cap with zero provider calls and nothing played", async () => {
		mocks.tryReserve.mockResolvedValue({ status: "capReached" });
		const interaction = click();
		await handleListen(interaction);
		expect(lastReply(interaction)).toEqual({ content: voiceCopy.listen.capReached(false) });
		expect(mocks.synthesize).not.toHaveBeenCalled();
		expect(speak).not.toHaveBeenCalled();
	});

	it("says the call ended when Dero left while the clip was rendering", async () => {
		mocks.sessionGet.mockReturnValueOnce(session).mockReturnValue(null);
		const interaction = click();
		await handleListen(interaction);
		expect(lastReply(interaction)).toEqual({ content: voiceCopy.listen.callEnded });
		expect(speak).not.toHaveBeenCalled();
	});
});

describe("everyone else gets the private mp3", () => {
	it.each([
		["a member in a different voice channel", { voiceChannelId: "vc-elsewhere" }],
		["a member in no voice channel", { voiceChannelId: null }],
		["a press from an uncached guild", { cached: false }],
	])("%s", async (_label, options) => {
		const interaction = click(options);
		await handleListen(interaction);

		expect(mocks.synthesize).toHaveBeenCalledWith(expect.objectContaining({ format: "mp3" }));
		expect(speak).not.toHaveBeenCalled();
		const reply = lastReply(interaction);
		expect(reply.files).toHaveLength(1);
		expect(reply.files?.[0].name).toBe("dero-listen.mp3");
	});

	it("never reads the clicker's voice state when the guild has no call", async () => {
		mocks.sessionGet.mockReturnValue(null);
		const inCachedGuild = vi.fn(() => true);
		const interaction = Object.assign(click(), { inCachedGuild });
		await handleListen(interaction);
		expect(inCachedGuild).not.toHaveBeenCalled();
		expect(lastReply(interaction).files).toHaveLength(1);
	});

	it("audits where the clip went, never the text", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		await handleListen(click({ content: "Only the post knows this sentence." }));
		const logged = info.mock.calls.flat().join(" ");
		expect(logged).toContain("delivery=call");
		expect(logged).not.toContain("Only the post knows");
	});
});
