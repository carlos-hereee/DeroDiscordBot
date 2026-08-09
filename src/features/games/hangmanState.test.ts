import { describe, it, expect } from "vitest";
import {
	createHangmanState,
	applyGuess,
	isSolved,
	maskedWord,
	wrongLetters,
	remainingAttempts,
	HANGMAN_MAX_WRONG,
} from "./hangmanState.js";
import { HANGMAN_WORDS, pickWord } from "./hangmanWords.js";

describe("applyGuess, the ordinary path", () => {
	it("accepts a correct letter without costing an attempt", () => {
		const state = createHangmanState("castle");
		expect(applyGuess(state, "c")).toEqual({ status: "hit", letter: "c", solved: false });
		expect(remainingAttempts(state)).toBe(HANGMAN_MAX_WRONG);
	});

	it("charges an attempt for a wrong letter", () => {
		const state = createHangmanState("castle");
		expect(applyGuess(state, "z")).toEqual({ status: "miss", letter: "z", remaining: 5, lost: false });
		expect(remainingAttempts(state)).toBe(5);
	});

	it("wins when the last distinct letter lands", () => {
		const state = createHangmanState("ember");
		for (const letter of ["e", "m", "b"]) applyGuess(state, letter);
		expect(applyGuess(state, "r")).toEqual({ status: "hit", letter: "r", solved: true });
		expect(state.status).toBe("won");
	});

	it("counts a repeated letter in the word only once toward solving", () => {
		// "ember" has one e at each end. Guessing e must reveal BOTH, or a word
		// with a doubled letter could never be solved.
		const state = createHangmanState("ember");
		applyGuess(state, "e");
		expect(maskedWord(state)).toBe("E \\_ \\_ E \\_");
	});

	it("loses on the sixth miss, not the fifth", () => {
		const state = createHangmanState("castle");
		const misses = ["z", "q", "x", "j", "v"];
		for (const letter of misses) {
			expect(applyGuess(state, letter)).toMatchObject({ status: "miss", lost: false });
		}
		expect(applyGuess(state, "w")).toEqual({ status: "miss", letter: "w", remaining: 0, lost: true });
		expect(state.status).toBe("lost");
	});
});

describe("applyGuess, the things that must NOT cost an attempt", () => {
	it("folds case, so A and a are the same guess", () => {
		const state = createHangmanState("castle");
		expect(applyGuess(state, "C")).toMatchObject({ status: "hit" });
		expect(applyGuess(state, "c")).toEqual({ status: "repeat", letter: "c" });
		expect(remainingAttempts(state)).toBe(HANGMAN_MAX_WRONG);
	});

	it("treats a repeated MISS as a repeat rather than a second charge", () => {
		// The nastier half of the repeat rule: a player double clicking a wrong
		// letter must not be knocked out twice for one mistake.
		const state = createHangmanState("castle");
		applyGuess(state, "z");
		expect(applyGuess(state, "z")).toEqual({ status: "repeat", letter: "z" });
		expect(remainingAttempts(state)).toBe(5);
	});

	it("rejects anything that is not a single letter, free of charge", () => {
		// setMaxLength(1) stops LENGTH but not CONTENT, so a digit or a symbol
		// still reaches this function and must not spend an attempt.
		const state = createHangmanState("castle");
		for (const bad of ["", " ", "1", "!", "ab", "é", "\n"]) {
			expect(applyGuess(state, bad)).toEqual({ status: "invalid" });
		}
		expect(remainingAttempts(state)).toBe(HANGMAN_MAX_WRONG);
		expect(state.guessed.size).toBe(0);
	});

	it("trims surrounding whitespace rather than calling it invalid", () => {
		const state = createHangmanState("castle");
		expect(applyGuess(state, "  a  ")).toMatchObject({ status: "hit", letter: "a" });
	});
});

describe("applyGuess, a finished round", () => {
	it("refuses further guesses after a win", () => {
		const state = createHangmanState("ab");
		applyGuess(state, "a");
		applyGuess(state, "b");
		expect(state.status).toBe("won");
		expect(applyGuess(state, "c")).toEqual({ status: "closed" });
	});

	it("refuses further guesses after a loss, and cannot go below zero attempts", () => {
		const state = createHangmanState("castle");
		for (const letter of ["z", "q", "x", "j", "v", "w"]) applyGuess(state, letter);
		expect(applyGuess(state, "y")).toEqual({ status: "closed" });
		expect(remainingAttempts(state)).toBe(0);
	});

	it("does not record a guess that arrived after the round closed", () => {
		// The public board means several members can submit in the same tick. The
		// synchronous status check is what stops a late one mutating a dead round.
		const state = createHangmanState("ab");
		applyGuess(state, "a");
		applyGuess(state, "b");
		const before = state.guessed.size;
		applyGuess(state, "z");
		expect(state.guessed.size).toBe(before);
	});
});

describe("board rendering", () => {
	it("masks every unguessed letter and reveals the rest", () => {
		const state = createHangmanState("castle");
		expect(maskedWord(state)).toBe("\\_ \\_ \\_ \\_ \\_ \\_");
		applyGuess(state, "a");
		applyGuess(state, "e");
		expect(maskedWord(state)).toBe("\\_ A \\_ \\_ \\_ E");
	});

	it("lists misses only, since hits are already visible in the mask", () => {
		const state = createHangmanState("castle");
		applyGuess(state, "a");
		applyGuess(state, "z");
		applyGuess(state, "q");
		expect(wrongLetters(state)).toEqual(["z", "q"]);
	});

	it("reports solved only when every distinct letter is in", () => {
		const state = createHangmanState("ember");
		expect(isSolved(state)).toBe(false);
		for (const letter of ["e", "m", "b", "r"]) applyGuess(state, letter);
		expect(isSolved(state)).toBe(true);
	});
});

describe("the word bank", () => {
	it("ships enough words that a channel will not see a repeat all evening", () => {
		expect(HANGMAN_WORDS.length).toBeGreaterThanOrEqual(100);
	});

	it("holds no duplicates", () => {
		expect(new Set(HANGMAN_WORDS).size).toBe(HANGMAN_WORDS.length);
	});

	it("holds only lowercase letters, 4 to 9 long", () => {
		// The mask reveals any character it cannot hide, so punctuation, spaces and
		// accents would leak the word's shape for free. Length keeps a 6 miss
		// budget meaningful at both ends.
		for (const word of HANGMAN_WORDS) {
			expect(word).toMatch(/^[a-z]{4,9}$/);
		}
	});

	it("is solvable by every word, given the whole alphabet", () => {
		for (const word of HANGMAN_WORDS) {
			const state = createHangmanState(word);
			for (const letter of new Set(word)) applyGuess(state, letter);
			expect(state.status).toBe("won");
		}
	});

	it("picks inside the bank at both rng boundaries", () => {
		expect(pickWord(() => 0)).toBe(HANGMAN_WORDS[0]);
		expect(pickWord(() => 0.9999999)).toBe(HANGMAN_WORDS[HANGMAN_WORDS.length - 1]);
	});
});
