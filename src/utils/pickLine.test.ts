import { describe, it, expect } from "vitest";
import { pickLine } from "./pickLine.js";
import { deroBrainCopy } from "@features/dero-brain/deroBrainCopy.js";
import { gameRoomsCopy } from "@features/game-rooms/gameRoomsCopy.js";
import { economyCopy } from "@features/economy/economyCopy.js";

// ── Dero's variant lines ──────────────────────────────────────────────────
// Every moment Dero says several ways is a list pickLine chooses from. The pick must stay
// inside the list at both ends of the random range, and every room line that pings must
// still lead with the member it pings, whichever variant comes up.
describe("pickLine", () => {
	it("picks the first line at 0 and the last just under 1, never past the list", () => {
		const lines = ["a", "b", "c"] as const;
		expect(pickLine(lines, () => 0)).toBe("a");
		expect(pickLine(lines, () => 0.999)).toBe("c");
	});

	it("refuses an empty list loudly, since every list is a literal in a copy file", () => {
		expect(() => pickLine([], () => 0)).toThrow(/empty/);
	});
});

describe("the variant lists", () => {
	it("gives every announcement and quip at least two ways to say it", () => {
		const dealer = deroBrainCopy.dealer;
		for (const list of [dealer.challengers, dealer.challengersAsking, dealer.countdown, dealer.turnWarning, dealer.turnOver, dealer.toAct, economyCopy.market.boughtQuips, economyCopy.market.soldQuips]) {
			expect(list.length).toBeGreaterThanOrEqual(2);
		}
	});

	it("leads every turn line and warning with the member it pings", () => {
		for (const line of gameRoomsCopy.turnPrompt.line) expect(line("u-1").startsWith("<@u-1>")).toBe(true);
		for (const line of gameRoomsCopy.turnClock.warningLine) expect(line("u-1", 10)).toMatch(/^⏰ <@u-1> /);
	});

	it("keeps the countdown and the warning naming their seconds in every variant", () => {
		for (const line of deroBrainCopy.dealer.countdown) expect(line(10)).toContain("10");
		for (const line of deroBrainCopy.dealer.turnWarning) expect(line("Alice", 10)).toMatch(/Alice.*10|10.*Alice/);
		for (const line of gameRoomsCopy.turnClock.warningLine) expect(line("u-1", 10)).toContain("10");
	});
});
