import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { HoldemTerms } from "@features/games/holdemTable.js";
import { deroBrainCopy } from "./deroBrainCopy.js";

// ── holdemTerms ───────────────────────────────────────────────────────────
// What:  the rules a hold em table Dero opens will run on: the standard ones, or
//        the host's own (seats, starting stack, big blind), checked against the
//        bounds before any card shows them.
// Who:   the executor (an open_holdem from the brain) and the rules card's Change
//        rules modal. Both go through resolveTerms, so a term typed into the modal
//        and a term the brain heard are held to the same bounds.
// When:  once per request, and once per Change rules submit.
// Where: pure. The parser already refuses an out of range term from the brain;
//        this is the single place the full set is merged and re-checked, because
//        the modal never passes through the parser.
// How:   ① every missing term takes its standard value; ② seats, stack and big
//        blind are checked in that order, so the first refusal names the term the
//        host should fix; ③ the small blind is half the big blind, rounded down,
//        never below 1.
//
// The big blind is measured against the RESOLVED stack, so a request for a 100
// chip stack with no big blind is refused (the standard 20 is more than a tenth
// of 100) rather than quietly given a blind nobody asked for.

/** What a request may name. Every field is optional; absent means standard. */
export interface HoldemTermsRequest {
	maxSeats?: number;
	startingStack?: number;
	bigBlind?: number;
}

export type TermsRefusal =
	| "not_a_whole_number"
	| "seats_out_of_range"
	| "stack_out_of_range"
	| "big_blind_too_small"
	| "big_blind_too_large";

export type ResolveTermsResult = { ok: true; terms: HoldemTerms } | { ok: false; reason: TermsRefusal };

/** The table every hold em room used before terms existed, unchanged. */
export const STANDARD_HOLDEM_TERMS: Readonly<HoldemTerms> = Object.freeze({
	startingStack: BOT_CONSTANTS.HOLDEM_STARTING_STACK,
	maxSeats: BOT_CONSTANTS.HOLDEM_MAX_SEATS,
	smallBlind: BOT_CONSTANTS.HOLDEM_SMALL_BLIND,
	bigBlind: BOT_CONSTANTS.HOLDEM_BIG_BLIND,
});

const isWholeNumber = (value: number): boolean => Number.isSafeInteger(value);

const inRange = (value: number, min: number, max: number): boolean => value >= min && value <= max;

/** The most a big blind may be for a stack: a tenth, so the blinds never decide a hand on their own. */
export const maxBigBlindFor = (startingStack: number): number =>
	Math.floor(startingStack / BOT_CONSTANTS.HOLDEM_TERMS_STACK_TO_BIG_BLIND);

/** Merge the requested terms over the standard ones and check them, or say which term is wrong. */
export function resolveTerms(request: HoldemTermsRequest): ResolveTermsResult {
	// ①
	const maxSeats = request.maxSeats ?? STANDARD_HOLDEM_TERMS.maxSeats;
	const startingStack = request.startingStack ?? STANDARD_HOLDEM_TERMS.startingStack;
	const bigBlind = request.bigBlind ?? STANDARD_HOLDEM_TERMS.bigBlind;
	if (![maxSeats, startingStack, bigBlind].every(isWholeNumber)) return { ok: false, reason: "not_a_whole_number" };

	// ②
	if (!inRange(maxSeats, BOT_CONSTANTS.HOLDEM_MIN_SEATS, BOT_CONSTANTS.HOLDEM_MAX_SEATS)) {
		return { ok: false, reason: "seats_out_of_range" };
	}
	if (!inRange(startingStack, BOT_CONSTANTS.HOLDEM_TERMS_MIN_STACK, BOT_CONSTANTS.HOLDEM_TERMS_MAX_STACK)) {
		return { ok: false, reason: "stack_out_of_range" };
	}
	if (bigBlind < BOT_CONSTANTS.HOLDEM_TERMS_MIN_BIG_BLIND) return { ok: false, reason: "big_blind_too_small" };
	if (bigBlind > maxBigBlindFor(startingStack)) return { ok: false, reason: "big_blind_too_large" };

	// ③ the minimum big blind is 2, so this floor of 1 is a guard, not a live path
	const smallBlind = Math.max(1, Math.floor(bigBlind / 2));
	return { ok: true, terms: { maxSeats, startingStack, smallBlind, bigBlind } };
}

/** True when these are exactly the standard rules, so the card can say "standard" rather than list them. */
export function isStandardTerms(terms: HoldemTerms): boolean {
	return (
		terms.maxSeats === STANDARD_HOLDEM_TERMS.maxSeats &&
		terms.startingStack === STANDARD_HOLDEM_TERMS.startingStack &&
		terms.smallBlind === STANDARD_HOLDEM_TERMS.smallBlind &&
		terms.bigBlind === STANDARD_HOLDEM_TERMS.bigBlind
	);
}

/** One plain sentence for the card and for speech, always naming the doubling blinds. */
export function describeTerms(terms: HoldemTerms): string {
	const sentence = isStandardTerms(terms) ? deroBrainCopy.holdem.standardRules : deroBrainCopy.holdem.customRules;
	return sentence(terms, BOT_CONSTANTS.HOLDEM_BLIND_ESCALATION_HANDS);
}

/** The line a member reads when a term is out of bounds, naming the bound. */
export function describeTermsRefusal(reason: TermsRefusal): string {
	return deroBrainCopy.holdem.termsRefused[reason]({
		minSeats: BOT_CONSTANTS.HOLDEM_MIN_SEATS,
		maxSeats: BOT_CONSTANTS.HOLDEM_MAX_SEATS,
		minStack: BOT_CONSTANTS.HOLDEM_TERMS_MIN_STACK,
		maxStack: BOT_CONSTANTS.HOLDEM_TERMS_MAX_STACK,
		minBigBlind: BOT_CONSTANTS.HOLDEM_TERMS_MIN_BIG_BLIND,
		stackToBigBlind: BOT_CONSTANTS.HOLDEM_TERMS_STACK_TO_BIG_BLIND,
	});
}
