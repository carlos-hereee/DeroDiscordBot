import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { elevenLabsApiKey } from "@utils/config.js";
import { failureKindForStatus, failureKindForThrown, type FetchLike } from "./elevenLabsTts.js";
import { SttError, type SttProvider, type SttRequest, type SttResult } from "./sttProvider.js";
import { WAV_HEADER_BYTES } from "./wavFile.js";

// ── ElevenLabs speech to text ──────────────────────────────────────────────
// What:  turn one utterance (a small WAV file) into text with ElevenLabs Scribe.
// Who:   turnLoop through the SttProvider interface, after it reserved the spend.
// When:  once per utterance from a member who passed the operator gate. This
//        module does not meter and does not decide who is heard; it transcribes.
// Where: the same provider and key as speech out. Wire details confirmed
//        against the ElevenLabs API reference on 2026-10-20: POST
//        /v1/speech-to-text as multipart/form-data, the xi-api-key header, the
//        fields model_id and file, model scribe_v2, a JSON body back whose
//        `text` is the transcript. language_code is left out, so the provider
//        detects the language.
// How:   ① refuse before any call when there is no audio, the audio is under
//        the provider's 100 ms minimum, or no key is set; ② one POST with a
//        15 second timeout; ③ NO retry of any kind: a lost sentence is cheaper
//        than a member waiting twice, and the member can simply say it again;
//        ④ every failure becomes a typed SttError.
//
// tag_audio_events is sent as false so a laugh or a cough never arrives as
// "(laughter)" text that could crowd the name out of the first six words.
//
// ⚠️ Nothing here logs. The audio, the transcript and the key never reach a log
// line, and an SttError message carries the kind and an HTTP status only.

const STT_PATH = "/v1/speech-to-text";
const PROVIDER_MIN_AUDIO_MS = 100;
const UPLOAD_FILE_NAME = "utterance.wav";
const UPLOAD_MIME_TYPE = "audio/wav";

export interface ElevenLabsSttOptions {
	apiKey: string;
	fetchImpl?: FetchLike;
	timeoutMs?: number;
	baseUrl?: string;
	modelId?: string;
}

function buildForm(wav: Buffer, modelId: string): FormData {
	const form = new FormData();
	form.append("model_id", modelId);
	form.append("tag_audio_events", "false");
	form.append("file", new Blob([new Uint8Array(wav)], { type: UPLOAD_MIME_TYPE }), UPLOAD_FILE_NAME);
	return form;
}

function readTranscript(body: unknown): string | null {
	const text = (body as { text?: unknown } | null)?.text;
	return typeof text === "string" ? text : null;
}

export function createElevenLabsStt(options: ElevenLabsSttOptions): SttProvider {
	const fetchImpl: FetchLike = options.fetchImpl ?? fetch;
	const timeoutMs = options.timeoutMs ?? BOT_CONSTANTS.DERO_VOICE_STT_TIMEOUT_MS;
	const baseUrl = options.baseUrl ?? BOT_CONSTANTS.DERO_VOICE_ELEVENLABS_BASE_URL;
	const modelId = options.modelId ?? BOT_CONSTANTS.DERO_VOICE_STT_MODEL_ID;

	return {
		modelId,
		async transcribe({ wav, durationMs }: SttRequest): Promise<SttResult> {
			// ①
			if (wav.length <= WAV_HEADER_BYTES || durationMs < PROVIDER_MIN_AUDIO_MS) throw new SttError("invalidInput");
			if (!options.apiKey) throw new SttError("auth");

			// ② ③ one call, no retry
			let response: Response;
			try {
				response = await fetchImpl(`${baseUrl}${STT_PATH}`, {
					method: "POST",
					// No Content-Type: fetch writes the multipart boundary itself.
					headers: { "xi-api-key": options.apiKey },
					body: buildForm(wav, modelId),
					signal: AbortSignal.timeout(timeoutMs),
				});
			}
			catch (error) {
				throw new SttError(failureKindForThrown(error));
			}

			// ④
			if (!response.ok) {
				await response.body?.cancel().catch(() => undefined);
				throw new SttError(failureKindForStatus(response.status), response.status);
			}
			let body: unknown;
			try {
				body = await response.json();
			}
			catch (error) {
				// A 200 whose body is not JSON is a provider fault; a timeout while
				// reading it is still a timeout.
				const kind = failureKindForThrown(error);
				throw new SttError(kind === "timeout" ? "timeout" : "providerDown", response.status);
			}
			const text = readTranscript(body);
			if (text === null) throw new SttError("providerDown", response.status);
			return { text };
		},
	};
}

// The process wide instance, keyed by the env value read once in config.ts.
export const elevenLabsStt: SttProvider = createElevenLabsStt({ apiKey: elevenLabsApiKey });
