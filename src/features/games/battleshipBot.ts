import { GRID_SIZE, opponentView, type BattleshipState, type CellView, type Coord } from "./battleshipState.js";

// ── battleshipBot ───────────────────────────────────────────────────
// What:  where a Dero bot captain fires (2026-10 item 250 Phase 5, the owner's choice to
//        build battleship bots in this phase): the classic hunt and target. While no hit
//        is still afloat it hunts on a checkerboard, since every ship covers at least two
//        cells and so always crosses one colour of it; once it has a hit on a ship not yet
//        sunk, it fires beside it, along the line two hits make when it has two.
// Who:   the room's bot driver (game-rooms/botTurns.ts) on the bot's turn, and the tests.
// Does NOT: look at the opponent's fleet. It reads opponentView, the same grid of
//        unknown, miss, hit and sunk cells a member sees on the public board, and nothing
//        else, so it cannot cheat. Its fleet was laid by the engine like any captain's.

const NEIGHBOURS: readonly Coord[] = [
	{ x: 1, y: 0 },
	{ x: -1, y: 0 },
	{ x: 0, y: 1 },
	{ x: 0, y: -1 },
];

/** The cell the bot fires on next, or null when there is nothing left to fire on. */
export function decideBattleshipShot(state: BattleshipState, botId: string, rng: () => number = Math.random): Coord | null {
	const view = opponentView(state, botId);
	const target = targetShot(view, rng);
	if (target) return target;
	return huntShot(view, rng);
}

// ① Target: an unknown cell beside a hit that is not part of a sunk ship. With two hits in
// a row on one ship, the line they make is where the rest of it lies, so those cells come first.
function targetShot(view: CellView[][], rng: () => number): Coord | null {
	const hits = cellsWhere(view, "hit");
	if (hits.length === 0) return null;

	const inLine: Coord[] = [];
	const beside: Coord[] = [];
	for (const hit of hits) {
		for (const step of NEIGHBOURS) {
			const next = { x: hit.x + step.x, y: hit.y + step.y };
			if (!isUnknown(view, next)) continue;
			const behind = { x: hit.x - step.x, y: hit.y - step.y };
			(cellAt(view, behind) === "hit" ? inLine : beside).push(next);
		}
	}
	return pickFrom(inLine, rng) ?? pickFrom(beside, rng);
}

// ② Hunt: an unknown cell on the checkerboard, or any unknown cell once those run out.
function huntShot(view: CellView[][], rng: () => number): Coord | null {
	const unknown = cellsWhere(view, "unknown");
	const checkerboard = unknown.filter((cell) => (cell.x + cell.y) % 2 === 0);
	return pickFrom(checkerboard, rng) ?? pickFrom(unknown, rng);
}

// The view is indexed [row][column], so y first.
function cellAt(view: CellView[][], coord: Coord): CellView | null {
	if (coord.x < 0 || coord.y < 0 || coord.x >= GRID_SIZE || coord.y >= GRID_SIZE) return null;
	return view[coord.y]?.[coord.x] ?? null;
}

const isUnknown = (view: CellView[][], coord: Coord): boolean => cellAt(view, coord) === "unknown";

function cellsWhere(view: CellView[][], wanted: CellView): Coord[] {
	const cells: Coord[] = [];
	view.forEach((row, y) => row.forEach((cell, x) => cell === wanted && cells.push({ x, y })));
	return cells;
}

function pickFrom(cells: readonly Coord[], rng: () => number): Coord | null {
	if (cells.length === 0) return null;
	return cells[Math.floor(rng() * cells.length)];
}
