import { describe, it, expect, vi, beforeEach } from "vitest";
import { EmbedBuilder, TextChannel, type Client, type ModalSubmitInteraction } from "discord.js";

// ── Hangman on the shared turn board (2026-10 item 263 R3-29 and R3-4) ──
// A guess is a turn: each guess posts a gallows card with that guess (and any hint it earned)
// in its This turn block, the card before it stays in the room with its controls off, and the
// guess reaches the transcript once, through its card, never as a line of its own. Driven
// through the real guess handler, turn board and trail, over an in memory row and a channel
// that keeps its messages in order.

const row = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

const valueAt = (target: unknown, path: string): unknown =>
	path.split(".").reduce<unknown>((value, key) => (value === null || value === undefined ? undefined : (value as Record<string, unknown>)[key]), target);

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: {
		findByRoomId: vi.fn(async () => (row.current ? structuredClone(row.current) : null)),
		update: vi.fn(async (_guildId: string, _roomId: string, patch: Record<string, unknown>) => {
			if (!row.current) return null;
			Object.assign(row.current, structuredClone(patch));
			return structuredClone(row.current);
		}),
		moveBoardMessage: vi.fn(async (_guildId: string, _roomId: string, fromId: string | null, toId: string, _alsoSet: unknown, field = "boardMessageId") => {
			const secret = row.current?.secret as Record<string, unknown> | undefined;
			if (!secret || ((valueAt(secret, field) as string | null | undefined) ?? null) !== fromId) return null;
			secret[field] = toId;
			return structuredClone(row.current);
		}),
		appendMove: vi.fn(async (_guildId: string, _roomId: string, move: unknown) => {
			(row.current?.moves as unknown[]).push(move);
		}),
	},
}));
vi.mock("./roomLifecycle.js", () => ({ roomLifecycle: { finish: vi.fn(async () => true) } }));
vi.mock("@features/games/gameXp.js", () => ({ awardMultiPlayerResult: vi.fn() }));
// The gallows picture is the shared board module's business; here a card is its embed, whose
// description the handler composes (the This turn block among it).
vi.mock("@features/games/hangmanBoard.js", () => ({
	playingBoardPicture: vi.fn(async (_state: unknown, description: string) => ({ embeds: [new EmbedBuilder().setDescription(description)], files: [] })),
}));

import { handleGuessModal } from "./roomHangman.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { GAME_ROOM_MODAL_PREFIX } from "./gameRoomActions.js";

const HOST = "host-1";
const GUESSER = "guesser-1";

interface FakeMessage {
	id: string;
	payload: { content?: string | null; embeds?: unknown[]; components?: unknown[] };
	readonly embeds: unknown[];
	attachments: Map<string, { name: string }>;
	edit: ReturnType<typeof vi.fn>;
}

function fakeRoom() {
	const messages: FakeMessage[] = [];
	let counter = 0;
	const channel = Object.assign(Object.create(TextChannel.prototype) as TextChannel, {
		id: "ch-1",
		isTextBased: () => true,
		isDMBased: () => false,
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
	return { client, messages };
}

function seedRound(): void {
	row.current = {
		roomId: "room-1",
		guildId: "guild-1",
		game: "hangman",
		status: "playing",
		hostId: HOST,
		playerIds: [HOST, GUESSER],
		channelId: "ch-1",
		moves: [],
		secret: { word: "planet", hint: "it goes around a star", extraHints: ["it has rings, sometimes"], revealedHints: 0, authoredBy: HOST, guessedLetters: [], wrong: 0, gallowsMessageId: null },
	};
}

function guess(client: Client, letter: string): ModalSubmitInteraction {
	return {
		customId: `${GAME_ROOM_MODAL_PREFIX}:guess:room-1`,
		guildId: "guild-1",
		user: { id: GUESSER },
		client,
		guild: { members: { cache: { get: () => undefined } } },
		fields: { getTextInputValue: (key: string) => (key === "letter" ? letter : "") },
		reply: vi.fn().mockResolvedValue(undefined),
		isFromMessage: () => true,
		deferUpdate: vi.fn().mockResolvedValue(undefined),
	} as unknown as ModalSubmitInteraction;
}

const transcript = (): string[] => (row.current?.moves as { text: string }[]).map((move) => move.text);
const descriptionOf = (message: FakeMessage): string => (message.payload.embeds?.[0] as { data?: { description?: string } } | undefined)?.data?.description ?? "";

beforeEach(() => {
	vi.clearAllMocks();
	row.current = null;
});

describe("each guess is a turn on the shared turn board", () => {
	it("plays five guesses and leaves five cards, only the newest with controls, each with its own guess", async () => {
		const room = fakeRoom();
		seedRound();

		// Three hits and two misses, so the round stays open and a miss can earn a hint.
		for (const letter of ["p", "z", "l", "q", "a"]) await handleGuessModal(guess(room.client, letter));

		expect(room.messages).toHaveLength(5);
		const newest = (row.current?.secret as { gallowsMessageId: string }).gallowsMessageId;
		expect(room.messages.at(-1)?.id).toBe(newest);
		expect(room.messages.filter((message) => (message.payload.components?.length ?? 0) > 0).map((message) => message.id)).toEqual([newest]);

		// Every move in the transcript once, and on exactly one card: a guess on its own card, a hint
		// on the card of the miss that earned it. A guess's text runs over several lines (the word so
		// far under it), so a card is matched on the whole text.
		const lines = transcript();
		expect(lines.filter((line) => line.includes(`<@${GUESSER}>`))).toHaveLength(5);
		for (const line of lines) {
			expect(room.messages.filter((message) => descriptionOf(message).includes(line)), line).toHaveLength(1);
		}
		for (const card of room.messages) expect(descriptionOf(card)).toContain(`**${gameRoomsCopy.turnBoard.thisTurnLabel}**`);
	});

	it("ends the round on the last guess's own card, with no controls, then the result line", async () => {
		const room = fakeRoom();
		seedRound();

		for (const letter of ["p", "l", "a", "n", "e", "t"]) await handleGuessModal(guess(room.client, letter));

		expect(room.messages).toHaveLength(7);
		const [lastCard, result] = room.messages.slice(-2);
		expect(lastCard.payload.components).toEqual([]);
		expect(descriptionOf(lastCard)).toContain(`<@${GUESSER}>`);
		expect(result.payload.content).toBe(gameRoomsCopy.hangman.wonLine("planet"));
		expect(room.messages.filter((message) => (message.payload.components?.length ?? 0) > 0)).toEqual([]);
	});
});
