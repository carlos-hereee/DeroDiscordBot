import { describe, it, expect } from "vitest";
import { EmbedBuilder } from "discord.js";
import { TURN_LINES_BUDGET, setTurnBlock, splitTurnAt, turnBlockLines, withTurnBlock } from "./turnLog.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";

// ── turnLog ──────────────────────────────────────────────────────────
// The This turn block every game's board shares (2026-10 item 263 R3-29), moved out of
// Monopoly's board, which the owner called perfect: these cases pin that it renders exactly as
// Monopoly's always did, trims to the same budget, and is rewritten on a kept board in place.

const HEADER = `**${gameRoomsCopy.turnBoard.thisTurnLabel}**`;

describe("turnBlockLines", () => {
	it("shows nothing for a turn with no line yet", () => {
		expect(turnBlockLines([])).toEqual([]);
	});

	it("puts every line of a short turn under the header, newest last", () => {
		expect(turnBlockLines(["rolled", "bought"])).toEqual([HEADER, "rolled", "bought"]);
	});

	it("keeps the newest lines a long turn fits in the budget and counts the rest", () => {
		const line = "x".repeat(99);
		const lines = Array.from({ length: 30 }, (_, index) => `${index} ${line}`);
		const block = turnBlockLines(lines);
		const shown = block.slice(2);
		expect(block[0]).toBe(HEADER);
		expect(block[1]).toBe(gameRoomsCopy.turnBoard.earlierThisTurn(lines.length - shown.length));
		expect(shown.at(-1)).toBe(lines.at(-1));
		expect(shown.join("\n").length).toBeLessThanOrEqual(TURN_LINES_BUDGET);
	});

	it("shows a single line longer than the budget rather than an empty block", () => {
		expect(turnBlockLines(["y".repeat(TURN_LINES_BUDGET + 10)])).toHaveLength(2);
	});
});

describe("withTurnBlock and setTurnBlock", () => {
	it("appends a block to a description that has none, after one blank line", () => {
		expect(withTurnBlock("status\nseats", [HEADER, "a"])).toBe(`status\nseats\n\n${HEADER}\na`);
	});

	it("replaces an existing block and leaves everything above it as it was", () => {
		expect(withTurnBlock(`status\nseats\n\n${HEADER}\nold`, [HEADER, "old", "new"])).toBe(`status\nseats\n\n${HEADER}\nold\nnew`);
	});

	it("takes the block off when the new one is empty", () => {
		expect(withTurnBlock(`status\n\n${HEADER}\nold`, [])).toBe("status");
	});

	it("rewrites a posted embed's block without touching its title or picture", () => {
		const posted = new EmbedBuilder().setTitle("Board").setDescription(`top\n\n${HEADER}\na`).setImage("attachment://board.png");
		const updated = setTurnBlock(posted.toJSON() as never, [HEADER, "a", "b"]);
		expect(updated.data.title).toBe("Board");
		expect(updated.data.image?.url).toBe("attachment://board.png");
		expect(updated.data.description).toBe(`top\n\n${HEADER}\na\nb`);
	});
});

describe("splitTurnAt", () => {
	it("adds every line to the running turn when no turn ended", () => {
		expect(splitTurnAt(["a"], ["b"], null)).toEqual({ finishedShown: null, finishedNew: [], current: ["a", "b"], currentNew: ["b"] });
	});

	it("closes the turn at the cut: the lines before it finish the old turn, the rest open the new one", () => {
		expect(splitTurnAt(["a"], ["b", "c"], 1)).toEqual({ finishedShown: ["a", "b"], finishedNew: ["b"], current: ["c"], currentNew: ["c"] });
	});

	it("opens the new turn with every line when the cut is at the start", () => {
		expect(splitTurnAt(["a"], ["b"], 0)).toEqual({ finishedShown: ["a"], finishedNew: [], current: ["b"], currentNew: ["b"] });
	});
});
