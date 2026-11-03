import { describe, it, expect, vi, beforeEach } from "vitest";
import { TtsError } from "./ttsProvider.js";

// ── call speech ────────────────────────────────────────────────────────────
// The render path for anything Dero says in a call. Fakes: the spend meter and
// the provider. The clip cache is the real module one, so each case uses its
// own text unless it is testing the replay.

const mocks = vi.hoisted(() => ({
	tryReserve: vi.fn(),
	refund: vi.fn(),
	synthesize: vi.fn(),
}));

vi.mock("./spendMeter.js", () => ({ tryReserve: mocks.tryReserve, refund: mocks.refund }));
vi.mock("./elevenLabsTts.js", () => ({ elevenLabsTts: { modelId: "test-model", synthesize: mocks.synthesize } }));

import { renderCallSpeech } from "./callSpeech.js";

const VOICE_ID = "abcDEF1234567890wxyz";
const RESERVATION = { guildId: "g", month: "2026-10", cents: 1, ttsChars: 10 };
// Two 24 kHz mono samples, which resample to four 48 kHz stereo frames.
const PCM_24K = Buffer.from([0x10, 0x00, 0x20, 0x00]);

let seq = 0;
const freshText = (): string => `Line number ${++seq}.`;

beforeEach(() => {
	vi.spyOn(console, "info").mockImplementation(() => undefined);
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	mocks.tryReserve.mockReset().mockResolvedValue({ status: "ok", reservation: RESERVATION });
	mocks.refund.mockReset().mockResolvedValue(undefined);
	mocks.synthesize.mockReset().mockResolvedValue({ bytes: PCM_24K, format: "pcm24k" });
});

describe("renderCallSpeech", () => {
	it("renders 24 kHz PCM and hands back 48 kHz stereo", async () => {
		const text = freshText();
		const result = await renderCallSpeech({ guildId: "g1", voiceId: VOICE_ID, text });
		expect(mocks.synthesize).toHaveBeenCalledWith({ voiceId: VOICE_ID, text, format: "pcm24k" });
		expect(result).toMatchObject({ status: "ok", cached: false });
		expect(result.status === "ok" && result.pcm48kStereo.length).toBe(PCM_24K.length * 4);
	});

	it("replays the same line from the cache with no meter or provider call", async () => {
		const text = freshText();
		await renderCallSpeech({ guildId: "g1", voiceId: VOICE_ID, text });
		mocks.tryReserve.mockClear();
		mocks.synthesize.mockClear();

		const again = await renderCallSpeech({ guildId: "g1", voiceId: VOICE_ID, text });
		expect(again).toMatchObject({ status: "ok", cached: true });
		expect(mocks.tryReserve).not.toHaveBeenCalled();
		expect(mocks.synthesize).not.toHaveBeenCalled();
	});

	it("refuses at the cap with zero provider calls", async () => {
		mocks.tryReserve.mockResolvedValue({ status: "capReached" });
		const result = await renderCallSpeech({ guildId: "g1", voiceId: VOICE_ID, text: freshText() });
		expect(result).toEqual({ status: "capReached" });
		expect(mocks.synthesize).not.toHaveBeenCalled();
	});

	it("refunds and reports the kind when the provider fails, and caches nothing", async () => {
		const text = freshText();
		mocks.synthesize.mockRejectedValueOnce(new TtsError("providerDown", 503));
		const result = await renderCallSpeech({ guildId: "g1", voiceId: VOICE_ID, text });
		expect(result).toEqual({ status: "failed", kind: "providerDown" });
		expect(mocks.refund).toHaveBeenCalledWith(RESERVATION);

		await renderCallSpeech({ guildId: "g1", voiceId: VOICE_ID, text });
		expect(mocks.synthesize).toHaveBeenCalledTimes(2);
	});

	it("rejects half a sample instead of caching a broken clip", async () => {
		const text = freshText();
		mocks.synthesize.mockResolvedValueOnce({ bytes: Buffer.from([1, 2, 3]), format: "pcm24k" });
		expect(await renderCallSpeech({ guildId: "g1", voiceId: VOICE_ID, text })).toEqual({ status: "failed", kind: "unexpected" });

		await renderCallSpeech({ guildId: "g1", voiceId: VOICE_ID, text });
		expect(mocks.synthesize).toHaveBeenCalledTimes(2);
	});

	it("never logs the text it renders", async () => {
		const text = "A very particular sentence nobody else would say.";
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		mocks.synthesize.mockRejectedValueOnce(new TtsError("auth", 401));
		await renderCallSpeech({ guildId: "g1", voiceId: VOICE_ID, text });
		await renderCallSpeech({ guildId: "g1", voiceId: VOICE_ID, text });
		expect(JSON.stringify(info.mock.calls)).not.toContain(text);
	});
});
