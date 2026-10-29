import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ButtonInteraction, Client, TextChannel } from "discord.js";

// ── a room's Blackjack table plays for a bankroll (2026-10 item 267) ──────────
// What is pinned here is the handler's half of the owner's decisions: every hand opens on its
// betting turns, a settle pays the bets into the stacks and writes them to the row, a broke seat
// is out, Leave cashes a seat out at once and only once, the turn clock bets the smallest choice
// or stands, a free table never reaches a wallet, and the room finishes once, paying its coins
// once, when nobody is left. The payout arithmetic itself is pinned in blackjackState.test.ts;
// each shoe below is stacked so the hand it deals is known.

const roomRow = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
const moves = vi.hoisted(() => ({ recorded: [] as { actorId: string; kind: string; text: string }[] }));
vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: {
		findByRoomId: vi.fn(async () => roomRow.current),
		appendMove: vi.fn(async (_guildId: string, _roomId: string, move: { actorId: string; kind: string; text: string }) => {
			moves.recorded.push(move);
		}),
	},
}));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn(async () => null) } }));
// The ledger writes and claims have their own suite (blackjackChips.test.ts) and the restart over
// them runs end to end in challengeBoard.rematch.test.ts; here they are what the handler asks for.
vi.mock("@features/game-rooms/blackjackChips.js", () => ({ cashOutBlackjackSeat: vi.fn(async () => true), saveBlackjackStacks: vi.fn(async () => undefined) }));
vi.mock("@features/game-rooms/roomLifecycle.js", () => ({ roomLifecycle: { finish: vi.fn(async () => true) } }));
vi.mock("@features/game-rooms/turnPrompt.js", () => ({ syncTurnPrompt: vi.fn(async () => undefined) }));
vi.mock("@utils/answerInChannel.js", () => ({ answerInChannel: vi.fn(async () => undefined), beginChannelAnswer: vi.fn() }));
vi.mock("./gameXp.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("./gameXp.js")>()), awardBlackjackResult: vi.fn(), awardBlackjackTableCoins: vi.fn() }));
vi.mock("./blackjackRenderer.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./blackjackRenderer.js")>()),
	renderBlackjackTableCard: vi.fn(async () => null),
	renderBlackjackResultCard: vi.fn(async () => null),
}));

import { _activeBlackjackGameCount, _blackjackTableOf, _clearBlackjackGames, blackjackTurnAdapter, startBlackjackTable } from "./blackjackHandler.js";
import type { Card, Rank } from "./blackjackState.js";
import { gamesCopy } from "./gamesCopy.js";
import { awardBlackjackResult, awardBlackjackTableCoins } from "./gameXp.js";
import { cashOutBlackjackSeat, saveBlackjackStacks } from "@features/game-rooms/blackjackChips.js";
import { roomLifecycle } from "@features/game-rooms/roomLifecycle.js";
import { answerInChannel } from "@utils/answerInChannel.js";
import { gameRoomsCopy } from "@features/game-rooms/gameRoomsCopy.js";
import { _resetDrawingPauses } from "@features/game-rooms/drawingPause.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";

const ALICE = { userId: "alice", username: "Alice" };
const BOB = { userId: "bob", username: "Bob" };
const CHIP_TABLE = { buyIn: 1000, chips: true };
const FREE_TABLE = { buyIn: 1000, chips: false };
const roomOf = { channelId: "ch-1", roomId: "room-1", guildId: "g1" } as never;
const ROOM = { channelId: "ch-1", roomId: "room-1", guildId: "g1" };

const saveMock = saveBlackjackStacks as unknown as ReturnType<typeof vi.fn>;
const cashOutMock = cashOutBlackjackSeat as unknown as ReturnType<typeof vi.fn>;
const finishMock = roomLifecycle.finish as unknown as ReturnType<typeof vi.fn>;
const coinsMock = awardBlackjackTableCoins as unknown as ReturnType<typeof vi.fn>;

// A room channel that keeps its messages, hears every board through one collector, and is
// the channel the trail resolves.
function fakeRoom() {
	let collect: ((click: unknown) => void) | undefined;
	let end: (() => void) | undefined;
	let counter = 0;
	const messages: Array<{ id: string; payload: Record<string, unknown> }> = [];
	const client = { channels: { fetch: vi.fn(async () => channel) } } as unknown as Client;
	const channel: Record<string, unknown> = {
		id: "ch-1",
		client,
		isTextBased: () => true,
		isDMBased: () => false,
		isSendable: () => true,
		createMessageComponentCollector: () => {
			const collector = {
				on(event: string, listener: (arg: unknown) => void) {
					if (event === "collect") collect = listener;
					else end = listener as () => void;
					return collector;
				},
				// As discord.js does: stopping a collector runs its end handler, the table's one cleanup.
				stop: () => end?.(),
			};
			return collector;
		},
		send: vi.fn(async (payload: Record<string, unknown>) => {
			const message = {
				id: `m${++counter}`,
				channelId: "ch-1",
				payload,
				get embeds() {
					return (message.payload.embeds as unknown[]) ?? [];
				},
				attachments: new Map(),
				channel,
				client,
				edit: vi.fn(async (edit: Record<string, unknown>) => {
					message.payload = { ...message.payload, ...edit };
					return message;
				}),
			};
			messages.push(message);
			return message;
		}),
		messages: { fetch: vi.fn(async (id: string) => messages.find((message) => message.id === id) ?? null) },
	};
	return { channel: channel as unknown as TextChannel, client, click: (fake: unknown) => collect?.(fake) };
}

// A press of a board button: a notice can open from it, and its update acknowledges it.
function press(action: string, userId: string, client: Client = {} as Client) {
	const click = {
		id: `press-${action}-${userId}`,
		customId: `minigame:blackjack:ch-1:${action}`,
		user: { id: userId, username: userId, globalName: userId },
		client,
		deferred: false,
		replied: false,
		isMessageComponent: () => true,
		isModalSubmit: () => false,
		update: vi.fn(async () => undefined),
		editReply: vi.fn(async () => undefined),
		deferUpdate: vi.fn(async () => undefined),
		reply: vi.fn(async () => undefined),
		showModal: vi.fn(async () => undefined),
		followUp: vi.fn(async () => undefined),
	};
	return click;
}

const cards = (ranks: Rank[]): Card[] => ranks.map((rank) => ({ rank, suit: "S" }));
const table = () => {
	const live = _blackjackTableOf("ch-1");
	if (!live) throw new Error("no table in ch-1");
	return live;
};
const bet = (userId: string, amount: number) => blackjackTurnAdapter.apply({} as never, roomOf, userId, { bet: String(amount) }, async () => undefined);
const act = (userId: string, move: string) => blackjackTurnAdapter.apply({} as never, roomOf, userId, { move }, async () => undefined);
const lastStacks = () => saveMock.mock.calls.filter((call) => (call[1] as unknown[]).length > 0).at(-1)?.[1];
const flush = async () => {
	for (let i = 0; i < 20; i++) await Promise.resolve();
};

beforeEach(() => {
	_clearBlackjackGames();
	_resetDrawingPauses();
	vi.clearAllMocks();
	moves.recorded = [];
	roomRow.current = { ...ROOM, game: "blackjack", status: "playing" };
	finishMock.mockResolvedValue(true);
	cashOutMock.mockResolvedValue(true);
	vi.spyOn(Math, "random").mockReturnValue(0.5);
});

afterEach(() => {
	_clearBlackjackGames();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("a two seat chip table, hand after hand", () => {
	it("bets, pays 1 to 1, 3 to 2 and a push into the stacks, puts a broke seat out, and cashes the last seat out once", async () => {
		const room = fakeRoom();
		expect(await startBlackjackTable(room.channel, "g1", ALICE, true, "room-1", [BOB], CHIP_TABLE)).toBe("started");
		expect(table().phase).toBe("betting");

		// Hand 1: Alice 19 beats the dealer's 18 for 1 to 1, Bob is dealt a natural for 3 to 2.
		table().shoe = cards(["10", "A", "10", "9", "K", "8"]);
		expect(await bet(ALICE.userId, 100)).toEqual({ ok: true });
		expect(await bet(BOB.userId, 50)).toEqual({ ok: true });
		expect(await act(ALICE.userId, "stand")).toEqual({ ok: true });
		expect(lastStacks()).toEqual([
			{ userId: ALICE.userId, stack: 1100 },
			{ userId: BOB.userId, stack: 1075 },
		]);
		expect(table().handNumber).toBe(2);

		// Hand 2: everyone holds 18, so both bets push back.
		table().shoe = cards(["10", "10", "10", "8", "8", "8"]);
		await bet(ALICE.userId, 250);
		await bet(BOB.userId, 100);
		await act(ALICE.userId, "stand");
		await act(BOB.userId, "stand");
		expect(lastStacks()).toEqual([
			{ userId: ALICE.userId, stack: 1100 },
			{ userId: BOB.userId, stack: 1075 },
		]);

		// Hand 3: Alice goes all in on 16 and loses it; Bob's 19 wins.
		table().shoe = cards(["10", "10", "10", "6", "9", "8"]);
		await bet(ALICE.userId, 1100);
		await bet(BOB.userId, 50);
		await act(ALICE.userId, "stand");
		await act(BOB.userId, "stand");
		expect(lastStacks()).toEqual([
			{ userId: ALICE.userId, stack: 0 },
			{ userId: BOB.userId, stack: 1125 },
		]);
		expect(table().seats[0].out).toBe("broke");
		expect(moves.recorded.map((move) => move.text)).toContain(gamesCopy.blackjack.brokeTrail(ALICE.userId));
		// Hand 4 waits on Bob alone.
		expect(blackjackTurnAdapter.whoseTurn(roomOf)).toBe(BOB.userId);

		// XP per hand, and no coins until the room ends.
		expect(awardBlackjackResult).toHaveBeenCalledTimes(3);
		expect(vi.mocked(awardBlackjackResult).mock.calls.every((call) => call[0].coinsPerHand === false)).toBe(true);
		expect(coinsMock).not.toHaveBeenCalled();

		// Bob leaves: his stack goes back to his wallet at once, through the ledger claim, once.
		const leave = press("leave", BOB.userId, room.client);
		room.click(leave);
		await vi.waitFor(() => expect(finishMock).toHaveBeenCalledOnce());
		expect(cashOutMock).toHaveBeenCalledOnce();
		expect(cashOutMock).toHaveBeenCalledWith(ROOM, BOB.userId, 1125);
		expect(answerInChannel).toHaveBeenCalledWith(leave, "member", { content: gamesCopy.blackjack.leftWithChips(1125) });

		// The room finishes once, naming the one member who ended above the buy in, and pays its coins once.
		expect(finishMock.mock.calls[0][2]).toEqual({ winnerId: BOB.userId });
		expect(coinsMock).toHaveBeenCalledOnce();
		expect(coinsMock).toHaveBeenCalledWith({
			guildId: "g1",
			game: "blackjack",
			roomId: "room-1",
			stacks: [
				{ userId: ALICE.userId, buyIn: 1000, stack: 0 },
				{ userId: BOB.userId, buyIn: 1000, stack: 1125 },
			],
		});
		expect(_activeBlackjackGameCount()).toBe(0);
	});

	it("cashes a seat that leaves mid table out once, and the table plays on without it", async () => {
		const room = fakeRoom();
		await startBlackjackTable(room.channel, "g1", ALICE, true, "room-1", [BOB], CHIP_TABLE);
		table().shoe = cards(["10", "10", "10", "6", "7", "8"]);
		await bet(ALICE.userId, 100);
		await bet(BOB.userId, 100);

		// Bob leaves with a hand in play: the bet on it is lost, the rest of his stack goes home.
		room.click(press("leave", BOB.userId, room.client));
		await vi.waitFor(() => expect(cashOutMock).toHaveBeenCalledOnce());
		expect(cashOutMock).toHaveBeenCalledWith(ROOM, BOB.userId, 900);

		const again = press("leave", BOB.userId, room.client);
		room.click(again);
		await flush();
		expect(cashOutMock).toHaveBeenCalledOnce();
		expect(finishMock).not.toHaveBeenCalled();
		expect(blackjackTurnAdapter.whoseTurn(roomOf)).toBe(ALICE.userId);
	});

	it("pays no coins when the room was already finished another way", async () => {
		const room = fakeRoom();
		finishMock.mockResolvedValue(false);
		await startBlackjackTable(room.channel, "g1", ALICE, true, "room-1", [], CHIP_TABLE);
		room.click(press("leave", ALICE.userId, room.client));
		await vi.waitFor(() => expect(finishMock).toHaveBeenCalledOnce());
		expect(coinsMock).not.toHaveBeenCalled();
	});
});

describe("a free table", () => {
	it("plays the same hands on a pretend stack and never reaches a wallet", async () => {
		const room = fakeRoom();
		await startBlackjackTable(room.channel, "g1", ALICE, true, "room-1", [], FREE_TABLE);
		table().shoe = cards(["10", "10", "9", "8"]);
		await bet(ALICE.userId, 50);
		await act(ALICE.userId, "stand");

		expect(table().seats[0].stack).toBe(1050);
		// The stacks are never written for a free table, only when a member last acted.
		expect(saveMock.mock.calls.every((call) => (call[1] as unknown[]).length === 0)).toBe(true);
		room.click(press("leave", ALICE.userId, room.client));
		await vi.waitFor(() => expect(finishMock).toHaveBeenCalledOnce());
		expect(cashOutMock).not.toHaveBeenCalled();
	});
});

describe("the turn clock", () => {
	const CLOCK = BOT_CONSTANTS.BLACKJACK_TURN_TIMEOUT_MS;

	it("bets the smallest choice when a betting turn runs out and stands when an action turn does, neither counting as the member acting", async () => {
		vi.useFakeTimers();
		const room = fakeRoom();
		await startBlackjackTable(room.channel, "g1", ALICE, true, "room-1", [BOB], FREE_TABLE);
		table().shoe = cards(["10", "10", "10", "6", "7", "8"]);
		const openedAt = saveMock.mock.calls[0][2] as Date;

		await vi.advanceTimersByTimeAsync(CLOCK - 1_000);
		expect(table().seats[0].bet).toBe(0);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(table().seats[0].bet).toBe(50);
		await vi.advanceTimersByTimeAsync(CLOCK);
		expect(table().phase).toBe("playing");

		await vi.advanceTimersByTimeAsync(CLOCK);
		expect(table().seats[0].hands[0].status).toBe("stood");
		await vi.advanceTimersByTimeAsync(CLOCK);
		expect(table().handNumber).toBe(2);

		const words = gameRoomsCopy.turnBoard;
		const lines = moves.recorded.map((move) => move.text);
		expect(lines).toContain(words.blackjackTimedOutBet(ALICE.userId, 50));
		expect(lines).toContain(words.blackjackTimedOutStand(ALICE.userId, "16"));
		// Every write of when a member last acted still names the table's open.
		expect(saveMock.mock.calls.every((call) => call[2] === openedAt)).toBe(true);
	});

	it("stops a table whose room was finished another way instead of playing on in it", async () => {
		vi.useFakeTimers();
		const room = fakeRoom();
		await startBlackjackTable(room.channel, "g1", ALICE, true, "room-1", [], FREE_TABLE);
		roomRow.current = { ...ROOM, game: "blackjack", status: "finished" };

		await vi.advanceTimersByTimeAsync(CLOCK);

		expect(_activeBlackjackGameCount()).toBe(0);
		expect(moves.recorded).toEqual([]);
	});
});

// A click from a member on a board button reaches the collector the room table wired on its channel.
it("answers a Leave from somebody with no seat with a notice, and moves nothing", async () => {
	const room = fakeRoom();
	await startBlackjackTable(room.channel, "g1", ALICE, true, "room-1", [], CHIP_TABLE);
	const stranger = press("leave", "stranger", room.client);
	room.click(stranger as unknown as ButtonInteraction);
	await flush();
	expect(stranger.showModal.mock.calls.length + stranger.reply.mock.calls.length).toBe(1);
	expect(cashOutMock).not.toHaveBeenCalled();
});
