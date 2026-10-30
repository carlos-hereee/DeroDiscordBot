import { BOARD, COLOR_GROUPS, JAIL_BAIL, MIN_AUCTION_BID, findOwnableTile, isOwnableTile, type OwnableTile, type TileId } from "./monopolyBoard.js";
import { liquidationValue } from "./monopolyBankruptcy.js";
import { activeSeatOf, findSeat, rejectAction } from "./monopolySeats.js";
import {
	acceptTrade,
	applyBuild,
	applyBuy,
	applyDebtDefault,
	applyEndTurn,
	applyJailChoice,
	applyMortgage,
	applyPayDebt,
	applyRoll,
	applySellBuilding,
	applySkip,
	listBuildOptions,
	listMortgageOptions,
	listSellOptions,
	placeBid,
	rejectTrade,
	waitingDebt,
	type BuildingKind,
	type JailChoice,
	type MonopolyResult,
	type MonopolySeat,
	type MonopolyState,
	type MortgageOption,
	type PendingDebt,
	type SellOption,
	type TradeProposal,
	unmortgageCost,
} from "./monopolyState.js";

// ── monopolyBot ─────────────────────────────────────────────────────────────
// What:  the heuristic a Dero bot seat plays a Monopoly match with. One question
//        (decideMonopolyMove: what should this bot do next?) and one answer
//        applied through the engine (applyMonopolyBotAction), plus the lot
//        valuation the auction and trade rules share (fairValue).
// Who:   the room layer that seats bots, which asks after every action whether a
//        bot has a move, applies it, and persists the result exactly as it would a
//        member's button press. The Vitest suite beside this file.
// When:  after every landed action, for every bot seat: on its turn for the turn
//        actions, and off turn for a trade offered to it, an auction it can bid
//        in, and a debt it owes.
// Where: beside the pure engine. It imports no discord.js, touches no database
//        and keeps no timers; it only reads MonopolyState and calls the same
//        apply functions a member's button reaches.
// How:   one decision per call, chosen by phase. Every move it returns comes from
//        the engine's own list helpers or rule checks, so the engine never has to
//        refuse a bot; the room calls decide again after each applied action,
//        which is how a bot that mortgages twice and then pays a debt takes three
//        separate steps.
//
// It does NOT propose trades (owner decision, 2026-10 item 250 Phase 5), close
// auctions (the room's round timer does), or unmortgage lots (no action kind for
// it in the room's contract).

// ── contract ────────────────────────────────────────────────────────────────

export type MonopolyBotAction =
	| { kind: "jail"; choice: JailChoice }
	| { kind: "roll" }
	| { kind: "buy"; tileId: TileId }
	| { kind: "skip" }
	| { kind: "build"; tileId: TileId; building: BuildingKind }
	| { kind: "mortgage"; tileId: TileId }
	| { kind: "sellBuilding"; tileId: TileId }
	| { kind: "payDebt" }
	// Nothing left to raise: the engine bankrupts the seat to its creditor.
	| { kind: "defaultDebt" }
	| { kind: "endTurn" }
	| { kind: "acceptTrade" }
	| { kind: "rejectTrade" }
	| { kind: "bid"; amount: number }
	// Nothing for this bot to do right now.
	| { kind: "wait" };

// ── tuning (owner decisions, 2026-10 item 250 Phase 5) ──────────────────────

// The cash a bot keeps on hand after building or paying bail. Below it, a single
// rent on a built lot could push the bot into a debt hold, so it stops spending.
const CASH_RESERVE = 500;
// Below this after a roll, the bot mortgages a lot that is not part of a monopoly.
const LOW_CASH_MORTGAGE_LINE = 200;
// Below this after a roll, a bot holding a hotel sells a building back.
const LOW_CASH_SELL_LINE = 100;
// A lot that completes the bot's own color group is worth double its list price
// to it, and one that keeps a single rival from completing theirs half again.
const COMPLETES_GROUP_MULTIPLIER = 2;
const BLOCKS_GROUP_MULTIPLIER = 1.5;
// A bot bids at most this share of a lot's fair value at auction.
const AUCTION_BID_SHARE = 0.5;
// What a Get Out of Jail Free card is worth in a trade: the bail it saves.
const JAIL_CARD_TRADE_VALUE = JAIL_BAIL;

const WAIT: MonopolyBotAction = { kind: "wait" };

// ── public API ──────────────────────────────────────────────────────────────

/**
 * What `botId` should do next in `state`, or `{ kind: "wait" }`. The answers to
 * other seats' moves (a trade offered to the bot, a debt it owes, an auction)
 * come before the turn actions, because the match waits on them. Never throws.
 */
export function decideMonopolyMove(state: MonopolyState, botId: string): MonopolyBotAction {
	try {
		return decideForSeat(state, botId);
	}
	catch {
		// ⚠️ Intentionally swallowed. The engine throws only on a corrupt state (an
		// unknown tile id in a stored deal), and a bot that throws would take the
		// room's action loop down with it. Waiting leaves the match for the idle
		// sweep, which is the same outcome a member who never clicks gets.
		return WAIT;
	}
}

/**
 * Applies one decided action through the engine for `botId`: exactly the engine
 * call a member's button would make, so the engine's refusals still guard it.
 * `wait` returns a refusal with the reason "wait", which the room reads as
 * "nothing to persist".
 */
export function applyMonopolyBotAction(state: MonopolyState, botId: string, action: MonopolyBotAction, rng: () => number, now: number): MonopolyResult {
	switch (action.kind) {
		case "jail":
			return applyOnBotTurn(state, botId, () => applyJailChoice(state, action.choice, rng, now));
		case "roll":
			return applyOnBotTurn(state, botId, () => applyRoll(state, rng, now));
		case "endTurn":
			return applyOnBotTurn(state, botId, () => applyEndTurn(state, now));
		case "buy":
			return applyBuy(state, botId, action.tileId);
		case "skip":
			return applySkip(state, botId, now);
		case "build":
			return applyBuild(state, botId, action.tileId, action.building);
		case "mortgage":
			return applyMortgage(state, botId, action.tileId);
		case "sellBuilding":
			return applySellBuilding(state, botId, action.tileId);
		case "payDebt":
			return applyPayDebt(state, botId, now);
		case "defaultDebt":
			return applyDefaultForBot(state, botId, now);
		case "acceptTrade":
			return acceptTrade(state, botId);
		case "rejectTrade":
			return rejectTrade(state, botId);
		case "bid":
			return placeBid(state, botId, action.amount);
		case "wait":
			return rejectAction("wait");
		default:
			return assertNeverAction(action);
	}
}

/**
 * A lot's fair value to `botId`: its list price, doubled when owning it completes
 * the bot's color group and raised by half when it is the last lot a single
 * rival needs. Transports and utilities stay at list price. A lot the bot already
 * holds is valued the same way, so giving away a lot of a finished group costs
 * the bot the completion premium. 0 for an id the board does not have.
 */
export function fairValue(state: MonopolyState, botId: string, tileId: TileId): number {
	const tile = findOwnableTile(tileId);
	if (!tile) return 0;
	if (tile.kind !== "property") return tile.price;
	const otherOwners = COLOR_GROUPS[tile.group].filter((id) => id !== tile.id).map((id) => state.properties[id].ownerId);
	if (otherOwners.every((ownerId) => ownerId === botId)) return tile.price * COMPLETES_GROUP_MULTIPLIER;
	if (isHeldWholeByOneRival(otherOwners, botId)) return Math.round(tile.price * BLOCKS_GROUP_MULTIPLIER);
	return tile.price;
}

// ── dispatch ────────────────────────────────────────────────────────────────

function decideForSeat(state: MonopolyState, botId: string): MonopolyBotAction {
	const seat = findSeat(state, botId);
	if (!seat || seat.bankrupt || state.phase === "finished") return WAIT;

	// ⚠️ The engine never sets the "in-trade" phase: an open trade sits on
	// pendingTrade while the turn plays on (see monopolyTrade). So a trade offered
	// to the bot is answered whatever the phase, on or off turn.
	const trade = state.pendingTrade;
	if (trade && trade.counterpartyId === botId) return decideTrade(state, botId, trade);

	// The debtor need not be the seat on the clock (a card can charge every seat),
	// and nothing else in the match moves until the debt settles.
	if (state.phase === "awaiting-debt") {
		const debt = waitingDebt(state);
		return debt && debt.debtorId === botId ? decideDebt(state, seat, debt) : WAIT;
	}
	if (state.phase === "in-auction") return decideBid(state, seat);

	if (activeSeatOf(state).userId !== botId) return WAIT;
	return decideTurn(state, seat);
}

function decideTurn(state: MonopolyState, seat: MonopolySeat): MonopolyBotAction {
	if (state.phase === "pre-roll") return seat.inJail ? decideJail(seat) : decidePreRoll(state, seat);
	if (state.phase === "awaiting-buy-or-skip") return decideBuyOrSkip(seat);
	if (state.phase === "post-roll") return decidePostRoll(state, seat);
	return WAIT;
}

// ── turn rules ──────────────────────────────────────────────────────────────

// A card first because it costs nothing; bail only while the reserve survives
// it, since a broke bot out of jail is a bot one rent away from a debt; else the
// free try at doubles. The third failed try forces bail inside the engine.
function decideJail(seat: MonopolySeat): MonopolyBotAction {
	if (seat.gojfCards > 0) return { kind: "jail", choice: "card" };
	if (seat.chips - JAIL_BAIL >= CASH_RESERVE) return { kind: "jail", choice: "bail" };
	return { kind: "jail", choice: "roll" };
}

// The engine only allows building before the roll (applyBuild refuses any other
// phase), so this is where every build happens, including the pre-roll a doubles
// reroll reopens. One build per decision: the room asks again after it lands.
function decidePreRoll(state: MonopolyState, seat: MonopolySeat): MonopolyBotAction {
	// A roll already taken this turn cannot be repeated, and an end turn is refused
	// before the roll, so the bot waits rather than return a move the engine refuses.
	if (state.rolledThisTurn) return WAIT;
	const build = chooseBuild(state, seat);
	if (build) return build;
	return { kind: "roll" };
}

// Always buy what the bot can afford (owner decision): a lot nobody owns is rent
// nobody collects, and a bot is never short of patience to wait for a monopoly.
function decideBuyOrSkip(seat: MonopolySeat): MonopolyBotAction {
	const tile = tileUnderSeat(seat);
	if (tile && seat.chips >= tile.price) return { kind: "buy", tileId: tile.id };
	return { kind: "skip" };
}

// After the roll the bot shores up its cash before handing the clock on: a lot
// off a monopoly is mortgaged first, because a monopoly's lots are what earn the
// big rents; a building only goes when the bot is nearly broke and has a hotel to
// spare. ⚠️ The owner's "build while cash > 500" rule cannot run here, because the
// engine refuses a build after the roll; decidePreRoll carries it instead.
function decidePostRoll(state: MonopolyState, seat: MonopolySeat): MonopolyBotAction {
	if (seat.chips < LOW_CASH_MORTGAGE_LINE) {
		const mortgage = cheapestOffMonopolyMortgage(state, seat.userId);
		if (mortgage) return { kind: "mortgage", tileId: mortgage.tileId };
	}
	if (seat.chips < LOW_CASH_SELL_LINE && ownsAHotel(state, seat.userId)) {
		const sale = firstSaleKeepingGroups(state, seat.userId);
		if (sale) return { kind: "sellBuilding", tileId: sale.tileId };
	}
	return { kind: "endTurn" };
}

// The first legal build (board order) that leaves the bot above the reserve.
// listBuildOptions already enforces the whole group, the even rule, the bank's
// stock and affordability, so only the reserve is checked here.
function chooseBuild(state: MonopolyState, seat: MonopolySeat): MonopolyBotAction | null {
	const option = listBuildOptions(state, seat.userId).find((candidate) => seat.chips - candidate.cost > CASH_RESERVE);
	return option ? { kind: "build", tileId: option.tileId, building: option.kind } : null;
}

// ── off turn rules ──────────────────────────────────────────────────────────

// Accepts a trade only when it comes out ahead on fair value. The accept is
// dry run through the engine first, because chips and lots can change between
// the offer and the answer (a mortgage, a sale), and a trade that no longer
// validates must be turned down rather than accepted and refused.
function decideTrade(state: MonopolyState, botId: string, trade: TradeProposal): MonopolyBotAction {
	const received = tradeSideValue(state, botId, trade.offer);
	const given = tradeSideValue(state, botId, trade.request);
	if (received - given <= 0) return { kind: "rejectTrade" };
	return acceptTrade(state, botId).ok ? { kind: "acceptTrade" } : { kind: "rejectTrade" };
}

// Raise the cash, then pay. applyPayDebt refuses while mortgaging and selling
// could still cover the shortfall, so the bot must do that raising itself first;
// when even everything it holds cannot cover it, it defaults.
function decideDebt(state: MonopolyState, seat: MonopolySeat, debt: PendingDebt): MonopolyBotAction {
	if (seat.chips >= debt.amount) return { kind: "payDebt" };
	if (liquidationValue(state, seat.userId) < debt.amount - seat.chips) return { kind: "defaultDebt" };
	return chooseCashRaise(state, seat.userId) ?? { kind: "defaultDebt" };
}

// Lots off a monopoly go first (lowest mortgage value first, so the least rent is
// lost), then buildings that come down one rung, then a monopoly lot whose buildings
// are gone, and a house shortage hotel sale that tears its whole group down only when
// nothing else is left (2026-10 item 280). The bare monopoly rung matters: a group with
// buildings cannot be mortgaged at all, so a bot that has sold its houses still needs
// it to reach the cash its liquidation value promised. The teardown stays the last rung
// rather than leaving the ladder, because liquidationValue counts its payout and a bot
// whose debt needs it must still find a legal step instead of defaulting.
function chooseCashRaise(state: MonopolyState, botId: string): MonopolyBotAction | null {
	const offMonopoly = cheapestOffMonopolyMortgage(state, botId);
	if (offMonopoly) return { kind: "mortgage", tileId: offMonopoly.tileId };
	const sale = firstSaleKeepingGroups(state, botId);
	if (sale) return { kind: "sellBuilding", tileId: sale.tileId };
	const anyMortgage = sortByMortgageValue(listMortgageOptions(state, botId))[0];
	if (anyMortgage) return { kind: "mortgage", tileId: anyMortgage.tileId };
	const teardown = listSellOptions(state, botId)[0];
	return teardown ? { kind: "sellBuilding", tileId: teardown.tileId } : null;
}

// The first sale (board order) that takes one rung off one lot. A house shortage hotel
// sale brings its whole color group down evenly (monopolyBuildings.isHouseShortageSale),
// which costs the bot that group's rents, so it is never a sale the bot picks while
// another one is on offer. Selling houses elsewhere also refills the bank's stock, which
// can end the shortage before the hotel ever has to go.
function firstSaleKeepingGroups(state: MonopolyState, botId: string): SellOption | undefined {
	return listSellOptions(state, botId).find((option) => !option.tearsDownGroup);
}

// One sealed bid of half the lot's fair value (capped at the bot's chips), and
// only when it would lead. ⚠️ Bids are sealed from the CHANNEL (their trail lines
// carry no amount), but they sit on the state, which is what the owner's "beats
// the current high bid" rule reads. The bot never uses them to snipe: it bids its
// own ceiling, never the high bid plus one.
function decideBid(state: MonopolyState, seat: MonopolySeat): MonopolyBotAction {
	const auction = state.pendingAuction;
	if (!auction || auction.bids[seat.userId] !== undefined) return WAIT;
	const ceiling = Math.floor(fairValue(state, seat.userId, auction.tileId) * AUCTION_BID_SHARE);
	const amount = Math.min(ceiling, seat.chips);
	if (amount < MIN_AUCTION_BID || amount <= highestBid(auction.bids)) return WAIT;
	return { kind: "bid", amount };
}

// ── apply guards ────────────────────────────────────────────────────────────

// Roll, end turn and the jail choices name no actor in the engine (the room
// checks the clicker), so the bot's own seat is checked here instead, or a bot
// could roll for the member on the clock.
function applyOnBotTurn(state: MonopolyState, botId: string, apply: () => MonopolyResult): MonopolyResult {
	if (state.phase === "finished") return rejectAction("The match is already over.");
	if (activeSeatOf(state).userId !== botId) return rejectAction("It is not your turn.");
	return apply();
}

// applyDebtDefault names no debtor either (it was written for the idle sweep), so
// the bot may only default a debt that is its own.
function applyDefaultForBot(state: MonopolyState, botId: string, now: number): MonopolyResult {
	const debt = waitingDebt(state);
	if (!debt || debt.debtorId !== botId) return rejectAction("There is no debt of yours waiting to be paid.");
	return applyDebtDefault(state, now);
}

function assertNeverAction(action: never): MonopolyResult {
	return rejectAction(`Unknown bot action ${JSON.stringify(action)}`);
}

// ── helpers ─────────────────────────────────────────────────────────────────

// True when every other lot of a group is held by the same seat, and that seat
// is not the bot: owning this lot is then the only thing stopping a rival's
// monopoly.
function isHeldWholeByOneRival(otherOwners: (string | null)[], botId: string): boolean {
	const [firstOwner] = otherOwners;
	if (firstOwner === null || firstOwner === undefined || firstOwner === botId) return false;
	return otherOwners.every((ownerId) => ownerId === firstOwner);
}

function tradeSideValue(state: MonopolyState, botId: string, side: TradeProposal["offer"]): number {
	const lotValue = side.properties.reduce((sum, tileId) => sum + tradedLotValue(state, botId, tileId), 0);
	return lotValue + side.chips + side.gojf * JAIL_CARD_TRADE_VALUE;
}

// A lot as a trade moves it: its fair value, less what lifting its mortgage would
// cost when it is mortgaged. A bot never lifts a mortgage, so without the discount
// it would take a mortgaged lot at full price and hold dead rent for the rest of
// the match (2026-10 item 280).
function tradedLotValue(state: MonopolyState, botId: string, tileId: TileId): number {
	const value = fairValue(state, botId, tileId);
	const tile = findOwnableTile(tileId);
	if (!tile || !state.properties[tile.id].mortgaged) return value;
	return Math.max(0, value - unmortgageCost(tile));
}

// The ownable lot the seat stands on. Only an ownable lot ever puts the match in
// "awaiting-buy-or-skip", so undefined here means a hand built state.
function tileUnderSeat(seat: MonopolySeat): OwnableTile | undefined {
	const tile = BOARD[seat.position];
	return tile && isOwnableTile(tile) ? tile : undefined;
}

// Whether `botId` owns every lot of this lot's color group. Transports and
// utilities belong to no group, so they are never part of a monopoly.
function isMonopolyLot(state: MonopolyState, botId: string, tileId: TileId): boolean {
	const tile = findOwnableTile(tileId);
	if (!tile || tile.kind !== "property") return false;
	return COLOR_GROUPS[tile.group].every((id) => state.properties[id].ownerId === botId);
}

function cheapestOffMonopolyMortgage(state: MonopolyState, botId: string): MortgageOption | undefined {
	const offMonopoly = listMortgageOptions(state, botId).filter((option) => !isMonopolyLot(state, botId, option.tileId));
	return sortByMortgageValue(offMonopoly)[0];
}

// A stable sort, so equal values keep the engine's board order and the choice
// stays deterministic for a seeded test.
const sortByMortgageValue = (options: MortgageOption[]): MortgageOption[] => [...options].sort((left, right) => left.amount - right.amount);

function ownsAHotel(state: MonopolyState, botId: string): boolean {
	return Object.values(state.properties).some((property) => property.ownerId === botId && property.hotel);
}

function highestBid(bids: Record<string, number>): number {
	return Math.max(0, ...Object.values(bids));
}
