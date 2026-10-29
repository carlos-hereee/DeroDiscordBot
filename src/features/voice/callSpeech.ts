import { clipCache, clipKey } from "./clipCache.js";
import { elevenLabsTts } from "./elevenLabsTts.js";
import { estimateTtsCents } from "./pricing.js";
import { pcm24kMonoToPcm48kStereo } from "./resample.js";
import { refund, tryReserve } from "./spendMeter.js";
import { TtsError, type TtsErrorKind } from "./ttsProvider.js";

// ── call speech ────────────────────────────────────────────────────────────
// What:  turn a line of text into audio a voice call can play: rendered in the
//        guild's voice as 24 kHz PCM, metered, cached, then resampled to the
//        48 kHz stereo the speaker takes.
// Who:   joinNotice (the greeting) in this phase; the executor's `say` next.
//        It does not queue anything: the caller hands the result to the
//        session's speaker, so this module never needs the session map.
// When:  once per spoken line. A cache hit is free and never touches the meter.
// Where: the call twin of listenHandler step ⑥, minus the Listen cooldowns,
//        which belong to a member pressing a button rather than to Dero
//        speaking. It renders "pcm24k", so its clips sit under their own cache
//        keys and can never be served to Listen as an mp3, or the reverse.
// How:   ① the clip cache; ② reserve the estimate against the monthly cap;
//        ③ render, refunding the reservation if the provider fails; ④ cache the
//        24 kHz original and resample a copy for the call.
//
// ⚠️ PRIVACY: the text is never logged, stored or put in an error. The audit
// line carries the guild id, a character count and an outcome code only.

export type CallSpeechFailure = TtsErrorKind | "unexpected";

export type CallSpeechResult =
	| { status: "ok"; pcm48kStereo: Buffer; cached: boolean }
	| { status: "capReached" }
	| { status: "failed"; kind: CallSpeechFailure };

export interface CallSpeechInput {
	guildId: string;
	voiceId: string;
	text: string;
}

// Only what went wrong is logged: with Dero commentating every move, a line per rendered or
// cached clip flooded the terminal, and the spend meter already counts what speech costs.
const QUIET_OUTCOMES: ReadonlySet<string> = new Set(["rendered", "cacheHit"]);

function audit(guildId: string, chars: number, outcome: string): void {
	if (QUIET_OUTCOMES.has(outcome)) return;
	console.info(`[dero-voice] call speech guild=${guildId} chars=${chars} outcome=${outcome}`);
}

/** Render one line for a call. Never throws: every failure is a typed result. */
export async function renderCallSpeech({ guildId, voiceId, text }: CallSpeechInput): Promise<CallSpeechResult> {
	const chars = text.length;
	try {
		// ①
		const key = clipKey(voiceId, elevenLabsTts.modelId, "pcm24k", text);
		const cached = clipCache.get(key);
		if (cached) {
			audit(guildId, chars, "cacheHit");
			return { status: "ok", pcm48kStereo: pcm24kMonoToPcm48kStereo(cached.bytes), cached: true };
		}

		// ②
		const reserved = await tryReserve(guildId, estimateTtsCents(chars), { ttsChars: chars });
		if (reserved.status === "capReached") {
			audit(guildId, chars, "capReached");
			return { status: "capReached" };
		}

		// ③
		let bytes: Buffer;
		try {
			bytes = (await elevenLabsTts.synthesize({ voiceId, text, format: "pcm24k" })).bytes;
		}
		catch (error) {
			await refund(reserved.reservation);
			const kind = error instanceof TtsError ? error.kind : "unexpected";
			audit(guildId, chars, `failed:${kind}`);
			return { status: "failed", kind };
		}

		// ④ Resample BEFORE caching: a provider body with half a sample is
		// rejected here, and a broken clip must never be cached for a replay. The
		// provider has already billed it, so the reservation is not refunded.
		const pcm48kStereo = pcm24kMonoToPcm48kStereo(bytes);
		clipCache.set(key, { bytes, format: "pcm24k" });
		audit(guildId, chars, "rendered");
		return { status: "ok", pcm48kStereo, cached: false };
	}
	catch (error) {
		// A store failure or a malformed provider body. The error comes from Mongo
		// or the resampler and holds no spoken text.
		console.error(`[dero-voice] call speech failed guild=${guildId} chars=${chars}`, error);
		audit(guildId, chars, "failed:unexpected");
		return { status: "failed", kind: "unexpected" };
	}
}
