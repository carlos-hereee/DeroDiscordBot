import { describe, it, expect } from "vitest";
import { decideBattleshipShot } from "./battleshipBot.js";
import { applyShot, createMatch, startBattle, markReady, type BattleshipState } from "./battleshipState.js";

// ── the Battleship bot (2026-10 item 250 Phase 5) ───────────────────────────
// Hunt and target from the public view only: it fires beside an open hit, along the
// line two hits make, never on a cell already fired, and two bots play a whole match to
// its end with only legal shots.

function seededRng(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state * 1664525 + 1013904223) % 4294967296;
		return state / 4294967296;
	};
}

function battle(seed: number): BattleshipState {
	const state = createMatch(
		[
			{ userId: "dero-bot-red", username: "Dero Red" },
			{ userId: "dero-bot-orange", username: "Dero Orange" },
		],
		seededRng(seed)
	);
	markReady(state, "dero-bot-red");
	markReady(state, "dero-bot-orange");
	startBattle(state);
	return state;
}

describe("decideBattleshipShot", () => {
	it("fires beside an open hit, and along the line once it has two", () => {
		const state = battle(5);
		const target = state.players[1];
		const ship = target.ships.find((entry) => entry.cells.length >= 3)!;
		const [first, second] = ship.cells;
		target.shots.add(`${first.x},${first.y}`);
		ship.hits.add(`${first.x},${first.y}`);

		const besideFirst = decideBattleshipShot(state, "dero-bot-red", seededRng(1))!;
		expect(Math.abs(besideFirst.x - first.x) + Math.abs(besideFirst.y - first.y)).toBe(1);

		target.shots.add(`${second.x},${second.y}`);
		ship.hits.add(`${second.x},${second.y}`);
		for (const seed of [1, 2, 3, 4]) {
			const next = decideBattleshipShot(state, "dero-bot-red", seededRng(seed))!;
			const horizontal = first.y === second.y;
			if (horizontal) expect(next.y).toBe(first.y);
			else expect(next.x).toBe(first.x);
		}
	});

	it.each([1, 2, 3, 7, 11])("plays two bots to the end with only legal shots, seed %i", (seed) => {
		const state = battle(seed);
		const rng = seededRng(seed * 13);
		let shots = 0;
		while (state.status === "playing" && shots < 200) {
			const shooter = state.players[state.turn].userId;
			const coord = decideBattleshipShot(state, shooter, rng);
			expect(coord).not.toBeNull();
			const result = applyShot(state, shooter, coord!);
			expect(["miss", "hit", "sunk"]).toContain(result.status);
			shots++;
		}
		expect(state.status).toBe("finished");
		// A hunting bot sinks a fleet well inside the 100 cells it would take to fire on all of them.
		expect(shots).toBeLessThan(200);
	});
});
