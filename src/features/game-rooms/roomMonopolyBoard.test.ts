import { describe, it, expect, vi, beforeEach } from "vitest";
import { TextChannel, type Client } from "discord.js";

// ── roomMonopolyBoard ────────────────────────────────────────────────
// One board per turn (2026-10 item 263 R3-29): a turn's board is edited in place while the
// turn runs and STAYS in the room with its This turn block once the turn passes, and the new
// turn's board posts below it. Driven end to end through the real commit path, the real turn
// board and the real trail, over an in-memory row and a channel that keeps its messages in
// order, so the room reads as a member scrolling it would see.

const row = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

// Reads a dotted path ("secret.seats.0.position") off the row.
const valueAt = (target: unknown, path: string): unknown =>
	path.split(".").reduce<unknown>((value, key) => (value === null || value === undefined ? undefined : (value as Record<string, unknown>)[key]), target);

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: {
		findByRoomId: vi.fn(async () => row.current),
		findPlayingByGame: vi.fn(async () => (row.current ? [row.current] : [])),
		// The compare and swap, as Mongo runs it: every expected path must still hold.
		updateSecretIf: vi.fn(async (_guildId: string, _roomId: string, expected: Record<string, unknown>, secret: unknown) => {
			const current = row.current;
			if (!current) return null;
			for (const [path, value] of Object.entries(expected)) if ((valueAt(current, path) ?? null) !== (value ?? null)) return null;
			current.secret = structuredClone(secret);
			return current;
		}),
		moveBoardMessage: vi.fn(async (_guildId: string, _roomId: string, fromId: string | null, toId: string) => {
			const secret = row.current?.secret as { boardMessageId: string | null } | undefined;
			if (!secret || (secret.boardMessageId ?? null) !== fromId) return null;
			secret.boardMessageId = toId;
			return row.current;
		}),
		appendMove: vi.fn(async (_guildId: string, _roomId: string, move: unknown) => {
			(row.current?.moves as unknown[]).push(move);
		}),
	},
}));
vi.mock("./roomLifecycle.js", () => ({ roomLifecycle: { finish: vi.fn(async () => true) } }));
vi.mock("@features/games/gameXp.js", () => ({ awardMultiPlayerResult: vi.fn() }));
vi.mock("@features/ratings/recordMatchRatings.js", () => ({ recordMatchRatings: vi.fn(), monopolyFinishingOrder: vi.fn(() => []) }));
// The text board, whatever art is on disk where the suite runs.
vi.mock("@features/games/monopolyRenderer.js", () => ({ renderBoard: vi.fn(async () => null), renderWinnerCard: vi.fn(async () => null), monopolyWinnerView: vi.fn() }));
// The prompt line has its own suite (turnPrompt.test.ts); here it is a no-op unless a test makes it post one.
vi.mock("./turnPrompt.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("./turnPrompt.js")>()), syncTurnPrompt: vi.fn(async () => undefined) }));

import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { applyEndTurn, applyForfeit, applyRoll, applySkip, createInitialState, type MonopolyResult, type MonopolyState } from "@features/games/monopolyState.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { commitMonopolyMove, persistIfUnchanged } from "./roomMonopolyHandlers.js";
import { postBelowMonopolyBoard, splitTurnLines } from "./roomMonopolyBoard.js";
import { surrenderMonopolySeat, surrenderMove } from "./roomMonopolySurrender.js";
import { sweepMonopolyIdle } from "./roomTurnSweep.js";
import { _resetDrawingPauses } from "./drawingPause.js";
import { syncTurnPrompt } from "./turnPrompt.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { labelBotMentions } from "./botSeat.js";

const A = "player-a";
const B = "player-b";
const C = "player-c";
// A Dero bot seat: it gets no turn line, so its turn's board keeps buttons a member's does not.
const BOT = "dero-bot-red";
// rollDie is floor(rng * 6) + 1: a 1 and a 2, three steps onto an unowned lot, no doubles.
const noDoubles = (): (() => number) => {
	const rolls = [0, 0.2];
	return () => rolls.shift() ?? 0;
};

interface FakeMessage {
	id: string;
	payload: { content?: string | null; embeds?: unknown[]; components?: unknown[] };
	// What a posted message reads back, as discord.js gives it: the embeds it shows and its files.
	readonly embeds: unknown[];
	attachments: Map<string, { name: string }>;
	edit: ReturnType<typeof vi.fn>;
	delete: ReturnType<typeof vi.fn>;
}

// A text channel that keeps its messages in posting order: send appends, delete removes.
function fakeRoom(options: { failDeletes?: boolean } = {}) {
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
				delete: vi.fn(async () => {
					if (options.failDeletes) throw new Error("the process died before the delete");
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
	Object.defineProperty(channel, "lastMessageId", { get: () => messages.at(-1)?.id ?? null });
	const client = { channels: { fetch: vi.fn(async () => channel) }, guilds: { cache: new Map(), fetch: vi.fn(async () => null) } } as unknown as Client;
	return { channel, client, messages };
}

// A playing room whose first board is already the room's only message.
async function seedMatch(room: ReturnType<typeof fakeRoom>, seats: string[] = [A, B]): Promise<IGameRoom> {
	const first = await room.channel.send({ embeds: [{ title: "board" }], components: [{ row: 1 }] });
	const state: MonopolyState = { ...createInitialState(seats, { auctionsEnabled: false }, Date.now(), 1), boardMessageId: first.id };
	row.current = { roomId: "room-1", guildId: "guild-1", game: "monopoly", status: "playing", hostId: A, playerIds: seats, channelId: "ch-1", monopolyReferee: false, moves: [], secret: state };
	return row.current as unknown as IGameRoom;
}

const stored = (): MonopolyState => row.current?.secret as MonopolyState;
const boardIsLast = (room: ReturnType<typeof fakeRoom>): boolean => room.messages.at(-1)?.id === stored().boardMessageId;
const transcript = (): string[] => (row.current?.moves as { text: string }[]).map((move) => move.text);
// A board's embed description as the room reads it, block included.
const descriptionOf = (message: FakeMessage): string => (message.payload.embeds?.[0] as { data?: { description?: string } } | undefined)?.data?.description ?? "";

beforeEach(() => {
	vi.clearAllMocks();
	_resetDrawingPauses();
	row.current = null;
});

describe("splitTurnLines", () => {
	it("keeps a move's lines on the turn while the turn runs on", () => {
		const read = { ...createInitialState([A, B], { auctionsEnabled: false }, 1, 1), turnLog: ["earlier"] };
		const split = splitTurnLines(read, { ...read, revision: read.revision + 1 }, ["rolled"]);
		expect(split).toEqual({ finishedShown: null, finishedNew: [], current: ["earlier", "rolled"], currentNew: ["rolled"] });
	});

	it("closes the turn at the handoff line, which opens the next turn's board", () => {
		const read = { ...createInitialState([A, B], { auctionsEnabled: false }, 1, 1), turnLog: ["rolled"] };
		const next = { ...read, stats: { turnsTaken: 1, auctionsOpened: 0, forfeits: 0, lowestCashShare: {} } };
		const split = splitTurnLines(read, next, ["bought", `It is now <@${B}>'s turn.`]);
		expect(split.finishedShown).toEqual(["rolled", "bought"]);
		expect(split.finishedNew).toEqual(["bought"]);
		expect(split.current).toEqual([`It is now <@${B}>'s turn.`]);
	});
});

describe("one board per turn", () => {
	it("carries a running turn's lines on the board, edited in place, with nothing posted under it", async () => {
		const room = fakeRoom();
		const seeded = await seedMatch(room);

		await commitMonopolyMove(room.client, seeded, A, (state) => applyRoll(state, noDoubles()), { onTurnOnly: true });

		expect(room.messages).toHaveLength(1);
		expect(boardIsLast(room)).toBe(true);
		expect(stored().turnLog?.[0]).toBe(`<@${A}> rolled 1 and 2.`);
		// Every line the board carries is in the transcript, once, after the edit that showed it.
		expect(transcript()).toEqual(stored().turnLog);
		const description = JSON.stringify(room.messages[0].payload.embeds);
		expect(description).toContain("rolled 1 and 2.");
	});

	it("keeps the finished turn's board with its last lines and no buttons, and posts the new turn's board below it, with no log message", async () => {
		const room = fakeRoom();
		const seeded = await seedMatch(room);
		const firstBoard = stored().boardMessageId;
		await commitMonopolyMove(room.client, seeded, A, (state) => applyRoll(state, noDoubles()), { onTurnOnly: true });
		await commitMonopolyMove(room.client, seeded, A, (state, actorId) => applyEndTurnAfterSkip(state, actorId), { onTurnOnly: true });

		expect(room.messages).toHaveLength(2);
		const [kept, board] = room.messages;
		expect(kept.id).toBe(firstBoard);
		expect(kept.payload.components).toEqual([]);
		const keptBlock = descriptionOf(kept);
		expect(keptBlock).toContain(`**${gameRoomsCopy.turnBoard.thisTurnLabel}**`);
		expect(keptBlock).toContain(`<@${A}> rolled 1 and 2.`);
		expect(keptBlock).not.toContain("It is now");
		expect(board.id).toBe(stored().boardMessageId);
		expect(descriptionOf(board)).toContain(`It is now <@${B}>'s turn.`);
		expect(descriptionOf(board)).not.toContain("rolled 1 and 2.");
		expect(stored().turnLog).toEqual([`It is now <@${B}>'s turn.`]);
		// One transcript row per line, each once, whichever board carried it, in the order played.
		expect(transcript().filter((line) => line.includes("rolled 1 and 2."))).toHaveLength(1);
		expect(transcript().at(-1)).toBe(`It is now <@${B}>'s turn.`);
	});

	it("posts the turn prompt between the finished turn's board and the new board", async () => {
		const room = fakeRoom();
		const seeded = await seedMatch(room);
		await commitMonopolyMove(room.client, seeded, A, (state) => applyRoll(state, noDoubles()), { onTurnOnly: true });
		// Only the turn that passes posts a prompt line; the roll above edited the board in place.
		vi.mocked(syncTurnPrompt).mockImplementationOnce(async (client) => {
			const channel = (await client.channels.fetch("ch-1")) as TextChannel;
			await channel.send({ content: "it's your turn" });
		});
		await commitMonopolyMove(room.client, seeded, A, (state, actorId) => applyEndTurnAfterSkip(state, actorId), { onTurnOnly: true });

		expect(room.messages.map((message) => message.payload.content ?? "board")).toEqual(["board", "it's your turn", "board"]);
		expect(boardIsLast(room)).toBe(true);
	});

	// The acceptance case (2026-10 item 263 R3-29 and R3-4): five turns, five boards, each with its
	// own block, every move once in the room and once in the transcript. Seat one is a Dero bot,
	// so the newest board, on the bot's turn, carries the buttons no turn line holds for it.
	it("plays five turns and leaves five boards, only the newest with buttons, each with its own This turn block", async () => {
		const room = fakeRoom();
		const seeded = await seedMatch(room, [BOT, A]);
		const seats = [BOT, A, BOT, A];
		for (const seat of seats) {
			await commitMonopolyMove(room.client, seeded, seat, (state) => applyRoll(state, noDoubles()), { onTurnOnly: true });
			await commitMonopolyMove(room.client, seeded, seat, (state, actorId) => applyEndTurnAfterSkip(state, actorId), { onTurnOnly: true });
		}

		expect(room.messages).toHaveLength(5);
		expect(boardIsLast(room)).toBe(true);
		const withButtons = room.messages.filter((message) => (message.payload.components ?? []).length > 0);
		expect(withButtons.map((message) => message.id)).toEqual([stored().boardMessageId]);
		for (const [index, seat] of seats.entries()) {
			const block = descriptionOf(room.messages[index]);
			expect(block).toContain(`**${gameRoomsCopy.turnBoard.thisTurnLabel}**`);
			// A bot's lines name it in the room (labelBotMentions), never as a raw mention.
			const roller = seat === A ? `<@${A}>` : "Red";
			expect(block).toContain(`${roller}`);
			expect(block).toContain("rolled 1 and 2.");
		}
		expect(descriptionOf(room.messages[4])).toContain("It is now");
		// Every line in the transcript once and on exactly one board: a line two turns share word for
		// word ("It is now X's turn.") is on as many boards as the transcript holds it.
		const lines = transcript();
		for (const line of new Set(lines)) {
			const boards = room.messages.filter((message) => descriptionOf(message).includes(labelBotMentions(line)));
			expect(boards.length, line).toBe(lines.filter((candidate) => candidate === line).length);
		}
		expect(lines.filter((line) => line.includes("rolled 1 and 2."))).toHaveLength(4);
		// No message other than the five boards: the finished turns posted no log message.
		expect(room.messages.every((message) => !message.payload.content)).toBe(true);
	});

	it("leads every reader to the new board: the next move edits it, and the idle sweep posts the next turn's", async () => {
		const room = fakeRoom();
		const seeded = await seedMatch(room, [A, B, C]);
		await commitMonopolyMove(room.client, seeded, A, (state) => applyRoll(state, noDoubles()), { onTurnOnly: true });
		await commitMonopolyMove(room.client, seeded, A, (state, actorId) => applyEndTurnAfterSkip(state, actorId), { onTurnOnly: true });
		const movedTo = stored().boardMessageId;

		// The next move's redraw reads the board the row points at now.
		await commitMonopolyMove(room.client, seeded, B, (state) => applyRoll(state, noDoubles()), { onTurnOnly: true });
		expect(stored().boardMessageId).toBe(movedTo);
		expect(boardIsLast(room)).toBe(true);
		expect(JSON.stringify(room.messages.at(-1)?.payload.embeds)).toContain(`<@${B}> rolled 1 and 2.`);

		// The idle sweep's forfeit passes the turn, so it posts the next turn's board.
		const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
		stored().turnStartedAt = twoDaysAgo;
		for (const move of row.current?.moves as { at: Date }[]) move.at = new Date(twoDaysAgo);
		await sweepMonopolyIdle(room.client, new Date());
		expect(stored().boardMessageId).not.toBe(movedTo);
		expect(boardIsLast(room)).toBe(true);
		expect(room.messages.map((message) => message.id)).toContain(movedTo);
	});

	it("loses a write computed before the board moved, so the old id is never written back", async () => {
		const room = fakeRoom();
		const seeded = await seedMatch(room);
		const staleRead = structuredClone(stored());
		await commitMonopolyMove(room.client, seeded, A, (state) => applyRoll(state, noDoubles()), { onTurnOnly: true });
		await commitMonopolyMove(room.client, seeded, A, (state, actorId) => applyEndTurnAfterSkip(state, actorId), { onTurnOnly: true });
		const movedTo = stored().boardMessageId;

		const written = await persistIfUnchanged(seeded, staleRead, { ...staleRead, revision: staleRead.revision + 1 }, []);
		expect(written).toBeNull();
		expect(stored().boardMessageId).toBe(movedTo);
	});

	it("ends the match on its last turn's board, edited in place, with no new board", async () => {
		const room = fakeRoom();
		const seeded = await seedMatch(room);
		await commitMonopolyMove(room.client, seeded, A, (state) => applyRoll(state, noDoubles()), { onTurnOnly: true });
		const boardId = stored().boardMessageId;
		await commitMonopolyMove(room.client, seeded, A, (state) => applyForfeit(state, A), { onTurnOnly: false });

		expect(room.messages).toHaveLength(1);
		expect(stored().boardMessageId).toBe(boardId);
		expect(room.messages[0].payload.components).toEqual([]);
		expect(descriptionOf(room.messages[0])).toContain("rolled 1 and 2.");
	});

	// The transcript outlives the room, so a match played to its end must leave every line every turn
	// made in it once, in the order played. The shortest real ending: two turns, then the second seat
	// surrenders through the Surrender confirm's own path, which leaves one seat and finishes the match.
	it("a finished match's transcript holds every move of every turn exactly once", async () => {
		const room = fakeRoom();
		const seeded = await seedMatch(room);
		const { roomLifecycle } = await import("./roomLifecycle.js");

		// Each move's engine lines, kept as the real commit path applies them; nothing races here, so
		// every move applied is a move that landed.
		const expected: string[] = [];
		const keeping =
			(move: (state: MonopolyState, actorId: string) => MonopolyResult) =>
			(state: MonopolyState, actorId: string): MonopolyResult => {
				const result = move(state, actorId);
				if (result.ok) expected.push(...result.trailLines);
				return result;
			};
		const roll = keeping((state) => applyRoll(state, noDoubles()));
		const endTurn = keeping(applyEndTurnAfterSkip);
		expect((await commitMonopolyMove(room.client, seeded, A, roll, { onTurnOnly: true })).ok).toBe(true);
		expect((await commitMonopolyMove(room.client, seeded, A, endTurn, { onTurnOnly: true })).ok).toBe(true);
		expect((await commitMonopolyMove(room.client, seeded, B, roll, { onTurnOnly: true })).ok).toBe(true);

		// The surrender's lines, worked out on a copy of the match it reads: its own line ahead of the forfeit's.
		const surrender = surrenderMove(structuredClone(stored()), B, [gameRoomsCopy.monopoly.surrendered(B)], false);
		expect(surrender.ok).toBe(true);
		if (surrender.ok) expected.push(...surrender.trailLines);
		expect(await surrenderMonopolySeat(room.client, seeded, B)).toBe("surrendered");

		// The match is over, through its real finish.
		expect(stored().phase).toBe("finished");
		expect(stored().winnerId).toBe(A);
		expect(roomLifecycle.finish).toHaveBeenCalledOnce();

		// Every line once, in order, and nothing else; and each on exactly as many boards as the
		// transcript holds it.
		const lines = transcript();
		expect(lines).toEqual(expected);
		expect(lines.filter((line) => line.includes("rolled 1 and 2."))).toHaveLength(2);
		expect(lines).toContain(gameRoomsCopy.monopoly.surrendered(B));
		for (const line of new Set(lines)) {
			const boards = room.messages.filter((message) => descriptionOf(message).includes(labelBotMentions(line)));
			expect(boards.length, line).toBe(lines.filter((candidate) => candidate === line).length);
		}
	});

	it("posts a referee notice below the board and never a second board for the same turn", async () => {
		const room = fakeRoom();
		const seeded = await seedMatch(room);
		const firstBoard = stored().boardMessageId;

		await postBelowMonopolyBoard(room.client, seeded, (channel) => channel.send({ content: "Dero joined the call." }));
		expect(stored().boardMessageId).toBe(firstBoard);
		expect(room.messages.map((message) => message.payload.content ?? "board")).toEqual(["board", "Dero joined the call."]);
		expect(gameRoomStore.moveBoardMessage).not.toHaveBeenCalled();
	});

	it("posts a fresh board when the stored one was deleted from under the match", async () => {
		const room = fakeRoom();
		const seeded = await seedMatch(room);
		room.messages.splice(0, 1);

		await commitMonopolyMove(room.client, seeded, A, (state) => applyRoll(state, noDoubles()), { onTurnOnly: true });
		expect(room.messages).toHaveLength(1);
		expect(boardIsLast(room)).toBe(true);
		expect(gameRoomStore.moveBoardMessage).toHaveBeenCalledOnce();
	});
});

// The landing lot is unowned, so the seat skips it, then ends the turn: one move of two
// engine actions, with the handoff line last, the way a real turn ends.
function applyEndTurnAfterSkip(state: MonopolyState, actorId: string): MonopolyResult {
	const skipped = applySkip(state, actorId);
	if (!skipped.ok) return skipped;
	const ended = applyEndTurn(skipped.state);
	return ended.ok ? { ...ended, trailLines: [...skipped.trailLines, ...ended.trailLines] } : ended;
}
