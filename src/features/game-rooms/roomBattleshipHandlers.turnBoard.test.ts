import { describe, it, expect, vi, beforeEach } from "vitest";
import { TextChannel, type Client } from "discord.js";

// ── Battleship on the shared turn board (2026-10 item 263 R3-29 and R3-4) ──
// A shot is a turn: each shot posts the battle's board afresh with that shot in its This turn
// block, the board before it stays in the room with its buttons off, and the shot reaches the
// transcript once, through the board, never as a line of its own. Driven through the real turn
// adapter, handlers, turn board and trail, over an in memory row and a channel that keeps its
// messages in order.

const row = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: {
		findByRoomId: vi.fn(async () => (row.current ? structuredClone(row.current) : null)),
		update: vi.fn(async (_guildId: string, _roomId: string, patch: Record<string, unknown>) => {
			if (!row.current) return null;
			Object.assign(row.current, structuredClone(patch));
			return structuredClone(row.current);
		}),
		moveBoardMessage: vi.fn(async (_guildId: string, _roomId: string, fromId: string | null, toId: string) => {
			const secret = row.current?.secret as { boardMessageId?: string | null } | undefined;
			if (!secret || (secret.boardMessageId ?? null) !== fromId) return null;
			secret.boardMessageId = toId;
			return structuredClone(row.current);
		}),
		appendMove: vi.fn(async (_guildId: string, _roomId: string, move: unknown) => {
			(row.current?.moves as unknown[]).push(move);
		}),
	},
}));
vi.mock("./roomLifecycle.js", () => ({ roomLifecycle: { finish: vi.fn(async () => true) } }));
vi.mock("@features/games/gameXp.js", () => ({ awardTwoPlayerResult: vi.fn() }));
vi.mock("@features/leveling/awardXp.js", () => ({ awardXp: vi.fn() }));
vi.mock("@features/ratings/recordMatchRatings.js", () => ({ recordMatchRatings: vi.fn(), twoPlayerFinishingOrder: vi.fn(() => []) }));
// The text board, whatever art is on disk where the suite runs.
vi.mock("@features/games/battleshipRenderer.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("@features/games/battleshipRenderer.js")>()),
	renderBattleshipBoardCard: vi.fn(async () => null),
}));
// The prompt line has its own suite (turnPrompt.test.ts).
vi.mock("./turnPrompt.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("./turnPrompt.js")>()), syncTurnPrompt: vi.fn(async () => undefined) }));

import { battleshipTurnAdapter } from "./roomBattleshipHandlers.js";
import { battleshipBoardMessage, deserializeMatch, startMatch, type StoredBattleship } from "./roomBattleship.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { _resetDrawingPauses } from "./drawingPause.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

const A = "captain-a";
const B = "captain-b";

interface FakeMessage {
	id: string;
	payload: { content?: string | null; embeds?: unknown[]; components?: unknown[] };
	readonly embeds: unknown[];
	attachments: Map<string, { name: string }>;
	edit: ReturnType<typeof vi.fn>;
	delete: ReturnType<typeof vi.fn>;
}

// A text channel that keeps its messages in posting order: send appends, delete removes.
function fakeRoom() {
	const messages: FakeMessage[] = [];
	let counter = 0;
	const channel = Object.assign(Object.create(TextChannel.prototype) as TextChannel, {
		id: "ch-1",
		send: vi.fn(async (payload: FakeMessage["payload"]) => {
			const message: FakeMessage = {
				id: `m${++counter}`,
				payload,
				get embeds() {
					return message.payload.embeds ?? [];
				},
				attachments: new Map(),
				edit: vi.fn(async (edit: FakeMessage["payload"]) => {
					message.payload = { ...message.payload, ...edit };
					return message;
				}),
				delete: vi.fn(async () => {
					messages.splice(messages.indexOf(message), 1);
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
	});
	const client = { channels: { fetch: vi.fn(async () => channel) } } as unknown as Client;
	return { channel, client, messages };
}

// A plain LCG, so the fleets are laid the same way every run.
function seededRng(seed = 3): () => number {
	let state = seed;
	return () => {
		state = (state * 1664525 + 1013904223) % 4294967296;
		return state / 4294967296;
	};
}

// A battle under way whose opening board is already the room's only message.
async function seedBattle(room: ReturnType<typeof fakeRoom>): Promise<void> {
	const laid = startMatch({ playerIds: [A, B] } as IGameRoom, { [A]: "Captain A", [B]: "Captain B" }, seededRng());
	const playing: StoredBattleship = { ...laid, status: "playing", ready: [true, true] };
	const first = await room.channel.send(await battleshipBoardMessage(deserializeMatch(playing), "room-1"));
	row.current = {
		roomId: "room-1",
		guildId: "guild-1",
		game: "battleship",
		status: "playing",
		hostId: A,
		playerIds: [A, B],
		channelId: "ch-1",
		moves: [],
		secret: { ...playing, boardMessageId: first.id },
	};
}

const snapshot = (): IGameRoom => structuredClone(row.current) as unknown as IGameRoom;
const boardId = (): string | null => (row.current?.secret as StoredBattleship).boardMessageId ?? null;
const transcript = (): string[] => (row.current?.moves as { text: string }[]).map((move) => move.text);
const descriptionOf = (message: FakeMessage): string => (message.payload.embeds?.[0] as { data?: { description?: string } } | undefined)?.data?.description ?? "";

beforeEach(() => {
	vi.clearAllMocks();
	_resetDrawingPauses();
	row.current = null;
});

describe("each shot is a turn on the shared turn board", () => {
	it("fires five shots and leaves five shot boards, only the newest with buttons, each with its own shot", async () => {
		const room = fakeRoom();
		await seedBattle(room);
		const openingBoard = boardId();
		// Each captain walks its own row of the grid, so no cell is fired twice.
		const nextCell: Record<string, number> = { [A]: 0, [B]: 0 };

		for (let shot = 0; shot < 5; shot++) {
			const current = snapshot();
			const shooter = battleshipTurnAdapter.whoseTurn(current)!;
			const x = nextCell[shooter]++;
			const result = await battleshipTurnAdapter.apply(room.client, current, shooter, { file: String(x), rank: shooter === A ? "0" : "9" }, async () => undefined);
			expect(result).toEqual({ ok: true });
		}

		// The opening board stays too, with no block: the battle had no shot when it posted.
		expect(room.messages).toHaveLength(6);
		expect(room.messages[0].id).toBe(openingBoard);
		const shotBoards = room.messages.slice(1);
		expect(shotBoards.at(-1)?.id).toBe(boardId());
		expect(room.messages.filter((message) => (message.payload.components?.length ?? 0) > 0).map((message) => message.id)).toEqual([boardId()]);

		// Five shots in the transcript, each once, and each on its own board's block and no other.
		const lines = transcript();
		expect(lines).toHaveLength(5);
		for (const [index, board] of shotBoards.entries()) {
			const description = descriptionOf(board);
			expect(description).toContain(`**${gameRoomsCopy.turnBoard.thisTurnLabel}**`);
			expect(room.messages.filter((message) => descriptionOf(message).split("\n").includes(lines[index]))).toEqual([board]);
		}
		// No shot posted a line of its own: every message in the room is a board.
		expect(room.messages.every((message) => (message.payload.embeds?.length ?? 0) > 0)).toBe(true);
	});
});
