import { describe, it, expect, vi, beforeEach } from "vitest";
import { TextChannel, type Client, type ModalSubmitInteraction } from "discord.js";

// ── a full Hold'em hand through the turn prompt (2026-10 item 257 Phase 4a) ──
// The real engine, handlers, trail, repost and turn prompt over an in memory room row and a
// channel that keeps its messages in order and REFUSES an invalid button emoji the way Discord
// does (50035 COMPONENT_INVALID_EMOJI, the Log 2 failure). A heads up hand is played to the end
// entirely through each player's Take your turn modal: every decision is prompted, a fresh table
// posts at each street and at the showdown while each street's table stays in the room with its
// bets in its This turn block (2026-10 item 263 R3-29), the table is redrawn without a refusal,
// and a stale Submit is turned away.

const row = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

const valueAt = (target: unknown, path: string): unknown =>
	path.split(".").reduce<unknown>((value, key) => (value === null || value === undefined ? undefined : (value as Record<string, unknown>)[key]), target);

function setAt(target: Record<string, unknown>, path: string, value: unknown): void {
	const keys = path.split(".");
	const last = keys.pop() as string;
	const holder = keys.reduce<Record<string, unknown>>((node, key) => (node[key] ??= {}) as Record<string, unknown>, target);
	holder[last] = value;
}

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: {
		findByRoomId: vi.fn(async () => (row.current ? structuredClone(row.current) : null)),
		updateSecretIf: vi.fn(async (_guildId: string, _roomId: string, expected: Record<string, unknown>, secret: unknown) => {
			const current = row.current;
			if (!current) return null;
			for (const [path, value] of Object.entries(expected)) if ((valueAt(current, path) ?? null) !== (value ?? null)) return null;
			current.secret = structuredClone(secret);
			return structuredClone(current);
		}),
		moveBoardMessage: vi.fn(async (_guildId: string, _roomId: string, fromId: string | null, toId: string, alsoSet: Record<string, unknown> = {}) => {
			const current = row.current;
			if (!current || ((valueAt(current, "secret.boardMessageId") as string | null | undefined) ?? null) !== fromId) return null;
			setAt(current, "secret.boardMessageId", toId);
			for (const [path, value] of Object.entries(alsoSet)) setAt(current, path, value);
			return structuredClone(current);
		}),
		appendMove: vi.fn(async (_guildId: string, _roomId: string, move: unknown) => {
			(row.current?.moves as unknown[]).push(move);
		}),
		claimTurnPrompt: vi.fn(async (_guildId: string, _roomId: string, from: string | null, next: Record<string, unknown>) => {
			const current = row.current;
			const held = current?.turnPrompt as { fingerprint: string | null } | undefined;
			if (!current || (held?.fingerprint ?? null) !== from) return null;
			const before = structuredClone(current);
			current.turnPrompt = { ...next, played: false };
			return before;
		}),
		setTurnPromptPlayed: vi.fn(async (_guildId: string, _roomId: string, fingerprint: string, played: boolean) => {
			const held = row.current?.turnPrompt as { fingerprint: string | null; played: boolean } | undefined;
			if (!held || held.fingerprint !== fingerprint) return null;
			held.played = played;
			return structuredClone(row.current);
		}),
		setTurnPromptLayout: vi.fn(async () => ({})),
	},
}));
vi.mock("./roomLifecycle.js", () => ({ roomLifecycle: { finish: vi.fn() } }));
vi.mock("@features/leveling/awardXp.js", () => ({ awardXp: vi.fn() }));
vi.mock("@features/economy/deroCoins.js", () => ({ awardForResult: vi.fn() }));
vi.mock("@features/ratings/gameResultCounts.js", () => ({ recordShowdownHand: vi.fn() }));
vi.mock("@features/dero-brain/dealerNarration.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("@features/dero-brain/dealerNarration.js")>()), announceDealer: vi.fn() }));
vi.mock("@features/dero-brain/dealerShowdownRenderer.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("@features/dero-brain/dealerShowdownRenderer.js")>()),
	renderHoldemLiveCard: vi.fn(async () => null),
}));

import { holdemRevealKey, holdemTurnAdapter, redrawTable } from "./roomHoldemHandlers.js";
import { handleTurnSubmit } from "./turnPrompt.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { _resetDrawingPauses } from "./drawingPause.js";
import { createTable, dealHand, handInProgress, joinTable, whoActs, type HoldemTable } from "@features/games/holdemTable.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

const A = "player-a";
const B = "player-b";

// Discord accepts a unicode emoji only with an emoji presentation: the RGI set.
const ACCEPTED_EMOJI = new RegExp("^\\p{RGI_Emoji}$", "v");
const invalidEmoji: string[] = [];

interface FakeMessage {
	id: string;
	payload: { content?: string | null; embeds?: unknown[]; components?: unknown[]; allowedMentions?: { users?: string[] } };
	deleted: boolean;
	// Set when the message was sent as a turn prompt line, so it is still found after it is edited.
	isPrompt: boolean;
	// What a posted message reads back, as discord.js gives it: the embeds it shows and its files.
	readonly embeds: unknown[];
	attachments: Map<string, { name: string }>;
	edit: ReturnType<typeof vi.fn>;
	delete: ReturnType<typeof vi.fn>;
}

// What Discord does to a component with an emoji it does not know: it refuses the whole message.
function refuseInvalidEmoji(components: unknown[] | undefined): void {
	for (const component of components ?? []) {
		const json = (component as { toJSON?: () => { components: { emoji?: { name?: string } }[] } }).toJSON?.();
		for (const button of json?.components ?? []) {
			const name = button.emoji?.name;
			if (name && !ACCEPTED_EMOJI.test(name)) {
				invalidEmoji.push(name);
				throw new Error("DiscordAPIError[50035]: COMPONENT_INVALID_EMOJI");
			}
		}
	}
}

function fakeRoom() {
	const messages: FakeMessage[] = [];
	let counter = 0;
	const channel = Object.assign(Object.create(TextChannel.prototype) as TextChannel, {
		id: "ch-1",
		isTextBased: () => true,
		isDMBased: () => false,
		send: vi.fn(async (payload: FakeMessage["payload"]) => {
			refuseInvalidEmoji(payload.components);
			const message: FakeMessage = {
				id: `m${++counter}`,
				payload,
				deleted: false,
				isPrompt: typeof payload.content === "string" && payload.content.includes("it's your turn"),
				get embeds() {
					return message.payload.embeds ?? [];
				},
				attachments: new Map(),
				edit: vi.fn(async (edit: FakeMessage["payload"]) => {
					refuseInvalidEmoji(edit.components);
					message.payload = { ...message.payload, ...edit };
					return message;
				}),
				delete: vi.fn(async () => {
					message.deleted = true;
				}),
			};
			messages.push(message);
			return message;
		}),
		messages: {
			fetch: vi.fn(async (id: string) => {
				const message = messages.find((candidate) => candidate.id === id && !candidate.deleted);
				if (!message) throw new Error("Unknown Message");
				return message;
			}),
		},
	});
	const client = { channels: { fetch: vi.fn(async () => channel) } } as unknown as Client;
	return { channel, client, messages };
}

function seedHand(room: ReturnType<typeof fakeRoom>, firstBoardId: string): void {
	const table: HoldemTable = createTable();
	joinTable(table, A, "Player A");
	joinTable(table, B, "Player B");
	table.status = "playing";
	let state = 7;
	dealHand(table, () => {
		state = (state * 1664525 + 1013904223) % 4294967296;
		return state / 4294967296;
	});
	table.boardMessageId = firstBoardId;
	// The table message on the board already shows this hand, so the first redraw edits it.
	table.revealKey = holdemRevealKey(table);
	row.current = {
		roomId: "room-1",
		guildId: "guild-1",
		game: "holdem",
		status: "playing",
		hostId: A,
		playerIds: [A, B],
		channelId: "ch-1",
		network: false,
		satellites: [],
		kickedIds: [],
		moves: [],
		turnPrompt: { fingerprint: null, messageId: null, playerId: null, layout: null, played: false },
		secret: table,
	};
	void room;
}

const stored = (): IGameRoom => structuredClone(row.current) as unknown as IGameRoom;
const tableOf = (): HoldemTable => row.current?.secret as HoldemTable;

// A member's Take your turn modal Submit, answering with the first of these moves it offers.
function submitFor(userId: string, room: IGameRoom, fingerprint: string, prefer: readonly string[]): ModalSubmitInteraction {
	const options = holdemTurnAdapter.view(room, userId)?.fields[0];
	const values = options && options.kind === "select" ? options.options.map((option) => option.value) : [];
	const move = prefer.find((candidate) => values.includes(candidate)) ?? values[0];
	return {
		id: "i",
		customId: `gameroomModal:turn:room-1:${fingerprint}`,
		guildId: "guild-1",
		user: { id: userId },
		client: undefined as unknown as Client,
		fields: { getStringSelectValues: () => [move], getTextInputValue: () => "" },
		deferUpdate: vi.fn().mockResolvedValue(undefined),
		reply: vi.fn().mockResolvedValue(undefined),
		followUp: vi.fn().mockResolvedValue(undefined),
		deferred: false,
		replied: false,
	} as unknown as ModalSubmitInteraction;
}

const livePrompts = (room: ReturnType<typeof fakeRoom>) => room.messages.filter((message) => message.isPrompt);
const tableMessages = (room: ReturnType<typeof fakeRoom>) => room.messages.filter((message) => (message.payload.embeds?.length ?? 0) > 0);
// A table message's embed description as the room reads it, its This turn block included.
const descriptionOf = (message: FakeMessage): string => {
	const embed = message.payload.embeds?.[0] as { data?: { description?: string }; description?: string } | undefined;
	return embed?.data?.description ?? embed?.description ?? "";
};
const transcript = (): string[] => (row.current?.moves as { text: string }[]).map((move) => move.text);

beforeEach(() => {
	vi.clearAllMocks();
	_resetDrawingPauses();
	invalidEmoji.length = 0;
});

describe("a Hold'em hand played through the turn prompt", () => {
	it("prompts every decision, posts a fresh table at each street and the showdown, and never trips a 50035", async () => {
		const room = fakeRoom();
		const firstBoard = await room.channel.send({ embeds: [{ title: "table" }], components: [] });
		seedHand(room, firstBoard.id);
		const prompted: string[] = [];

		// The deal's redraw: the first player to act is pinged.
		await redrawTable(room.client, stored());

		for (let guard = 0; guard < 40 && handInProgress(tableOf()); guard++) {
			const acting = whoActs(tableOf())!;
			const live = livePrompts(room).filter((message) => !message.deleted && (message.payload.components?.length ?? 0) > 0);
			expect(live).toHaveLength(1);
			expect(live[0].payload.allowedMentions?.users).toEqual([acting]);
			prompted.push(acting);

			const snapshot = stored();
			const interaction = submitFor(acting, snapshot, holdemTurnAdapter.fingerprintOf(snapshot)!, ["check", "call"]);
			(interaction as unknown as { client: Client }).client = room.client;
			await handleTurnSubmit(interaction, () => holdemTurnAdapter);
			expect(interaction.deferUpdate).toHaveBeenCalledOnce();
		}

		expect(handInProgress(tableOf())).toBe(false);
		// Heads up, every street: two decisions each on four streets.
		expect(prompted).toHaveLength(8);
		expect(livePrompts(room)).toHaveLength(8);
		expect(invalidEmoji).toEqual([]);

		// The table: the flop, the turn, the river and the showdown each posted afresh (the deal's own
		// table was already on the board), and every street's table STAYS: five turns, five tables,
		// only the newest with buttons (2026-10 item 263 R3-29 and R3-4).
		const tables = tableMessages(room);
		expect(tables).toHaveLength(5);
		expect(tables.every((message) => !message.deleted)).toBe(true);
		expect(tables.at(-1)?.id).toBe(tableOf().boardMessageId);
		expect(tables.filter((message) => (message.payload.components?.length ?? 0) > 0).map((message) => message.id)).toEqual([tableOf().boardMessageId]);

		// Each street's table carries its own bets in its This turn block, the bet that closed it
		// included, and the showdown's carries the result.
		for (const street of tables.slice(0, 4)) {
			const block = descriptionOf(street);
			expect(block).toContain(`**${gameRoomsCopy.turnBoard.thisTurnLabel}**`);
			expect(block.split("\n").filter((line) => /^<@player-[ab]> (checks|calls)/.test(line))).toHaveLength(2);
		}
		expect(descriptionOf(tables[4])).toMatch(/ takes \d+\./);

		// Every move once in the transcript and on exactly one table: a bet two streets share word
		// for word is on as many tables as the transcript holds it, and no move posted a line.
		const lines = transcript();
		expect(lines.length).toBeGreaterThan(8);
		for (const line of new Set(lines)) {
			const onTables = tables.filter((message) => descriptionOf(message).split("\n").includes(line));
			expect(onTables.length, line).toBe(lines.filter((candidate) => candidate === line).length);
		}
		expect(room.messages.filter((message) => !message.isPrompt && (message.payload.embeds?.length ?? 0) === 0)).toEqual([]);

		// Every prompt line is spent: edited to say it was played through its modal, with no button.
		for (const prompt of livePrompts(room)) {
			expect(prompt.payload.components).toEqual([]);
			expect(prompt.payload.content).toMatch(/played their turn/);
		}
	});

	// A heads up table ends when one seat is out of chips, so both players going all in on the first
	// decision plays the shortest real path to a finished table: one hand, run out to a showdown,
	// the loser busted. The transcript outlives the room, so it must hold every bet and every result
	// line of that hand once, in the order they happened.
	it("a finished match's transcript holds every move of every turn exactly once", async () => {
		const room = fakeRoom();
		const firstBoard = await room.channel.send({ embeds: [{ title: "table" }], components: [] });
		seedHand(room, firstBoard.id);
		const { roomLifecycle } = await import("./roomLifecycle.js");
		await redrawTable(room.client, stored());

		// Each decision's own transcript rows, as they landed: the first must be the decision's own line.
		const decided: { actor: string; added: { actorId: string; kind: string; text: string }[] }[] = [];
		for (let guard = 0; guard < 10 && handInProgress(tableOf()); guard++) {
			const acting = whoActs(tableOf())!;
			const before = (row.current?.moves as unknown[]).length;
			const snapshot = stored();
			const interaction = submitFor(acting, snapshot, holdemTurnAdapter.fingerprintOf(snapshot)!, ["allin", "call"]);
			(interaction as unknown as { client: Client }).client = room.client;
			await handleTurnSubmit(interaction, () => holdemTurnAdapter);
			decided.push({ actor: acting, added: (row.current?.moves as { actorId: string; kind: string; text: string }[]).slice(before) });
		}

		// The table is over, through its real finish.
		expect(tableOf().status).toBe("finished");
		expect(roomLifecycle.finish).toHaveBeenCalledOnce();
		const winner = tableOf().winnerId as string;
		const loser = [A, B].find((id) => id !== winner) as string;

		// Two decisions, each recorded as its own player's line, once.
		expect(decided.map((entry) => entry.actor)).toHaveLength(2);
		for (const entry of decided) {
			expect(entry.added[0]?.actorId).toBe(entry.actor);
			expect(entry.added[0]?.kind).toBe("guess");
		}

		// The hand's end, in order: both hands shown, the pot taken, the loser out, each once.
		const holdem = gameRoomsCopy.holdem;
		const lines = transcript();
		const indexOfLine = (line: string): number => lines.indexOf(line);
		const shows = lines.filter((line) => /^<@player-[ab]> shows /.test(line));
		expect(shows.map((line) => line.slice(0, line.indexOf(">") + 1)).sort()).toEqual([`<@${A}>`, `<@${B}>`]);
		expect(lines.filter((line) => line.startsWith(`<@${winner}> takes `))).toHaveLength(1);
		expect(lines.filter((line) => line === holdem.busted(loser))).toHaveLength(1);
		const lastDecision = Math.max(...decided.map((entry) => indexOfLine(entry.added[0].text)));
		const firstShow = Math.min(...shows.map(indexOfLine));
		const taken = lines.findIndex((line) => line.startsWith(`<@${winner}> takes `));
		expect(lastDecision).toBeLessThan(firstShow);
		expect(Math.max(...shows.map(indexOfLine))).toBeLessThan(taken);
		expect(taken).toBeLessThan(indexOfLine(holdem.busted(loser)));

		// Nothing doubled, and every row is on exactly one of the hand's tables.
		expect(new Set(lines).size).toBe(lines.length);
		const tables = tableMessages(room);
		for (const line of lines) expect(tables.filter((message) => descriptionOf(message).split("\n").includes(line)), line).toHaveLength(1);
	});

	it("turns a stale Submit away: a modal opened for a turn that has passed plays nothing", async () => {
		const room = fakeRoom();
		const firstBoard = await room.channel.send({ embeds: [{ title: "table" }], components: [] });
		seedHand(room, firstBoard.id);
		await redrawTable(room.client, stored());

		// A opens the modal for the first turn and sits on it.
		const stale = whoActs(tableOf())!;
		const staleSnapshot = stored();
		const staleFingerprint = holdemTurnAdapter.fingerprintOf(staleSnapshot)!;

		// The hand moves on until the same member is on the clock again, in a later turn.
		for (let guard = 0; guard < 40; guard++) {
			const acting = whoActs(tableOf())!;
			const snapshot = stored();
			if (acting === stale && holdemTurnAdapter.fingerprintOf(snapshot) !== staleFingerprint) break;
			const move = submitFor(acting, snapshot, holdemTurnAdapter.fingerprintOf(snapshot)!, ["call", "check"]);
			(move as unknown as { client: Client }).client = room.client;
			await handleTurnSubmit(move, () => holdemTurnAdapter);
		}
		expect(whoActs(tableOf())).toBe(stale);
		const before = structuredClone(tableOf());

		// The old modal, submitted now: the same member is on the clock, but the turn is not that one.
		const replay = submitFor(stale, staleSnapshot, staleFingerprint, ["call"]);
		(replay as unknown as { client: Client }).client = room.client;
		await handleTurnSubmit(replay, () => holdemTurnAdapter);

		expect(tableOf()).toEqual(before);
		expect(JSON.stringify((replay.reply as unknown as ReturnType<typeof vi.fn>).mock.calls)).toContain(gameRoomsCopy.turnPrompt.turnPassed);
	});

	// Risk R17 of 2026-10 item 263 (R13 of item 257): a street's table stays in the room once the
	// next one posts, so a move read while the old table was the live one must not write its id
	// back. The read below differs from the row in the board id alone, so nothing else refuses it.
	it("refuses a move read against the table a new street replaced, and keeps the new table's id", async () => {
		const room = fakeRoom();
		const firstBoard = await room.channel.send({ embeds: [{ title: "table" }], components: [] });
		seedHand(room, firstBoard.id);
		await redrawTable(room.client, stored());
		for (let guard = 0; guard < 10 && tableOf().board.length === 0; guard++) {
			const acting = whoActs(tableOf())!;
			const snapshot = stored();
			const move = submitFor(acting, snapshot, holdemTurnAdapter.fingerprintOf(snapshot)!, ["check", "call"]);
			(move as unknown as { client: Client }).client = room.client;
			await handleTurnSubmit(move, () => holdemTurnAdapter);
		}
		const flopTable = tableOf().boardMessageId;
		expect(flopTable).not.toBe(firstBoard.id);
		const before = structuredClone(tableOf());

		const stale = stored();
		(stale.secret as unknown as HoldemTable).boardMessageId = firstBoard.id;
		const acting = whoActs(tableOf())!;
		const result = await holdemTurnAdapter.apply(room.client, stale, acting, { move: "check" }, async () => undefined);

		expect(result).toEqual({ ok: false, reason: gameRoomsCopy.holdem.tableBusy });
		expect(tableOf()).toEqual(before);
		expect(tableOf().boardMessageId).toBe(flopTable);
	});

	it("gives a Dero bot seat on the clock no prompt", async () => {
		const room = fakeRoom();
		const firstBoard = await room.channel.send({ embeds: [{ title: "table" }], components: [] });
		seedHand(room, firstBoard.id);
		const table = tableOf();
		table.seats[table.betting?.toAct ?? 0].userId = "dero-bot-red";
		table.betting!.seats[table.betting!.toAct].userId = "dero-bot-red";

		await redrawTable(room.client, stored());

		expect(livePrompts(room)).toHaveLength(0);
	});
});
