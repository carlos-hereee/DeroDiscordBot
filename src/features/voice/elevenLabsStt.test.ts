import { describe, it, expect, vi } from "vitest";
import type { FetchLike } from "./elevenLabsTts.js";
import { createElevenLabsStt } from "./elevenLabsStt.js";
import { SttError } from "./sttProvider.js";
import { wavFromPcm16kMono } from "./wavFile.js";

// ── ElevenLabs speech to text, with a fake fetch ───────────────────────────
// No case here reaches the network. The fake records every call, so the wire
// shape confirmed against the API reference (path, header, multipart fields,
// model id), the no retry rule and the "no call at all" refusals are pinned.

const WAV = wavFromPcm16kMono(Buffer.alloc(16_000));
const ONE_SECOND = 1000;

const transcriptResponse = (body: unknown = { language_code: "en", text: "Dero, send hello world" }): Response =>
	new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const statusResponse = (status: number): Response => new Response("{}", { status });

function hangUntilAborted(_url: string, init: RequestInit): Promise<Response> {
	return new Promise((_resolve, reject) => {
		init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
	});
}

function client(fetchImpl: FetchLike, overrides: { apiKey?: string; timeoutMs?: number } = {}) {
	return createElevenLabsStt({ apiKey: overrides.apiKey ?? "test-key", fetchImpl, timeoutMs: overrides.timeoutMs });
}

async function kindOf(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
		return "resolved";
	}
	catch (error) {
		return error instanceof SttError ? error.kind : "untyped";
	}
}

describe("request shape", () => {
	it("posts the WAV and scribe_v2 as multipart to /v1/speech-to-text with the xi-api-key header", async () => {
		const fetchImpl = vi.fn<FetchLike>(async () => transcriptResponse());
		const result = await client(fetchImpl).transcribe({ wav: WAV, durationMs: ONE_SECOND });

		expect(result).toEqual({ text: "Dero, send hello world" });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
		expect(init.method).toBe("POST");
		// No Content-Type of our own: fetch must write the multipart boundary.
		expect(init.headers).toEqual({ "xi-api-key": "test-key" });
		expect(init.signal).toBeInstanceOf(AbortSignal);

		const form = init.body as FormData;
		expect(form.get("model_id")).toBe("scribe_v2");
		expect(form.get("tag_audio_events")).toBe("false");
		// Language detection is left to the provider.
		expect(form.has("language_code")).toBe(false);
		const file = form.get("file") as File;
		expect(file.name).toBe("utterance.wav");
		expect(file.type).toBe("audio/wav");
		expect(Buffer.from(await file.arrayBuffer()).equals(WAV)).toBe(true);
	});

	it("reports the model it calls", () => {
		expect(client(vi.fn<FetchLike>()).modelId).toBe("scribe_v2");
	});
});

describe("refusals before any call", () => {
	it.each([
		["an empty file", wavFromPcm16kMono(Buffer.alloc(0)), ONE_SECOND],
		["audio under the provider's 100 ms minimum", WAV, 99],
	])("refuses %s as invalidInput with zero calls", async (_label, wav, durationMs) => {
		const fetchImpl = vi.fn<FetchLike>();
		expect(await kindOf(client(fetchImpl).transcribe({ wav, durationMs }))).toBe("invalidInput");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("refuses with auth and zero calls when no key is set", async () => {
		const fetchImpl = vi.fn<FetchLike>();
		expect(await kindOf(client(fetchImpl, { apiKey: "" }).transcribe({ wav: WAV, durationMs: ONE_SECOND }))).toBe("auth");
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

describe("failures, never retried", () => {
	it.each([
		[401, "auth"],
		[403, "auth"],
		[422, "rejected"],
		[429, "rateLimit"],
		[500, "providerDown"],
		[503, "providerDown"],
	])("maps a %i to %s after exactly one call", async (status, kind) => {
		const fetchImpl = vi.fn<FetchLike>(async () => statusResponse(status));
		expect(await kindOf(client(fetchImpl).transcribe({ wav: WAV, durationMs: ONE_SECOND }))).toBe(kind);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("times out after the limit and does not try again", async () => {
		const fetchImpl = vi.fn<FetchLike>(hangUntilAborted);
		expect(await kindOf(client(fetchImpl, { timeoutMs: 5 }).transcribe({ wav: WAV, durationMs: ONE_SECOND }))).toBe("timeout");
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("treats a network failure as providerDown", async () => {
		const fetchImpl = vi.fn<FetchLike>(async () => {
			throw new TypeError("fetch failed");
		});
		expect(await kindOf(client(fetchImpl).transcribe({ wav: WAV, durationMs: ONE_SECOND }))).toBe("providerDown");
	});

	it.each([
		["a body that is not JSON", new Response("<html>", { status: 200 })],
		["JSON with no text", transcriptResponse({ language_code: "en" })],
		["a text that is not a string", transcriptResponse({ text: 42 })],
	])("treats %s as providerDown", async (_label, response) => {
		const fetchImpl = vi.fn<FetchLike>(async () => response);
		expect(await kindOf(client(fetchImpl).transcribe({ wav: WAV, durationMs: ONE_SECOND }))).toBe("providerDown");
	});

	it("puts only the kind and the status in the error message", async () => {
		const fetchImpl = vi.fn<FetchLike>(async () => statusResponse(429));
		await expect(client(fetchImpl).transcribe({ wav: WAV, durationMs: ONE_SECOND })).rejects.toThrow("stt rateLimit (status 429)");
	});
});
