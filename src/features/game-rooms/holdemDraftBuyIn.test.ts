import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@db/stores/gameRoomStore.js", () => ({ gameRoomStore: { addBuyInPaid: vi.fn(), takeBuyInPaid: vi.fn(), findByRoomId: vi.fn() } }));
vi.mock("@db/stores/chipWalletStore.js", () => ({ chipWalletStore: { debit: vi.fn(), credit: vi.fn() } }));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn() } }));

import { buyInModal, chargeJoiner, draftBuyInOf, isValidDraftBuyIn, refundAllJoiners, refundJoiners, refundOpenedSeats, seatsAtStart, settleDraftBuyIns } from "./holdemDraftBuyIn.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { chipWalletStore } from "@db/stores/chipWalletStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── the Hold'em buy in on the challenge card (2026-10 item 257 Phase 4a) ──
// Paid from the wallet on Join, given back on decline, removal and cancel, and the room opens
// with the payers seated. Driven over mocked stores: the ledger's conditional writes are the
// store's, and the order of take, record and give back is what is pinned here.

const storeMock = gameRoomStore as unknown as Record<"addBuyInPaid" | "takeBuyInPaid" | "findByRoomId", ReturnType<typeof vi.fn>>;
const walletMock = chipWalletStore as unknown as Record<"debit" | "credit", ReturnType<typeof vi.fn>>;
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
	walletMock.credit.mockResolvedValue({ balance: 0 });
	storeMock.addBuyInPaid.mockResolvedValue({});
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
		expect(walletMock.debit).toHaveBeenCalledWith(key(GUEST), 2_500);
		expect(storeMock.addBuyInPaid).toHaveBeenCalledWith("guild-1", "room-1", GUEST, 2_500);
	});

	it("refuses a joiner whose wallet is short, and records nothing", async () => {
		walletMock.debit.mockResolvedValue(null);
		expect(await chargeJoiner(draft(), GUEST)).toBe(gameRoomsCopy.holdem.notEnoughChips(2_500));
		expect(storeMock.addBuyInPaid).not.toHaveBeenCalled();
	});

	it("gives the chips back when the host changed the amount between the charge and the record", async () => {
		storeMock.addBuyInPaid.mockResolvedValue(null);
		expect(await chargeJoiner(draft(), GUEST)).toBe(gameRoomsCopy.board.buyInChangedJoining);
		expect(walletMock.credit).toHaveBeenCalledWith(key(GUEST), 2_500);
	});

	// 2026-10 item 263 risk R7: the store refuses a second record for one member, so a double press
	// of Join or Accept and buy in keeps the first charge and gives the second straight back.
	it("charges a double press once, giving the second charge back", async () => {
		storeMock.addBuyInPaid.mockResolvedValue(null);
		storeMock.findByRoomId.mockResolvedValue(draft({ buyInPaidBy: [GUEST] }));
		expect(await chargeJoiner(draft(), GUEST)).toBe(gameRoomsCopy.holdem.buyInAlreadyPaid);
		expect(walletMock.debit).toHaveBeenCalledTimes(1);
		expect(walletMock.credit).toHaveBeenCalledWith(key(GUEST), 2_500);
	});

	it("charges nobody on a free play draft: chips off, a Dero bot seat, a network table", async () => {
		configMock.findByGuildId.mockResolvedValue({ chipEconomyEnabled: false });
		expect(await chargeJoiner(draft(), GUEST)).toBeNull();
		configMock.findByGuildId.mockResolvedValue({ chipEconomyEnabled: true });
		expect(await chargeJoiner(draft({ botSeats: 1 }), GUEST)).toBeNull();
		expect(await chargeJoiner(draft({ network: true }), GUEST)).toBeNull();
		expect(walletMock.debit).not.toHaveBeenCalled();
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

	it("never throws into the decision that triggered it", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		storeMock.takeBuyInPaid.mockRejectedValue(new Error("mongo down"));
		await expect(refundJoiners(draft(), [GUEST])).resolves.toBeUndefined();
	});
});

describe("opening the table", () => {
	it("charges the host and seats them first, then everyone who paid and is still in the pool", async () => {
		const settled = await settleDraftBuyIns(draft({ buyInPaidBy: ["a", "gone"] }), ["a", "unpaid"]);
		expect(settled).toEqual({ ok: true, seats: { buyIn: 2_500, userIds: [HOST, "a"], charged: true } });
		expect(walletMock.debit).toHaveBeenCalledWith(key(HOST), 2_500);
	});

	// The ledger is cleared once the room opens, so a payer who left the pool is paid back here.
	it("gives the buy in back to a payer who is no longer in the pool", async () => {
		await settleDraftBuyIns(draft({ buyInPaidBy: ["a", "gone"] }), ["a"]);
		expect(walletMock.credit.mock.calls.map((call) => (call[0] as { userId: string }).userId)).toEqual(["gone"]);
	});

	it("refuses the start when the host's wallet is short, taking nothing", async () => {
		walletMock.debit.mockResolvedValue(null);
		expect(await settleDraftBuyIns(draft(), [])).toEqual({ ok: false, reason: gameRoomsCopy.holdem.notEnoughChips(2_500) });
	});

	it("gives every payment back and seats every pool member free when the table turned out to play free", async () => {
		configMock.findByGuildId.mockResolvedValue({ chipEconomyEnabled: false });
		expect(await settleDraftBuyIns(draft({ buyInPaidBy: ["a"] }), ["a", "b"])).toEqual({ ok: true, seats: { buyIn: 2_500, userIds: [HOST, "a", "b"], charged: false } });
		expect(walletMock.credit).toHaveBeenCalledWith(key("a"), 2_500);
		expect(walletMock.debit).not.toHaveBeenCalled();
	});

	// 2026-10 item 263 risk R8: a Dero bot seat makes the table free, which used to seat nobody, so
	// the room opened with the bots alone and the host unseated.
	it("seats the host and every member free at a table with a Dero bot", async () => {
		expect(await settleDraftBuyIns(draft({ botSeats: 1 }), ["a"])).toEqual({ ok: true, seats: { buyIn: 2_500, userIds: [HOST, "a"], charged: false } });
		expect(walletMock.debit).not.toHaveBeenCalled();
	});

	it("is not a Hold'em chip draft for any other game", async () => {
		expect(await settleDraftBuyIns(draft({ game: "monopoly" }), [])).toEqual({ ok: true, seats: null });
		expect(walletMock.debit).not.toHaveBeenCalled();
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
