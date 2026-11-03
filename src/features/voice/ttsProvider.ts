// ── text to speech provider contract ───────────────────────────────────────
// What:  the seam between "Dero wants to say this" and whoever renders it. The
//        Listen handler (and Phase 3's voice speaker) depend on this interface,
//        never on ElevenLabs directly.
// Who:   implemented by elevenLabsTts.ts; faked in tests.
// Where: one narrow call so the provider can change without touching the
//        handler, the cache or the spend meter.
//
// Two output formats, named for what they are rather than for a provider's
// wire string: "mp3" is a file a member can play from a Discord attachment;
// "pcm24k" is raw 16 bit mono PCM at 24 kHz, which Phase 3 resamples and feeds
// to the voice player so no ffmpeg is needed.

export type TtsFormat = "mp3" | "pcm24k";

export interface TtsRequest {
	voiceId: string;
	text: string;
	format: TtsFormat;
}

export interface TtsClip {
	bytes: Buffer;
	format: TtsFormat;
}

export interface TtsProvider {
	// The model id is part of the clip cache key: the same text in the same voice
	// renders differently on a different model.
	readonly modelId: string;
	synthesize(request: TtsRequest): Promise<TtsClip>;
}

// Every way a render can fail, as a closed list the caller can switch on. The
// handler maps each to one member visible line and one log outcome code.
//   auth          the key is missing, wrong or revoked (401, 403, or no key set)
//   rateLimit     the account's concurrency or rate limit was hit (429)
//   providerDown  the provider failed (5xx, after the one retry)
//   timeout       no answer inside the timeout
//   rejected      the provider refused this request (other 4xx, e.g. an
//                 unknown voice id), so retrying the same request cannot help
//   invalidInput  refused BEFORE any call (empty text, or over the length cap)
export type TtsErrorKind = "auth" | "rateLimit" | "providerDown" | "timeout" | "rejected" | "invalidInput";

/**
 * A typed render failure. The message carries the kind and an HTTP status at
 * most, NEVER the text being spoken or the API key, so it is safe to log.
 */
export class TtsError extends Error {
	constructor(
		readonly kind: TtsErrorKind,
		readonly status?: number
	) {
		super(status === undefined ? `tts ${kind}` : `tts ${kind} (status ${status})`);
		this.name = "TtsError";
	}
}
