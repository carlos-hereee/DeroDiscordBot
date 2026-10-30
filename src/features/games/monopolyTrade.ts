import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { JAIL_BAIL, OWNABLE_TILES, findOwnableTile, ownableTileName, type OwnableTile, type TileId } from "./monopolyBoard.js";
import { groupHasBuildings } from "./monopolyBuildings.js";
import { waitingDebt } from "./monopolyDebts.js";
import type { MonopolyResult, MonopolySeat, MonopolyState, TradeProposal } from "./monopolyState.js";
import { cloneState, completeAction, countNoun, mentionPlayer, rejectAction } from "./monopolySeats.js";

// ── monopolyTrade ───────────────────────────────────────────────────────────
// What:  a trade between two seats: one side proposes lots, chips and Get Out of
//        Jail Free cards for the other side's, and the other side accepts or
//        turns it down. One trade may be open at a time.
// Who:   the Phase 5 trade modal flow, through the re-exports in monopolyState.
//        The room handler checks the clicker; the engine re-checks it when the
//        caller names one.
// When:  at any point in a live match, on or off turn, which is the standard
//        rule. An open trade never moves the phase: the seat on the clock keeps
//        playing its turn while two players haggle, so "in-trade" stays unused.
// Where: the proposal sits on MonopolyState.pendingTrade until it resolves. Its
//        terms are private to the two parties until accepted (master plan
//        Section 1), so the trail lines for opening and turning one down never
//        name them; only an accepted trade, whose result the board shows
//        anyway, says what moved.
// How:   validateTrade runs on open AND on accept, because chips, lots and seats
//        can all change between the two (a mortgage, a bankruptcy, a sale). An
//        accept that passes moves everything on one clone, so a refusal leaves
//        the state exactly as it was and nothing ever half moves.
//
// A lot whose color group has buildings cannot be traded, per the standard
// rules: they are sold back first. A mortgaged lot moves still mortgaged and
// the receiver pays no interest on it, the same ruling as a bankruptcy transfer
// (see monopolyBankruptcy); charging the 10 percent fee is a Phase 5 prompt.
//
// An open trade lapses after MONOPOLY_TRADE_EXPIRY_MS (2026-10 item 276, audit P3), or one seat
// that never answers would block every other trade for the rest of the match: a lapsed offer
// cannot be accepted, and the next offer replaces it.
//
// A seat the match is waiting on for a debt may still trade to raise the cash,
// as the standard rules allow, but never give away more than it takes back
// (refuseDebtorGiveaway), or it could empty itself and then Pay into a $0
// bankruptcy that leaves its creditor nothing (2026-10 item 276, P2-2).

type TradeSide = TradeProposal["offer"];

// Seat indices rather than seats, so accept can find the same seats on the
// clone it is about to mutate (the same shape as monopolyBuildings' guard).
type TradeCheck = { ok: true; initiatorIndex: number; counterpartyIndex: number } | { ok: false; reason: string };

// ── public actions ──────────────────────────────────────────────────────────

/** The open trade while it still stands: null when none is open, or once it has lapsed. */
export function liveTrade(state: MonopolyState, now: number = Date.now()): TradeProposal | null {
	const trade = state.pendingTrade;
	return trade && !hasLapsed(trade, now) ? trade : null;
}

const hasLapsed = (trade: TradeProposal, now: number): boolean => now - trade.openedAt >= BOT_CONSTANTS.MONOPOLY_TRADE_EXPIRY_MS;

/** Opens a trade from `proposal.initiatorId` to `proposal.counterpartyId`, in place of one that lapsed. */
export function openTrade(state: MonopolyState, proposal: TradeProposal): MonopolyResult {
	if (liveTrade(state, proposal.openedAt)) return rejectAction("A trade is already waiting for an answer.");
	const check = validateTrade(state, proposal);
	if (!check.ok) return rejectAction(check.reason);

	const next = cloneState(state);
	const lapsed = state.pendingTrade;
	next.pendingTrade = structuredClone(proposal);
	const lines = [
		...(lapsed ? [`The trade ${mentionPlayer(lapsed.initiatorId)} offered ${mentionPlayer(lapsed.counterpartyId)} lapsed unanswered.`] : []),
		`${mentionPlayer(proposal.initiatorId)} offered ${mentionPlayer(proposal.counterpartyId)} a trade.`,
	];
	return completeAction(next, proposal.initiatorId, lines);
}

/**
 * The counterparty accepts the open trade and every item moves at once. When
 * `accepterId` is given it must be the counterparty, since only the side that
 * was asked can say yes.
 */
export function acceptTrade(state: MonopolyState, accepterId?: string, now: number = Date.now()): MonopolyResult {
	const trade = state.pendingTrade;
	if (!trade) return rejectAction("There is no trade waiting for an answer.");
	if (hasLapsed(trade, now)) return rejectAction("That trade lapsed unanswered, so nothing moved. Any player may offer a new one.");
	if (accepterId !== undefined && accepterId !== trade.counterpartyId) return rejectAction("Only the player this trade was offered to can accept it.");
	const check = validateTrade(state, trade);
	if (!check.ok) return rejectAction(`This trade can no longer go through. ${check.reason}`);

	const next = cloneState(state);
	const initiator = next.seats[check.initiatorIndex];
	const counterparty = next.seats[check.counterpartyIndex];
	moveTradeSide(next, initiator, counterparty, trade.offer);
	moveTradeSide(next, counterparty, initiator, trade.request);
	next.pendingTrade = null;
	return completeAction(next, counterparty.userId, [
		`${mentionPlayer(counterparty.userId)} accepted the trade from ${mentionPlayer(initiator.userId)}.`,
		`${mentionPlayer(initiator.userId)} gave ${describeTradeSide(trade.offer)}.`,
		`${mentionPlayer(counterparty.userId)} gave ${describeTradeSide(trade.request)}.`,
	]);
}

/**
 * Clears the open trade with nothing moved. Either party may end it: the
 * counterparty turns it down, or the initiator withdraws it. When `actorId` is
 * given it must be one of the two.
 */
export function rejectTrade(state: MonopolyState, actorId?: string): MonopolyResult {
	const trade = state.pendingTrade;
	if (!trade) return rejectAction("There is no trade waiting for an answer.");
	const actor = actorId ?? trade.counterpartyId;
	if (actor !== trade.initiatorId && actor !== trade.counterpartyId) return rejectAction("Only the two players in this trade can call it off.");

	const next = cloneState(state);
	next.pendingTrade = null;
	const line = actor === trade.initiatorId
		? `${mentionPlayer(actor)} withdrew the trade offered to ${mentionPlayer(trade.counterpartyId)}.`
		: `${mentionPlayer(actor)} turned down the trade from ${mentionPlayer(trade.initiatorId)}.`;
	return completeAction(next, actor, [line]);
}

// ── validation ──────────────────────────────────────────────────────────────

// Every rule a trade must pass, in the order a player would want to hear about
// it, and the two seats when it may go through.
function validateTrade(state: MonopolyState, trade: TradeProposal): TradeCheck {
	const refuse = (reason: string): TradeCheck => ({ ok: false, reason });
	if (state.phase === "finished") return refuse("The match is already over.");
	if (trade.initiatorId === trade.counterpartyId) return refuse("You cannot trade with yourself.");
	const initiatorIndex = findPlayingSeatIndex(state, trade.initiatorId);
	const counterpartyIndex = findPlayingSeatIndex(state, trade.counterpartyId);
	if (initiatorIndex === -1 || counterpartyIndex === -1) return refuse("Both players in a trade must still be playing.");
	if (isEmptySide(trade.offer) && isEmptySide(trade.request)) return refuse("A trade has to move something.");
	const sideRefusal =
		validateSide(state, state.seats[initiatorIndex], trade.offer) ??
		validateSide(state, state.seats[counterpartyIndex], trade.request) ??
		refuseDebtorGiveaway(state, trade);
	return sideRefusal ? refuse(sideRefusal) : { ok: true, initiatorIndex, counterpartyIndex };
}

// Every debtor in a held batch, on either side of the trade, must take back at
// least what it gives, measured as cash toward the debt (debtValueOf). The whole
// batch is checked, not only the debt the match is waiting on first, or the
// second debtor of a "collect from every player" card could empty itself before
// its turn to pay comes. Checked on accept too, since a debt can be held after
// the trade was offered.
function refuseDebtorGiveaway(state: MonopolyState, trade: TradeProposal): string | null {
	if (!waitingDebt(state)) return null;
	const heldDebtorIds = new Set(state.pendingDebt?.debts.map((debt) => debt.debtorId));
	for (const debtorId of [trade.initiatorId, trade.counterpartyId]) {
		if (!heldDebtorIds.has(debtorId)) continue;
		const gives = debtorId === trade.initiatorId ? trade.offer : trade.request;
		const takes = debtorId === trade.initiatorId ? trade.request : trade.offer;
		if (debtValueOf(state, gives, JAIL_BAIL) > debtValueOf(state, takes, 0)) {
			return `${mentionPlayer(debtorId)} owes a debt the match is waiting on, so they cannot give more than they get back in a trade.`;
		}
	}
	return null;
}

// One side of a trade as cash toward a debt, on the same rungs liquidationValue
// counts a seat's holdings by: chips at face, an unmortgaged lot at its mortgage
// (a traded lot never has buildings), a mortgaged lot at nothing more. A Get Out
// of Jail Free card counts at `jailCardValue`: the bail on the side the debtor
// gives, since a creditor takes the card in a default, and nothing on the side it
// takes, since liquidationValue cannot sell a card for cash (or a debtor could swap
// its cash for a card and Pay into a bankruptcy that hands its creditor the card).
function debtValueOf(state: MonopolyState, side: TradeSide, jailCardValue: number): number {
	let value = side.chips + side.gojf * jailCardValue;
	for (const tileId of side.properties) {
		const tile = findOwnableTile(tileId);
		if (tile && !state.properties[tile.id].mortgaged) value += tile.mortgage;
	}
	return value;
}

// The index of a seat still in the match, or -1 for an unknown or bankrupt one.
const findPlayingSeatIndex = (state: MonopolyState, userId: string): number =>
	state.seats.findIndex((seat) => seat.userId === userId && !seat.bankrupt);

const isEmptySide = (side: TradeSide): boolean => side.properties.length === 0 && side.chips === 0 && side.gojf === 0;

// What one seat is giving: whole, non negative amounts it actually holds, and
// lots it owns that the rules let it trade.
function validateSide(state: MonopolyState, giver: MonopolySeat, side: TradeSide): string | null {
	const player = mentionPlayer(giver.userId);
	if (!isWholeCount(side.chips) || !isWholeCount(side.gojf)) return "Chips and cards in a trade are whole numbers, zero or more.";
	if (side.chips > giver.chips) return `${player} does not have $${side.chips}.`;
	if (side.gojf > giver.gojfCards) return `${player} does not have ${countNoun(side.gojf, "Get Out of Jail Free card")}.`;
	if (new Set(side.properties).size !== side.properties.length) return "A lot can only be listed once in a trade.";
	for (const tileId of side.properties) {
		const refusal = validateLot(state, giver, tileId);
		if (refusal) return refusal;
	}
	return null;
}

function validateLot(state: MonopolyState, giver: MonopolySeat, tileId: TileId): string | null {
	const tile = findOwnableTile(tileId);
	if (!tile) return "That is not a lot on this board.";
	if (state.properties[tile.id].ownerId !== giver.userId) return `${mentionPlayer(giver.userId)} does not own ${tile.name}.`;
	if (groupHasBuildings(state, tile)) return `${tile.name} cannot be traded while its color group has buildings.`;
	return null;
}

const isWholeCount = (value: number): boolean => Number.isInteger(value) && value >= 0;

/**
 * Every lot `userId` owns that a trade could move right now, in board order. The
 * room's trade modal lists exactly these, using the same lot rule the trade
 * itself checks, so the modal never offers a lot the engine would refuse.
 */
export function tradableLots(state: MonopolyState, userId: string): OwnableTile[] {
	const seat = state.seats.find((candidate) => candidate.userId === userId && !candidate.bankrupt);
	if (!seat) return [];
	return OWNABLE_TILES.filter((tile) => validateLot(state, seat, tile.id) === null);
}

// ── moving ──────────────────────────────────────────────────────────────────

// Jail cards move as a count: which physical card a seat holds is derived from
// the decks (monopolyCards.heldJailCardIds), so no pile changes here.
function moveTradeSide(state: MonopolyState, giver: MonopolySeat, receiver: MonopolySeat, side: TradeSide): void {
	for (const tileId of side.properties) state.properties[tileId].ownerId = receiver.userId;
	giver.chips -= side.chips;
	receiver.chips += side.chips;
	giver.gojfCards -= side.gojf;
	receiver.gojfCards += side.gojf;
}

/**
 * One side of a trade in words: "Reader Dock, $100 and 1 Get Out of Jail Free
 * card", or "nothing". Shared by the accepted trade's trail lines and the room's
 * private review of an open offer, so the two can never describe it differently.
 */
export function describeTradeSide(side: TradeSide): string {
	const items = side.properties.map(ownableTileName);
	if (side.chips > 0) items.push(`$${side.chips}`);
	if (side.gojf > 0) items.push(countNoun(side.gojf, "Get Out of Jail Free card"));
	if (items.length === 0) return "nothing";
	if (items.length === 1) return items[0];
	return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
