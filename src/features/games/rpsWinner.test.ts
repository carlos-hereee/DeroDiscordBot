import { describe, it, expect } from "vitest";
import { scoreRps, RPS_CHOICES, type RpsChoice } from "./rpsWinner.js";

describe("scoreRps, all nine combinations", () => {
	// The full truth table written out longhand rather than generated, so a
	// change to the rules has to be made here deliberately and cannot be
	// rationalized away by a clever loop that shares the bug.
	it.each([
		["rock", "rock", "tie"],
		["rock", "paper", "opponent"],
		["rock", "scissors", "challenger"],
		["paper", "rock", "challenger"],
		["paper", "paper", "tie"],
		["paper", "scissors", "opponent"],
		["scissors", "rock", "opponent"],
		["scissors", "paper", "challenger"],
		["scissors", "scissors", "tie"],
	] as const)("challenger %s vs opponent %s is %s", (challenger, opponent, expected) => {
		expect(scoreRps(challenger, opponent)).toBe(expected);
	});
});

describe("scoreRps fairness properties", () => {
	it("is antisymmetric, swapping the players swaps the winner", () => {
		// The property that matters most: going first must never be an advantage.
		for (const a of RPS_CHOICES) {
			for (const b of RPS_CHOICES) {
				const forward = scoreRps(a, b);
				const reversed = scoreRps(b, a);
				if (a === b) {
					expect(forward).toBe("tie");
					expect(reversed).toBe("tie");
				} else {
					expect(forward).not.toBe("tie");
					expect(reversed).not.toBe("tie");
					expect(forward).not.toBe(reversed);
				}
			}
		}
	});

	it("gives every choice exactly one win and one loss, so no throw is dominant", () => {
		// A rules table with a duplicated value (say two choices both beating
		// scissors) still passes a naive spot check but makes one throw strictly
		// better. This catches that shape directly.
		for (const choice of RPS_CHOICES) {
			const others = RPS_CHOICES.filter((c) => c !== choice);
			const wins = others.filter((other) => scoreRps(choice, other) === "challenger");
			const losses = others.filter((other) => scoreRps(choice, other) === "opponent");
			expect(wins).toHaveLength(1);
			expect(losses).toHaveLength(1);
		}
	});

	it("ties only on identical choices", () => {
		for (const a of RPS_CHOICES) {
			for (const b of RPS_CHOICES) {
				expect(scoreRps(a, b) === "tie").toBe(a === b);
			}
		}
	});

	it("covers exactly three choices, so a fourth cannot be added without new rules", () => {
		expect([...RPS_CHOICES].sort()).toEqual(["paper", "rock", "scissors"] as RpsChoice[]);
	});
});
