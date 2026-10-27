import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ButtonInteraction } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: { update: vi.fn(), updateSecretIf: vi.fn(), findByRoomId: vi.fn(), addPendingJoin: vi.fn() },
}));
vi.mock("@db/stores/playerRatingStore.js", () => ({ playerRatingStore: { findForPlayers: vi.fn() } }));
vi.mock("./roomTrail.js", () => ({ roomTrail: { postMove: vi.fn() } }));
vi.mock("./roomLifecycle.js", () => ({ roomLifecycle: { finish: vi.fn() } }));
vi.mock("@features/leveling/awardXp.js", () => ({ awardXp: vi.fn() }));
vi.mock("@features/ratings/recordMatchRatings.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("@features/ratings/recordMatchRatings.js")>()),
	recordMatchRatings: vi.fn(),
}));

import { handleBuyIn, handleDeal, handleEndTable, handleSeatsToggle } from "./roomHoldemHandlers.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { roomTrail } from "./roomTrail.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { recordMatchRatings } from "@features/ratings/recordMatchRatings.js";
import { act, createTable, dealHand, handInProgress, joinTable, requestLateSeat, whoActs, type HoldemTable } from "@features/games/holdemTable.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── the table half of the host controls (2026-10 item 244 Phase 4) ─────────
// What:  Buy in and Take a seat pass the host's join gate; a late seat waits for the
//        next deal, and only the deal makes it a seat and a player; the host's seat
//        toggle; and a removed player kept out of an ended table's ratings.

const words = rokCommanderCopy.arcadeHostControls;
type Mock = ReturnType<typeof vi.fn>;
const storeMock = gameRoomStore as unknown as Record<"update" | "updateSecretIf" | "findByRoomId" | "addPendingJoin", Mock>;
const trailMock = roomTrail.postMove as unknown as Mock;
const finishMock = roomLifecycle.finish as unknown as Mock;
const ratingMock = recordMatchRatings as unknown as Mock;

const HOST = "p0";

function seededRng(seed = 11): () => number {
	let state = seed;
	return () => {
		state = (state * 1664525 + 1013904223) % 4294967296;
		return state / 4294967296;
	};
}

// A three seat tournament between hands, after hand one settled.
function betweenHands(): HoldemTable {
	const table = createTable();
	for (const userId of ["p0", "p1", "p2"]) joinTable(table, userId, userId.toUpperCase());
	table.status = "playing";
	dealHand(table, seededRng(3));
	for (let turn = 0; turn < 20 && handInProgress(table); turn++) act(table, whoActs(table)!, "fold");
	table.boardMessageId = null;
	return table;
}

const makeRoom = (table: HoldemTable, overrides: Partial<IGameRoom> = {}): IGameRoom =>
	({
		roomId: "room-1",
		guildId: "guild-1",
		game: "holdem",
		hostId: HOST,
		status: "playing",
		playerIds: table.seats.map((seat) => seat.userId),
		channelId: "ch-1",
		secret: table,
		...overrides,
	}) as unknown as IGameRoom;

function makeInteraction(userId: string): ButtonInteraction {
	return {
		guildId: "guild-1",
		guild: { members: { cache: { get: () => ({ displayName: `Name ${userId}` }) } } },
		user: { id: userId, username: userId, globalName: userId },
		client: { channels: { fetch: vi.fn().mockResolvedValue(null) } },
		reply: vi.fn().mockResolvedValue(undefined),
		deferUpdate: vi.fn().mockResolvedValue(undefined),
	} as unknown as ButtonInteraction;
}

const replyText = (interaction: ButtonInteraction): string =>
	(((interaction.reply as unknown as Mock).mock.calls[0]?.[0] ?? {}) as { content?: string }).content ?? "";

beforeEach(() => {
	vi.clearAllMocks();
	storeMock.updateSecretIf.mockResolvedValue({});
	storeMock.findByRoomId.mockResolvedValue(null);
	finishMock.mockResolvedValue(true);
});

describe("Buy in and Take a seat pass the host's gate", () => {
	it("refuse a member the host removed, writing nothing", async () => {
		const table = createTable();
		const interaction = makeInteraction("kicked-1");

		await handleBuyIn(interaction, makeRoom(table, { status: "playing", playerIds: [HOST], kickedIds: ["kicked-1"] }));

		expect(replyText(interaction)).toBe(words.kick.refusedRejoin);
		expect(storeMock.updateSecretIf).not.toHaveBeenCalled();
	});

	it("turn a stranger's buy in into a request when the host approves each joiner", async () => {
		const table = createTable();
		storeMock.addPendingJoin.mockResolvedValue(makeRoom(table, { pendingJoinIds: ["stranger"] }));
		const interaction = makeInteraction("stranger");

		await handleBuyIn(interaction, makeRoom(table, { playerIds: [HOST], requireApproval: true }));

		expect(storeMock.addPendingJoin).toHaveBeenCalledWith("guild-1", "room-1", "stranger");
		expect(replyText(interaction)).toBe(words.approval.asked);
		expect(storeMock.updateSecretIf).not.toHaveBeenCalled();
	});

	it("let a member the room already let in buy in without asking", async () => {
		const table = createTable();

		await handleBuyIn(makeInteraction("p1"), makeRoom(table, { playerIds: [HOST, "p1"], requireApproval: true }));

		expect(storeMock.addPendingJoin).not.toHaveBeenCalled();
		expect(storeMock.updateSecretIf).toHaveBeenCalledOnce();
	});
});

describe("a late seat while the host has seats open", () => {
	it("holds the seat for the next deal: a compare and swap on the stamp, the open seats and the removal list, with no player added yet", async () => {
		const table = betweenHands();
		const readAt = table.lastActionAt;
		const interaction = makeInteraction("late");

		await handleBuyIn(interaction, makeRoom(table, { seatsOpen: true }));

		const [, , expected, written, extra] = storeMock.updateSecretIf.mock.calls[0] as [string, string, Record<string, unknown>, HoldemTable, unknown];
		expect(expected).toEqual({ "secret.lastActionAt": readAt, seatsOpen: true, kickedIds: { $ne: "late" }, "secret.boardMessageId": null });
		expect(written.pendingSeats).toEqual([{ userId: "late", username: "Name late" }]);
		expect(written.seats.some((seat) => seat.userId === "late")).toBe(false);
		expect(extra).toBeUndefined();
		expect(replyText(interaction)).toBe(words.seats.heldReply(BOT_CONSTANTS.HOLDEM_STARTING_STACK));
	});

	it("is refused while the seats are closed", async () => {
		const table = betweenHands();
		const interaction = makeInteraction("late");

		await handleBuyIn(interaction, makeRoom(table, { seatsOpen: false }));

		expect(replyText(interaction)).toBe(words.seats.closedRefused);
		expect(storeMock.updateSecretIf).not.toHaveBeenCalled();
	});

	it("becomes a seat and a player at the next deal, in the deal's own write", async () => {
		const table = betweenHands();
		requestLateSeat(table, "late", "Late");

		await handleDeal(makeInteraction(HOST), makeRoom(table, { seatsOpen: true }));

		const [, , , dealt, extra] = storeMock.updateSecretIf.mock.calls[0] as [string, string, unknown, HoldemTable, { $addToSet: { playerIds: { $each: string[] } } }];
		const seat = dealt.seats.find((entry) => entry.userId === "late");
		expect(seat).toBeDefined();
		expect(seat!.stack + seat!.totalCommitted).toBe(BOT_CONSTANTS.HOLDEM_STARTING_STACK);
		expect(dealt.holeCards.late).toHaveLength(2);
		expect(extra.$addToSet.playerIds.$each).toEqual(["late"]);
		expect(trailMock.mock.calls.map((call) => (call[2] as { text: string }).text)).toContain(
			words.seats.seatedLine("late", BOT_CONSTANTS.HOLDEM_STARTING_STACK)
		);
	});

	it("drops a waiting seat whose player the host removed, rather than dealing them in", async () => {
		const table = betweenHands();
		requestLateSeat(table, "late", "Late");

		await handleDeal(makeInteraction(HOST), makeRoom(table, { seatsOpen: true, kickedIds: ["late"] }));

		const dealt = storeMock.updateSecretIf.mock.calls[0][3] as HoldemTable;
		expect(dealt.seats.some((seat) => seat.userId === "late")).toBe(false);
		expect(storeMock.updateSecretIf.mock.calls[0]).toHaveLength(4);
	});
});

describe("the host's seat toggle", () => {
	it("opens the seats and says so in the trail", async () => {
		const table = betweenHands();
		storeMock.update.mockResolvedValue(makeRoom(table, { seatsOpen: true }));

		await handleSeatsToggle(makeInteraction(HOST), makeRoom(table, { seatsOpen: false }), "on");

		expect(storeMock.update).toHaveBeenCalledWith("guild-1", "room-1", { seatsOpen: true });
		expect((trailMock.mock.calls[0][2] as { text: string }).text).toBe(words.seats.openedLine(HOST));
	});

	it("refuses before the first deal, and says so when nothing would change", async () => {
		const joining = createTable();
		const early = makeInteraction(HOST);
		await handleSeatsToggle(early, makeRoom(joining), "on");
		expect(replyText(early)).toBe(words.seats.notPlaying);

		const again = makeInteraction(HOST);
		await handleSeatsToggle(again, makeRoom(betweenHands(), { seatsOpen: true }), "on");
		expect(replyText(again)).toBe(words.seats.alreadyOpen);
		expect(storeMock.update).not.toHaveBeenCalled();
	});
});

describe("ending a table a removed player sat at", () => {
	it("excludes them from the ratings", async () => {
		const table = betweenHands();

		await handleEndTable(makeInteraction(HOST), makeRoom(table, { kickedIds: ["p2"] }));

		expect(ratingMock).toHaveBeenCalledOnce();
		expect(ratingMock.mock.calls[0][2]).toEqual(["p2"]);
	});
});
