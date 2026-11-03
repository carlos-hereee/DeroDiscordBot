import { describe, it, expect } from "vitest";
import {
	validateHangmanAuthoring,
	splitExtraHints,
	HANGMAN_WORD_MIN,
	HANGMAN_WORD_MAX,
	HANGMAN_HINT_MAX,
} from "./hangmanAuthoring.js";

const ok = (word: string, hint = "a body in the sky", extras: string[] = []) =>
	validateHangmanAuthoring(word, hint, extras);

describe("the word", () => {
	it("accepts a plain word and folds it", () => {
		const result = validateHangmanAuthoring("  PLANET  ", "a body in the sky");
		expect(result).toEqual({ ok: true, word: "planet", hint: "a body in the sky", extraHints: [] });
	});

	// Each of these is a specific reason on purpose. A single "invalid word" would
	// send a host off fixing the wrong thing, and these are exactly the four the
	// completion criteria name.
	it.each([
		["a digit", "plan3t", "wordNotLetters"],
		["a space", "ice cream", "wordNotLetters"],
		["an accent", "café", "wordNotLetters"],
		["punctuation", "well-done", "wordNotLetters"],
		["too few distinct letters", "abab", "wordTooFewDistinct"],
		["nothing at all", "   ", "wordMissing"],
	])("refuses %s with its own reason", (_label, word, reason) => {
		expect(ok(word)).toEqual({ ok: false, reason });
	});

	// Ordering matters: "ice cream" is 9 characters, so a length check running first
	// would pass it and then the host would be told the wrong thing.
	it("reports a spaced word as not-letters rather than as a length problem", () => {
		expect(ok("ice cream")).toEqual({ ok: false, reason: "wordNotLetters" });
	});

	it("enforces both ends of the length range", () => {
		expect(ok("a".repeat(HANGMAN_WORD_MIN - 1))).toEqual({ ok: false, reason: "wordTooShort" });
		expect(ok("abcdefghijklm")).toEqual({ ok: false, reason: "wordTooLong" });
		expect(ok("abcd").ok).toBe(true);
		expect(validateHangmanAuthoring("abcdefghijkl", "twelve of them").ok).toBe(true);
		expect("abcdefghijkl".length).toBe(HANGMAN_WORD_MAX);
	});

	// Not moderation, a guard rail: a PARTIALLY revealed word can read as a slur even
	// when the whole word is innocent, and the mask is on screen the entire round.
	it("screens a word containing a denied fragment", () => {
		expect(ok("nazis")).toEqual({ ok: false, reason: "wordDenied" });
	});

	// 2026-10 item 280 (owner ruling): a word only refused as itself no longer refuses the
	// ordinary words that contain it.
	it("refuses a denied whole word but lets ordinary words that contain it through", () => {
		expect(ok("rape")).toEqual({ ok: false, reason: "wordDenied" });
		expect(ok("chinks")).toEqual({ ok: false, reason: "wordDenied" });
		for (const word of ["grape", "drape", "scrape", "spice", "spicy", "auspicious"]) expect(ok(word).ok).toBe(true);
	});
});

describe("the hint", () => {
	it("is required", () => {
		expect(validateHangmanAuthoring("planet", "   ")).toEqual({ ok: false, reason: "hintMissing" });
	});

	it("is capped", () => {
		expect(validateHangmanAuthoring("planet", "x".repeat(HANGMAN_HINT_MAX + 1))).toEqual({
			ok: false,
			reason: "hintTooLong",
		});
	});

	// The host owns the hint, giveaways included, so nothing here may refuse one for
	// naming the word or a piece of it.
	it.each([
		["the word outright", "the answer is planet"],
		["the word inside a longer token", "something planetary"],
		["a prefix of the word", "make a plan"],
	])("accepts a hint carrying %s", (_label, hint) => {
		expect(validateHangmanAuthoring("planet", hint)).toEqual({ ok: true, word: "planet", hint, extraHints: [] });
	});
});

describe("the extra hints", () => {
	it("accepts up to three and drops blank lines", () => {
		const result = validateHangmanAuthoring("planet", "a body in the sky", ["far away", "   ", "very round", ""]);
		expect(result).toEqual({ ok: true, word: "planet", hint: "a body in the sky", extraHints: ["far away", "very round"] });
	});

	it("refuses a fourth", () => {
		expect(ok("planet", "a body in the sky", ["a", "b", "c", "d"])).toEqual({ ok: false, reason: "tooManyExtraHints" });
	});

	it("accepts an extra hint that names the word, like the main hint", () => {
		expect(ok("planet", "a body in the sky", ["it is a planet"])).toEqual({
			ok: true,
			word: "planet",
			hint: "a body in the sky",
			extraHints: ["it is a planet"],
		});
	});

	it("caps each one", () => {
		expect(ok("planet", "a body in the sky", ["x".repeat(HANGMAN_HINT_MAX + 1)])).toEqual({
			ok: false,
			reason: "extraHintTooLong",
		});
	});
});

describe("splitExtraHints", () => {
	// ⚠️ CRLF, NOT JUST LF. A textarea value can arrive carriage-return terminated,
	// and splitting on "\n" alone leaves a stray \r on every line, which then counts
	// toward the 100 character cap and renders as a phantom character in the hint.
	it("splits CRLF as cleanly as LF", () => {
		expect(splitExtraHints("one\r\ntwo\r\nthree")).toEqual(["one", "two", "three"]);
		expect(splitExtraHints("one\ntwo")).toEqual(["one", "two"]);
	});

	it("treats an absent paragraph field as no hints at all", () => {
		expect(splitExtraHints(null)).toEqual([]);
		expect(splitExtraHints(undefined)).toEqual([]);
		expect(splitExtraHints("")).toEqual([]);
	});
});

// ⚠️ RISK R12. Every rejection is a bare tag. A reason carrying the offending text
// would travel straight into the handler's reply, and the whole point of the word
// is that nobody but the host has seen it.
describe("no rejection ever carries the word", () => {
	it.each([
		["plan3t", "a body in the sky"],
		["ab", "a body in the sky"],
		["planet", "x".repeat(HANGMAN_HINT_MAX + 1)],
	])("keeps %s out of its own rejection", (word, hint) => {
		const result = validateHangmanAuthoring(word, hint);
		expect(result.ok).toBe(false);
		expect(JSON.stringify(result)).not.toContain(word.toLowerCase());
	});
});
