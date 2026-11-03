import { describe, it, expect, vi, afterEach } from "vitest";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { addressingOf } from "./addressing.js";

// ── addressing rule ────────────────────────────────────────────────────────
// A transcript reaches the brain only when it names Dero in its first six words
// or follows Dero's own line by at most 20 seconds. Everything else is dropped,
// including a sentence that merely mentions Dero further in.

const NEVER_SPOKE = null;

function verdict(transcript: string, deroLastSpokeAt: number | null = NEVER_SPOKE, utteranceEndedAt = Date.now()) {
	return addressingOf({ transcript, utteranceEndedAt, deroLastSpokeAt });
}

afterEach(() => {
	vi.useRealTimers();
});

describe("addressing by name", () => {
	it("accepts the owner's Gate B sentence", () => {
		expect(verdict("Dero, send hello world with an emoji in general")).toBe("named");
	});

	it.each(["dero", "Derro", "DIRO"])("accepts the spelling %s in any case", (name) => {
		expect(verdict(`hey ${name} post hello world`)).toBe("named");
	});

	it("ignores punctuation around the name", () => {
		expect(verdict("Okay... Dero? Can you post hello?")).toBe("named");
	});

	it("accepts the name as the sixth word and refuses it as the seventh", () => {
		expect(verdict("one two three four five dero post it")).toBe("named");
		expect(verdict("one two three four five six dero post it")).toBe("notAddressed");
	});

	it("drops a sentence that mentions Dero in the middle of a long sentence", () => {
		expect(verdict("I was telling my friend yesterday that Dero can post messages for us")).toBe("notAddressed");
	});

	it("does not count a longer word that starts with the name", () => {
		expect(verdict("derogatory comments are not allowed here")).toBe("notAddressed");
	});

	it("drops ordinary conversation", () => {
		expect(verdict("did you see the game last night")).toBe("notAddressed");
	});

	it("keeps the name list and the window in BOT_CONSTANTS", () => {
		expect(BOT_CONSTANTS.DERO_VOICE_WAKE_NAMES).toEqual(["dero", "derro", "diro"]);
		expect(BOT_CONSTANTS.DERO_VOICE_NAME_WITHIN_WORDS).toBe(6);
		expect(BOT_CONSTANTS.DERO_VOICE_FOLLOW_UP_WINDOW_MS).toBe(20_000);
	});
});

describe("the 20 second follow up window", () => {
	it("accepts an unnamed answer up to exactly 20 seconds after Dero finished, and not one millisecond later", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
		const deroFinished = Date.now();

		vi.advanceTimersByTime(20_000);
		expect(verdict("yes post it there", deroFinished, Date.now())).toBe("followUp");

		vi.advanceTimersByTime(1);
		expect(verdict("yes post it there", deroFinished, Date.now())).toBe("notAddressed");
	});

	it("accepts a member who spoke while Dero was still mid answer", () => {
		const utteranceEndedAt = 1_000_000;
		expect(verdict("no wait, the other channel", utteranceEndedAt + 3_000, utteranceEndedAt)).toBe("followUp");
	});

	it("needs Dero to have spoken at all in this call", () => {
		expect(verdict("yes post it there", NEVER_SPOKE)).toBe("notAddressed");
	});

	it("prefers the name when both hold", () => {
		expect(verdict("Dero do it again", Date.now())).toBe("named");
	});
});
