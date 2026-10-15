// ── voice provider pricing ─────────────────────────────────────────────────
// What:  the provider unit prices the spend meter estimates from, and the one
//        function that turns a text length into a whole cent estimate.
// Who:   spendMeter (reserve before a call) via listenHandler. Phase 3 reads the
//        speech to text price from here too.
// When:  per Listen render. A cache hit never prices anything.
// Where: an ESTIMATE that runs before the call, deliberately rounded up, so the
//        monthly cap errs toward refusing early rather than overspending.
// How:   prices are kept in the provider's own unit and converted to millicents
//        (thousandths of a cent) once, so the per call math is integer until the
//        final division and a price like 0.045 cannot drift through floats.
//
// Checked on 2026-10-14 at https://elevenlabs.io/pricing/api (no date shown on
// the page). The page bills text to speech PER 1,000 CHARACTERS, not per minute:
// Flash and Turbo at 0.04 dollars per 1K characters, which the same page equates
// to about one minute of audio per 1K characters. Scribe v2 Realtime is 0.39
// dollars per hour. These move; re-check them before trusting a month's estimate.

export const PRICING_CHECKED_ON = "2026-10-14";
export const PRICING_SOURCE_URL = "https://elevenlabs.io/pricing/api";

// Text to speech, Flash v2.5 (listed as "Flash / Turbo"), dollars per 1K characters.
export const FLASH_TTS_USD_PER_1K_CHARS = 0.04;
// Speech to text, Scribe v2 Realtime, dollars per hour of audio. Recorded now,
// first read in Phase 3.
export const SCRIBE_V2_REALTIME_USD_PER_HOUR = 0.39;

const CHARS_PER_PRICE_UNIT = 1000;
const CENTS_PER_USD = 100;
const MILLICENTS_PER_CENT = 1000;
const MILLICENTS_PER_USD = CENTS_PER_USD * MILLICENTS_PER_CENT;
const CENT_DECIMALS = 2;

// Math.round absorbs float noise in the conversion (0.04 * 100000 is not exactly
// 4000 in binary floating point); nothing finer than a millicent is priced.
const FLASH_TTS_MILLICENTS_PER_1K_CHARS = Math.round(FLASH_TTS_USD_PER_1K_CHARS * MILLICENTS_PER_USD);

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

/** Whole cents as a dollar string for admin copy, "12.34". */
export function formatUsd(cents: number): string {
	return (cents / CENTS_PER_USD).toFixed(CENT_DECIMALS);
}

/** A whole dollar cap as cents, the unit the meter compares in. */
export function usdToCents(usd: number): number {
	return Math.round(usd * CENTS_PER_USD);
}
