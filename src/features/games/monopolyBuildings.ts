import {
	BOARD,
	BUILDING_RESALE_DIVISOR,
	COLOR_GROUPS,
	MAX_HOUSES_PER_LOT,
	OWNABLE_TILES,
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
//        a mortgage, sell a building back to the bank, and build houses and
//        hotels on a complete color group.
// Who:   the room's build picker and the inventory peek's mortgage and sell
//        controls, through the re-exports in monopolyState. The list functions
//        (listBuildOptions, listMortgageOptions, listUnmortgageOptions,
//        listSellOptions) share their rule checks with the actions, so a control
//        never offers a move the engine would refuse (rule 17). The building
//        helpers are shared with monopolyBankruptcy (the forced sale before a
//        bankruptcy) and monopolyTrade (which lots may move).
// When:  mortgages and sales at any point in a live match, by any seat still in
//        it, which is the standard rule. Building only on the owner's own turn
//        before the roll, per Section 1 of the plan.
// Where: split out of monopolyState (rule 18) along the "owner's holdings" seam.
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

// Every rule a mortgage must pass, shared by applyMortgage and listMortgageOptions
// so the room's mortgage picker and the action cannot disagree (rule 17).
function checkMortgage(state: MonopolyState, ownerId: string, tileId: TileId): OwnedTile {
	const owned = findOwnedTile(state, ownerId, tileId);
	if (!owned.ok) return owned;
	const { tile } = owned;
	if (state.properties[tile.id].mortgaged) return { ok: false, reason: `${tile.name} is already mortgaged.` };
	if (groupHasBuildings(state, tile)) return { ok: false, reason: `${tile.name} cannot be mortgaged while its color group has buildings.` };
	return owned;
}

// Every rule lifting a mortgage must pass, shared the same way with listUnmortgageOptions.
function checkUnmortgage(state: MonopolyState, ownerId: string, tileId: TileId): OwnedTile {
	const owned = findOwnedTile(state, ownerId, tileId);
	if (!owned.ok) return owned;
	const { seat, tile } = owned;
	if (!state.properties[tile.id].mortgaged) return { ok: false, reason: `${tile.name} is not mortgaged.` };
	const cost = unmortgageCost(tile);
	if (seat.chips < cost) return { ok: false, reason: `You need $${cost} to lift the mortgage on ${tile.name}.` };
	return owned;
}

/** The owner mortgages an unimproved lot and takes its mortgage value from the bank. */
export function applyMortgage(state: MonopolyState, ownerId: string, tileId: TileId): MonopolyResult {
	const check = checkMortgage(state, ownerId, tileId);
	if (!check.ok) return rejectAction(check.reason);
	const { seatIndex, tile } = check;

	const next = cloneState(state);
	next.properties[tile.id].mortgaged = true;
	next.seats[seatIndex].chips += tile.mortgage;
	return completeAction(next, ownerId, [`${mentionPlayer(ownerId)} mortgaged ${tile.name} for $${tile.mortgage}.`]);
}

/** The owner pays the mortgage value plus interest and the lot charges rent again. */
export function applyUnmortgage(state: MonopolyState, ownerId: string, tileId: TileId): MonopolyResult {
	const check = checkUnmortgage(state, ownerId, tileId);
	if (!check.ok) return rejectAction(check.reason);
	const { seatIndex, tile } = check;
	const cost = unmortgageCost(tile);

	const next = cloneState(state);
	next.properties[tile.id].mortgaged = false;
	next.seats[seatIndex].chips -= cost;
	return completeAction(next, ownerId, [`${mentionPlayer(ownerId)} paid $${cost} to lift the mortgage on ${tile.name}.`]);
}

/** One mortgage move a seat could make right now: the lot, and the chips it would get or pay. */
export interface MortgageOption {
	tileId: TileId;
	name: string;
	amount: number;
}

/**
 * Every lot `ownerId` could mortgage right now, in board order, with what the bank
 * would pay for it. Any seat still in the match may mortgage at any time (the
 * standard rule), so unlike building this does not depend on the turn.
 */
export function listMortgageOptions(state: MonopolyState, ownerId: string): MortgageOption[] {
	return OWNABLE_TILES.filter((tile) => checkMortgage(state, ownerId, tile.id).ok).map((tile) => ({
		tileId: tile.id,
		name: tile.name,
		amount: tile.mortgage,
	}));
}

/**
 * Every mortgaged lot `ownerId` could lift right now, in board order, with what it
 * would cost. A lot the seat cannot afford to lift is left out, the same as the
 * action would refuse it.
 */
export function listUnmortgageOptions(state: MonopolyState, ownerId: string): MortgageOption[] {
	return OWNABLE_TILES.filter((tile) => checkUnmortgage(state, ownerId, tile.id).ok).map((tile) => ({
		tileId: tile.id,
		name: tile.name,
		amount: unmortgageCost(tile),
	}));
}

// ── sell ────────────────────────────────────────────────────────────────────

/**
 * Sells one rung of buildings on `tile` back to the bank, mutating `state` (the
 * caller's clone), and returns the trail line. A house goes for half its cost. A
 * hotel goes for half its cost too and hands the four houses it replaced back to
 * the lot when the bank has them; when it does not, the standard house shortage
 * rule tears the lot down to bare ground and pays for all five rungs at once.
 * Shared by the player's own sale and the forced sale at bankruptcy.
 */
export function sellBuildingRung(state: MonopolyState, seat: MonopolySeat, tile: PropertyTile): string {
	const property = state.properties[tile.id];
	const player = mentionPlayer(seat.userId);
	const unitPrice = buildingSaleValue(tile);
	if (!property.hotel) {
		property.houses -= 1;
		state.bank.houses += 1;
		seat.chips += unitPrice;
		return `${player} sold a house on ${tile.name} back to the bank for $${unitPrice}.`;
	}
	state.bank.hotels += 1;
	property.hotel = false;
	if (state.bank.houses >= MAX_HOUSES_PER_LOT) {
		state.bank.houses -= MAX_HOUSES_PER_LOT;
		property.houses = MAX_HOUSES_PER_LOT;
		seat.chips += unitPrice;
		return `${player} sold the hotel on ${tile.name} back to the bank for $${unitPrice}.`;
	}
	const teardown = unitPrice * (MAX_HOUSES_PER_LOT + 1);
	seat.chips += teardown;
	return `${player} sold the hotel on ${tile.name} and, with no houses left in the bank, every rung under it for $${teardown}.`;
}

// What a sale of the next rung on this lot pays: the teardown price for a hotel
// the bank has no houses to give back for, otherwise one rung.
function rungSaleValue(state: MonopolyState, tile: PropertyTile): number {
	const unitPrice = buildingSaleValue(tile);
	const tearsDown = state.properties[tile.id].hotel && state.bank.houses < MAX_HOUSES_PER_LOT;
	return tearsDown ? unitPrice * (MAX_HOUSES_PER_LOT + 1) : unitPrice;
}

type SellCheck = { ok: true; seatIndex: number; tile: PropertyTile } | { ok: false; reason: string };

// Every rule a sale must pass, shared by applySellBuilding and listSellOptions.
// Selling runs the even building rule backwards: a lot may only drop a rung while
// it is the tallest in its group.
function checkSell(state: MonopolyState, ownerId: string, tileId: TileId): SellCheck {
	const owned = findOwnedTile(state, ownerId, tileId);
	if (!owned.ok) return owned;
	const { seatIndex, tile } = owned;
	if (tile.kind !== "property" || !hasBuildings(state.properties[tile.id])) return { ok: false, reason: `${tile.name} has no buildings to sell.` };
	const tallest = Math.max(...COLOR_GROUPS[tile.group].map((id) => buildingLevel(state.properties[id])));
	if (buildingLevel(state.properties[tile.id]) < tallest) {
		return { ok: false, reason: `Sell evenly: the other lots in the ${tile.group} group have more buildings.` };
	}
	return { ok: true, seatIndex, tile };
}

/** The owner sells one house, or its hotel, on a lot back to the bank at half what it cost. Any seat still playing, at any time. */
export function applySellBuilding(state: MonopolyState, ownerId: string, tileId: TileId): MonopolyResult {
	const check = checkSell(state, ownerId, tileId);
	if (!check.ok) return rejectAction(check.reason);
	const next = cloneState(state);
	return completeAction(next, ownerId, [sellBuildingRung(next, next.seats[check.seatIndex], check.tile)]);
}

/** One building a seat could sell right now: the lot, whether it is a house or the hotel, and what the bank pays. */
export interface SellOption {
	tileId: TileId;
	name: string;
	kind: BuildingKind;
	amount: number;
}

/** Every lot `ownerId` could sell a building from right now, in board order, with what the sale pays. */
export function listSellOptions(state: MonopolyState, ownerId: string): SellOption[] {
	const options: SellOption[] = [];
	for (const tile of BOARD) {
		if (tile.kind !== "property" || !checkSell(state, ownerId, tile.id).ok) continue;
		const kind: BuildingKind = state.properties[tile.id].hotel ? "hotel" : "house";
		options.push({ tileId: tile.id, name: tile.name, kind, amount: rungSaleValue(state, tile) });
	}
	return options;
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
