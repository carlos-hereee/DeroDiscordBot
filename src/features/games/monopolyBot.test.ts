import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { BOARD, JAIL_BAIL, isOwnableTile, type TileId } from "./monopolyBoard.js";
import { applyMonopolyBotAction, decideMonopolyMove, fairValue, type MonopolyBotAction } from "./monopolyBot.js";
import { closeAuction, createInitialState, type MonopolyResult, type MonopolyState, type TradeProposal } from "./monopolyState.js";
import { createSeededRng } from "@utils/seededRng.js";

// ── monopolyBot tests ───────────────────────────────────────────────────────
// Unit cases pin each owner rule (2026-10 item 250 Phase 5) on a hand built
// state; the simulations then let four bots play whole matches against each
// other and check that every move they chose was one the engine accepted.

// ── fixtures ────────────────────────────────────────────────────────────────

const RED = "dero-bot-red";
const BLUE = "dero-bot-blue";
const GREEN = "dero-bot-green";
const GOLD = "dero-bot-gold";
const BOTS = [RED, BLUE, GREEN, GOLD];
const NOW = 1_000;

// An open trade lapses against the clock (BOT_CONSTANTS.MONOPOLY_TRADE_EXPIRY_MS, 2026-10 item 276),
// so the engine's Date.now reads this file's fixed NOW; only Date is faked, never a timer.
beforeEach(() => {
	vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
});
afterEach(() => {
	vi.useRealTimers();
});
// Pins both deck orders for the hand built states.
const SEED = 250;

const BROWN_LOTS: TileId[] = ["vermillion-alley", "burnt-umber-row"];
const RAIL_ONE = "rail-one";

const newMatch = (auctionsEnabled = false): MonopolyState => createInitialState([RED, BLUE], { auctionsEnabled }, NOW, SEED);

// A copy of `state` changed by `mutate`, so each case reads as the facts it sets.
function arrange(state: MonopolyState, mutate: (draft: MonopolyState) => void): MonopolyState {
	const draft = structuredClone(state);
	mutate(draft);
	return draft;
}

const seatOf = (state: MonopolyState, userId: string) => {
	const seat = state.seats.find((candidate) => candidate.userId === userId);
	if (!seat) throw new Error(`no seat ${userId}`);
	return seat;
};

function giveLots(state: MonopolyState, ownerId: string, tileIds: TileId[]): void {
	for (const tileId of tileIds) state.properties[tileId].ownerId = ownerId;
}

function setChips(state: MonopolyState, userId: string, chips: number): void {
	seatOf(state, userId).chips = chips;
}

function boardIndex(tileId: TileId): number {
	return BOARD.findIndex((tile) => isOwnableTile(tile) && tile.id === tileId);
}

function expectOk(result: MonopolyResult): MonopolyState {
	if (!result.ok) throw new Error(`expected ok, got refusal: ${result.reason}`);
	return result.state;
}

// A debt hold on `debtorId` for `amount`, owed to the bank, as the engine stores one.
function holdDebt(state: MonopolyState, debtorId: string, amount: number): void {
	state.pendingDebt = { debts: [{ debtorId, creditorId: "bank", amount }], resumePhase: "post-roll", moveAfter: null };
	state.phase = "awaiting-debt";
}

function openTradeTo(state: MonopolyState, proposal: Partial<Pick<TradeProposal, "offer" | "request">>): void {
	const empty = { properties: [], chips: 0, gojf: 0 };
	state.pendingTrade = {
		initiatorId: BLUE,
		counterpartyId: RED,
		offer: proposal.offer ?? empty,
		request: proposal.request ?? empty,
		openedAt: NOW,
	};
}

// ── fairValue ───────────────────────────────────────────────────────────────

describe("fairValue", () => {
	it("is the list price for a lot that changes nothing", () => {
		expect(fairValue(newMatch(), RED, "vermillion-alley")).toBe(60);
	});

	it("doubles for the lot that completes the bot's color group", () => {
		const state = arrange(newMatch(), (draft) => giveLots(draft, RED, ["burnt-umber-row"]));
		expect(fairValue(state, RED, "vermillion-alley")).toBe(120);
	});

	it("rises by half for the lot one rival needs to complete a group", () => {
		const state = arrange(newMatch(), (draft) => giveLots(draft, BLUE, ["teal-vale", "teal-ridge"]));
		expect(fairValue(state, RED, "reader-dock")).toBe(150);
	});

	it("keeps transports at list price and answers 0 for an unknown id", () => {
		expect(fairValue(newMatch(), RED, RAIL_ONE)).toBe(200);
		expect(fairValue(newMatch(), RED, "not-a-lot")).toBe(0);
	});
});

// ── turn rules ──────────────────────────────────────────────────────────────

describe("jail", () => {
	const jailed = (chips: number, cards: number): MonopolyState =>
		arrange(newMatch(), (draft) => {
			const seat = seatOf(draft, RED);
			seat.inJail = true;
			seat.jailTurnsRemaining = 3;
			seat.position = 10;
			seat.chips = chips;
			seat.gojfCards = cards;
		});

	it("spends a Get Out of Jail Free card first", () => {
		expect(decideMonopolyMove(jailed(1500, 1), RED)).toEqual({ kind: "jail", choice: "card" });
	});

	it("pays bail while the reserve survives it", () => {
		expect(decideMonopolyMove(jailed(500 + JAIL_BAIL, 0), RED)).toEqual({ kind: "jail", choice: "bail" });
	});

	it("rolls for doubles when bail would dip under the reserve", () => {
		const state = jailed(500 + JAIL_BAIL - 1, 0);
		const decision = decideMonopolyMove(state, RED);
		expect(decision).toEqual({ kind: "jail", choice: "roll" });
		expect(applyMonopolyBotAction(state, RED, decision, createSeededRng(1), NOW).ok).toBe(true);
	});
});

describe("pre-roll", () => {
	it("rolls when there is nothing to build", () => {
		expect(decideMonopolyMove(newMatch(), RED)).toEqual({ kind: "roll" });
	});

	it("builds on a complete group first while the reserve survives the build", () => {
		const state = arrange(newMatch(), (draft) => giveLots(draft, RED, BROWN_LOTS));
		const decision = decideMonopolyMove(state, RED);
		expect(decision).toEqual({ kind: "build", tileId: "vermillion-alley", building: "house" });
		const built = expectOk(applyMonopolyBotAction(state, RED, decision, createSeededRng(1), NOW));
		// The even rule moves the next build to the other brown lot.
		expect(decideMonopolyMove(built, RED)).toEqual({ kind: "build", tileId: "burnt-umber-row", building: "house" });
	});

	it("rolls instead of building when the build would leave 500 or less", () => {
		const state = arrange(newMatch(), (draft) => {
			giveLots(draft, RED, BROWN_LOTS);
			setChips(draft, RED, 550);
		});
		expect(decideMonopolyMove(state, RED)).toEqual({ kind: "roll" });
	});
});

describe("awaiting buy or skip", () => {
	const standingOn = (tileId: TileId, chips: number): MonopolyState =>
		arrange(newMatch(), (draft) => {
			seatOf(draft, RED).position = boardIndex(tileId);
			setChips(draft, RED, chips);
			draft.phase = "awaiting-buy-or-skip";
			draft.rolledThisTurn = true;
		});

	it("buys a lot it can afford", () => {
		const state = standingOn(RAIL_ONE, 200);
		const decision = decideMonopolyMove(state, RED);
		expect(decision).toEqual({ kind: "buy", tileId: RAIL_ONE });
		expect(expectOk(applyMonopolyBotAction(state, RED, decision, createSeededRng(1), NOW)).properties[RAIL_ONE].ownerId).toBe(RED);
	});

	it("skips a lot it cannot afford", () => {
		const state = standingOn(RAIL_ONE, 199);
		const decision = decideMonopolyMove(state, RED);
		expect(decision).toEqual({ kind: "skip" });
		expect(applyMonopolyBotAction(state, RED, decision, createSeededRng(1), NOW).ok).toBe(true);
	});
});

describe("post-roll", () => {
	const afterRoll = (mutate: (draft: MonopolyState) => void): MonopolyState =>
		arrange(newMatch(), (draft) => {
			draft.phase = "post-roll";
			draft.rolledThisTurn = true;
			mutate(draft);
		});

	it("ends the turn with healthy cash", () => {
		const state = afterRoll((draft) => giveLots(draft, RED, [RAIL_ONE]));
		expect(decideMonopolyMove(state, RED)).toEqual({ kind: "endTurn" });
	});

	it("mortgages the cheapest lot off a monopoly when cash is under 200", () => {
		const state = afterRoll((draft) => {
			giveLots(draft, RED, [...BROWN_LOTS, RAIL_ONE, "reader-dock"]);
			setChips(draft, RED, 150);
		});
		// The brown pair is a monopoly, so the 50 chip Reader Dock goes before the transport.
		expect(decideMonopolyMove(state, RED)).toEqual({ kind: "mortgage", tileId: "reader-dock" });
	});

	it("sells a building when under 100 with a hotel and nothing to mortgage", () => {
		const state = afterRoll((draft) => {
			giveLots(draft, RED, BROWN_LOTS);
			for (const tileId of BROWN_LOTS) draft.properties[tileId].hotel = true;
			draft.bank.hotels -= 2;
			setChips(draft, RED, 50);
		});
		const decision = decideMonopolyMove(state, RED);
		expect(decision).toEqual({ kind: "sellBuilding", tileId: "vermillion-alley" });
		expect(applyMonopolyBotAction(state, RED, decision, createSeededRng(1), NOW).ok).toBe(true);
	});

	it("ends the turn rather than sell a hotel that would tear its group down in a house shortage (2026-10 item 280)", () => {
		const state = afterRoll((draft) => {
			giveLots(draft, RED, BROWN_LOTS);
			for (const tileId of BROWN_LOTS) draft.properties[tileId].hotel = true;
			draft.bank.hotels -= 2;
			draft.bank.houses = 0;
			setChips(draft, RED, 50);
		});
		expect(decideMonopolyMove(state, RED)).toEqual({ kind: "endTurn" });
	});

	it("does not sell houses when it holds no hotel", () => {
		const state = afterRoll((draft) => {
			giveLots(draft, RED, BROWN_LOTS);
			for (const tileId of BROWN_LOTS) draft.properties[tileId].houses = 2;
			draft.bank.houses -= 4;
			setChips(draft, RED, 50);
		});
		expect(decideMonopolyMove(state, RED)).toEqual({ kind: "endTurn" });
	});
});

// ── off turn rules ──────────────────────────────────────────────────────────

describe("auction", () => {
	const auctioning = (tileId: TileId, bids: Record<string, number>): MonopolyState =>
		arrange(newMatch(true), (draft) => {
			draft.phase = "in-auction";
			draft.pendingAuction = { tileId, bids, roundOpenedAt: NOW, skippedBy: RED };
		});

	it("bids half the lot's fair value, off turn too", () => {
		const state = auctioning(RAIL_ONE, {});
		const decision = decideMonopolyMove(state, BLUE);
		expect(decision).toEqual({ kind: "bid", amount: 100 });
		expect(applyMonopolyBotAction(state, BLUE, decision, createSeededRng(1), NOW).ok).toBe(true);
	});

	it("bids once, and not at all when half its fair value does not lead", () => {
		expect(decideMonopolyMove(auctioning(RAIL_ONE, { [BLUE]: 100 }), BLUE)).toEqual({ kind: "wait" });
		expect(decideMonopolyMove(auctioning(RAIL_ONE, { [RED]: 100 }), BLUE)).toEqual({ kind: "wait" });
	});

	it("caps the bid at its chips", () => {
		const state = arrange(auctioning(RAIL_ONE, { [RED]: 20 }), (draft) => setChips(draft, BLUE, 40));
		expect(decideMonopolyMove(state, BLUE)).toEqual({ kind: "bid", amount: 40 });
	});
});

describe("trade offered to the bot", () => {
	it("accepts when it receives more fair value than it gives, off turn", () => {
		const state = arrange(newMatch(), (draft) => {
			draft.activeSeatIndex = 1;
			giveLots(draft, BLUE, [RAIL_ONE]);
			giveLots(draft, RED, ["reader-dock"]);
			openTradeTo(draft, { offer: { properties: [RAIL_ONE], chips: 0, gojf: 0 }, request: { properties: ["reader-dock"], chips: 50, gojf: 0 } });
		});
		const decision = decideMonopolyMove(state, RED);
		expect(decision).toEqual({ kind: "acceptTrade" });
		expect(expectOk(applyMonopolyBotAction(state, RED, decision, createSeededRng(1), NOW)).properties[RAIL_ONE].ownerId).toBe(RED);
	});

	it("counts jail cards at 50 and rejects an even or losing trade", () => {
		const even = arrange(newMatch(), (draft) => {
			seatOf(draft, BLUE).gojfCards = 1;
			openTradeTo(draft, { offer: { properties: [], chips: 0, gojf: 1 }, request: { properties: [], chips: JAIL_BAIL, gojf: 0 } });
		});
		expect(decideMonopolyMove(even, RED)).toEqual({ kind: "rejectTrade" });
		expect(applyMonopolyBotAction(even, RED, { kind: "rejectTrade" }, createSeededRng(1), NOW).ok).toBe(true);
	});

	it("values a lot that completes its group at double", () => {
		const state = arrange(newMatch(), (draft) => {
			giveLots(draft, RED, ["burnt-umber-row"]);
			giveLots(draft, BLUE, ["vermillion-alley"]);
			openTradeTo(draft, { offer: { properties: ["vermillion-alley"], chips: 0, gojf: 0 }, request: { properties: [], chips: 100, gojf: 0 } });
		});
		expect(decideMonopolyMove(state, RED)).toEqual({ kind: "acceptTrade" });
	});

	it("takes a mortgaged lot at its price less the cost of lifting it, since a bot never lifts one (2026-10 item 280)", () => {
		const offerMortgagedRail = (chips: number): MonopolyState =>
			arrange(newMatch(), (draft) => {
				giveLots(draft, BLUE, [RAIL_ONE]);
				draft.properties[RAIL_ONE].mortgaged = true;
				openTradeTo(draft, { offer: { properties: [RAIL_ONE], chips: 0, gojf: 0 }, request: { properties: [], chips, gojf: 0 } });
			});
		// Rail One lists at $200 and costs $110 to lift: worth $90 to a bot.
		expect(decideMonopolyMove(offerMortgagedRail(150), RED)).toEqual({ kind: "rejectTrade" });
		expect(decideMonopolyMove(offerMortgagedRail(80), RED)).toEqual({ kind: "acceptTrade" });
	});

	it("rejects a winning trade the engine would no longer let through", () => {
		const state = arrange(newMatch(), (draft) => {
			// Blue offered chips it has since spent.
			setChips(draft, BLUE, 10);
			openTradeTo(draft, { offer: { properties: [], chips: 500, gojf: 0 }, request: { properties: [], chips: 0, gojf: 0 } });
		});
		expect(decideMonopolyMove(state, RED)).toEqual({ kind: "rejectTrade" });
	});
});

describe("debt", () => {
	// 10 + 100 (the transport) + 25 (the house) + 30 + 30 (the bare brown pair) = 195, which covers 175.
	it("raises cash off monopoly first, then buildings, then the monopoly, then pays", () => {
		let state = arrange(newMatch(), (draft) => {
			// Blue is on the clock: the debtor need not be.
			draft.activeSeatIndex = 1;
			giveLots(draft, RED, [...BROWN_LOTS, RAIL_ONE]);
			draft.properties["vermillion-alley"].houses = 1;
			draft.bank.houses -= 1;
			setChips(draft, RED, 10);
			holdDebt(draft, RED, 175);
		});
		const decisions: MonopolyBotAction[] = [];
		for (let step = 0; step < 10 && state.phase === "awaiting-debt"; step++) {
			const decision = decideMonopolyMove(state, RED);
			decisions.push(decision);
			state = expectOk(applyMonopolyBotAction(state, RED, decision, createSeededRng(1), NOW));
		}
		expect(decisions).toEqual([
			{ kind: "mortgage", tileId: RAIL_ONE },
			{ kind: "sellBuilding", tileId: "vermillion-alley" },
			{ kind: "mortgage", tileId: "vermillion-alley" },
			{ kind: "mortgage", tileId: "burnt-umber-row" },
			{ kind: "payDebt" },
		]);
		expect(seatOf(state, RED).bankrupt).toBe(false);
	});

	// ── a house shortage (2026-10 item 280) ──
	// A brown hotel sold with an empty bank tears the brown group down, so the bot sells
	// the dark blue houses and mortgages the bare dark blue pair first:
	// 10 + 100 + 100 + 175 + 200 = 585 covers 400 without the brown hotels.
	const DARK_BLUE_LOTS: TileId[] = ["jade-reach", "postern-lane"];
	const shortageDebt = (amount: number, withDarkBlue: boolean): MonopolyState =>
		arrange(newMatch(), (draft) => {
			draft.activeSeatIndex = 1;
			giveLots(draft, RED, BROWN_LOTS);
			for (const tileId of BROWN_LOTS) draft.properties[tileId].hotel = true;
			draft.bank.hotels -= 2;
			if (withDarkBlue) {
				giveLots(draft, RED, DARK_BLUE_LOTS);
				for (const tileId of DARK_BLUE_LOTS) draft.properties[tileId].houses = 1;
			}
			draft.bank.houses = 0;
			setChips(draft, RED, 10);
			holdDebt(draft, RED, amount);
		});
	const raiseAndPay = (start: MonopolyState): { decisions: MonopolyBotAction[]; state: MonopolyState } => {
		let state = start;
		const decisions: MonopolyBotAction[] = [];
		for (let step = 0; step < 10 && state.phase === "awaiting-debt"; step++) {
			const decision = decideMonopolyMove(state, RED);
			decisions.push(decision);
			state = expectOk(applyMonopolyBotAction(state, RED, decision, createSeededRng(1), NOW));
		}
		return { decisions, state };
	};

	it("sells houses and mortgages a bare monopoly before a hotel sale that tears its group down", () => {
		const { decisions, state } = raiseAndPay(shortageDebt(400, true));
		expect(decisions).toEqual([
			{ kind: "sellBuilding", tileId: "jade-reach" },
			{ kind: "sellBuilding", tileId: "postern-lane" },
			{ kind: "mortgage", tileId: "jade-reach" },
			{ kind: "mortgage", tileId: "postern-lane" },
			{ kind: "payDebt" },
		]);
		for (const tileId of BROWN_LOTS) expect(state.properties[tileId].hotel).toBe(true);
		expect(seatOf(state, RED).bankrupt).toBe(false);
	});

	it("still takes the teardown sale when nothing else raises the cash", () => {
		const { decisions, state } = raiseAndPay(shortageDebt(200, false));
		expect(decisions[0]).toEqual({ kind: "sellBuilding", tileId: "vermillion-alley" });
		expect(decisions.at(-1)).toEqual({ kind: "payDebt" });
		expect(seatOf(state, RED).bankrupt).toBe(false);
	});

	it("defaults when nothing it holds could cover the debt", () => {
		const state = arrange(newMatch(), (draft) => {
			setChips(draft, RED, 10);
			holdDebt(draft, RED, 500);
		});
		const decision = decideMonopolyMove(state, RED);
		expect(decision).toEqual({ kind: "defaultDebt" });
		expect(seatOf(expectOk(applyMonopolyBotAction(state, RED, decision, createSeededRng(1), NOW)), RED).bankrupt).toBe(true);
	});

	it("waits on a debt that belongs to another seat", () => {
		const state = arrange(newMatch(), (draft) => holdDebt(draft, BLUE, 100));
		expect(decideMonopolyMove(state, RED)).toEqual({ kind: "wait" });
	});
});

// ── waiting and guards ──────────────────────────────────────────────────────

describe("waiting and the apply guards", () => {
	it("waits off turn, in a finished match, and for a seat not in the match", () => {
		expect(decideMonopolyMove(newMatch(), BLUE)).toEqual({ kind: "wait" });
		expect(decideMonopolyMove(arrange(newMatch(), (draft) => (draft.phase = "finished")), RED)).toEqual({ kind: "wait" });
		expect(decideMonopolyMove(newMatch(), "stranger")).toEqual({ kind: "wait" });
	});

	it("answers wait with a refusal and never acts on another seat's turn", () => {
		const rng = createSeededRng(1);
		expect(applyMonopolyBotAction(newMatch(), RED, { kind: "wait" }, rng, NOW)).toEqual({ ok: false, reason: "wait" });
		expect(applyMonopolyBotAction(newMatch(), BLUE, { kind: "roll" }, rng, NOW).ok).toBe(false);
		expect(applyMonopolyBotAction(newMatch(), BLUE, { kind: "endTurn" }, rng, NOW).ok).toBe(false);
		const blueOwes = arrange(newMatch(), (draft) => holdDebt(draft, BLUE, 5000));
		expect(applyMonopolyBotAction(blueOwes, RED, { kind: "defaultDebt" }, rng, NOW).ok).toBe(false);
	});
});

// ── simulations ─────────────────────────────────────────────────────────────

// ⚠️ Bot only Monopoly can stalemate, and does so on about half of all seeds.
// Bots never propose trades (owner decision), so a monopoly only forms by luck,
// a bankruptcy transfer or an auction, and without one no rent is big enough to
// bankrupt anyone while GO salary keeps adding chips. A scan of seeds 1 to 20 at
// 20,000 actions finished 8 seeds plain and 9 with auctions, the rest running at
// the cap. So the finishing seeds below assert a finish, and the stalemate seeds
// assert only that every move was legal up to the cap, which is the endless
// guard. The auction finishers include seeds whose bots bid and skip, which the
// coverage test below needs. Re-scan when a rule changes how many rolls a turn
// gets: the seeds move with it. The room layer needs its own end for a table of
// bots (see the report for 2026-10 item 250 Phase 5).
const ACTION_CAP = 20_000;
const FINISHING_SEEDS: Record<"plain" | "auctions", number[]> = { plain: [6, 10, 14, 18], auctions: [6, 10, 11, 15, 17] };
const STALEMATE_SEEDS = [1, 4];
const SIMULATION_TIMEOUT_MS = 120_000;

interface SimulationResult {
	state: MonopolyState;
	actions: number;
	refusals: string[];
	kinds: Set<MonopolyBotAction["kind"]>;
}

// One action per pass: the first seat (in seat order) with a move plays it. When
// no seat has one during an auction, every bot has bid or passed, so the test
// closes the round, which the room's timer does in play.
function simulateBotMatch(seed: number, auctionsEnabled: boolean): SimulationResult {
	const rng = createSeededRng(seed);
	let state = createInitialState(BOTS, { auctionsEnabled }, NOW, seed);
	const refusals: string[] = [];
	const kinds = new Set<MonopolyBotAction["kind"]>();
	let actions = 0;
	while (state.phase !== "finished" && actions < ACTION_CAP) {
		const mover = BOTS.map((botId) => ({ botId, action: decideMonopolyMove(state, botId) })).find((entry) => entry.action.kind !== "wait");
		actions += 1;
		if (!mover) {
			if (state.phase !== "in-auction") {
				refusals.push(`every bot waits in ${state.phase}`);
				break;
			}
			state = expectOk(closeAuction(state));
			continue;
		}
		kinds.add(mover.action.kind);
		const result = applyMonopolyBotAction(state, mover.botId, mover.action, rng, NOW);
		if (!result.ok) {
			refusals.push(`${mover.botId} ${JSON.stringify(mover.action)}: ${result.reason}`);
			break;
		}
		state = result.state;
	}
	return { state, actions, refusals, kinds };
}

describe.each([
	{ mode: "plain" as const, auctionsEnabled: false },
	{ mode: "auctions" as const, auctionsEnabled: true },
])("four bots playing each other ($mode)", ({ mode, auctionsEnabled }) => {
	it.each(FINISHING_SEEDS[mode])("seed %i: every move is legal and the match finishes", (seed) => {
		const { state, refusals } = simulateBotMatch(seed, auctionsEnabled);
		expect(refusals).toEqual([]);
		expect(state.phase).toBe("finished");
		expect(state.seats.filter((seat) => seat.bankrupt)).toHaveLength(BOTS.length - 1);
		expect(state.winnerId).toBe(state.seats.find((seat) => !seat.bankrupt)?.userId);
	}, SIMULATION_TIMEOUT_MS);

	it.each(STALEMATE_SEEDS)("seed %i: a stalemate stays legal up to the action cap", (seed) => {
		const { state, refusals, actions } = simulateBotMatch(seed, auctionsEnabled);
		expect(refusals).toEqual([]);
		expect(state.phase === "finished" || actions === ACTION_CAP).toBe(true);
	}, SIMULATION_TIMEOUT_MS);
});

describe("simulation coverage", () => {
	it("exercises every kind of move a bot makes across the finishing seeds", () => {
		const kinds = new Set<string>();
		for (const seed of FINISHING_SEEDS.auctions) {
			for (const kind of simulateBotMatch(seed, true).kinds) kinds.add(kind);
		}
		for (const kind of ["roll", "buy", "skip", "build", "mortgage", "endTurn", "bid", "jail"]) expect(kinds).toContain(kind);
	}, SIMULATION_TIMEOUT_MS);
});
