import { describe, expect, it } from "vitest";
import { clipText, fitLines } from "./clipText.js";

// clipText and fitLines (2026-11 item 420, L13): text cut to a length with a mark that it was
// cut, never through an emoji, and a whole list sharing one message's room.

describe("clipText", () => {
	it("keeps text that fits and marks text that was cut", () => {
		expect(clipText("sword", 5)).toBe("sword");
		expect(clipText("swords", 5)).toBe("swor\u2026");
		expect(clipText("swords", 0)).toBe("");
	});

	it("never cuts an emoji in half", () => {
		const cut = clipText("ab\u{1F409}cd", 4);
		expect(cut).toBe("ab\u2026");
	});
});

describe("fitLines", () => {
	const draw = (text: string, index: number): string => `${index}:${text}`;

	it("keeps short lines whole and clips only the long ones", () => {
		expect(fitLines(["ab", "cd"], draw, 100)).toEqual(["0:ab", "1:cd"]);
		expect(fitLines(["ab", "x".repeat(50)], draw, 25)).toEqual(["0:ab", `1:${"x".repeat(9)}\u2026`]);
	});

	it("draws every line inside the room, newlines counted", () => {
		const lines = fitLines(Array.from({ length: 25 }, () => "x".repeat(300)), draw, 4096);
		expect(lines).toHaveLength(25);
		expect(lines.join("\n").length).toBeLessThanOrEqual(4096);
	});

	it("draws nothing from an empty list", () => {
		expect(fitLines([], draw, 10)).toEqual([]);
	});
});
