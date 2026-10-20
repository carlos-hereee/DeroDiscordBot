// ── voice provider pricing ─────────────────────────────────────────────────
// What:  the provider unit prices the spend meter estimates from, and the two
//        functions that turn a text length (speech out) or an audio length
//        (speech to text) into a whole cent estimate.
// Who:   spendMeter (reserve before a call) via listenHandler and callSpeech
//        for speech out, and via turnLoop for speech to text.
// When:  per render and per transcribed utterance. A cache hit never prices
//        anything.
// Where: an ESTIMATE that runs before the call, deliberately rounded up, so the
//        monthly cap errs toward refusing early rather than overspending.
// How:   prices are kept in the provider's own unit and converted to millicents
//        (thousandths of a cent) once, so the per call math is integer until the
//        final division and a price like 0.045 cannot drift through floats.
//
// Checked on 2026-10-14 and again on 2026-10-20 at
// https://elevenlabs.io/pricing/api (no date shown on the page). The page bills
// text to speech PER 1,000 CHARACTERS, not per minute: Flash and Turbo at 0.04
// dollars per 1K characters, which the same page equates to about one minute of
// audio per 1K characters. Speech to text is per hour of audio: Scribe v2 (the
// batch model the turn loop calls, one utterance per request) at 0.22 dollars,
// Scribe v2 Realtime (a streaming socket, not used) at 0.39 dollars. The page
// lists no per request minimum. These move; re-check them before trusting a
// month's estimate.

export const PRICING_CHECKED_ON = "2026-10-20";
export const PRICING_SOURCE_URL = "https://elevenlabs.io/pricing/api";

// Text to speech, Flash v2.5 (listed as "Flash / Turbo"), dollars per 1K characters.
export const FLASH_TTS_USD_PER_1K_CHARS = 0.04;
// Speech to text, Scribe v2 (batch), dollars per hour of audio. What an
// utterance is metered at.
export const SCRIBE_V2_USD_PER_HOUR = 0.22;
// Speech to text, Scribe v2 Realtime, dollars per hour of audio. Recorded for
// comparison only: the plan sends one utterance at a time and never streams.
export const SCRIBE_V2_REALTIME_USD_PER_HOUR = 0.39;

const CHARS_PER_PRICE_UNIT = 1000;
const CENTS_PER_USD = 100;
const MILLICENTS_PER_CENT = 1000;
const MILLICENTS_PER_USD = CENTS_PER_USD * MILLICENTS_PER_CENT;
const CENT_DECIMALS = 2;

// Math.round absorbs float noise in the conversion (0.04 * 100000 is not exactly
// 4000 in binary floating point); nothing finer than a millicent is priced.
const FLASH_TTS_MILLICENTS_PER_1K_CHARS = Math.round(FLASH_TTS_USD_PER_1K_CHARS * MILLICENTS_PER_USD);
const MS_PER_HOUR = 3_600_000;
const SCRIBE_V2_MILLICENTS_PER_HOUR = Math.round(SCRIBE_V2_USD_PER_HOUR * MILLICENTS_PER_USD);

/**
 * The estimated cost of rendering `chars` characters, in whole cents, rounded UP.
 * Any non empty text costs at least one cent, so a stream of tiny clips can
 * never meter as free. Zero or negative input costs nothing.
 */
export function estimateTtsCents(chars: number): number {
	if (!Number.isFinite(chars) || chars <= 0) return 0;
	// chars times the per 1K price is the cost in millicents scaled up by 1K, an
	// exact integer; dividing once at the end keeps the rounding in one place.
	const scaledMillicents = Math.ceil(chars) * FLASH_TTS_MILLICENTS_PER_1K_CHARS;
	return Math.max(1, Math.ceil(scaledMillicents / (CHARS_PER_PRICE_UNIT * MILLICENTS_PER_CENT)));
}

/**
 * The estimated cost of transcribing `durationMs` of audio, in whole cents,
 * rounded UP, with the same one cent floor as speech out. At 0.22 dollars an
 * hour a 20 second utterance is about 0.12 cents, so in practice every
 * transcribed utterance meters as exactly 1 cent: the floor, not the rate, is
 * what a member's speech costs the monthly cap.
 */
export function estimateSttCents(durationMs: number): number {
	if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
	const scaledMillicents = Math.ceil(durationMs) * SCRIBE_V2_MILLICENTS_PER_HOUR;
	return Math.max(1, Math.ceil(scaledMillicents / (MS_PER_HOUR * MILLICENTS_PER_CENT)));
}

/** Whole cents as a dollar string for admin copy, "12.34". */
export function formatUsd(cents: number): string {
	return (cents / CENTS_PER_USD).toFixed(CENT_DECIMALS);
}

/** A whole dollar cap as cents, the unit the meter compares in. */
export function usdToCents(usd: number): number {
	return Math.round(usd * CENTS_PER_USD);
}
