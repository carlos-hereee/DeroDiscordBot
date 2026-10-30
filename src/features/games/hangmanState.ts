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

// ── the hint ladder (game rooms Phase 5) ──
// Wrong-guess counts at which the next host-authored hint is earned. Three rungs
// against three allowed extra hints, and the spacing is deliberate: 2 is early
// enough to rescue a room that opened badly, then 4 and 5 tighten as the gallows
// fills, so the last hint lands when it is nearly over rather than as a
// consolation after it is.
//
// A hint is earned on the miss that REACHES the threshold, never on a hit and
// never on a repeat, because neither of those cost the room anything.
export const HINT_REVEAL_THRESHOLDS: readonly number[] = [2, 4, 5];

export interface HangmanState {
	word: string;
	// Every letter tried this round, hits and misses alike, lowercased. A Set so
	// the repeat check is O(1) and cannot drift out of order.
	guessed: Set<string>;
	wrong: number;
	status: HangmanStatus;
	// The host's extra hints, in the order they were authored. Empty for a casual
	// round drawn from the bundled bank, which has no hints at all.
	hints: string[];
	// How many rungs of the ladder the room has climbed. Only ever incremented by
	// applyGuess, so it cannot drift from `wrong`.
	revealedHints: number;
	// The host, when a member authored this word. Null for a bank word, which is
	// what tells the handler whether anybody is barred from guessing.
	authoredBy: string | null;
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
	// `revealedHint` is present only on the miss that crossed a rung of the ladder.
	// Carried on the RESULT rather than left for the caller to derive, so the room
	// trail can post the reveal as its own move without re-deriving a threshold and
	// getting it subtly different.
	| { status: "miss"; letter: string; remaining: number; lost: boolean; revealedHint?: string };

export interface CreateHangmanOptions {
	// The host's extra hints. A bank word passes none.
	hints?: string[];
	// The host, when a member authored the word. They are barred from guessing it.
	authoredBy?: string | null;
}

export function createHangmanState(word: string, options: CreateHangmanOptions = {}): HangmanState {
	return {
		word: word.toLowerCase(),
		guessed: new Set<string>(),
		wrong: 0,
		status: "playing",
		hints: options.hints ?? [],
		revealedHints: 0,
		authoredBy: options.authoredBy ?? null,
	};
}

export function applyGuess(state: HangmanState, raw: string): HangmanGuess {
	if (state.status !== "playing") return { status: "closed" };

	// Trim then fold. A guess of "A" and a guess of " a " are the same guess, and
	// treating them as different would let a player burn the same letter twice.
	const letter = raw.trim().toLowerCase();
	// House rule: single letters only, never a guess at the whole word. The round is
	// cooperative with no turns, so a whole word guess would let the fastest typist end
	// it for everyone, and a wrong one would have to cost a miss the room did not choose.
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

	// Climb at most ONE rung per miss. `HINT_REVEAL_THRESHOLDS[revealedHints]` is the
	// next rung this room has not taken, so comparing it against the new wrong count
	// needs no search and cannot double-reveal: the counter advances with the reveal,
	// which moves the comparison to the following rung.
	//
	// Still synchronous, and it must stay that way. An await anywhere between the
	// check and the increment would let two members' misses land in the same tick and
	// both claim the same hint.
	let revealedHint: string | undefined;
	const nextRung = HINT_REVEAL_THRESHOLDS[state.revealedHints];
	if (nextRung !== undefined && state.wrong >= nextRung && state.hints.length > state.revealedHints) {
		revealedHint = state.hints[state.revealedHints];
		state.revealedHints += 1;
	}

	return { status: "miss", letter, remaining: HANGMAN_MAX_WRONG - state.wrong, lost, revealedHint };
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
	return revealedLetters(state)
		.map((letter) => (letter === null ? "\\_" : letter.toUpperCase()))
		.join(" ");
}

/**
 * The mask as data: each letter of the word that has been guessed, and null for
 * each that has not. The one rule for what a board may show, read by maskedWord
 * and by the hangman card, so the card can never draw a letter the text hides.
 * Its output is safe to hash into a card's cache key because it holds no letter
 * the room has not already seen.
 */
export function revealedLetters(state: HangmanState): Array<string | null> {
	return [...state.word].map((character) => (state.guessed.has(character) ? character : null));
}

// Misses only, in guess order, for the board's "tried and failed" line. Hits are
// already visible in the mask, so repeating them there would be noise.
export function wrongLetters(state: HangmanState): string[] {
	return [...state.guessed].filter((letter) => !state.word.includes(letter));
}

export function remainingAttempts(state: HangmanState): number {
	return HANGMAN_MAX_WRONG - state.wrong;
}
