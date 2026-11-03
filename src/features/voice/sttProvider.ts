import type { TtsErrorKind } from "./ttsProvider.js";

// ── speech to text provider contract ───────────────────────────────────────
// What:  the seam between "a member said something to Dero" and whoever turns
//        it into text. The turn loop depends on this interface, never on
//        ElevenLabs directly.
// Who:   implemented by elevenLabsStt.ts; faked in tests.
// Where: one narrow call, one utterance per call. Nothing streams: the plan
//        sends a finished utterance as one small WAV file, which keeps a
//        provider failure to exactly one lost sentence.
//
// ⚠️ PRIVACY: the WAV and the returned text belong to the caller for the length
// of one turn. A provider implementation never logs, stores or caches either.

export interface SttRequest {
	/** One utterance as a complete 16 kHz mono WAV file. */
	wav: Buffer;
	/** Its length, for the provider's own minimum and for metering. */
	durationMs: number;
}

export interface SttResult {
	text: string;
}

export interface SttProvider {
	readonly modelId: string;
	transcribe(request: SttRequest): Promise<SttResult>;
}

// The same closed list as speech out (auth, rateLimit, providerDown, timeout,
// rejected, invalidInput), because both directions talk to the same provider
// and fail the same ways. The turn loop maps every kind to one canned line.
export type SttErrorKind = TtsErrorKind;

/**
 * A typed transcription failure. The message carries the kind and an HTTP
 * status at most, NEVER the audio, the text or the API key, so it is safe to log.
 */
export class SttError extends Error {
	constructor(
		readonly kind: SttErrorKind,
		readonly status?: number
	) {
		super(status === undefined ? `stt ${kind}` : `stt ${kind} (status ${status})`);
		this.name = "SttError";
	}
}
