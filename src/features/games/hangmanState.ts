// ── hangmanState ───────────────────────────────────────────────────────────
// The round's rules, kept PURE and separate from hangmanHandler's Discord work,
// the same split rollFortune.ts / respondWithFortune.ts and rpsRound.ts /
// rpsHandler.ts already draw. Everything a guess can do to a round is decided
// here, so the fiddly parts (case folding, what does and does not cost an
// attempt, when a round is won) are testable without a single Discord mock.
//
// ⚠️ applyGuess is SYNCHRONOUS by contract, for the same reason rpsRound's
// applyPick is: the board is public and several members can submit a letter in
// the same tick. An uninterrupted check-then-write is what keeps two
// simultaneous guesses from both spending the last attempt. Do not make it async.

// Six misses, which is the classic gallows: head, body, two arms, two legs. The
// art manifest declares exactly seven frames (stage 0 through stage 6) against
// this number, so changing it means drawing more gallows.
export const HANGMAN_MAX_WRONG = 6;

export type HangmanStatus = "playing" | "won" | "lost";

export interface HangmanState {
	word: string;
	// Every letter tried this round, hits and misses alike, lowercased. A Set so
	// the repeat check is O(1) and cannot drift out of order.
	guessed: Set<string>;
	wrong: number;
	status: HangmanStatus;
}

export type HangmanGuess =
	// Not a single alphabetic character. Costs nothing: Discord's setMaxLength(1)
	// stops length but not content, so a digit or a symbol still arrives here.
	| { status: "invalid" }
	// Already tried this round. Costs nothing, or a player could be knocked out by
	// their own double click.
	| { status: "repeat"; letter: string }
	// The round already ended. A late submit gets told rather than silently doing
	// nothing.
	| { status: "closed" }
	| { status: "hit"; letter: string; solved: boolean }
	| { status: "miss"; letter: string; remaining: number; lost: boolean };

export function createHangmanState(word: string): HangmanState {
	return { word: word.toLowerCase(), guessed: new Set<string>(), wrong: 0, status: "playing" };
}

export function applyGuess(state: HangmanState, raw: string): HangmanGuess {
	if (state.status !== "playing") return { status: "closed" };

	// Trim then fold. A guess of "A" and a guess of " a " are the same guess, and
	// treating them as different would let a player burn the same letter twice.
	const letter = raw.trim().toLowerCase();
	if (letter.length !== 1 || letter < "a" || letter > "z") return { status: "invalid" };

	if (state.guessed.has(letter)) return { status: "repeat", letter };

	// From here the guess is genuinely new, so it counts. Recorded BEFORE the hit
	// test so a hit and a miss are equally un-repeatable.
	state.guessed.add(letter);

	if (state.word.includes(letter)) {
		const solved = isSolved(state);
		if (solved) state.status = "won";
		return { status: "hit", letter, solved };
	}

	state.wrong += 1;
	const lost = state.wrong >= HANGMAN_MAX_WRONG;
	if (lost) state.status = "lost";
	return { status: "miss", letter, remaining: HANGMAN_MAX_WRONG - state.wrong, lost };
}

// Every distinct letter of the word has been guessed. Derived rather than
// tracked, so it cannot fall out of sync with `guessed`.
export function isSolved(state: HangmanState): boolean {
	for (const character of state.word) {
		if (!state.guessed.has(character)) return false;
	}
	return true;
}

// The board's headline. Unrevealed letters become an underscore, and every
// character is space separated so a run of blanks is countable at a glance
// rather than an unreadable smear.
export function maskedWord(state: HangmanState): string {
	return [...state.word].map((character) => (state.guessed.has(character) ? character.toUpperCase() : "\\_")).join(" ");
}

// Misses only, in guess order, for the board's "tried and failed" line. Hits are
// already visible in the mask, so repeating them there would be noise.
export function wrongLetters(state: HangmanState): string[] {
	return [...state.guessed].filter((letter) => !state.word.includes(letter));
}

export function remainingAttempts(state: HangmanState): number {
	return HANGMAN_MAX_WRONG - state.wrong;
}
