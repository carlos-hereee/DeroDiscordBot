// ── hangmanAuthoring ───────────────────────────────────────────────────────
// What:  validates a host-authored hangman word, its required hint, and its
//        optional extra hints, and hands back either a clean triple or ONE
//        specific reason it was refused.
// Who:   the `gameroomModal:word:<roomId>` submit handler, and nothing else.
// When:  once per hosted room, before the round exists.
// Where: PURE. No Discord, no store, no I/O, which is what lets every refusal
//        below be a unit test rather than something you discover by typing an
//        accented word into a modal in a real guild.
// How:   normalise first, then check in the order a host would hit the problems,
//        and return a discriminated union so the handler renders one message per
//        reason and cannot accidentally show a generic "invalid word".
//
// ⚠️ THE WORD NEVER LEAVES THIS MODULE IN AN ERROR. Every rejection reason below
// is a bare tag, never the offending text, because the handler echoes the reason
// back into the channel-adjacent ephemeral reply and a reason carrying the word
// would defeat the entire point of a hidden word (risk R12).

// The mask leaks structure if a word carries anything but letters: a space or a
// hyphen shows through as itself, so "ice cream" is half solved before a letter is
// played. Same rule the bundled word bank documents for itself.
const WORD_PATTERN = /^[a-z]+$/;

// 4 is the floor because below it a lucky pair of vowels solves the word. 12 is a
// deliberate widening over the bundled bank's 9: a host who wants it harder should
// be allowed to, and past 12 a six miss budget stops being a game and becomes a
// coin flip.
export const HANGMAN_WORD_MIN = 4;
export const HANGMAN_WORD_MAX = 12;

// "aaaa" and "abab" are technically words-shaped and are not games. Three distinct
// letters is the smallest count where the mask actually carries information.
export const HANGMAN_MIN_DISTINCT = 3;

export const HANGMAN_HINT_MAX = 100;
export const HANGMAN_MAX_EXTRA_HINTS = 3;

// A small screen, not a profanity filter. Kept short and obvious on purpose; this is a
// guard rail, not moderation.
//
// Two lists because one substring match refused ordinary words (2026-10 item 280, owner
// ruling): "rape" sits inside grape and drape, "spic" inside spice and spicy. A STEM is a
// slur root no ordinary word contains, so it is still refused anywhere in the word, since a
// partly revealed mask would show it. A WHOLE word is refused only as the word itself, which
// accepts that a mask such as "_rape" can show one mid round, the cost the owner chose over
// refusing innocent words.
const DENIED_STEMS: readonly string[] = ["nazi", "slut", "whore", "nigg", "fagg", "kike"];
const DENIED_WHOLE_WORDS: ReadonlySet<string> = new Set(["rape", "rapes", "raped", "rapist", "spic", "spics", "chink", "chinks"]);

const isDeniedWord = (word: string): boolean => DENIED_WHOLE_WORDS.has(word) || DENIED_STEMS.some((stem) => word.includes(stem));

export type HangmanAuthoringRejection =
	| "wordMissing"
	| "wordNotLetters"
	| "wordTooShort"
	| "wordTooLong"
	| "wordTooFewDistinct"
	| "wordDenied"
	| "hintMissing"
	| "hintTooLong"
	| "tooManyExtraHints"
	| "extraHintTooLong";

export type HangmanAuthoringResult =
	| { ok: true; word: string; hint: string; extraHints: string[] }
	| { ok: false; reason: HangmanAuthoringRejection };

// Fold a raw modal value into the form everything downstream compares against.
// Internal whitespace is COLLAPSED rather than stripped so a hint keeps its shape
// while a word with a space in it still fails WORD_PATTERN and is refused honestly
// rather than silently repaired into a different word.
function normalise(raw: string): string {
	return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

export function validateHangmanAuthoring(
	rawWord: string,
	rawHint: string,
	rawExtraHints: string[] = []
): HangmanAuthoringResult {
	const word = normalise(rawWord);

	if (!word) return { ok: false, reason: "wordMissing" };
	// Checked before length, because "ice cream" is 9 characters and reporting it as
	// the wrong length would send the host off fixing the wrong thing.
	if (!WORD_PATTERN.test(word)) return { ok: false, reason: "wordNotLetters" };
	if (word.length < HANGMAN_WORD_MIN) return { ok: false, reason: "wordTooShort" };
	if (word.length > HANGMAN_WORD_MAX) return { ok: false, reason: "wordTooLong" };
	if (new Set(word).size < HANGMAN_MIN_DISTINCT) return { ok: false, reason: "wordTooFewDistinct" };
	if (isDeniedWord(word)) return { ok: false, reason: "wordDenied" };

	const hint = rawHint.trim().replace(/\s+/g, " ");
	if (!hint) return { ok: false, reason: "hintMissing" };
	if (hint.length > HANGMAN_HINT_MAX) return { ok: false, reason: "hintTooLong" };
	// Nothing checks whether a hint gives the word away. The hint is the host's to
	// write (the owner's call in the 1.7.0 test fixes plan, item 12), and a guard that
	// second guesses it refused hints the host meant.

	// Blank lines are dropped rather than counted: a host who leaves a trailing
	// newline in the paragraph box has not written a fourth hint.
	const extraHints = rawExtraHints.map((line) => line.trim().replace(/\s+/g, " ")).filter((line) => line.length > 0);

	if (extraHints.length > HANGMAN_MAX_EXTRA_HINTS) return { ok: false, reason: "tooManyExtraHints" };
	for (const extra of extraHints) {
		if (extra.length > HANGMAN_HINT_MAX) return { ok: false, reason: "extraHintTooLong" };
	}

	return { ok: true, word, hint, extraHints };
}

// Split the modal's paragraph field into candidate hints.
//
// ⚠️ SPLIT ON \r?\n, NOT \n. A multipart or browser-submitted textarea value can
// arrive CRLF-terminated, and splitting on "\n" alone leaves a trailing carriage
// return on every line, which then counts toward the 100 character cap and shows up
// as a stray character in the rendered hint.
export function splitExtraHints(raw: string | null | undefined): string[] {
	if (!raw) return [];
	return raw.split(/\r?\n/);
}
