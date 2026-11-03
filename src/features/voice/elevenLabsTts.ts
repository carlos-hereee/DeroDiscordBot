import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { elevenLabsApiKey } from "@utils/config.js";
import { TtsError, type TtsClip, type TtsErrorKind, type TtsProvider, type TtsRequest } from "./ttsProvider.js";

// ── ElevenLabs text to speech ──────────────────────────────────────────────
// What:  the one place the bot calls ElevenLabs. Renders text in a stored voice
//        id with the Flash v2.5 model, as an mp3 for Listen or raw 24 kHz PCM
//        for Phase 3's voice player.
// Who:   listenHandler through the TtsProvider interface. Nothing else imports
//        the HTTP details.
// When:  only after the handler has checked the kill switch, the cooldowns and
//        the spend reservation. This module does not meter; it renders.
// Where: the ONLY endpoint this bot calls is text to speech. It never creates a
//        voice and never lists voices: the owner made the clone by hand and the
//        bot holds its id only.
// How:   ① refuse before any call when the text is empty or over the cap, or no
//        key is set; ② POST /v1/text-to-speech/{voice_id}?output_format=… with
//        the xi-api-key header and a JSON body of text and model_id; ③ retry at
//        most once, and only on a 5xx; ④ map every other failure to a typed
//        TtsError. One AbortSignal covers the whole call INCLUDING the retry, so
//        the member waits at most the timeout, not twice it.
//
// ⚠️ Nothing here logs. The text being spoken and the key never reach a log line,
// and a TtsError message carries the kind and an HTTP status only.

const TTS_PATH = "/v1/text-to-speech/";
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR_MIN = 500;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ElevenLabsTtsOptions {
	apiKey: string;
	fetchImpl?: FetchLike;
	timeoutMs?: number;
	baseUrl?: string;
	modelId?: string;
}

/**
 * The failure kind for an ElevenLabs HTTP status that is not ok. Shared with
 * elevenLabsStt, so both directions of speech map a status the same way.
 */
export function failureKindForStatus(status: number): TtsErrorKind {
	if (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN) return "auth";
	if (status === HTTP_TOO_MANY_REQUESTS) return "rateLimit";
	if (status >= HTTP_SERVER_ERROR_MIN) return "providerDown";
	return "rejected";
}

/**
 * The failure kind for something fetch (or a body read) threw. AbortSignal.timeout
 * rejects with a DOMException named TimeoutError; anything else is a network
 * failure. Shared with elevenLabsStt.
 */
export function failureKindForThrown(error: unknown): TtsErrorKind {
	const name = (error as { name?: string } | null)?.name;
	if (name === "TimeoutError" || name === "AbortError") return "timeout";
	return "providerDown";
}

function statusToError(status: number): TtsError {
	return new TtsError(failureKindForStatus(status), status);
}

function thrownToError(error: unknown): TtsError {
	return new TtsError(failureKindForThrown(error));
}

export function createElevenLabsTts(options: ElevenLabsTtsOptions): TtsProvider {
	const fetchImpl: FetchLike = options.fetchImpl ?? fetch;
	const timeoutMs = options.timeoutMs ?? BOT_CONSTANTS.DERO_VOICE_TTS_TIMEOUT_MS;
	const baseUrl = options.baseUrl ?? BOT_CONSTANTS.DERO_VOICE_ELEVENLABS_BASE_URL;
	const modelId = options.modelId ?? BOT_CONSTANTS.DERO_VOICE_TTS_MODEL_ID;

	async function send(url: string, body: string, signal: AbortSignal): Promise<Response> {
		try {
			return await fetchImpl(url, {
				method: "POST",
				headers: { "xi-api-key": options.apiKey, "Content-Type": "application/json" },
				body,
				signal,
			});
		}
		catch (error) {
			throw thrownToError(error);
		}
	}

	return {
		modelId,
		async synthesize(request: TtsRequest): Promise<TtsClip> {
			// ① refusals that cost nothing
			if (request.text.trim().length === 0 || request.text.length > BOT_CONSTANTS.DERO_VOICE_TTS_MAX_CHARS) {
				throw new TtsError("invalidInput");
			}
			if (!request.voiceId) throw new TtsError("invalidInput");
			if (!options.apiKey) throw new TtsError("auth");

			// ② the call
			const outputFormat = BOT_CONSTANTS.DERO_VOICE_OUTPUT_FORMATS[request.format];
			const url = `${baseUrl}${TTS_PATH}${encodeURIComponent(request.voiceId)}?output_format=${encodeURIComponent(outputFormat)}`;
			const body = JSON.stringify({ text: request.text, model_id: modelId });
			const signal = AbortSignal.timeout(timeoutMs);

			let response = await send(url, body, signal);
			// ③ at most DERO_VOICE_TTS_MAX_RETRIES more tries, and only for a 5xx. A
			// 4xx is this request's fault and a retry would just be billed twice.
			for (let retry = 0; retry < BOT_CONSTANTS.DERO_VOICE_TTS_MAX_RETRIES && response.status >= HTTP_SERVER_ERROR_MIN; retry++) {
				// Release the failed response's socket before reusing the connection.
				await response.body?.cancel().catch(() => undefined);
				response = await send(url, body, signal);
			}

			// ④ typed failure
			if (!response.ok) {
				await response.body?.cancel().catch(() => undefined);
				throw statusToError(response.status);
			}

			let bytes: Buffer;
			try {
				bytes = Buffer.from(await response.arrayBuffer());
			}
			catch (error) {
				throw thrownToError(error);
			}
			// A 200 with no audio is a provider fault, not a silent clip to cache.
			if (bytes.length === 0) throw new TtsError("providerDown", response.status);
			return { bytes, format: request.format };
		},
	};
}

// The process wide instance, keyed by the env value read once in config.ts.
export const elevenLabsTts: TtsProvider = createElevenLabsTts({ apiKey: elevenLabsApiKey });

/** True when a key is set. /dero-config status reports this, never the key. */
export function isTtsKeyConfigured(): boolean {
	return elevenLabsApiKey.length > 0;
}
