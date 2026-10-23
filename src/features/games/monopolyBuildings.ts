import {
	BOARD,
	BUILDING_RESALE_DIVISOR,
	COLOR_GROUPS,
	MAX_HOUSES_PER_LOT,
	UNMORTGAGE_INTEREST_PERCENT,
	findOwnableTile,
	type OwnableTile,
	type PropertyTile,
	type TileId,
} from "./monopolyBoard.js";
import type { MonopolyResult, MonopolySeat, MonopolyState, PropertyState } from "./monopolyState.js";
import { activeSeatOf, cloneState, completeAction, guardActiveTurn, mentionPlayer, rejectAction } from "./monopolySeats.js";

// ── monopolyBuildings ───────────────────────────────────────────────────────
// What:  what an owner does with lots between rolls: mortgage one for cash, lift
//        a mortgage, and build houses and hotels on a complete color group.
// Who:   the room's build picker and mortgage controls, through the re-exports in
//        monopolyState; listBuildOptions is what the picker offers. unmortgageCost is also what the board embed shows, so the
//        price on the button and the charge cannot disagree (rule 17). The
//        building helpers below are shared with monopolyBankruptcy (selling back
//        and mortgaging to cover a debt) and monopolyTrade (which lots may move).
// When:  mortgages at any point in a live match, by any seat still in it, which
//        is the standard rule. Building only on the owner's own turn before the
//        roll, per Section 1 of the plan.
// Where: split out of monopolyState (rule 18) along the "owner's holdings" seam.
//        Selling buildings back and the forced mortgage before bankruptcy live in
//        monopolyBankruptcy, because they only ever happen to cover a debt.
// How:   every value (price, mortgage, house cost) comes from monopolyBoard;
//        the bank's house and hotel stock lives on the state and is the supply a
//        build draws from.

export type BuildingKind = "house" | "hotel";

/** What lifting the mortgage on this tile costs: its mortgage value plus interest, rounded up. */
export function unmortgageCost(tile: OwnableTile): number {
	return tile.mortgage + Math.ceil((tile.mortgage * UNMORTGAGE_INTEREST_PERCENT) / 100);
}

// A lot's place on the building ladder: 0 to 4 houses, then the hotel one rung
// above. The even building rule compares these, so a hotel outranks four houses,
// and selling back walks the same ladder down.
export const buildingLevel = (property: PropertyState): number => (property.hotel ? MAX_HOUSES_PER_LOT + 1 : property.houses);

export const hasBuildings = (property: PropertyState): boolean => property.hotel || property.houses > 0;

/** What the bank pays for one house or one hotel on this lot when it is sold back. */
export const buildingSaleValue = (tile: PropertyTile): number => tile.houseCost / BUILDING_RESALE_DIVISOR;

/**
 * Whether any lot in this tile's color group has buildings. The standard rules
 * forbid mortgaging or trading any lot of such a group until they are sold, so
 * the group is checked, not just the lot. Transports and utilities have no
 * group and never block.
 */
export function groupHasBuildings(state: MonopolyState, tile: OwnableTile): boolean {
	return tile.kind === "property" && COLOR_GROUPS[tile.group].some((id) => hasBuildings(state.properties[id]));
}

// ── ownership guard ─────────────────────────────────────────────────────────

// seatIndex rather than the seat itself, so the caller can find the same seat on
// the clone it is about to mutate.
type OwnedTile = { ok: true; seat: MonopolySeat; seatIndex: number; tile: OwnableTile } | { ok: false; reason: string };

// The checks mortgage and unmortgage share: a live match, a seat still in it,
// a real tile, and that seat owning it.
function findOwnedTile(state: MonopolyState, ownerId: string, tileId: TileId): OwnedTile {
	if (state.phase === "finished") return { ok: false, reason: "The match is already over." };
	const seatIndex = state.seats.findIndex((candidate) => candidate.userId === ownerId);
	const seat = state.seats[seatIndex];
	if (!seat || seat.bankrupt) return { ok: false, reason: "You are not playing in this match." };
	const tile = findOwnableTile(tileId);
	if (!tile) return { ok: false, reason: "That is not a lot on this board." };
	if (state.properties[tile.id].ownerId !== ownerId) return { ok: false, reason: `You do not own ${tile.name}.` };
	return { ok: true, seat, seatIndex, tile };
}

// ── mortgage ────────────────────────────────────────────────────────────────

/** The owner mortgages an unimproved lot and takes its mortgage value from the bank. */
export function applyMortgage(state: MonopolyState, ownerId: string, tileId: TileId): MonopolyResult {
	const owned = findOwnedTile(state, ownerId, tileId);
	if (!owned.ok) return rejectAction(owned.reason);
	const { seatIndex, tile } = owned;
	if (state.properties[tile.id].mortgaged) return rejectAction(`${tile.name} is already mortgaged.`);
	if (groupHasBuildings(state, tile)) {
		return rejectAction(`${tile.name} cannot be mortgaged while its color group has buildings.`);
	}

	const next = cloneState(state);
	next.properties[tile.id].mortgaged = true;
	next.seats[seatIndex].chips += tile.mortgage;
	return completeAction(next, ownerId, [`${mentionPlayer(ownerId)} mortgaged ${tile.name} for $${tile.mortgage}.`]);
}

/** The owner pays the mortgage value plus interest and the lot charges rent again. */
export function applyUnmortgage(state: MonopolyState, ownerId: string, tileId: TileId): MonopolyResult {
	const owned = findOwnedTile(state, ownerId, tileId);
	if (!owned.ok) return rejectAction(owned.reason);
	const { seat, seatIndex, tile } = owned;
	if (!state.properties[tile.id].mortgaged) return rejectAction(`${tile.name} is not mortgaged.`);
	const cost = unmortgageCost(tile);
	if (seat.chips < cost) return rejectAction(`You need $${cost} to lift the mortgage on ${tile.name}.`);

	const next = cloneState(state);
	next.properties[tile.id].mortgaged = false;
	next.seats[seatIndex].chips -= cost;
	return completeAction(next, ownerId, [`${mentionPlayer(ownerId)} paid $${cost} to lift the mortgage on ${tile.name}.`]);
}

// ── build ───────────────────────────────────────────────────────────────────

/**
 * The active seat builds one house or one hotel on a lot of a color group it
 * owns whole. A hotel needs four houses on the lot and hands those four back to
 * the bank's stock.
 */
export function applyBuild(state: MonopolyState, ownerId: string, tileId: TileId, kind: BuildingKind): MonopolyResult {
	const turnRefusal = guardActiveTurn(state, ownerId);
	if (turnRefusal) return rejectAction(turnRefusal);
	if (state.phase !== "pre-roll") return rejectAction("Build before you roll.");
	const tile = findOwnableTile(tileId);
	if (!tile || tile.kind !== "property") return rejectAction("Only color lots take buildings.");

	const refusal = checkBuildRules(state, ownerId, tile, kind);
	if (refusal) return rejectAction(refusal);

	const next = cloneState(state);
	const property = next.properties[tile.id];
	activeSeatOf(next).chips -= tile.houseCost;
	if (kind === "house") {
		property.houses += 1;
		next.bank.houses -= 1;
		return completeAction(next, ownerId, [`${mentionPlayer(ownerId)} built a house on ${tile.name} for $${tile.houseCost}.`]);
	}
	next.bank.houses += property.houses;
	next.bank.hotels -= 1;
	property.houses = 0;
	property.hotel = true;
	return completeAction(next, ownerId, [`${mentionPlayer(ownerId)} built a hotel on ${tile.name} for $${tile.houseCost}.`]);
}

/** One build the active seat could make right now: the lot, what goes on it next, and what it costs. */
export interface BuildOption {
	tileId: TileId;
	name: string;
	kind: BuildingKind;
	cost: number;
}

/**
 * Every lot `ownerId` could build on at this moment, in board order, with the
 * building that would go up next (a hotel once a lot has four houses). Built on
 * the same rule check applyBuild runs, so the room's Build picker can never offer
 * a lot the build would then refuse (rule 17). Empty off turn and after the roll.
 */
export function listBuildOptions(state: MonopolyState, ownerId: string): BuildOption[] {
	if (guardActiveTurn(state, ownerId) || state.phase !== "pre-roll") return [];
	const options: BuildOption[] = [];
	for (const tile of BOARD) {
		if (tile.kind !== "property") continue;
		const kind = nextBuildingKind(state.properties[tile.id]);
		if (checkBuildRules(state, ownerId, tile, kind) !== null) continue;
		options.push({ tileId: tile.id, name: tile.name, kind, cost: tile.houseCost });
	}
	return options;
}

/** The building a lot takes next: houses up to four, then the hotel. */
export const nextBuildingKind = (property: PropertyState): BuildingKind => (property.houses >= MAX_HOUSES_PER_LOT ? "hotel" : "house");

// Every build rule in the order a player would want to hear about it, or null
// when the build is legal.
function checkBuildRules(state: MonopolyState, ownerId: string, tile: PropertyTile, kind: BuildingKind): string | null {
	const property = state.properties[tile.id];
	if (property.ownerId !== ownerId) return `You do not own ${tile.name}.`;
	const group = COLOR_GROUPS[tile.group].map((id) => state.properties[id]);
	if (group.some((lot) => lot.ownerId !== ownerId)) return `You need every lot in the ${tile.group} group to build.`;
	if (group.some((lot) => lot.mortgaged)) return `Lift every mortgage in the ${tile.group} group before building.`;
	if (property.hotel) return `${tile.name} already has a hotel.`;

	const ladderRefusal = kind === "house" ? checkHouseLadder(property, tile) : checkHotelLadder(property, tile);
	if (ladderRefusal) return ladderRefusal;
	// Even building: a lot may only rise when it is on the lowest rung of its
	// group, so no two lots ever differ by more than one building.
	if (buildingLevel(property) > Math.min(...group.map(buildingLevel))) {
		return `Build evenly: the other lots in the ${tile.group} group need more buildings first.`;
	}
	if (kind === "house" && state.bank.houses < 1) return "The bank has no houses left.";
	if (kind === "hotel" && state.bank.hotels < 1) return "The bank has no hotels left.";
	if (activeSeatOf(state).chips < tile.houseCost) return `You need $${tile.houseCost} to build on ${tile.name}.`;
	return null;
}

function checkHouseLadder(property: PropertyState, tile: PropertyTile): string | null {
	return property.houses >= MAX_HOUSES_PER_LOT ? `${tile.name} has ${MAX_HOUSES_PER_LOT} houses, so a hotel comes next.` : null;
}

function checkHotelLadder(property: PropertyState, tile: PropertyTile): string | null {
	return property.houses < MAX_HOUSES_PER_LOT ? `${tile.name} needs ${MAX_HOUSES_PER_LOT} houses before a hotel.` : null;
}
