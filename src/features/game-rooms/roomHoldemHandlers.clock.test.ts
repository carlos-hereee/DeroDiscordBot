import { describe, it, expect, vi, beforeEach } from "vitest";
import { TextChannel, type ButtonInteraction, type Client } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: { update: vi.fn(), findPlayingByGame: vi.fn(), updateSecretIf: vi.fn(), findByRoomId: vi.fn(), moveBoardMessage: vi.fn() },
}));
vi.mock("./roomTrail.js", () => ({ roomTrail: { postMove: vi.fn() } }));
vi.mock("./roomLifecycle.js", () => ({ roomLifecycle: { finish: vi.fn() } }));
vi.mock("@features/leveling/awardXp.js", () => ({ awardXp: vi.fn() }));
// The live card's PNG is pinned in arcadeCards.test.ts; here it answers a fixed
// attachment, or null where `fail` stands in for a host where it does not draw.
const live = vi.hoisted(() => ({ fail: false }));
vi.mock("@features/dero-brain/dealerShowdownRenderer.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("@features/dero-brain/dealerShowdownRenderer.js")>();
	const { AttachmentBuilder: Attachment } = await import("discord.js");
	return {
		...real,
		renderHoldemLiveCard: vi.fn(async () =>
			live.fail ? null : { attachment: new Attachment(Buffer.from("png"), { name: "holdem-table-abc.png" }), ref: "attachment://holdem-table-abc.png" }
		),
	};
});

import { handleImBack, handleMove, holdemRevealKey, sweepHoldemClocks } from "./roomHoldemHandlers.js";
import { bettingRows, betweenHandsRows } from "./roomHoldem.js";
import { GAME_ROOM_ACTIONS } from "./gameRoomActions.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { roomTrail } from "./roomTrail.js";
import { _resetDrawingPauses, roomDrawingKey, withDrawingPause } from "./drawingPause.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { act, createTable, dealHand, joinTable, whoActs, type HoldemTable } from "@features/games/holdemTable.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── the hold em clock (Dero 1.7.0 test fixes, Phase 3a, item 13) ───────────
// What:  60 seconds a decision counted from when the board shows the prompt, a
//        countdown on the board, the next hand dealing itself 10 seconds after the
//        last, two timeouts in a row sitting a seat out until I'm back, and the
//        live table card on every redraw behind the drawing pause.
// Who:   the room handlers over a mocked store, trail and lifecycle, with the real
//        engine and the real drawing pause.

const storeMock = gameRoomStore as unknown as Record<"update" | "findPlayingByGame" | "updateSecretIf" | "findByRoomId" | "moveBoardMessage", ReturnType<typeof vi.fn>>;
const trailMock = roomTrail as unknown as { postMove: ReturnType<typeof vi.fn> };
const NOW = Date.UTC(2026, 9, 23, 18, 0, 0);

function seededRng(seed = 11): () => number {
	let state = seed;
	return () => {
		state = (state * 1664525 + 1013904223) % 4294967296;
		return state / 4294967296;
	};
}

function dealtTable(seats = 3): HoldemTable {
	const table = createTable();
	for (let index = 0; index < seats; index++) joinTable(table, `p${index}`, `Player ${index}`);
	table.status = "playing";
	dealHand(table, seededRng());
	table.boardMessageId = "board-1";
	// Already on the board as this hand: a redraw edits it in place. A reveal reposts, tested below.
	table.revealKey = holdemRevealKey(table);
	return table;
}

// A table whose last hand has settled: everyone folds to one seat.
function betweenHands(seats = 2): HoldemTable {
	const table = dealtTable(seats);
	for (let guard = 0; guard < 10 && table.street !== "showdown"; guard++) act(table, whoActs(table)!, "fold");
	table.revealKey = holdemRevealKey(table);
	return table;
}

function makeRoom(table: HoldemTable): IGameRoom {
	return {
		roomId: "room-1",
		guildId: "guild-1",
		hostId: "p0",
		game: "holdem",
		status: "playing",
		playerIds: table.seats.map((seat) => seat.userId),
		channelId: "ch-1",
		secret: table,
	} as unknown as IGameRoom;
}

function boardClient() {
	const board = { edit: vi.fn().mockResolvedValue(undefined), delete: vi.fn().mockResolvedValue(undefined) };
	const fresh = { id: "board-2", delete: vi.fn().mockResolvedValue(undefined) };
	const send = vi.fn().mockResolvedValue(fresh);
	const channel = Object.assign(Object.create(TextChannel.prototype) as TextChannel, { send, messages: { fetch: vi.fn().mockResolvedValue(board) } });
	const client = { channels: { fetch: vi.fn().mockResolvedValue(channel) } } as unknown as Client;
	return { client, board, send };
}

const quietClient = { channels: { fetch: vi.fn().mockResolvedValue(null) } } as unknown as Client;

function makeInteraction(userId: string, client: Client = quietClient) {
	return {
		guildId: "guild-1",
		user: { id: userId, username: userId, globalName: userId },
		client,
		reply: vi.fn().mockResolvedValue(undefined),
		deferUpdate: vi.fn().mockResolvedValue(undefined),
	} as unknown as ButtonInteraction & Record<"reply" | "deferUpdate", ReturnType<typeof vi.fn>>;
}

const trailTexts = (): string[] => trailMock.postMove.mock.calls.map((call) => (call[2] as { text: string }).text);
const sweepAt = (offsetMs: number) => sweepHoldemClocks(quietClient, new Date(NOW + offsetMs));
const relative = (epochMs: number): string => `<t:${Math.floor(epochMs / 1000)}:R>`;

beforeEach(() => {
	vi.clearAllMocks();
	_resetDrawingPauses();
	live.fail = false;
	storeMock.updateSecretIf.mockResolvedValue({} as never);
	storeMock.moveBoardMessage.mockResolvedValue({} as never);
});

describe("the turn clock", () => {
	it("gives a player 60 seconds, counted from when the board showed them their turn", async () => {
		expect(BOT_CONSTANTS.HOLDEM_TURN_TIMEOUT_MS).toBe(60_000);
		const table = dealtTable();
		// Dealt five minutes ago, but the board only showed the prompt 59 seconds ago.
		table.lastActionAt = NOW - 5 * 60_000;
		table.turnPrompt = { stamp: table.lastActionAt, shownAt: NOW - 59_000 };
		storeMock.findPlayingByGame.mockResolvedValue([makeRoom(table)]);

		expect(await sweepAt(0)).toEqual({ forced: 0, dealt: 0 });
		expect(await sweepAt(1_000)).toEqual({ forced: 1, dealt: 0 });
	});

	it("ignores a prompt the board showed for an earlier state", async () => {
		const table = dealtTable();
		table.lastActionAt = NOW - 61_000;
		table.turnPrompt = { stamp: table.lastActionAt - 1, shownAt: NOW - 1_000 };
		storeMock.findPlayingByGame.mockResolvedValue([makeRoom(table)]);

		expect(await sweepAt(0)).toEqual({ forced: 1, dealt: 0 });
	});

	it("holds while the board draws, so a render never costs the player their turn", async () => {
		const table = dealtTable();
		table.lastActionAt = NOW - 61_000;
		const room = makeRoom(table);
		storeMock.findPlayingByGame.mockResolvedValue([room]);
		let finish: (value: null) => void = () => undefined;
		const pending = new Promise<null>((resolve) => {
			finish = resolve;
		});
		const drawing = withDrawingPause({
			gameKey: roomDrawingKey(room),
			showStatus: async () => undefined,
			render: () => pending,
			fallback: () => null,
			swapIn: async () => undefined,
		});

		expect(await sweepAt(0)).toEqual({ forced: 0, dealt: 0 });
		finish(null);
		await drawing;
	});

	it("sits a seat out on its second timeout in a row, and says so in the room", async () => {
		const table = dealtTable();
		const stalling = whoActs(table)!;
		table.seats.find((seat) => seat.userId === stalling)!.timeoutsInRow = 1;
		table.lastActionAt = NOW - 61_000;
		storeMock.findPlayingByGame.mockResolvedValue([makeRoom(table)]);

		await sweepAt(0);

		expect(table.seats.find((seat) => seat.userId === stalling)!.sittingOut).toBe(true);
		expect(trailTexts()).toContain(gameRoomsCopy.holdem.satOut(stalling));
	});
});

describe("the board", () => {
	it("redraws with the drawing status, then the live card and the countdown for the next player", async () => {
		const table = dealtTable();
		const { client, board } = boardClient();

		await handleMove(makeInteraction(whoActs(table)!, client), makeRoom(table), "fold");

		expect(board.edit.mock.calls[0][0]).toEqual({ content: gameRoomsCopy.drawing.status });
		const swapped = board.edit.mock.calls.at(-1)![0] as {
			content: null;
			embeds: { data: { description?: string; image?: { url: string } } }[];
			files: unknown[];
			attachments: unknown[];
		};
		expect(swapped.content).toBeNull();
		expect(swapped.attachments).toEqual([]);
		expect(swapped.files).toHaveLength(1);
		expect(swapped.embeds[0].data.image?.url).toBe("attachment://holdem-table-abc.png");

		const prompt = table.turnPrompt!;
		expect(prompt.stamp).toBe(table.lastActionAt);
		expect(swapped.embeds[0].data.description).toContain(
			gameRoomsCopy.holdem.turnClockLine(whoActs(table)!, prompt.shownAt + BOT_CONSTANTS.HOLDEM_TURN_TIMEOUT_MS)
		);
		expect(swapped.embeds[0].data.description).toContain(relative(prompt.shownAt + 60_000));
		// The prompt is kept on the row only while the table is still in the state shown.
		expect(storeMock.updateSecretIf.mock.calls.at(-1)![2]).toEqual({ "secret.lastActionAt": table.lastActionAt, "secret.status": "playing", "secret.boardMessageId": "board-1" });
	});

	it("posts the text table, with no stale card, when the live card does not draw", async () => {
		live.fail = true;
		const table = dealtTable();
		const { client, board } = boardClient();

		await handleMove(makeInteraction(whoActs(table)!, client), makeRoom(table), "fold");

		const swapped = board.edit.mock.calls.at(-1)![0] as { files: unknown[]; attachments: unknown[]; embeds: { data: { image?: unknown } }[] };
		expect(swapped.files).toEqual([]);
		expect(swapped.attachments).toEqual([]);
		expect(swapped.embeds[0].data.image).toBeUndefined();
	});
});

describe("the next hand", () => {
	it("deals itself 10 seconds after the last hand, as the host", async () => {
		expect(BOT_CONSTANTS.HOLDEM_NEXT_HAND_DELAY_MS).toBe(10_000);
		const table = betweenHands();
		table.lastActionAt = NOW - 9_999;
		const readStamp = table.lastActionAt;
		storeMock.findPlayingByGame.mockResolvedValue([makeRoom(table)]);

		expect(await sweepAt(0)).toEqual({ forced: 0, dealt: 0 });
		expect(table.handNumber).toBe(1);

		expect(await sweepAt(1)).toEqual({ forced: 0, dealt: 1 });
		expect(table.handNumber).toBe(2);
		// Claimed on the hand number and the action stamp, so a leave or an I'm back
		// between the sweep's read and its deal makes the deal lose.
		expect(storeMock.updateSecretIf.mock.calls[0][2]).toEqual({ "secret.handNumber": 1, "secret.lastActionAt": readStamp, "secret.boardMessageId": "board-1" });
		const dealt = trailMock.postMove.mock.calls.find((call) => (call[2] as { text: string }).text.includes("is dealt"));
		expect(dealt?.[2]).toMatchObject({ actorId: "p0", kind: "system" });
	});

	it("deals nothing when the host's own deal won the claim", async () => {
		const table = betweenHands();
		table.lastActionAt = NOW - 60_000;
		storeMock.findPlayingByGame.mockResolvedValue([makeRoom(table)]);
		storeMock.updateSecretIf.mockResolvedValue(null);

		expect(await sweepAt(0)).toEqual({ forced: 0, dealt: 0 });
		expect(trailMock.postMove).not.toHaveBeenCalled();
	});

	it("waits for two players at the table rather than deal to seats that sit out", async () => {
		const table = betweenHands(3);
		table.seats[1].sittingOut = true;
		table.seats[2].sittingOut = true;
		table.lastActionAt = NOW - 60_000;
		storeMock.findPlayingByGame.mockResolvedValue([makeRoom(table)]);

		expect(await sweepAt(0)).toEqual({ forced: 0, dealt: 0 });
	});

	it("tells the table when it deals itself, on the board between hands", async () => {
		const table = dealtTable(2);
		const { client, send } = boardClient();

		await handleMove(makeInteraction(whoActs(table)!, client), makeRoom(table), "fold");

		// A hand that ends reveals its result, so the table posts afresh (item 257 Phase 4a).
		const swapped = send.mock.calls.at(-1)![0] as { embeds: { data: { description?: string } }[] };
		expect(swapped.embeds[0].data.description).toContain(
			gameRoomsCopy.holdem.nextHandLine(table.turnPrompt!.shownAt + BOT_CONSTANTS.HOLDEM_NEXT_HAND_DELAY_MS)
		);
	});
});

describe("I'm back", () => {
	const customIdsOf = (rows: { toJSON(): { components: { custom_id?: string }[] } }[]) =>
		rows.flatMap((row) => row.toJSON().components.map((component) => component.custom_id));

	it("is a player's control, and shows on the board only while a seat sits out", () => {
		expect(GAME_ROOM_ACTIONS.hback).toEqual({ hostOnly: false, playersOnly: true });
		const table = dealtTable();
		expect(customIdsOf(bettingRows(table, "room-1", 30))).not.toContain("gameroom:hback:room-1");
		table.seats[2].sittingOut = true;
		expect(customIdsOf(bettingRows(table, "room-1", 30))).toContain("gameroom:hback:room-1");
		expect(customIdsOf(betweenHandsRows("room-1", table))).toContain("gameroom:hback:room-1");
	});

	it("brings a seat that sits out back, on a compare and swap of the stamp it read", async () => {
		const table = dealtTable();
		const away = table.seats.find((seat) => seat.userId !== whoActs(table))!;
		away.sittingOut = true;
		const readAt = table.lastActionAt;
		const interaction = makeInteraction(away.userId);

		await handleImBack(interaction, makeRoom(table));

		expect(storeMock.updateSecretIf.mock.calls[0][2]).toEqual({ "secret.lastActionAt": readAt, "secret.boardMessageId": "board-1" });
		expect((storeMock.updateSecretIf.mock.calls[0][3] as HoldemTable).seats.find((seat) => seat.userId === away.userId)!.sittingOut).toBe(false);
		expect(interaction.deferUpdate).toHaveBeenCalledOnce();
		expect(trailTexts()).toEqual([gameRoomsCopy.holdem.backAtTable(away.userId)]);
	});

	it("refuses a seat that is playing, and writes nothing", async () => {
		const interaction = makeInteraction("p0");

		await handleImBack(interaction, makeRoom(dealtTable()));

		expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: gameRoomsCopy.holdem.notSittingOut }));
		expect(storeMock.updateSecretIf).not.toHaveBeenCalled();
	});
});
