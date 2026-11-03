import { describe, it, expect, vi, beforeEach } from "vitest";
import { AttachmentBuilder, type Guild } from "discord.js";
import { NO_PINGS } from "@utils/mentions.js";
import { TtsError } from "./ttsProvider.js";
import { voiceCopy } from "./voiceCopy.js";
import type { VoiceSpeaker } from "./voiceSpeaker.js";

// ── join notice ────────────────────────────────────────────────────────────
// What a successful join does: the public notice first, with no pings and the
// plain truth about listening, then the greeting through the real call
// speech path. Fakes: the spend meter, the provider, the channel and the
// speaker. A refused or failed greeting leaves the join standing, in silence.

const mocks = vi.hoisted(() => ({
	tryReserve: vi.fn(),
	refund: vi.fn(),
	synthesize: vi.fn(),
	renderVoicePresenceCard: vi.fn(),
}));

vi.mock("./spendMeter.js", () => ({ tryReserve: mocks.tryReserve, refund: mocks.refund }));
vi.mock("./elevenLabsTts.js", () => ({ elevenLabsTts: { modelId: "test-model", synthesize: mocks.synthesize } }));
// The JOINED presence card (2026-10 item 243 Phase 4). Null by default, so every
// case below sees the notice exactly as it was before the card existed; the
// presence card describe switches it on.
vi.mock("./voicePresenceRenderer.js", () => ({ renderVoicePresenceCard: mocks.renderVoicePresenceCard }));

import { announceJoin, postVoiceNotice } from "./joinNotice.js";

const RESERVATION = { guildId: "g", month: "2026-10", cents: 1, ttsChars: 10 };
const PCM_24K = Buffer.from([0x10, 0x00, 0x20, 0x00]);

let seq = 0;
let order: string[];

function rig(options: { sendable?: boolean; speakResult?: string } = {}) {
	// Each case gets its own voice id, so the greeting's clip cache entry from one
	// case can never turn the next case's render into a free replay.
	const voiceId = `voice${String(++seq).padStart(12, "0")}`;
	const send = vi.fn(async () => {
		order.push("notice");
		return undefined;
	});
	const channel = { isSendable: () => options.sendable ?? true, send };
	const guild = { id: "g1", channels: { cache: new Map([["text-1", channel]]) } } as unknown as Guild;
	const speak = vi.fn(() => options.speakResult ?? "playing");
	const speaker = { speak } as unknown as VoiceSpeaker;
	const input = { guild, controlChannelId: "text-1", voiceChannelId: "vc-1", voiceId, speaker };
	return { input, send, speak };
}

beforeEach(() => {
	order = [];
	vi.spyOn(console, "info").mockImplementation(() => undefined);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	mocks.tryReserve.mockReset().mockResolvedValue({ status: "ok", reservation: RESERVATION });
	mocks.refund.mockReset().mockResolvedValue(undefined);
	mocks.renderVoicePresenceCard.mockReset().mockResolvedValue(null);
	mocks.synthesize.mockReset().mockImplementation(async () => {
		order.push("render");
		return { bytes: PCM_24K, format: "pcm24k" };
	});
});

describe("announceJoin", () => {
	it("posts the notice with no pings before rendering, then greets at brain priority", async () => {
		const { input, send, speak } = rig();
		expect(await announceJoin(input)).toBe("greeted");

		expect(send).toHaveBeenCalledWith({ content: voiceCopy.call.joinNotice("vc-1"), allowedMentions: NO_PINGS });
		expect(order).toEqual(["notice", "render"]);
		expect(mocks.synthesize).toHaveBeenCalledWith(expect.objectContaining({ text: voiceCopy.call.greeting, format: "pcm24k" }));
		expect(speak).toHaveBeenCalledWith(expect.any(Buffer), "brain");
	});

	it("says in plain words who Dero hears, where the speech goes, that nothing is kept, and how to stop it", () => {
		const notice = voiceCopy.call.joinNotice("vc-1");
		expect(notice).toContain("is listening, but only to members on Dero's task list");
		expect(notice).toContain("sent to ElevenLabs and turned into text");
		expect(notice).toContain("Dero records and keeps nothing");
		expect(notice).toContain("/dero leave");
	});

	it("degrades to silence when the meter refuses, with zero provider calls", async () => {
		mocks.tryReserve.mockResolvedValue({ status: "capReached" });
		const { input, send, speak } = rig();
		expect(await announceJoin(input)).toBe("capReached");
		expect(send).toHaveBeenCalledTimes(1);
		expect(mocks.synthesize).not.toHaveBeenCalled();
		expect(speak).not.toHaveBeenCalled();
	});

	it("degrades to silence when the provider fails, and refunds", async () => {
		mocks.synthesize.mockRejectedValue(new TtsError("rateLimit", 429));
		const { input, speak } = rig();
		expect(await announceJoin(input)).toBe("providerTrouble");
		expect(mocks.refund).toHaveBeenCalledWith(RESERVATION);
		expect(speak).not.toHaveBeenCalled();
	});

	it("reports a speaker that could not start the clip", async () => {
		const { input } = rig({ speakResult: "dropped" });
		expect(await announceJoin(input)).toBe("playbackFailed");
	});

	it("still greets when the notice channel cannot take a message", async () => {
		const { input, send, speak } = rig({ sendable: false });
		expect(await announceJoin(input)).toBe("greeted");
		expect(send).not.toHaveBeenCalled();
		expect(speak).toHaveBeenCalledTimes(1);
	});
});

describe("postVoiceNotice", () => {
	it("swallows a failed send instead of throwing into the caller", async () => {
		const send = vi.fn(async () => {
			throw Object.assign(new Error("Missing Permissions"), { code: 50013 });
		});
		const guild = { id: "g1", channels: { cache: new Map([["t", { isSendable: () => true, send }]]) } } as unknown as Guild;
		await expect(postVoiceNotice(guild, "t", "line")).resolves.toBeUndefined();
	});

	it("skips a channel that is not in the guild's cache", async () => {
		const guild = { id: "g1", channels: { cache: new Map() } } as unknown as Guild;
		await expect(postVoiceNotice(guild, "missing", "line")).resolves.toBeUndefined();
	});
});

describe("announceJoin's presence card", () => {
	it("posts the JOINED card under the notice, named for the voice channel", async () => {
		const attachment = new AttachmentBuilder(Buffer.from("png"), { name: "voice-presence.png" });
		mocks.renderVoicePresenceCard.mockResolvedValue({ attachment, ref: "attachment://voice-presence.png" });
		const { input, send } = rig();
		(input.guild.channels.cache as Map<string, unknown>).set("vc-1", { name: "War Council" });

		await announceJoin(input);

		expect(mocks.renderVoicePresenceCard).toHaveBeenCalledWith({ state: "joined", channelName: "War Council" });
		expect(send).toHaveBeenCalledWith({ content: voiceCopy.call.joinNotice("vc-1"), allowedMentions: NO_PINGS, files: [attachment] });
	});

	it("posts the notice alone, the privacy promise intact, when the card does not draw", async () => {
		mocks.renderVoicePresenceCard.mockRejectedValue(new Error("simulated renderer failure"));
		const { input, send } = rig();

		expect(await announceJoin(input)).toBe("greeted");

		expect(send).toHaveBeenCalledWith({ content: voiceCopy.call.joinNotice("vc-1"), allowedMentions: NO_PINGS });
	});
});
