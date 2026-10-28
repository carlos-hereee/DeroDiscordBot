import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Client, TextChannel } from "discord.js";

// ── a room's blackjack table on the shared turn board (2026-10 item 263 R3-29 and R3-4) ──
// A hand is the table's one turn: every move edits the hand's board in place with the move in
// its This turn block, and the result posts as a new board through the shared turn board while
// the hand's board STAYS in the room, its buttons off and its block finished with the move that
// ended the hand. Every move reaches the transcript once. Driven through the real turn adapter,
// handler, turn board and trail over a channel that keeps its messages in order.

const moves = vi.hoisted(() => ({ recorded: [] as { actorId: string; kind: string; text: string }[] }));
// The row the table's room reads back. Null by default: the prompt line and the room's finish have
// their own suites; the finished match case below hands one over to see the finish happen.
const roomRow = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: {
		findByRoomId: vi.fn(async () => roomRow.current),
		appendMove: vi.fn(async (_guildId: string, _roomId: string, move: { actorId: string; kind: string; text: string }) => {
			moves.recorded.push(move);
		}),
	},
}));
vi.mock("@features/game-rooms/roomLifecycle.js", () => ({ roomLifecycle: { finish: vi.fn(async () => true) } }));
vi.mock("./gameXp.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("./gameXp.js")>()), awardBlackjackResult: vi.fn() }));
// The text table, whatever art is on disk where the suite runs.
vi.mock("./blackjackRenderer.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./blackjackRenderer.js")>()),
	renderBlackjackTableCard: vi.fn(async () => null),
	renderBlackjackResultCard: vi.fn(async () => null),
}));

import { _clearBlackjackGames, blackjackTurnAdapter, startBlackjackTable } from "./blackjackHandler.js";
import { gameRoomsCopy } from "@features/game-rooms/gameRoomsCopy.js";
import { _resetDrawingPauses } from "@features/game-rooms/drawingPause.js";
import { roomLifecycle } from "@features/game-rooms/roomLifecycle.js";

const HOST = { userId: "host-1", username: "Host" };
const GUEST = { userId: "guest-1", username: "Guest" };

interface FakeMessage {
	id: string;
	payload: { content?: string | null; embeds?: unknown[]; components?: unknown[] };
	readonly embeds: unknown[];
	attachments: Map<string, { name: string }>;
	channel: unknown;
	client: Client;
	edit: ReturnType<typeof vi.fn>;
	createMessageComponentCollector: () => { on: () => unknown; stop: () => void };
}

// A room channel that keeps its messages in posting order.
function fakeRoom() {
	const messages: FakeMessage[] = [];
	let counter = 0;
	const channel = {
		id: "ch-1",
		client: {} as Client,
		isSendable: () => true,
		send: vi.fn(async (payload: FakeMessage["payload"]) => {
			const message: FakeMessage = {
				id: `m${++counter}`,
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
				createMessageComponentCollector: () => {
					const collector = { on: () => collector, stop: () => undefined };
					return collector;
				},
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
	it("keeps the hand's board with every move in its block, posts the result below it, and records each move once", async () => {
		const room = fakeRoom();
		expect(await startBlackjackTable(room.channel, "g1", HOST, true, "room-1", [GUEST])).toBe("started");
		const handBoard = room.messages[0];

		// Each seat hits once when it may, then stands, until the dealer plays.
		const hit = new Set<string>();
		for (let guard = 0; guard < 12; guard++) {
			const acting = blackjackTurnAdapter.whoseTurn(roomOf);
			if (!acting) break;
			const move = hit.has(acting) ? "stand" : "hit";
			hit.add(acting);
			expect(await blackjackTurnAdapter.apply({} as never, roomOf, acting, { move }, async () => undefined)).toEqual({ ok: true });
		}

		// The hand's board and the result: two messages, nothing left to press on either.
		expect(room.messages).toHaveLength(2);
		const [kept, result] = room.messages;
		expect(kept.id).toBe(handBoard.id);
		expect(kept.payload.components).toEqual([]);
		expect(result.payload.components).toEqual([]);

		// Every move on the hand's block once, the one that ended the hand included, and once in the
		// transcript; the result board repeats none of them.
		const lines = moves.recorded.map((move) => move.text);
		expect(lines.length).toBeGreaterThanOrEqual(2);
		const block = descriptionOf(kept);
		expect(block).toContain(`**${gameRoomsCopy.turnBoard.thisTurnLabel}**`);
		for (const line of lines) {
			expect(block.split("\n").filter((shown) => shown === line), line).toHaveLength(1);
			expect(descriptionOf(result)).not.toContain(line);
		}
		expect(new Set(lines).size).toBe(lines.length);
	});

	// A room table plays one hand and closes its room, and the transcript is what outlives the room:
	// every action the hand took is in it once, in the order played, and nothing else is.
	it("a finished match's transcript holds every move of every turn exactly once", async () => {
		const room = fakeRoom();
		expect(await startBlackjackTable(room.channel, "g1", HOST, true, "room-1", [GUEST])).toBe("started");
		// The row the settle hands to finish. Stored as already finished so the turn prompt, which has
		// its own suite, finds no seat on the clock and posts nothing in this room.
		roomRow.current = { roomId: "room-1", guildId: "g1", channelId: "ch-1", status: "finished" };

		const played: { actor: string; move: "hit" | "stand" }[] = [];
		const hit = new Set<string>();
		for (let guard = 0; guard < 12; guard++) {
			const acting = blackjackTurnAdapter.whoseTurn(roomOf);
			if (!acting) break;
			const move = hit.has(acting) ? "stand" : "hit";
			hit.add(acting);
			expect(await blackjackTurnAdapter.apply({} as never, roomOf, acting, { move }, async () => undefined)).toEqual({ ok: true });
			played.push({ actor: acting, move });
		}

		// The hand ended: no seat is on the clock, and the settle closed the room once.
		expect(blackjackTurnAdapter.whoseTurn(roomOf)).toBeNull();
		await vi.waitFor(() => expect(roomLifecycle.finish).toHaveBeenCalledOnce());

		// One transcript row per action, in the order played, each the action it records. A hit's
		// line opens with the hitter and "hits:", a stand's with the stander and "stands on".
		const words = gameRoomsCopy.turnBoard;
		const openingOf = (entry: { actor: string; move: "hit" | "stand" }): string =>
			(entry.move === "hit" ? words.blackjackHit(entry.actor, "\u0000", "") : words.blackjackStand(entry.actor, "\u0000")).split("\u0000")[0];
		expect(played.length).toBeGreaterThanOrEqual(2);
		expect(moves.recorded.map((move) => move.actorId)).toEqual(played.map((entry) => entry.actor));
		for (const [index, entry] of played.entries()) expect(moves.recorded[index].text.startsWith(openingOf(entry)), moves.recorded[index].text).toBe(true);
		const lines = moves.recorded.map((move) => move.text);
		expect(new Set(lines).size).toBe(lines.length);
	});
});
