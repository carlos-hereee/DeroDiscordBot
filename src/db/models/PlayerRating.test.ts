import { describe, it, expect } from "vitest";
import { PlayerRating } from "./PlayerRating.js";

// ── PlayerRating index declarations ────────────────────────────────────────
// SCHEMA assertions, not store tests, in the pattern GameRoom.test.ts set. The
// unique { userId, game } index is what keeps a player on one row per game when two
// first ratings race; the { game, displayRating: -1 } index serves the board.
// Importing the model only registers a schema and opens no connection.

type DeclaredIndex = [Record<string, unknown>, Record<string, unknown>];
const indexes = PlayerRating.schema.indexes() as unknown as DeclaredIndex[];

const matching = (key: Record<string, unknown>): DeclaredIndex[] =>
	indexes.filter(([fields]) => JSON.stringify(fields) === JSON.stringify(key));

describe("PlayerRating indexes", () => {
	it("declares the unique { userId, game } index exactly once", () => {
		const unique = matching({ userId: 1, game: 1 });
		expect(unique).toHaveLength(1);
		expect(unique[0][1].unique).toBe(true);
	});

	it("declares the { game, displayRating: -1 } board index exactly once", () => {
		const board = matching({ game: 1, displayRating: -1 });
		expect(board).toHaveLength(1);
		expect(board[0][1].unique).toBeUndefined();
	});

	it("declares no other index", () => {
		expect(indexes).toHaveLength(2);
	});
});
