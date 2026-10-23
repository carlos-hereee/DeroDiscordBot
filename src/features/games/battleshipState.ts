// ── battleshipState ─────────────────────────────────────────────────────────
// The match's rules, kept PURE and separate from any Discord work, the same
// split blackjackState / blackjackHandler and hangmanState / hangmanHandler
// already draw. Everything a shot can do to a match is decided here, so the
// fiddly parts (what counts as a repeat, when a ship is sunk, when the fleet is
// gone) are testable without a single Discord mock.
//
// ⚠️ THE LEAK IS THE RISK, not the arithmetic. A player must never learn where
// the opponent's UNFIRED ships are, in any surface, including the persisted
// transcript. The defense here is structural rather than careful: `opponentView`
// builds its output from the shots that have been FIRED and never reads a ship's
// cells at all, so there is no code path along which an unfired position could
// reach a renderer even by mistake. Do not add a convenience that returns the
// raw board for "just the embed".
//
// ⚠️ applyShot is SYNCHRONOUS by contract, matching applyAction and applyGuess.
// The board is public and two clicks can land in the same tick; an uninterrupted
// check-then-write is what stops one turn being spent twice.

export const GRID_SIZE = 10;

// The classic Milton Bradley fleet. Sizes are the rules, so they are named
// rather than sitting as loose numbers in a placement loop.
export const FLEET = [
	{ name: "carrier", size: 5 },
	{ name: "battleship", size: 4 },
	{ name: "cruiser", size: 3 },
	{ name: "submarine", size: 3 },
	{ name: "destroyer", size: 2 },
] as const;

export type ShipName = (typeof FLEET)[number]["name"];

// Auto placement retries on a collision. Bounded so a pathological rng cannot
// spin forever; 500 is far beyond what a 10x10 grid with 17 occupied cells ever
// needs, and exhausting it throws rather than returning a half placed fleet.
const PLACEMENT_ATTEMPT_LIMIT = 500;

export interface Coord {
	x: number;
	y: number;
}

export interface Ship {
	name: ShipName;
	cells: Coord[];
	// Which of this ship's own cells have been hit, as "x,y" keys. A Set so the
	// sunk test is a size comparison and cannot double count one cell.
	hits: Set<string>;
}

export interface PlayerBoard {
	userId: string;
	username: string;
	ships: Ship[];
	// Every cell fired AT this board, hit or miss alike. This is the half that is
	// safe to show an opponent, and it is deliberately the only half opponentView
	// reads.
	shots: Set<string>;
}

export type MatchStatus = "playing" | "finished";

export interface BattleshipState {
	// Exactly two, indexed so `turn` can be an index rather than an id lookup.
	players: [PlayerBoard, PlayerBoard];
	turn: 0 | 1;
	status: MatchStatus;
	winnerId: string | null;
	// Consecutive expired turns per player, by index. Two in a row forfeits the
	// match, which is what stops an abandoned room from never terminating and
	// blocking the archive sweep.
	missedTurns: [number, number];
}

// ── coordinates ─────────────────────────────────────────────────────────────
// "A5" is what a player says and two select menus produce; {x, y} is what the
// grid uses. Both directions live here so no caller invents its own parser.

const key = (coord: Coord): string => `${coord.x},${coord.y}`;

export const COLUMNS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"] as const;

export function formatCoord(coord: Coord): string {
	return `${COLUMNS[coord.x]}${coord.y + 1}`;
}

// Returns null rather than throwing on nonsense, because the callers are a
// select menu and a transcript replay, neither of which should crash a match
// over a malformed value.
export function parseCoord(raw: string): Coord | null {
	const match = /^([A-J])(10|[1-9])$/i.exec(raw.trim());
	if (!match) return null;
	return { x: COLUMNS.indexOf(match[1].toUpperCase() as (typeof COLUMNS)[number]), y: Number(match[2]) - 1 };
}

export const inBounds = (coord: Coord): boolean =>
	Number.isInteger(coord.x) && Number.isInteger(coord.y) && coord.x >= 0 && coord.x < GRID_SIZE && coord.y >= 0 && coord.y < GRID_SIZE;

// ── placement ───────────────────────────────────────────────────────────────

// Auto placement only. Manual placement is a second full coordinate UI for a
// fraction of the value and is deferred (the plan says so, and the Reroll button
// on the placement screen is what makes auto placement acceptable).
//
// The rng is injected exactly as versusResolve and blackjackState inject theirs,
// so a test gets a known fleet and production passes nothing.
export function placeFleet(rng: () => number = Math.random): Ship[] {
	const ships: Ship[] = [];
	const occupied = new Set<string>();

	for (const spec of FLEET) {
		let placed = false;
		for (let attempt = 0; attempt < PLACEMENT_ATTEMPT_LIMIT && !placed; attempt += 1) {
			const horizontal = rng() < 0.5;
			// The origin is constrained so the whole ship fits, which is why the span
			// is subtracted from the range rather than the ship being rejected after
			// the fact for running off the edge.
			const span = spec.size - 1;
			const x = Math.floor(rng() * (GRID_SIZE - (horizontal ? span : 0)));
			const y = Math.floor(rng() * (GRID_SIZE - (horizontal ? 0 : span)));

			const cells: Coord[] = [];
			for (let i = 0; i < spec.size; i += 1) cells.push({ x: horizontal ? x + i : x, y: horizontal ? y : y + i });

			if (cells.some((cell) => occupied.has(key(cell)))) continue;
			for (const cell of cells) occupied.add(key(cell));
			ships.push({ name: spec.name, cells, hits: new Set<string>() });
			placed = true;
		}
		// Unreachable on a 10x10 grid holding 17 cells of ship, but a silent partial
		// fleet would mean a match nobody can ever win, which is worse than a crash
		// at creation where the caller can retry.
		if (!placed) throw new Error(`battleship: could not place ${spec.name} in ${PLACEMENT_ATTEMPT_LIMIT} attempts`);
	}

	return ships;
}

export function createMatch(
	players: [{ userId: string; username: string }, { userId: string; username: string }],
	rng: () => number = Math.random
): BattleshipState {
	return {
		players: [
			{ ...players[0], ships: placeFleet(rng), shots: new Set<string>() },
			{ ...players[1], ships: placeFleet(rng), shots: new Set<string>() },
		],
		turn: 0,
		status: "playing",
		winnerId: null,
		missedTurns: [0, 0],
	};
}

// ── firing ──────────────────────────────────────────────────────────────────

export type ShotResult =
	| { status: "not-your-turn" }
	| { status: "finished" }
	| { status: "invalid"; reason: "off-grid" }
	| { status: "repeat"; coord: Coord }
	| { status: "miss"; coord: Coord }
	| { status: "hit"; coord: Coord; ship: ShipName }
	| { status: "sunk"; coord: Coord; ship: ShipName; fleetDestroyed: boolean };

const opponentIndex = (turn: 0 | 1): 0 | 1 => (turn === 0 ? 1 : 0);

export function applyShot(state: BattleshipState, shooterId: string, coord: Coord): ShotResult {
	if (state.status !== "playing") return { status: "finished" };
	if (state.players[state.turn].userId !== shooterId) return { status: "not-your-turn" };
	if (!inBounds(coord)) return { status: "invalid", reason: "off-grid" };

	const target = state.players[opponentIndex(state.turn)];
	const cell = key(coord);
	// A repeat costs NOTHING, not even the turn. Discord's select menus make a
	// double submit easy, and spending someone's turn on their own double click
	// is the kind of unfairness a player never forgives.
	if (target.shots.has(cell)) return { status: "repeat", coord };

	target.shots.add(cell);
	// A shot that lands resets the idle counter: the player is clearly present.
	state.missedTurns[state.turn] = 0;

	const struck = target.ships.find((ship) => ship.cells.some((c) => key(c) === cell));
	if (!struck) {
		passTurn(state);
		return { status: "miss", coord };
	}

	struck.hits.add(cell);
	if (struck.hits.size < struck.cells.length) {
		passTurn(state);
		return { status: "hit", coord, ship: struck.name };
	}

	const fleetDestroyed = isFleetDestroyed(state, target.userId);
	if (fleetDestroyed) {
		state.status = "finished";
		state.winnerId = shooterId;
	} else {
		passTurn(state);
	}
	return { status: "sunk", coord, ship: struck.name, fleetDestroyed };
}

// One shot per turn, and the turn passes on a HIT as well as a miss. That is the
// classic rule. The shoot-again-on-a-hit variant exists, but it lets one lucky
// run end a match before the other player has taken a meaningful number of
// turns, which reads as broken rather than exciting.
function passTurn(state: BattleshipState): void {
	state.turn = opponentIndex(state.turn);
}

export function isFleetDestroyed(state: BattleshipState, userId: string): boolean {
	const board = state.players.find((player) => player.userId === userId);
	if (!board) return false;
	return board.ships.every((ship) => ship.hits.size === ship.cells.length);
}

// ── the idle clock ──────────────────────────────────────────────────────────

// Called when a turn's timer expires rather than when a shot lands. Two
// consecutive expiries forfeit the match, because a room that waits forever on
// somebody who closed Discord never terminates, and the game rooms archive sweep
// depends on rooms terminating.
export function expireTurn(state: BattleshipState): { forfeited: boolean; winnerId: string | null } {
	if (state.status !== "playing") return { forfeited: false, winnerId: null };

	state.missedTurns[state.turn] += 1;
	if (state.missedTurns[state.turn] >= 2) {
		const winner = state.players[opponentIndex(state.turn)];
		state.status = "finished";
		state.winnerId = winner.userId;
		return { forfeited: true, winnerId: winner.userId };
	}

	passTurn(state);
	return { forfeited: false, winnerId: null };
}

// ── views ───────────────────────────────────────────────────────────────────

export type CellView = "unknown" | "miss" | "hit" | "sunk";

// ⚠️ THE ANTI LEAK BOUNDARY. What one player is allowed to know about the other
// board: where they have fired, and what those shots found. It is built by
// walking the SHOTS, never the ships, so an unfired ship cell has no route into
// the output. A render bug can therefore make this ugly but cannot make it
// cheat. `sunk` is included because a sunk ship is public knowledge in every
// version of the game, and only its cells are revealed.
export function opponentView(state: BattleshipState, viewerId: string): CellView[][] {
	const target = state.players.find((player) => player.userId !== viewerId);
	const grid: CellView[][] = Array.from({ length: GRID_SIZE }, () => Array.from({ length: GRID_SIZE }, (): CellView => "unknown"));
	if (!target) return grid;

	const sunkCells = new Set<string>();
	for (const ship of target.ships) {
		if (ship.hits.size === ship.cells.length) for (const cell of ship.cells) sunkCells.add(key(cell));
	}

	for (const shot of target.shots) {
		const [x, y] = shot.split(",").map(Number);
		// Every fired cell resolves to exactly one of three visible states. None of
		// them may stay "unknown": a fired cell that rendered as unfired would have
		// a player wasting turns re-firing it.
		if (sunkCells.has(shot)) grid[y][x] = "sunk";
		else if (target.ships.some((ship) => ship.hits.has(shot))) grid[y][x] = "hit";
		else grid[y][x] = "miss";
	}

	return grid;
}

// The viewer's OWN board, which they may see in full: their ship positions plus
// the incoming fire. Delivered on the member's own click as an ephemeral reply,
// never pushed, so it always rides a fresh interaction token.
export interface OwnCellView {
	ship: ShipName | null;
	hit: boolean;
	miss: boolean;
}

export function ownView(state: BattleshipState, viewerId: string): OwnCellView[][] {
	const board = state.players.find((player) => player.userId === viewerId);
	const grid: OwnCellView[][] = Array.from({ length: GRID_SIZE }, () =>
		Array.from({ length: GRID_SIZE }, (): OwnCellView => ({ ship: null, hit: false, miss: false }))
	);
	if (!board) return grid;

	for (const ship of board.ships) for (const cell of ship.cells) grid[cell.y][cell.x].ship = ship.name;
	for (const shot of board.shots) {
		const [x, y] = shot.split(",").map(Number);
		if (grid[y][x].ship) grid[y][x].hit = true;
		else grid[y][x].miss = true;
	}

	return grid;
}

/** A ship the viewer has sunk: its name and every cell it covered. */
export interface SunkShipView {
	name: ShipName;
	cells: Coord[];
}

// The ships the viewer has SUNK on the other board, named, for the card's
// sinking reveal. It reads ship cells, which opponentView never does, and stays
// on the safe side of the same boundary for one reason: a ship is listed only
// once every one of its cells has been hit, so every cell it returns is a cell
// the viewer already fired on and opponentView already shows as sunk. A ship
// with even one cell unhit never appears, so this cannot place an afloat hull.
export function sunkShips(state: BattleshipState, viewerId: string): SunkShipView[] {
	const target = state.players.find((player) => player.userId !== viewerId);
	if (!target) return [];
	return target.ships
		.filter((ship) => ship.hits.size === ship.cells.length)
		.map((ship) => ({ name: ship.name, cells: ship.cells.map((cell) => ({ x: cell.x, y: cell.y })) }));
}

// How many of a player's ships are still afloat, for the board's headline.
// Derived rather than tracked so it cannot drift from the hits themselves.
export function shipsRemaining(state: BattleshipState, userId: string): number {
	const board = state.players.find((player) => player.userId === userId);
	if (!board) return 0;
	return board.ships.filter((ship) => ship.hits.size < ship.cells.length).length;
}
