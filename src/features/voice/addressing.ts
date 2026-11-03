import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";

// ── addressing rule ────────────────────────────────────────────────────────
// What:  decide whether a transcript was meant for Dero. Only a transcript that
//        was is handed to the brain; every other one is dropped on the spot.
// Who:   turnLoop, once per transcript, before anything leaves the bot again.
// When:  after speech to text, so the rule reads words, not sound. The member
//        was already transcribed (they passed the operator gate); this rule
//        keeps their ordinary conversation away from the brain.
// Where: pure. The owner tunes it by editing DERO_VOICE_WAKE_NAMES,
//        DERO_VOICE_NAME_WITHIN_WORDS and DERO_VOICE_FOLLOW_UP_WINDOW_MS.
// How:   ① "named": one of the wake names (any case, punctuation ignored, so
//        "Dero," counts) is among the first six words; ② "followUp": the
//        utterance ended within 20 seconds of Dero finishing one of its own
//        lines in that call, which lets a member answer Dero without repeating
//        its name; ③ otherwise "notAddressed". A name further into a sentence
//        ("I told my friend about Dero yesterday") does not count: that is
//        talking ABOUT Dero, not TO it.
//
// The follow up also holds when Dero finished speaking AFTER the utterance
// ended (a negative gap): the member spoke while Dero was mid answer, which is
// the conversation the window exists for.

export type AddressingVerdict = "named" | "followUp" | "notAddressed";

export interface AddressingInput {
	transcript: string;
	/** When the member stopped speaking, epoch milliseconds. */
	utteranceEndedAt: number;
	/** When Dero last finished one of its own lines in this call, or null. */
	deroLastSpokeAt: number | null;
}

export interface AddressingRules {
	names: readonly string[];
	withinWords: number;
	followUpWindowMs: number;
}

export const DEFAULT_ADDRESSING_RULES: AddressingRules = {
	names: BOT_CONSTANTS.DERO_VOICE_WAKE_NAMES,
	withinWords: BOT_CONSTANTS.DERO_VOICE_NAME_WITHIN_WORDS,
	followUpWindowMs: BOT_CONSTANTS.DERO_VOICE_FOLLOW_UP_WINDOW_MS,
};

const WORD_SEPARATOR = /\s+/;
// Everything that is not a letter or a digit, so "Dero," and "¿Dero?" both
// read as "dero".
const NOT_A_WORD_CHARACTER = /[^\p{L}\p{N}]/gu;

function leadingWords(transcript: string, count: number): string[] {
	return transcript
		.trim()
		.split(WORD_SEPARATOR)
		.map((word) => word.replace(NOT_A_WORD_CHARACTER, "").toLowerCase())
		.filter((word) => word.length > 0)
		.slice(0, count);
}

/** Whether a transcript is for Dero, and why. */
export function addressingOf(input: AddressingInput, rules: AddressingRules = DEFAULT_ADDRESSING_RULES): AddressingVerdict {
	// ①
	const names = new Set(rules.names.map((name) => name.toLowerCase()));
	if (leadingWords(input.transcript, rules.withinWords).some((word) => names.has(word))) return "named";

	// ②
	if (input.deroLastSpokeAt !== null && input.utteranceEndedAt - input.deroLastSpokeAt <= rules.followUpWindowMs) {
		return "followUp";
	}

	// ③
	return "notAddressed";
}
