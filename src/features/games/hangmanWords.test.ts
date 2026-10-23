import { describe, it, expect } from "vitest";
import { validateHangmanAuthoring } from "./hangmanAuthoring.js";
import {
	HANGMAN_CATEGORIES,
	HANGMAN_ENTRIES,
	HANGMAN_WORD_BANK,
	HANGMAN_WORDS,
	isHangmanCategory,
	pickWord,
	pickWordFromCategory,
} from "./hangmanWords.js";

// ── the hangman word bank ──────────────────────────────────────────────────
// Pins the shape the owner decided (the 1.7.0 test fixes, item 12): 300 entries in
// 10 categories of exactly 30, every word a single 4 to 9 letter word, no word twice
// anywhere, and no hint that gives its own word away.

describe("the bank's shape", () => {
	it("holds 300 entries in the 10 named categories of exactly 30", () => {
		expect(HANGMAN_CATEGORIES).toEqual(["animals", "food", "places", "objects", "nature", "jobs", "sports", "music", "space", "realm"]);
		expect(Object.keys(HANGMAN_WORD_BANK).sort()).toEqual([...HANGMAN_CATEGORIES].sort());
		for (const category of HANGMAN_CATEGORIES) {
			expect(HANGMAN_WORD_BANK[category], category).toHaveLength(30);
		}
		expect(HANGMAN_ENTRIES).toHaveLength(300);
		expect(HANGMAN_WORDS).toHaveLength(300);
	});

	it("never repeats a word, inside a category or across two", () => {
		const seen = new Map<string, string>();
		for (const entry of HANGMAN_ENTRIES) {
			// Naming both shelves beats a bare count when this fails.
			expect(seen.get(entry.word), `${entry.word} is in ${entry.category} and ${seen.get(entry.word)}`).toBeUndefined();
			seen.set(entry.word, entry.category);
		}
	});

	it("holds only lowercase a to z words, 4 to 9 letters long", () => {
		// The mask shows any character it cannot hide, so anything else would leak the
		// word's shape for free.
		for (const word of HANGMAN_WORDS) {
			expect(word).toMatch(/^[a-z]{4,9}$/);
		}
	});

	it("never puts a word inside its own hint", () => {
		for (const { word, hint } of HANGMAN_ENTRIES) {
			expect(hint.length, word).toBeGreaterThan(0);
			expect(hint.toLowerCase(), `the hint for ${word}`).not.toContain(word);
		}
	});

	it("holds every entry to the bar a host's own word and hint must clear", () => {
		// The same validator the authoring modal runs: distinct letters, the denylist and
		// the hint length, so a bank word can never be one a host would be refused.
		for (const { word, hint } of HANGMAN_ENTRIES) {
			expect(validateHangmanAuthoring(word, hint), word).toEqual({ ok: true, word, hint, extraHints: [] });
		}
	});
});

describe("picking a word", () => {
	it("pickWord draws over the whole bank, hint and shelf included", () => {
		expect(pickWord(() => 0)).toEqual(HANGMAN_ENTRIES[0]);
		expect(pickWord(() => 0.9999999)).toEqual(HANGMAN_ENTRIES[HANGMAN_ENTRIES.length - 1]);
	});

	it("pickWordFromCategory stays on its own shelf at both rng boundaries", () => {
		for (const category of HANGMAN_CATEGORIES) {
			const shelf = HANGMAN_WORD_BANK[category];
			expect(pickWordFromCategory(category, () => 0)).toEqual({ ...shelf[0], category });
			expect(pickWordFromCategory(category, () => 0.9999999)).toEqual({ ...shelf[shelf.length - 1], category });
		}
	});

	it("recognises a category id and refuses anything else", () => {
		expect(isHangmanCategory("realm")).toBe(true);
		expect(isHangmanCategory("Realm")).toBe(false);
		expect(isHangmanCategory("weapons")).toBe(false);
	});
});
