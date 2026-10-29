import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Client, TextChannel } from "discord.js";

// ── a room's blackjack table on the shared turn board (2026-10 item 263 R3-29 and R3-4) ──
// A hand is the table's one turn, its bets included (2026-10 item 267): every bet and move edits
// the hand's board in place with the line in its This turn block, the result posts as a new
// board through the shared turn board while the hand's board STAYS in the room, its buttons off
// and its block finished with the move that ended the hand, and the next hand's betting board
// posts below the result. Every bet and move reaches the transcript once. Driven through the real
// turn adapter, handler, turn board and trail over a channel that keeps its messages in order.

const moves = vi.hoisted(() => ({ recorded: [] as { actorId: string; kind: string; text: string }[] }));
// The row the table's room reads back. Null by default: the prompt line and the room's finish have
// their own suites; the finished table case below hands one over to see the finish happen.
const roomRow = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: {
		findByRoomId: vi.fn(async () => roomRow.current),
		appendMove: vi.fn(async (_guildId: string, _roomId: string, move: { actorId: string; kind: string; text: string }) => {
			moves.recorded.push(move);
		}),
		saveBlackjackStacks: vi.fn(async () => null),
	},
}));
vi.mock("@features/game-rooms/roomLifecycle.js", () => ({ roomLifecycle: { finish: vi.fn(async () => true) } }));
// The prompt line has its own suite; here it would only read rows this fake does not keep.
vi.mock("@features/game-rooms/turnPrompt.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("@features/game-rooms/turnPrompt.js")>()), syncTurnPrompt: vi.fn(async () => undefined) }));
vi.mock("./gameXp.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("./gameXp.js")>()), awardBlackjackResult: vi.fn(), awardBlackjackTableCoins: vi.fn() }));
// The text table, whatever art is on disk where the suite runs.
vi.mock("./blackjackRenderer.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./blackjackRenderer.js")>()),
	renderBlackjackTableCard: vi.fn(async () => null),
	renderBlackjackResultCard: vi.fn(async () => null),
}));

import { _blackjackTableOf, _clearBlackjackGames, blackjackTurnAdapter, startBlackjackTable } from "./blackjackHandler.js";
import type { Card, Rank } from "./blackjackState.js";
import { gameRoomsCopy } from "@features/game-rooms/gameRoomsCopy.js";
import { _resetDrawingPauses } from "@features/game-rooms/drawingPause.js";
import { roomLifecycle } from "@features/game-rooms/roomLifecycle.js";

const HOST = { userId: "host-1", username: "Host" };
const GUEST = { userId: "guest-1", username: "Guest" };
// A free table on the standard stack, so no wallet is in play here.
const FREE_TABLE = { buyIn: 1000, chips: false };

interface FakeMessage {
	id: string;
	channelId: string;
	payload: { content?: string | null; embeds?: unknown[]; components?: unknown[] };
	readonly embeds: unknown[];
	attachments: Map<string, { name: string }>;
	channel: unknown;
	client: Client;
	edit: ReturnType<typeof vi.fn>;
}

// A room channel that keeps its messages in posting order.
function fakeRoom() {
	const messages: FakeMessage[] = [];
	let counter = 0;
	const channel = {
		id: "ch-1",
		client: {} as Client,
		isSendable: () => true,
		// A room table hears every board through one collector on its channel.
		createMessageComponentCollector: () => {
			const collector = { on: () => collector, stop: () => undefined };
			return collector;
		},
		send: vi.fn(async (payload: FakeMessage["payload"]) => {
			const message: FakeMessage = {
				id: `m${++counter}`,
				channelId: "ch-1",
				payload,
				get embeds() {
					return message.payload.embeds ?? [];
				},
				attachments: new Map(),
				channel,
				client: {} as Client,
				edit: vi.fn(async (edit: FakeMessage["payload"]) => {
					message.payload = { ...message.payload, ...edit };
					return message;
				}),
			};
			messages.push(message);
			return message;
		}),
		messages: {
			fetch: vi.fn(async (id: string) => {
				const message = messages.find((candidate) => candidate.id === id);
				if (!message) throw new Error("Unknown Message");
				return message;
			}),
		},
	};
	return { channel: channel as unknown as TextChannel, messages };
}

const roomOf = { channelId: "ch-1", roomId: "room-1", guildId: "g1" } as never;
const descriptionOf = (message: FakeMessage): string => (message.payload.embeds?.[0] as { data?: { description?: string } } | undefined)?.data?.description ?? "";
const cards = (ranks: Rank[]): Card[] => ranks.map((rank) => ({ rank, suit: "S" }));

// Every seat bets the given choice of its turn modal, in seat order, until the hand deals.
async function betAll(pick: (amounts: number[]) => number): Promise<void> {
	for (let guard = 0; guard < 6; guard++) {
		const betting = _blackjackTableOf("ch-1");
		if (betting?.phase !== "betting") return;
		const acting = blackjackTurnAdapter.whoseTurn(roomOf);
		if (!acting) return;
		const field = blackjackTurnAdapter.view(roomOf, acting)?.fields[0];
		const amounts = field?.kind === "select" ? field.options.map((option) => Number(option.value)) : [];
		expect(await blackjackTurnAdapter.apply({} as never, roomOf, acting, { bet: String(pick(amounts)) }, async () => undefined)).toEqual({ ok: true });
	}
}

beforeEach(() => {
	_clearBlackjackGames();
	_resetDrawingPauses();
	moves.recorded = [];
	roomRow.current = null;
	vi.mocked(roomLifecycle.finish).mockClear();
	// A fixed deal, so the hand is the same every run and opens with no natural.
	vi.spyOn(Math, "random").mockReturnValue(0.5);
});

afterEach(() => {
	_clearBlackjackGames();
	vi.restoreAllMocks();
});

describe("a room's blackjack hand on the shared turn board", () => {
	it("keeps the hand's board with every bet and move in its block, posts the result below it, then the next hand's bets, and records each line once", async () => {
		const room = fakeRoom();
		expect(await startBlackjackTable(room.channel, "g1", HOST, true, "room-1", [GUEST], FREE_TABLE)).toBe("started");
		const handBoard = room.messages[0];
		await betAll((amounts) => amounts[0]);

		// Each seat hits once when it may, then stands, until the dealer plays.
		const hit = new Set<string>();
		for (let guard = 0; guard < 12; guard++) {
			if (_blackjackTableOf("ch-1")?.phase !== "playing") break;
			const acting = blackjackTurnAdapter.whoseTurn(roomOf);
			if (!acting) break;
			const move = hit.has(acting) ? "stand" : "hit";
			hit.add(acting);
			expect(await blackjackTurnAdapter.apply({} as never, roomOf, acting, { move }, async () => undefined)).toEqual({ ok: true });
		}

		// The hand's board, the result, and the next hand's betting board below them.
		expect(room.messages).toHaveLength(3);
		const [kept, result, next] = room.messages;
		expect(kept.id).toBe(handBoard.id);
		expect(kept.payload.components).toEqual([]);
		expect(result.payload.components).toEqual([]);
		// The bets and Leave ride the turn line, so no board of a room table carries a button.
		expect(next.payload.components).toEqual([]);
		expect(_blackjackTableOf("ch-1")?.handNumber).toBe(2);

		// Every bet and move on the hand's block once, the one that ended the hand included, and
		// once in the transcript; the result board repeats none of them.
		const lines = moves.recorded.map((move) => move.text);
		expect(lines.length).toBeGreaterThanOrEqual(4);
		expect(lines[0]).toBe(gameRoomsCopy.turnBoard.blackjackBet(HOST.userId, 50));
		const block = descriptionOf(kept);
		expect(block).toContain(`**${gameRoomsCopy.turnBoard.thisTurnLabel}**`);
		for (const line of lines) {
			expect(block.split("\n").filter((shown) => shown === line), line).toHaveLength(1);
			expect(descriptionOf(result)).not.toContain(line);
		}
		expect(new Set(lines).size).toBe(lines.length);
	});

	// The transcript is what outlives the room: every bet and action the table took is in it once,
	// in the order played, and the table closes its room once when nobody has chips left.
	it("a finished table's transcript holds every bet and move exactly once, and the room finishes once", async () => {
		const room = fakeRoom();
		roomRow.current = { roomId: "room-1", guildId: "g1", channelId: "ch-1", game: "blackjack", status: "playing" };
		expect(await startBlackjackTable(room.channel, "g1", HOST, true, "room-1", [GUEST], FREE_TABLE)).toBe("started");

		// Both seats go all in on a hand that loses to the dealer's 18, so both are out after it.
		const table = _blackjackTableOf("ch-1");
		if (!table) throw new Error("no table");
		table.shoe = cards(["10", "10", "10", "6", "6", "8"]);
		await betAll((amounts) => amounts[amounts.length - 1]);
		const played: string[] = [];
		for (let guard = 0; guard < 4; guard++) {
			const acting = blackjackTurnAdapter.whoseTurn(roomOf);
			if (!acting || table.phase !== "playing") break;
			expect(await blackjackTurnAdapter.apply({} as never, roomOf, acting, { move: "stand" }, async () => undefined)).toEqual({ ok: true });
			played.push(acting);
		}

		expect(table.seats.map((seat) => seat.out)).toEqual(["broke", "broke"]);
		expect(blackjackTurnAdapter.whoseTurn(roomOf)).toBeNull();
		await vi.waitFor(() => expect(roomLifecycle.finish).toHaveBeenCalledOnce());
		expect(vi.mocked(roomLifecycle.finish).mock.calls[0][2]).toEqual({ winnerId: null });

		const words = gameRoomsCopy.turnBoard;
		expect(moves.recorded.map((move) => move.text).slice(0, 4)).toEqual([
			words.blackjackBet(HOST.userId, 1000),
			words.blackjackBet(GUEST.userId, 1000),
			words.blackjackStand(HOST.userId, "16"),
			words.blackjackStand(GUEST.userId, "16"),
		]);
		expect(played).toEqual([HOST.userId, GUEST.userId]);
		const lines = moves.recorded.map((move) => move.text);
		expect(new Set(lines).size).toBe(lines.length);
	});
});
