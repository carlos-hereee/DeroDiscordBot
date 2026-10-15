import { describe, it, expect, vi } from "vitest";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { createElevenLabsTts, type FetchLike } from "./elevenLabsTts.js";
import { TtsError } from "./ttsProvider.js";

// ── ElevenLabs client, with a fake fetch ───────────────────────────────────
// No case here reaches the network. The fake records every call so the request
// shape, the retry rule and the "no call at all" refusals are all observable.

const VOICE_ID = "abcDEF1234567890wxyz";
const AUDIO = Uint8Array.from([0x49, 0x44, 0x33, 0x04]);

const audioResponse = (): Response => new Response(AUDIO, { status: 200 });
const statusResponse = (status: number): Response => new Response("{}", { status });

// A fetch that never answers until the call's own AbortSignal fires.
function hangUntilAborted(_url: string, init: RequestInit): Promise<Response> {
	return new Promise((_resolve, reject) => {
		init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
	});
}

function client(fetchImpl: FetchLike, overrides: { apiKey?: string; timeoutMs?: number } = {}) {
	return createElevenLabsTts({ apiKey: overrides.apiKey ?? "test-key", fetchImpl, timeoutMs: overrides.timeoutMs });
}

async function kindOf(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
		return "resolved";
	}
	catch (error) {
		return error instanceof TtsError ? error.kind : "untyped";
	}
}

describe("request shape", () => {
	it("posts the text and the Flash v2.5 model to the voice's text to speech endpoint", async () => {
		const fetchImpl = vi.fn<FetchLike>(async () => audioResponse());
		const clip = await client(fetchImpl).synthesize({ voiceId: VOICE_ID, text: "Hello there.", format: "mp3" });

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toBe(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_128`);
		expect(init.method).toBe("POST");
		expect(init.headers).toEqual({ "xi-api-key": "test-key", "Content-Type": "application/json" });
		expect(JSON.parse(String(init.body))).toEqual({ text: "Hello there.", model_id: "eleven_flash_v2_5" });
		expect(init.signal).toBeInstanceOf(AbortSignal);

		expect(clip.format).toBe("mp3");
		expect([...clip.bytes]).toEqual([...AUDIO]);
	});

	it("asks for raw 24 kHz PCM on the pcm24k path", async () => {
		const fetchImpl = vi.fn<FetchLike>(async () => audioResponse());
		const clip = await client(fetchImpl).synthesize({ voiceId: VOICE_ID, text: "Hello.", format: "pcm24k" });

		expect(fetchImpl.mock.calls[0][0]).toContain("?output_format=pcm_24000");
		expect(clip.format).toBe("pcm24k");
	});

	it("exposes the model id the cache key is built from", () => {
		expect(client(vi.fn<FetchLike>()).modelId).toBe(BOT_CONSTANTS.DERO_VOICE_TTS_MODEL_ID);
	});
});

describe("refusals that make no call", () => {
	it("rejects text over the length cap before any call", async () => {
		const fetchImpl = vi.fn<FetchLike>(async () => audioResponse());
		const text = "a".repeat(BOT_CONSTANTS.DERO_VOICE_TTS_MAX_CHARS + 1);

		expect(await kindOf(client(fetchImpl).synthesize({ voiceId: VOICE_ID, text, format: "mp3" }))).toBe("invalidInput");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("accepts text exactly at the length cap", async () => {
		const fetchImpl = vi.fn<FetchLike>(async () => audioResponse());
		const text = "a".repeat(BOT_CONSTANTS.DERO_VOICE_TTS_MAX_CHARS);

		expect(await kindOf(client(fetchImpl).synthesize({ voiceId: VOICE_ID, text, format: "mp3" }))).toBe("resolved");
	});

	it("rejects empty or whitespace text before any call", async () => {
		const fetchImpl = vi.fn<FetchLike>(async () => audioResponse());
		expect(await kindOf(client(fetchImpl).synthesize({ voiceId: VOICE_ID, text: "   ", format: "mp3" }))).toBe("invalidInput");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("refuses as auth, with no call, when no key is set", async () => {
		const fetchImpl = vi.fn<FetchLike>(async () => audioResponse());
		const tts = client(fetchImpl, { apiKey: "" });

		expect(await kindOf(tts.synthesize({ voiceId: VOICE_ID, text: "Hello.", format: "mp3" }))).toBe("auth");
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

describe("typed failures", () => {
	it("maps 401 to auth, without a retry", async () => {
		const fetchImpl = vi.fn<FetchLike>(async () => statusResponse(401));
		expect(await kindOf(client(fetchImpl).synthesize({ voiceId: VOICE_ID, text: "Hello.", format: "mp3" }))).toBe("auth");
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("maps 403 to auth", async () => {
		const fetchImpl = vi.fn<FetchLike>(async () => statusResponse(403));
		expect(await kindOf(client(fetchImpl).synthesize({ voiceId: VOICE_ID, text: "Hello.", format: "mp3" }))).toBe("auth");
	});

	it("maps 429 to rateLimit, without a retry", async () => {
		const fetchImpl = vi.fn<FetchLike>(async () => statusResponse(429));
		expect(await kindOf(client(fetchImpl).synthesize({ voiceId: VOICE_ID, text: "Hello.", format: "mp3" }))).toBe("rateLimit");
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("maps any other 4xx to rejected, without a retry", async () => {
		const fetchImpl = vi.fn<FetchLike>(async () => statusResponse(404));
		expect(await kindOf(client(fetchImpl).synthesize({ voiceId: VOICE_ID, text: "Hello.", format: "mp3" }))).toBe("rejected");
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("maps a network failure to providerDown", async () => {
		const fetchImpl = vi.fn<FetchLike>(async () => {
			throw new TypeError("fetch failed");
		});
		expect(await kindOf(client(fetchImpl).synthesize({ voiceId: VOICE_ID, text: "Hello.", format: "mp3" }))).toBe("providerDown");
	});

	it("treats a 200 with no audio as providerDown rather than a silent clip", async () => {
		const fetchImpl = vi.fn<FetchLike>(async () => new Response(new Uint8Array(0), { status: 200 }));
		expect(await kindOf(client(fetchImpl).synthesize({ voiceId: VOICE_ID, text: "Hello.", format: "mp3" }))).toBe("providerDown");
	});

	it("aborts at the timeout and reports timeout", async () => {
		const fetchImpl = vi.fn<FetchLike>(hangUntilAborted);
		const tts = client(fetchImpl, { timeoutMs: 20 });
		expect(await kindOf(tts.synthesize({ voiceId: VOICE_ID, text: "Hello.", format: "mp3" }))).toBe("timeout");
	});
});

describe("the 5xx retry", () => {
	it("retries a 5xx exactly once and returns the clip when the retry succeeds", async () => {
		const fetchImpl = vi.fn<FetchLike>().mockResolvedValueOnce(statusResponse(500)).mockResolvedValueOnce(audioResponse());
		const clip = await client(fetchImpl).synthesize({ voiceId: VOICE_ID, text: "Hello.", format: "mp3" });

		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(clip.bytes.length).toBe(AUDIO.length);
	});

	it("gives up after one retry and reports providerDown", async () => {
		const fetchImpl = vi.fn<FetchLike>(async () => statusResponse(503));
		expect(await kindOf(client(fetchImpl).synthesize({ voiceId: VOICE_ID, text: "Hello.", format: "mp3" }))).toBe("providerDown");
		expect(fetchImpl).toHaveBeenCalledTimes(1 + BOT_CONSTANTS.DERO_VOICE_TTS_MAX_RETRIES);
	});

	it("shares one deadline across the first try and the retry", async () => {
		const fetchImpl = vi.fn<FetchLike>().mockResolvedValueOnce(statusResponse(502)).mockImplementationOnce(hangUntilAborted);
		await client(fetchImpl, { timeoutMs: 20 }).synthesize({ voiceId: VOICE_ID, text: "Hello.", format: "mp3" }).catch(() => undefined);

		expect(fetchImpl.mock.calls[0][1].signal).toBe(fetchImpl.mock.calls[1][1].signal);
	});
});

describe("what an error carries", () => {
	it("never carries the spoken text or the key", async () => {
		const fetchImpl = vi.fn<FetchLike>(async () => statusResponse(401));
		const error = await client(fetchImpl, { apiKey: "sk_secret_value" })
			.synthesize({ voiceId: VOICE_ID, text: "a very private sentence", format: "mp3" })
			.catch((caught: unknown) => caught as Error);

		expect(String(error)).not.toContain("private");
		expect(String(error)).not.toContain("sk_secret_value");
	});
});
