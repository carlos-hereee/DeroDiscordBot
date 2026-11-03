import { describe, it, expect } from "vitest";
import { createTable, dealHand, joinTable, whoActs, type HoldemTable } from "@features/games/holdemTable.js";
import { bettingRows, holdemPromptButtons, holdemTurnView, resolveRaiseAmount } from "./roomHoldem.js";

// ── the game card and the turn line (owner decision of 2026-10-29) ─────────────
// A member on the clock plays every move, Show my cards and Leave table from the turn line, so
// the board keeps only the host's settings; no button is on both. With nobody pinged (a bot or a
// network table) the board keeps every button, since there is no turn line to press.

function dealtTable(): HoldemTable {
	const table = createTable();
	joinTable(table, "a", "Player A");
	joinTable(table, "b", "Player B");
	table.status = "playing";
	let seed = 7;
	dealHand(table, () => {
		seed = (seed * 1664525 + 1013904223) % 4294967296;
		return seed / 4294967296;
	});
	return table;
}

const idsOf = (rows: ReturnType<typeof bettingRows>): string[] => rows.flatMap((row) => row.toJSON().components.map((component) => (component as { custom_id?: string }).custom_id ?? ""));

describe("Hold'em's board and turn line", () => {
	it("keeps only End table on the board while the moves ride the turn line", () => {
		const table = dealtTable();
		expect(idsOf(bettingRows(table, "room-1", 30, undefined, true))).toEqual(["gameroom:hend:room-1"]);
	});

	it("keeps every move, Show my cards and Leave on the board when there is no turn line", () => {
		const ids = idsOf(bettingRows(dealtTable(), "room-1", 30));
		expect(ids).toEqual(expect.arrayContaining(["gameroom:hmove:room-1:fold", "gameroom:hcards:room-1", "gameroom:hleave:room-1", "gameroom:hend:room-1"]));
	});

	it("puts Show my cards and Leave table on the turn line, never End table", () => {
		const ids = holdemPromptButtons("room-1", dealtTable()).map((button) => (button.toJSON() as { custom_id: string }).custom_id);
		expect(ids).toEqual(["gameroom:hcards:room-1", "gameroom:hleave:room-1"]);
	});

	it("offers the board's half pot and pot raises among the turn's moves while a raise is legal", () => {
		const table = dealtTable();
		const actor = whoActs(table) as string;
		const values = holdemTurnView(table, actor, 30)?.fields[0];
		expect(values?.kind === "select" ? values.options.map((option) => option.value) : []).toEqual(expect.arrayContaining(["half", "pot"]));
	});
});

describe("the half pot and pot raise presets (2026-10 item 276)", () => {
	it("size a true pot raise: the bet faced, plus the pot, plus the call", () => {
		// Heads up the button posts 10 and acts first, facing the big blind's 20 in a pot of 30.
		// The call makes the pot 40, so pot raises to 20 + 40 and half pot to 20 + 20.
		const table = dealtTable();
		const actor = whoActs(table) as string;
		expect(resolveRaiseAmount(table, actor, "pot", 30)).toBe(60);
		expect(resolveRaiseAmount(table, actor, "half", 30)).toBe(40);
	});

	it("label each preset with the total its press commits", () => {
		const table = dealtTable();
		const actor = whoActs(table) as string;
		const values = holdemTurnView(table, actor, 30)?.fields[0];
		const labels = values?.kind === "select" ? values.options.map((option) => option.label) : [];
		expect(labels).toEqual(expect.arrayContaining(["Half pot (40)", "Pot (60)"]));
	});

	it("stays inside the legal band, so a pot bigger than the stack is an all in", () => {
		const table = dealtTable();
		const actor = whoActs(table) as string;
		const seat = table.betting!.seats.find((entry) => entry.userId === actor)!;
		expect(resolveRaiseAmount(table, actor, "pot", 100_000)).toBe(seat.committed + seat.stack);
	});
});
