import { describe, it, expect } from "vitest";
import {
	applyShot,
	COLUMNS,
	createMatch,
	expireTurn,
	FLEET,
	formatCoord,
	GRID_SIZE,
	inBounds,
	isFleetDestroyed,
	markReady,
	opponentView,
	ownView,
	parseCoord,
	placeFleet,
	rerollFleet,
	shipsRemaining,
	startBattle,
	type BattleshipState,
	type Coord,
} from "./battleshipState.js";

// ── helpers ─────────────────────────────────────────────────────────────────

// A deterministic rng, so a fleet and therefore a whole match is reproducible.
// Seeded rather than constant because a constant rng makes placeFleet collide
// with itself forever and exhaust its attempt limit.
function seeded(seed = 1): () => number {
	let n = seed;
	return () => ((n = (n * 1103515245 + 12345) % 2147483648) / 2147483648);
}

const players: [{ userId: string; username: string }, { userId: string; username: string }] = [
	{ userId: "a", username: "a" },
	{ userId: "b", username: "b" },
];

// A match past setup, which is what every firing case below starts from. The setup
// stage itself has its own block at the end.
const match = (seed = 1): BattleshipState => {
	const state = createMatch(players, seeded(seed));
	startBattle(state);
	return state;
};

// Fire at every cell of the target's fleet, in order, alternating turns so the
// shooter always has the move. Used to drive a match to its end deterministically.
function sinkEverything(state: BattleshipState, shooterId: string): void {
	const target = state.players.find((p) => p.userId !== shooterId);
	if (!target) return;
	const cells = target.ships.flatMap((ship) => ship.cells);
	for (const cell of cells) {
		if (state.status !== "playing") break;
		// Give the turn back to the shooter: the opponent's reply shot is irrelevant
		// to what is being measured and would otherwise sink the shooter first.
		state.turn = state.players[0].userId === shooterId ? 0 : 1;
		applyShot(state, shooterId, cell);
	}
}

// ── coordinates ─────────────────────────────────────────────────────────────

describe("coordinates", () => {
	it("round trips every cell on the grid", () => {
		for (let x = 0; x < GRID_SIZE; x++) {
			for (let y = 0; y < GRID_SIZE; y++) {
				expect(parseCoord(formatCoord({ x, y }))).toEqual({ x, y });
			}
		}
	});

	it("reads the corners the way a player writes them", () => {
		expect(parseCoord("A1")).toEqual({ x: 0, y: 0 });
		expect(parseCoord("J10")).toEqual({ x: 9, y: 9 });
		expect(formatCoord({ x: 9, y: 9 })).toBe("J10");
	});

	it("accepts lower case and surrounding space", () => {
		expect(parseCoord(" c7 ")).toEqual({ x: 2, y: 6 });
	});

	it("returns null rather than throwing on nonsense", () => {
		// A select menu and a transcript replay are the callers; neither should
		// crash a live match over a malformed value.
		for (const bad of ["", "K1", "A0", "A11", "AA1", "1A", "A", "10"]) {
			expect(parseCoord(bad)).toBeNull();
		}
	});

	it("rejects off grid coordinates", () => {
		expect(inBounds({ x: -1, y: 0 })).toBe(false);
		expect(inBounds({ x: 0, y: GRID_SIZE })).toBe(false);
		expect(inBounds({ x: 1.5, y: 2 })).toBe(false);
		expect(inBounds({ x: 0, y: 0 })).toBe(true);
	});

	it("labels ten columns", () => {
		expect(COLUMNS).toHaveLength(GRID_SIZE);
	});
});

// ── placement ───────────────────────────────────────────────────────────────

describe("placeFleet", () => {
	it("places the whole fleet at its declared sizes", () => {
		const ships = placeFleet(seeded());
		expect(ships).toHaveLength(FLEET.length);
		for (const spec of FLEET) {
			const ship = ships.find((s) => s.name === spec.name);
			expect(ship?.cells).toHaveLength(spec.size);
		}
	});

	it("never overlaps two ships", () => {
		// Swept across many seeds rather than one, because an overlap bug is exactly
		// the kind that hides behind a lucky first placement.
		for (let seed = 1; seed <= 100; seed++) {
			const cells = placeFleet(seeded(seed)).flatMap((ship) => ship.cells.map((c) => `${c.x},${c.y}`));
			expect(new Set(cells).size).toBe(cells.length);
		}
	});

	it("keeps every ship on the grid", () => {
		for (let seed = 1; seed <= 100; seed++) {
			for (const ship of placeFleet(seeded(seed))) {
				for (const cell of ship.cells) expect(inBounds(cell)).toBe(true);
			}
		}
	});

	it("lays every ship in a straight unbroken line", () => {
		for (const ship of placeFleet(seeded())) {
			const xs = new Set(ship.cells.map((c) => c.x));
			const ys = new Set(ship.cells.map((c) => c.y));
			// One axis is fixed and the other advances by exactly one per cell.
			expect(xs.size === 1 || ys.size === 1).toBe(true);
			const moving = xs.size === 1 ? ship.cells.map((c) => c.y) : ship.cells.map((c) => c.x);
			for (let i = 1; i < moving.length; i++) expect(moving[i] - moving[i - 1]).toBe(1);
		}
	});

	it("is deterministic for a given rng, which is what makes a match reproducible", () => {
		expect(placeFleet(seeded(7))).toEqual(placeFleet(seeded(7)));
	});
});

// ── firing ──────────────────────────────────────────────────────────────────

describe("applyShot", () => {
	it("refuses a shot from the player who is not to move", () => {
		const state = match();
		expect(applyShot(state, "b", { x: 0, y: 0 })).toEqual({ status: "not-your-turn" });
	});

	it("refuses a shot off the grid without spending the turn", () => {
		const state = match();
		expect(applyShot(state, "a", { x: 10, y: 0 })).toEqual({ status: "invalid", reason: "off-grid" });
		expect(state.turn).toBe(0);
	});

	it("passes the turn on a miss", () => {
		const state = match();
		// A cell no ship of b's occupies.
		const occupied = new Set(state.players[1].ships.flatMap((s) => s.cells.map((c) => `${c.x},${c.y}`)));
		let empty: Coord | undefined;
		for (let x = 0; x < GRID_SIZE && !empty; x++) {
			for (let y = 0; y < GRID_SIZE && !empty; y++) if (!occupied.has(`${x},${y}`)) empty = { x, y };
		}
		expect(applyShot(state, "a", empty as Coord).status).toBe("miss");
		expect(state.turn).toBe(1);
	});

	it("passes the turn on a HIT too, which is the classic rule", () => {
		// The shoot-again-on-a-hit variant lets one lucky run end a match before the
		// other player has taken a meaningful number of turns.
		const state = match();
		const cell = state.players[1].ships[0].cells[0];
		expect(applyShot(state, "a", cell).status).toBe("hit");
		expect(state.turn).toBe(1);
	});

	it("charges NOTHING for a repeat, not even the turn", () => {
		const state = match();
		const cell = state.players[1].ships[0].cells[0];
		applyShot(state, "a", cell);
		state.turn = 0;
		expect(applyShot(state, "a", cell)).toEqual({ status: "repeat", coord: cell });
		expect(state.turn).toBe(0);
	});

	it("reports a sunk ship by name once its last cell is struck", () => {
		const state = match();
		const ship = state.players[1].ships.find((s) => s.name === "destroyer");
		if (!ship) throw new Error("no destroyer");
		state.turn = 0;
		applyShot(state, "a", ship.cells[0]);
		state.turn = 0;
		const result = applyShot(state, "a", ship.cells[1]);
		expect(result).toMatchObject({ status: "sunk", ship: "destroyer", fleetDestroyed: false });
	});

	it("ends the match when the last ship goes down", () => {
		const state = match();
		sinkEverything(state, "a");
		expect(state.status).toBe("finished");
		expect(state.winnerId).toBe("a");
		expect(isFleetDestroyed(state, "b")).toBe(true);
		expect(shipsRemaining(state, "b")).toBe(0);
	});

	it("refuses any further shot once the match is finished", () => {
		const state = match();
		sinkEverything(state, "a");
		expect(applyShot(state, "a", { x: 0, y: 0 })).toEqual({ status: "finished" });
	});
});

// ── the idle clock ──────────────────────────────────────────────────────────

describe("expireTurn", () => {
	it("passes the turn on a single expiry", () => {
		const state = match();
		expect(expireTurn(state)).toEqual({ forfeited: false, winnerId: null });
		expect(state.turn).toBe(1);
		expect(state.status).toBe("playing");
	});

	it("forfeits the match after two consecutive expiries", () => {
		// A room that waits forever on somebody who closed Discord never terminates,
		// and the game rooms archive sweep depends on rooms terminating.
		const state = match();
		expireTurn(state);
		state.turn = 0;
		expect(expireTurn(state)).toEqual({ forfeited: true, winnerId: "b" });
		expect(state.status).toBe("finished");
	});

	it("resets the idle count when a player fires", () => {
		const state = match();
		expireTurn(state);
		state.turn = 0;
		applyShot(state, "a", state.players[1].ships[0].cells[0]);
		expect(state.missedTurns[0]).toBe(0);
	});

	it("does nothing once the match is over", () => {
		const state = match();
		sinkEverything(state, "a");
		expect(expireTurn(state)).toEqual({ forfeited: false, winnerId: null });
	});
});

// ── the leak boundary, the risk that actually matters ───────────────────────

describe("opponentView never leaks an unfired ship", () => {
	it("shows exactly the cells that have been fired at, and nothing else", () => {
		// The structural claim: the view is built by walking SHOTS, never ships, so
		// the set of visible cells must equal the set of fired cells exactly.
		const state = match();
		const fired: string[] = [];
		for (const cell of [
			{ x: 0, y: 0 },
			{ x: 3, y: 4 },
			{ x: 9, y: 9 },
			{ x: 5, y: 5 },
		]) {
			state.turn = 0;
			applyShot(state, "a", cell);
			fired.push(`${cell.x},${cell.y}`);
		}

		const view = opponentView(state, "a");
		const visible: string[] = [];
		for (let y = 0; y < GRID_SIZE; y++) {
			for (let x = 0; x < GRID_SIZE; x++) if (view[y][x] !== "unknown") visible.push(`${x},${y}`);
		}
		expect(visible.sort()).toEqual([...fired].sort());
	});

	it("hides an untouched fleet completely at the opening", () => {
		const state = match();
		const view = opponentView(state, "a");
		expect(view.flat().every((cell) => cell === "unknown")).toBe(true);
	});

	it("reveals a sunk ship's cells, which is public knowledge in every version", () => {
		const state = match();
		const ship = state.players[1].ships.find((s) => s.name === "destroyer");
		if (!ship) throw new Error("no destroyer");
		for (const cell of ship.cells) {
			state.turn = 0;
			applyShot(state, "a", cell);
		}
		const view = opponentView(state, "a");
		for (const cell of ship.cells) expect(view[cell.y][cell.x]).toBe("sunk");
	});

	it("marks a struck but unsunk ship as a hit rather than a sink", () => {
		const state = match();
		const carrier = state.players[1].ships.find((s) => s.name === "carrier");
		if (!carrier) throw new Error("no carrier");
		state.turn = 0;
		applyShot(state, "a", carrier.cells[0]);
		expect(opponentView(state, "a")[carrier.cells[0].y][carrier.cells[0].x]).toBe("hit");
	});

	it("never lets a miss render as unfired", () => {
		// A fired cell showing as unknown would have a player wasting turns
		// re-firing it, and repeats cost nothing so nothing else would flag it.
		const state = match();
		const occupied = new Set(state.players[1].ships.flatMap((s) => s.cells.map((c) => `${c.x},${c.y}`)));
		let fired = 0;
		for (let x = 0; x < GRID_SIZE; x++) {
			for (let y = 0; y < GRID_SIZE; y++) {
				if (occupied.has(`${x},${y}`)) continue;
				state.turn = 0;
				applyShot(state, "a", { x, y });
				fired += 1;
			}
		}
		const view = opponentView(state, "a");
		expect(view.flat().filter((cell) => cell === "miss")).toHaveLength(fired);
	});
});

describe("ownView", () => {
	it("shows the viewer their own fleet", () => {
		const state = match();
		const view = ownView(state, "a");
		const shown = view.flat().filter((cell) => cell.ship !== null).length;
		expect(shown).toBe(FLEET.reduce((sum, spec) => sum + spec.size, 0));
	});

	it("marks incoming fire as hits and misses on the viewer's own grid", () => {
		const state = match();
		const cell = state.players[0].ships[0].cells[0];
		state.turn = 1;
		applyShot(state, "b", cell);
		const view = ownView(state, "a");
		expect(view[cell.y][cell.x]).toMatchObject({ hit: true, miss: false });
	});

	it("returns an empty grid for somebody who is not in this match", () => {
		const state = match();
		expect(ownView(state, "stranger").flat().every((cell) => cell.ship === null)).toBe(true);
	});
});

// ── setup (post-launch plan item 17) ────────────────────────────────────────

describe("setup", () => {
	const fresh = (): BattleshipState => createMatch(players, seeded(7));

	it("opens in setup, and nobody can fire until both players are ready", () => {
		const state = fresh();
		expect(state.status).toBe("setup");
		expect(applyShot(state, "a", { x: 0, y: 0 })).toEqual({ status: "setup" });
	});

	it("starts the battle on the second Ready, not the first", () => {
		const state = fresh();
		expect(markReady(state, "a")).toEqual({ ok: true, index: 0, battleStarted: false });
		expect(state.status).toBe("setup");
		expect(markReady(state, "b")).toEqual({ ok: true, index: 1, battleStarted: true });
		expect(state.status).toBe("playing");
	});

	it("refuses a second Ready, a stranger, and anything after setup", () => {
		const state = fresh();
		markReady(state, "a");
		expect(markReady(state, "a")).toEqual({ ok: false, reason: "already-ready" });
		expect(markReady(state, "z")).toEqual({ ok: false, reason: "not-a-player" });
		markReady(state, "b");
		expect(markReady(state, "b")).toEqual({ ok: false, reason: "not-in-setup" });
	});

	it("re-lays only the asking player's fleet, and only before they are ready", () => {
		const state = fresh();
		const before = JSON.stringify(state.players[1].ships);
		const own = JSON.stringify(state.players[0].ships);
		expect(rerollFleet(state, "a", seeded(99))).toEqual({ ok: true, index: 0 });
		expect(JSON.stringify(state.players[0].ships)).not.toBe(own);
		expect(JSON.stringify(state.players[1].ships)).toBe(before);
		markReady(state, "a");
		expect(rerollFleet(state, "a")).toEqual({ ok: false, reason: "already-ready" });
	});

	it("a re-laid fleet is still the whole legal fleet", () => {
		const state = fresh();
		rerollFleet(state, "b", seeded(3));
		const ships = state.players[1].ships;
		expect(ships.map((ship) => ship.name)).toEqual(FLEET.map((spec) => spec.name));
		const cells = ships.flatMap((ship) => ship.cells.map((cell) => `${cell.x},${cell.y}`));
		expect(new Set(cells).size).toBe(cells.length);
	});

	it("the setup clock starts the battle as laid, once", () => {
		const state = fresh();
		expect(startBattle(state)).toBe(true);
		expect(state.status).toBe("playing");
		expect(state.ready).toEqual([true, true]);
		expect(startBattle(state)).toBe(false);
	});
});
