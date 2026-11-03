import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: {
		holdBuyInCharge: vi.fn(),
		recordBuyInCharge: vi.fn(),
		dropBuyInCharge: vi.fn(),
		releaseBuyInCharges: vi.fn(),
		takeBuyInPaid: vi.fn(),
		takePotPayer: vi.fn(),
		takeHeldBuyIn: vi.fn(),
		findByRoomId: vi.fn(),
	},
}));
vi.mock("@db/stores/chipWalletStore.js", () => ({ chipWalletStore: { debit: vi.fn(), credit: vi.fn(), debitWithReceipt: vi.fn(), refundReceipt: vi.fn(), closeReceipt: vi.fn() } }));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn() } }));

import {
	buyInModal,
	chargeJoiner,
	chargeSeats,
	chargeSoloTable,
	draftBuyInOf,
	isChipDraft,
	isValidDraftBuyIn,
	refundAllJoiners,
	refundClaimedPayers,
	refundHeldBuyIns,
	refundJoiners,
	refundOpenedSeats,
	refundSeatsDirectly,
	seatsAtStart,
	settleDraftBuyIns,
} from "./holdemDraftBuyIn.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { chipWalletStore } from "@db/stores/chipWalletStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── the Hold'em buy in on the challenge card (2026-10 item 257 Phase 4a) ──
// Paid from the wallet on Join, given back on decline, removal and cancel, and the room opens
// with the payers seated. Driven over mocked stores: the ledger's conditional writes are the
// store's, and the order of hold, take, record and give back is what is pinned here. A charge
// onto the ledger is taken with a wallet receipt (2026-10 item 278, gap G3); a crash between its
// steps is pinned in startClaimCrash.test.ts.

const storeMock = gameRoomStore as unknown as Record<
	"holdBuyInCharge" | "recordBuyInCharge" | "dropBuyInCharge" | "releaseBuyInCharges" | "takeBuyInPaid" | "takePotPayer" | "takeHeldBuyIn" | "findByRoomId",
	ReturnType<typeof vi.fn>
>;
const walletMock = chipWalletStore as unknown as Record<"debit" | "credit" | "debitWithReceipt" | "refundReceipt" | "closeReceipt", ReturnType<typeof vi.fn>>;
const configMock = guildConfigStore as unknown as { findByGuildId: ReturnType<typeof vi.fn> };

const HOST = "host";
const GUEST = "guest";
// A member's one global wallet (2026-10 item 267): the key names the member alone.
const key = (userId: string) => ({ userId });

function draft(overrides: Partial<IGameRoom> = {}): IGameRoom {
	return {
		roomId: "room-1",
		guildId: "guild-1",
		game: "holdem",
		hostId: HOST,
		status: "draft",
		network: false,
		botSeats: 0,
		holdemBuyIn: 2_500,
		buyInPaidBy: [],
		...overrides,
	} as unknown as IGameRoom;
}

beforeEach(() => {
	vi.clearAllMocks();
	configMock.findByGuildId.mockResolvedValue({ chipEconomyEnabled: true });
	walletMock.debit.mockResolvedValue({ balance: 0 });
	walletMock.debitWithReceipt.mockResolvedValue({ balance: 0 });
	walletMock.credit.mockResolvedValue({ balance: 0 });
	walletMock.refundReceipt.mockResolvedValue({ balance: 0 });
	storeMock.holdBuyInCharge.mockResolvedValue({});
	storeMock.recordBuyInCharge.mockResolvedValue({});
	storeMock.releaseBuyInCharges.mockResolvedValue(null);
	storeMock.takeBuyInPaid.mockResolvedValue({});
	storeMock.findByRoomId.mockResolvedValue(draft());
});

describe("the amount", () => {
	it("is the host's, or the standard stack, inside the table's bounds", () => {
		expect(draftBuyInOf(draft())).toBe(2_500);
		expect(draftBuyInOf(draft({ holdemBuyIn: null }))).toBe(BOT_CONSTANTS.HOLDEM_STARTING_STACK);
		expect(isValidDraftBuyIn(199)).toBe(false);
		expect(isValidDraftBuyIn(200)).toBe(true);
		expect(isValidDraftBuyIn(1_000_001)).toBe(false);
	});

	it("opens a modal with the current amount chosen and a field for any other", () => {
		const json = JSON.stringify(buyInModal("room-1", 2_500).toJSON());
		expect(json).toContain("gameroomModal:hbuyin:room-1");
		expect(json).toContain('"default":true');
	});
});

describe("paying on Join", () => {
	it("takes the buy in from the wallet and records it against the amount charged", async () => {
		expect(await chargeJoiner(draft(), GUEST)).toBeNull();
		expect(walletMock.debitWithReceipt).toHaveBeenCalledWith(key(GUEST), 2_500, expect.any(String));
		expect(storeMock.recordBuyInCharge).toHaveBeenCalledWith("guild-1", "room-1", { userId: GUEST, buyIn: 2_500, chargeId: expect.any(String) }, 2_500);
	});

	it("holds the charge on the row before the wallet is touched, and closes the receipt once it is recorded", async () => {
		await chargeJoiner(draft(), GUEST);
		const [hold] = storeMock.holdBuyInCharge.mock.invocationCallOrder;
		const [take] = walletMock.debitWithReceipt.mock.invocationCallOrder;
		const [record] = storeMock.recordBuyInCharge.mock.invocationCallOrder;
		expect(hold).toBeLessThan(take);
		expect(take).toBeLessThan(record);
		const chargeId = (storeMock.holdBuyInCharge.mock.calls[0][2] as { chargeId: string }).chargeId;
		expect(walletMock.debitWithReceipt).toHaveBeenCalledWith(key(GUEST), 2_500, chargeId);
		expect(walletMock.closeReceipt).toHaveBeenCalledWith(key(GUEST), chargeId);
	});

	it("refuses a joiner whose wallet is short, records nothing and lets the hold go", async () => {
		walletMock.debitWithReceipt.mockResolvedValue(null);
		expect(await chargeJoiner(draft(), GUEST)).toBe(gameRoomsCopy.holdem.notEnoughChips(2_500));
		expect(storeMock.recordBuyInCharge).not.toHaveBeenCalled();
		expect(storeMock.dropBuyInCharge).toHaveBeenCalledOnce();
	});

	it("gives the chips back through the receipt when the host changed the amount between the charge and the record", async () => {
		storeMock.recordBuyInCharge.mockResolvedValue(null);
		expect(await chargeJoiner(draft(), GUEST)).toBe(gameRoomsCopy.board.buyInChangedJoining);
		expect(walletMock.refundReceipt).toHaveBeenCalledWith(key(GUEST), 2_500, expect.any(String));
		expect(storeMock.dropBuyInCharge).toHaveBeenCalledOnce();
	});

	// 2026-10 item 263 risk R7: the row refuses a second hold for a member already paid, so a
	// double press of Join or Accept and buy in keeps the first charge and takes nothing again.
	it("charges a double press once, taking nothing the second time", async () => {
		storeMock.holdBuyInCharge.mockResolvedValue(null);
		storeMock.findByRoomId.mockResolvedValue(draft({ buyInPaidBy: [GUEST] }));
		expect(await chargeJoiner(draft(), GUEST)).toBe(gameRoomsCopy.holdem.buyInAlreadyPaid);
		expect(walletMock.debitWithReceipt).not.toHaveBeenCalled();
	});

	// A press that died left its charge on the row; the member's next press settles it first.
	it("gives back a charge a dead press left before holding the new one", async () => {
		storeMock.findByRoomId.mockResolvedValue(draft({ buyInCharges: [{ userId: GUEST, buyIn: 2_500, chargeId: "dead-press", released: false }] }));
		expect(await chargeJoiner(draft(), GUEST)).toBeNull();
		expect(walletMock.refundReceipt).toHaveBeenCalledWith(key(GUEST), 2_500, "dead-press");
		expect(storeMock.dropBuyInCharge).toHaveBeenCalledWith("guild-1", "room-1", "dead-press");
		expect(walletMock.refundReceipt.mock.invocationCallOrder[0]).toBeLessThan(storeMock.holdBuyInCharge.mock.invocationCallOrder[0]);
	});

	it("charges nobody on a free play draft: chips off, a Dero bot seat, a network table", async () => {
		configMock.findByGuildId.mockResolvedValue({ chipEconomyEnabled: false });
		expect(await chargeJoiner(draft(), GUEST)).toBeNull();
		configMock.findByGuildId.mockResolvedValue({ chipEconomyEnabled: true });
		expect(await chargeJoiner(draft({ botSeats: 1 }), GUEST)).toBeNull();
		expect(await chargeJoiner(draft({ network: true }), GUEST)).toBeNull();
		expect(walletMock.debitWithReceipt).not.toHaveBeenCalled();
	});
});

describe("getting it back", () => {
	it("refunds a declined or removed joiner once their entry is claimed", async () => {
		await refundJoiners(draft(), [GUEST]);
		expect(storeMock.takeBuyInPaid).toHaveBeenCalledWith("guild-1", "room-1", GUEST);
		expect(walletMock.credit).toHaveBeenCalledWith(key(GUEST), 2_500);
	});

	it("pays nothing to a member who never paid, and a member listed twice once", async () => {
		storeMock.takeBuyInPaid.mockResolvedValueOnce(null);
		await refundJoiners(draft(), ["never-paid"]);
		expect(walletMock.credit).not.toHaveBeenCalled();

		await refundJoiners(draft(), [GUEST, GUEST]);
		expect(walletMock.credit).toHaveBeenCalledTimes(1);
	});

	it("refunds everybody on a cancelled draft", async () => {
		await refundAllJoiners(draft({ buyInPaidBy: ["a", "b"] }));
		expect(walletMock.credit.mock.calls.map((call) => (call[0] as { userId: string }).userId)).toEqual(["a", "b"]);
	});

	// 2026-10 item 278, gap G3: a charge held between a press and its record is released first, so
	// the press can no longer record it, then paid back through its receipt, which pays only a
	// charge really taken.
	it("releases every held charge, then pays each back through its receipt", async () => {
		const charges = [
			{ userId: "a", buyIn: 2_500, chargeId: "charge-a", released: true },
			{ userId: "b", buyIn: 2_500, chargeId: "charge-b", released: true },
		];
		storeMock.releaseBuyInCharges.mockResolvedValue({ buyInCharges: charges });
		walletMock.refundReceipt.mockResolvedValueOnce({ balance: 0 }).mockResolvedValueOnce(null);
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		await refundAllJoiners(draft({ buyInPaidBy: [] }));
		expect(storeMock.releaseBuyInCharges).toHaveBeenCalledWith("guild-1", "room-1", null);
		expect(walletMock.refundReceipt.mock.calls).toEqual([
			[key("a"), 2_500, "charge-a"],
			[key("b"), 2_500, "charge-b"],
		]);
		expect(storeMock.releaseBuyInCharges.mock.invocationCallOrder[0]).toBeLessThan(walletMock.refundReceipt.mock.invocationCallOrder[0]);
	});

	it("releases only the declined member's held charge", async () => {
		storeMock.releaseBuyInCharges.mockResolvedValue({
			buyInCharges: [
				{ userId: GUEST, buyIn: 2_500, chargeId: "charge-guest", released: true },
				{ userId: "other", buyIn: 2_500, chargeId: "charge-other", released: false },
			],
		});
		await refundJoiners(draft(), [GUEST]);
		expect(storeMock.releaseBuyInCharges).toHaveBeenCalledWith("guild-1", "room-1", [GUEST]);
		expect(walletMock.refundReceipt.mock.calls).toEqual([[key(GUEST), 2_500, "charge-guest"]]);
	});

	it("never throws into the decision that triggered it", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		storeMock.takeBuyInPaid.mockRejectedValue(new Error("mongo down"));
		await expect(refundJoiners(draft(), [GUEST])).resolves.toBeUndefined();
	});
});

// 2026-10 item 278: the start claim moves every buy in onto the pot or a Hold'em table's held
// seats, and a payer the room seats nowhere comes back off it by a pull that answers whether it
// landed. Claim first, pay second, so the open and a finish racing it pay a payer once.
describe("giving back a buy in the start claim moved", () => {
	it("pulls each unseated payer off the pot and pays only the pulls that landed", async () => {
		storeMock.takePotPayer.mockResolvedValueOnce({ roomId: "room-1" }).mockResolvedValueOnce(null);
		await refundClaimedPayers(draft(), "chipPot", 1_500, ["late", "finished-first", "late"]);
		expect(storeMock.takePotPayer.mock.calls).toEqual([
			["guild-1", "room-1", "late"],
			["guild-1", "room-1", "finished-first"],
		]);
		expect(walletMock.credit.mock.calls).toEqual([[key("late"), 1_500]]);
		expect(storeMock.takeHeldBuyIn).not.toHaveBeenCalled();
	});

	it("pulls from a Hold'em table's held seats, and keeps going past a pull that threw", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		storeMock.takeHeldBuyIn.mockRejectedValueOnce(new Error("mongo down")).mockResolvedValueOnce({ roomId: "room-1" });
		await expect(refundClaimedPayers(draft(), "heldBuyIns", 2_500, ["a", "b"])).resolves.toBeUndefined();
		// A pull that threw may have landed, so nothing is paid for it: a crash loses, never mints.
		expect(walletMock.credit.mock.calls).toEqual([[key("b"), 2_500]]);
	});

	it("refunds every seat a finished row still holds, and nothing when none is held", async () => {
		storeMock.takeHeldBuyIn.mockResolvedValue({ roomId: "room-1" });
		await refundHeldBuyIns(draft({ heldBuyIns: { buyIn: 2_500, userIds: ["host", "a"] } }));
		expect(walletMock.credit.mock.calls).toEqual([
			[key("host"), 2_500],
			[key("a"), 2_500],
		]);

		vi.clearAllMocks();
		await refundHeldBuyIns(draft({ heldBuyIns: null }));
		await refundHeldBuyIns(draft({ heldBuyIns: { buyIn: 2_500, userIds: [] } }));
		expect(storeMock.takeHeldBuyIn).not.toHaveBeenCalled();
	});
});

describe("opening the table", () => {
	it("charges the host and seats them first, then everyone who paid and is still in the pool", async () => {
		const settled = await settleDraftBuyIns(draft({ buyInPaidBy: ["a", "gone"] }), ["a", "unpaid"]);
		expect(settled).toEqual({ ok: true, seats: { buyIn: 2_500, userIds: [HOST, "a"], charged: true } });
		expect(walletMock.debitWithReceipt).toHaveBeenCalledWith(key(HOST), 2_500, expect.any(String));
	});

	// 2026-10 item 276, audit P3: the host's Start charge sat outside every ledger while the room was
	// built, so a crash in those seconds lost it and Call it off could not refund it.
	it("puts the host's charge on the draft ledger, and gives it back through its receipt when the draft closed first", async () => {
		await settleDraftBuyIns(draft({ buyInPaidBy: ["a"] }), ["a"]);
		expect(storeMock.recordBuyInCharge).toHaveBeenCalledWith("guild-1", "room-1", { userId: HOST, buyIn: 2_500, chargeId: expect.any(String) }, 2_500);

		storeMock.recordBuyInCharge.mockResolvedValueOnce(null);
		expect(await settleDraftBuyIns(draft({ buyInPaidBy: ["a"] }), ["a"])).toEqual({ ok: false, reason: gameRoomsCopy.board.draftGone });
		expect(walletMock.refundReceipt).toHaveBeenCalledWith(key(HOST), 2_500, expect.any(String));
	});

	// The ledger is cleared once the room opens, so a payer who left the pool is paid back here.
	it("gives the buy in back to a payer who is no longer in the pool", async () => {
		await settleDraftBuyIns(draft({ buyInPaidBy: ["a", "gone"] }), ["a"]);
		expect(walletMock.credit.mock.calls.map((call) => (call[0] as { userId: string }).userId)).toEqual(["gone"]);
	});

	it("refuses the start when the host's wallet is short, taking nothing", async () => {
		walletMock.debitWithReceipt.mockResolvedValue(null);
		expect(await settleDraftBuyIns(draft(), [])).toEqual({ ok: false, reason: gameRoomsCopy.holdem.notEnoughChips(2_500) });
	});

	it("gives every payment back and seats every pool member free when the table turned out to play free", async () => {
		configMock.findByGuildId.mockResolvedValue({ chipEconomyEnabled: false });
		expect(await settleDraftBuyIns(draft({ buyInPaidBy: ["a"] }), ["a", "b"])).toEqual({ ok: true, seats: { buyIn: 2_500, userIds: [HOST, "a", "b"], charged: false } });
		expect(walletMock.credit).toHaveBeenCalledWith(key("a"), 2_500);
		expect(walletMock.debitWithReceipt).not.toHaveBeenCalled();
	});

	// 2026-10 item 263 risk R8: a Dero bot seat makes the table free, which used to seat nobody, so
	// the room opened with the bots alone and the host unseated.
	it("seats the host and every member free at a table with a Dero bot", async () => {
		expect(await settleDraftBuyIns(draft({ botSeats: 1 }), ["a"])).toEqual({ ok: true, seats: { buyIn: 2_500, userIds: [HOST, "a"], charged: false } });
		expect(walletMock.debitWithReceipt).not.toHaveBeenCalled();
	});

	it("is not a chip draft for a game with no stake, or a Battleship card with no wager", async () => {
		expect(await settleDraftBuyIns(draft({ game: "hangman" }), [])).toEqual({ ok: true, seats: null });
		// A Battleship card with no wager seats its captains free, like any free table.
		expect(await settleDraftBuyIns(draft({ game: "battleship", holdemBuyIn: null }), ["a"])).toEqual({ ok: true, seats: { buyIn: BOT_CONSTANTS.HOLDEM_STARTING_STACK, userIds: [HOST, "a"], charged: false } });
		expect(walletMock.debitWithReceipt).not.toHaveBeenCalled();
	});

	it("gives the host and every payer their buy in back when the room does not open", async () => {
		await refundOpenedSeats(draft(), { buyIn: 2_500, userIds: [HOST, "a"], charged: true });
		expect(walletMock.credit.mock.calls.map((call) => (call[0] as { userId: string }).userId)).toEqual([HOST, "a"]);
	});

	it("owes nobody anything when a free table does not open", async () => {
		await refundOpenedSeats(draft(), { buyIn: 2_500, userIds: [HOST, "a"], charged: false });
		expect(walletMock.credit).not.toHaveBeenCalled();
	});
});

// The card's Start refuses below HOLDEM_MIN_SEATS (2026-10 item 263 R3-27, owner decision 4).
describe("the seats a draft would open with", () => {
	it("counts the host and the payers still in the pool at a chip table", async () => {
		expect(await seatsAtStart(draft({ buyInPaidBy: ["a", "gone"] }), ["a", "invited-unpaid"])).toBe(2);
		expect(await seatsAtStart(draft(), ["invited-unpaid"])).toBe(1);
	});

	it("counts the host, every pool member and every Dero bot at a free table", async () => {
		expect(await seatsAtStart(draft({ botSeats: 1 }), [])).toBe(2);
		configMock.findByGuildId.mockResolvedValue({ chipEconomyEnabled: false });
		expect(await seatsAtStart(draft(), ["a", "b"])).toBe(3);
	});
});

// ── Blackjack plays for the same buy in (2026-10 item 267, owner decisions 1 and 2) ──
describe("a Blackjack table's buy in", () => {
	const blackjack = (overrides: Partial<IGameRoom> = {}) => draft({ game: "blackjack", ...overrides });

	// 2026-10 item 276, owner decisions D4 and D10: ranked Monopoly's fixed buy in and Battleship's
	// wager ride the same ledger as a table's buy in.
	it("charges a ranked Monopoly joiner the fixed buy in, whatever the row holds", async () => {
		const monopoly = draft({ game: "monopoly", holdemBuyIn: null });
		storeMock.findByRoomId.mockResolvedValue(monopoly);
		expect(draftBuyInOf(monopoly)).toBe(BOT_CONSTANTS.ECONOMY.MONOPOLY_RANKED_BUY_IN);
		expect(await chargeJoiner(monopoly, GUEST)).toBeNull();
		expect(walletMock.debitWithReceipt).toHaveBeenCalledWith(key(GUEST), BOT_CONSTANTS.ECONOMY.MONOPOLY_RANKED_BUY_IN, expect.any(String));
	});

	it("charges a Battleship wager only when the host set one, inside the wager's bounds", async () => {
		const { BATTLESHIP_MIN_WAGER, BATTLESHIP_MAX_WAGER } = BOT_CONSTANTS.ECONOMY;
		expect(isValidDraftBuyIn(BATTLESHIP_MIN_WAGER - 1, "battleship")).toBe(false);
		expect(isValidDraftBuyIn(BATTLESHIP_MIN_WAGER, "battleship")).toBe(true);
		expect(isValidDraftBuyIn(BATTLESHIP_MAX_WAGER + 1, "battleship")).toBe(false);
		expect(await isChipDraft(draft({ game: "battleship", holdemBuyIn: null }))).toBe(false);
		expect(await isChipDraft(draft({ game: "battleship", holdemBuyIn: 250 }))).toBe(true);
		expect(await isChipDraft(draft({ game: "battleship", holdemBuyIn: 250, casual: true }))).toBe(false);
	});

	it("refuses a head to head Start whose chosen opponent never paid, before the host is charged", async () => {
		const battleship = draft({ game: "battleship", holdemBuyIn: 250, buyInPaidBy: [] });
		const settled = await settleDraftBuyIns(battleship, [GUEST], { everyonePays: true });
		expect(settled).toEqual({ ok: false, reason: gameRoomsCopy.holdem.opponentNotPaid(GUEST, 250) });
		expect(walletMock.debitWithReceipt).not.toHaveBeenCalled();
	});

	it("charges the host and seats both captains once the opponent paid the wager", async () => {
		const battleship = draft({ game: "battleship", holdemBuyIn: 250, buyInPaidBy: [GUEST] });
		expect(await settleDraftBuyIns(battleship, [GUEST], { everyonePays: true })).toEqual({ ok: true, seats: { buyIn: 250, userIds: [HOST, GUEST], charged: true } });
		expect(walletMock.debitWithReceipt).toHaveBeenCalledWith(key(HOST), 250, expect.any(String));
	});

	it("charges a Blackjack joiner through the same ledger as Hold'em's, once", async () => {
		expect(await chargeJoiner(blackjack(), GUEST)).toBeNull();
		expect(walletMock.debitWithReceipt).toHaveBeenCalledWith(key(GUEST), 2_500, expect.any(String));
		expect(storeMock.recordBuyInCharge).toHaveBeenCalledWith("guild-1", "room-1", { userId: GUEST, buyIn: 2_500, chargeId: expect.any(String) }, 2_500);

		// A double press: the row refuses to hold a second charge, so nothing is taken again.
		storeMock.holdBuyInCharge.mockResolvedValue(null);
		storeMock.findByRoomId.mockResolvedValue(blackjack({ buyInPaidBy: [GUEST] }));
		expect(await chargeJoiner(blackjack(), GUEST)).toBe(gameRoomsCopy.holdem.buyInAlreadyPaid);
		expect(walletMock.debitWithReceipt).toHaveBeenCalledOnce();
	});

	it("charges the host at Start and seats the host and every payer at the buy in", async () => {
		const settled = await settleDraftBuyIns(blackjack({ buyInPaidBy: ["a"] }), ["a", "invited-unpaid"]);
		expect(settled).toEqual({ ok: true, seats: { buyIn: 2_500, userIds: [HOST, "a"], charged: true } });
		expect(walletMock.debitWithReceipt).toHaveBeenCalledWith(key(HOST), 2_500, expect.any(String));
	});

	it("plays free and moves no chips on a server with chips off, or on a network table", async () => {
		configMock.findByGuildId.mockResolvedValue({ chipEconomyEnabled: false });
		expect(await chargeJoiner(blackjack(), GUEST)).toBeNull();
		expect(await settleDraftBuyIns(blackjack(), ["a"])).toEqual({ ok: true, seats: { buyIn: 2_500, userIds: [HOST, "a"], charged: false } });

		configMock.findByGuildId.mockResolvedValue({ chipEconomyEnabled: true });
		expect(await isChipDraft(blackjack({ network: true }))).toBe(false);
		expect(await chargeJoiner(blackjack({ network: true }), GUEST)).toBeNull();
		expect(walletMock.debitWithReceipt).not.toHaveBeenCalled();
	});

	// 2026-10 item 276, owner decision D1: chips move only in ranked matches, so a Casual card, of
	// either buy in game, charges nobody even where chips are on, seats everyone on a pretend stack,
	// and gives back anything its ledger still holds.
	it("charges nobody on a Casual card with chips on, Blackjack and Hold'em alike, and seats everyone free", async () => {
		configMock.findByGuildId.mockResolvedValue({ chipEconomyEnabled: true });
		for (const casualCard of [blackjack({ casual: true }), draft({ casual: true })]) {
			expect(await isChipDraft(casualCard)).toBe(false);
			expect(await chargeJoiner(casualCard, GUEST)).toBeNull();
			expect(await settleDraftBuyIns(casualCard, ["a"])).toEqual({ ok: true, seats: { buyIn: casualCard.holdemBuyIn ?? BOT_CONSTANTS.HOLDEM_STARTING_STACK, userIds: [HOST, "a"], charged: false } });
		}
		expect(walletMock.debitWithReceipt).not.toHaveBeenCalled();
		// The Rated card beside it still charges.
		expect(await isChipDraft(blackjack())).toBe(true);
	});

	// 2026-10 item 276, owner decision D1: a solo table against Dero is never a ranked match, so
	// it plays free on the standard pretend stack wherever it is opened, chips on or off.
	it("charges a solo table nothing at the press, with chips on or off, since it is never a ranked match", async () => {
		const free = { ok: true, seats: { buyIn: BOT_CONSTANTS.HOLDEM_STARTING_STACK, userIds: [HOST], charged: false } };
		expect(await chargeSoloTable("guild-1", HOST)).toEqual(free);
		configMock.findByGuildId.mockResolvedValue({ chipEconomyEnabled: false });
		expect(await chargeSoloTable("guild-1", HOST)).toEqual(free);
		expect(walletMock.debit).not.toHaveBeenCalled();
	});

	it("charges a rematch's returning players one by one, leaving out a short wallet", async () => {
		walletMock.debit.mockImplementation(async (wallet: { userId: string }) => (wallet.userId === "short" ? null : { balance: 0 }));
		expect(await chargeSeats(["a", "short", "b"], 1_000)).toEqual({ paid: ["a", "b"], short: ["short"] });
	});

	// Bot audit 2026-10-30: a throw out of chargeSeats lost the caller the members already charged.
	it("counts a member whose debit throws as short, and keeps charging the rest", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		walletMock.debit.mockImplementation(async (wallet: { userId: string }) => {
			if (wallet.userId === "broken") throw new Error("Mongo blip");
			return { balance: 0 };
		});
		expect(await chargeSeats(["a", "broken", "b"], 1_000)).toEqual({ paid: ["a", "b"], short: ["broken"] });
	});

	it("gives seats no ledger holds straight back, and owes a free table nothing", async () => {
		await refundSeatsDirectly({ buyIn: 1_000, userIds: [HOST, "a"], charged: true });
		expect(walletMock.credit).toHaveBeenCalledWith(key(HOST), 1_000);
		expect(walletMock.credit).toHaveBeenCalledWith(key("a"), 1_000);
		walletMock.credit.mockClear();
		await refundSeatsDirectly({ buyIn: 1_000, userIds: [HOST], charged: false });
		expect(walletMock.credit).not.toHaveBeenCalled();
	});
});
