import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChannelType, type ButtonInteraction, type Client } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: {
		findByRoomId: vi.fn(),
		update: vi.fn(),
		// Start's player and pool lists, written as given: the filter against the stored pool is the
		// store's own (gameRoomStore.seatDraft), and stores are not unit tested (house rule 6).
		seatDraft: vi.fn(async (_guildId: string, _roomId: string, _hostId: string, playerIds: string[], spectatorIds: string[]) => ({ playerIds, spectatorIds })),
		addPoolMember: vi.fn(),
		lowerBotSeats: vi.fn(),
	},
}));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn() } }));
vi.mock("./RoomProvisioner.js", () => ({ RoomProvisioner: { open: vi.fn() }, describeRoomOpenFailure: () => "nope" }));
vi.mock("./soloRooms.js", () => ({ readPrivateQuotaStatus: vi.fn().mockResolvedValue(null), describeSoloOpenFailure: () => "nope" }));
vi.mock("./challengeCard.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("./challengeCard.js")>()), refreshCard: vi.fn() }));
vi.mock("@features/setup/adminLog.js", () => ({ adminLog: { emit: vi.fn(), emitFor: vi.fn() } }));

import { chooseCasual, joinChallenge, confirmStartMatch, yieldBotSeatsTo } from "./challengeBoard.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { RoomProvisioner } from "./RoomProvisioner.js";
import { adminLog } from "@features/setup/adminLog.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { HOST_STRICT_ACTIONS } from "./gameRoomActions.js";
import { casualBotSeats } from "./botSeat.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { _runStartCountdownsOut } from "./startCountdown.js";
import { startCountdownState } from "./startCountdownState.js";

// ── Rated or Casual (2026-10 item 254, Arcade 6) ────────────────────────────
// Casual fills the empty seats with Dero bots through the write Play vs bots makes (one
// bot.slot line), up to a 4 seat table at Hold'em and Monopoly and one bot at battleship.
// A person who joins before the start takes one bot's seat; once the match started no
// seat swaps; Rated takes every bot away. A bot never reaches playerIds.

type Mock = ReturnType<typeof vi.fn>;
const HOST = "host-1";
const JOINER = "joiner-1";
const storeMock = gameRoomStore as unknown as Record<"findByRoomId" | "update" | "addPoolMember" | "lowerBotSeats", Mock>;
const configMock = guildConfigStore.findByGuildId as unknown as Mock;
const openMock = RoomProvisioner.open as unknown as Mock;
const logForMock = adminLog.emitFor as unknown as Mock;
const logMock = adminLog.emit as unknown as Mock;

const makeRoom = (game: string, overrides: Partial<IGameRoom> = {}): IGameRoom =>
	({
		roomId: "room-1",
		guildId: "guild-1",
		game,
		hostId: HOST,
		status: "draft",
		visibility: "public",
		playerIds: [HOST],
		spectatorIds: [],
		pendingJoinIds: [],
		kickedIds: [],
		ratingBand: "any",
		requireApproval: false,
		botsOffered: true,
		botSeats: 0,
		casual: false,
		...overrides,
	}) as unknown as IGameRoom;

const category = { id: "cat", type: ChannelType.GuildCategory };
const guild = {
	id: "guild-1",
	channels: { fetch: vi.fn().mockResolvedValue(category) },
	members: { cache: new Map(), fetch: vi.fn().mockResolvedValue(null) },
};
const client = {} as Client;

function button(userId = HOST): ButtonInteraction {
	return {
		guildId: "guild-1",
		guild,
		user: { id: userId },
		client,
		reply: vi.fn().mockResolvedValue(undefined),
		deferReply: vi.fn().mockResolvedValue(undefined),
		deferUpdate: vi.fn().mockResolvedValue(undefined),
		editReply: vi.fn().mockResolvedValue(undefined),
	} as unknown as ButtonInteraction;
}

// Start counts the match in (2026-10 item 267, decision 13) and opens on the draft the count reads
// again, so a case about what Start opens starts the match and runs the count out at once.
async function startCounted(interaction: Parameters<typeof confirmStartMatch>[0], draft: IGameRoom): Promise<void> {
	await confirmStartMatch(interaction, draft);
	storeMock.findByRoomId.mockResolvedValue(draft);
	await _runStartCountdownsOut();
}

const replyText = (interaction: { reply: unknown }): string => (((interaction.reply as Mock).mock.calls[0]?.[0] ?? {}) as { content?: string }).content ?? "";

beforeEach(() => {
	vi.clearAllMocks();
	startCountdownState._reset();
	configMock.mockResolvedValue({ guildId: "guild-1", gamesCategoryId: "cat" });
	openMock.mockResolvedValue({ ok: false, reason: "createFailed" });
	// The update answers the row with the patch applied, as Mongo's findOneAndUpdate does.
	storeMock.update.mockImplementation(async (_guildId: string, _roomId: string, patch: Partial<IGameRoom>) => ({ ...current, ...patch }));
});
let current: IGameRoom = makeRoom("holdem");

describe("choosing Casual", () => {
	it("fills a Hold'em table to four, the host and three Dero bots, logged as one bot.slot line", async () => {
		current = makeRoom("holdem");
		const interaction = button();

		await chooseCasual(interaction, current, "on");

		expect(storeMock.update).toHaveBeenCalledWith("guild-1", "room-1", { casual: true, botSeats: 3 });
		expect(logForMock).toHaveBeenCalledOnce();
		expect(logForMock).toHaveBeenCalledWith(interaction, "guild-1", "bot.slot", expect.objectContaining({ botCount: 3, actor: HOST, detail: gameRoomsCopy.board.casual.logFilled(3) }));
		expect(interaction.deferUpdate).toHaveBeenCalled();
	});

	it("fills Monopoly to four as well, and battleship with its one bot", () => {
		expect(casualBotSeats("monopoly", 0)).toBe(3);
		expect(casualBotSeats("holdem", 0)).toBe(3);
		expect(casualBotSeats("battleship", 0)).toBe(1);
	});

	it("fills only the seats nobody holds: two joined Hold'em players leave one bot", async () => {
		current = makeRoom("holdem", { spectatorIds: ["p1", "p2"] });

		await chooseCasual(button(), current, "on");

		expect(storeMock.update).toHaveBeenCalledWith("guild-1", "room-1", { casual: true, botSeats: 1 });
	});

	it("starts the filled table with the bots in the match and only the host in playerIds", async () => {
		current = makeRoom("holdem", { casual: true, botSeats: 3 });

		await startCounted(button(), current);

		expect(openMock).toHaveBeenCalledWith(expect.objectContaining({ playerIds: [HOST], botIds: ["dero-bot-red", "dero-bot-orange", "dero-bot-gold"] }));
	});

	it("takes every bot away when the host switches back to Rated", async () => {
		current = makeRoom("monopoly", { casual: true, botSeats: 3 });
		const interaction = button();

		await chooseCasual(interaction, current, "off");

		expect(storeMock.update).toHaveBeenCalledWith("guild-1", "room-1", { casual: false, botSeats: 0 });
		expect(logForMock).toHaveBeenCalledWith(interaction, "guild-1", "bot.slot", expect.objectContaining({ botCount: 0, detail: gameRoomsCopy.board.casual.logCleared }));
	});

	it("refuses where bots cannot sit: a game no bot plays, a network table, a server with bots off", async () => {
		const luck = button();
		await chooseCasual(luck, makeRoom("coinflip"), "on");
		expect(replyText(luck)).toBe(gameRoomsCopy.board.botsNotHere);

		const network = button();
		await chooseCasual(network, makeRoom("holdem", { network: true }), "on");
		expect(replyText(network)).toBe(gameRoomsCopy.board.botsNotHere);

		configMock.mockResolvedValue({ guildId: "guild-1", botOpponentsEnabled: false });
		const off = button();
		await chooseCasual(off, makeRoom("holdem"), "on");
		expect(replyText(off)).toBe(gameRoomsCopy.board.botsOff);

		expect(storeMock.update).not.toHaveBeenCalled();
	});

	it("refuses a forged choice", async () => {
		const interaction = button();
		await chooseCasual(interaction, makeRoom("holdem"), "maybe");
		expect(replyText(interaction)).toBe(gameRoomsCopy.errors.controlRetired);
		expect(storeMock.update).not.toHaveBeenCalled();
	});

	it("is the host's alone, like Play vs bots: no admin override", () => {
		expect(HOST_STRICT_ACTIONS.has("casual")).toBe(true);
		expect(HOST_STRICT_ACTIONS.has("bots")).toBe(true);
	});
});

describe("a person joining a Casual table", () => {
	it("takes one Dero bot's seat before the start, with Dero logged as the actor", async () => {
		current = makeRoom("holdem", { casual: true, botSeats: 3 });
		storeMock.addPoolMember.mockResolvedValue(makeRoom("holdem", { casual: true, botSeats: 3, spectatorIds: [JOINER] }));
		storeMock.lowerBotSeats.mockResolvedValue(makeRoom("holdem", { casual: true, botSeats: 2, spectatorIds: [JOINER] }));

		await joinChallenge(button(JOINER), current);

		expect(storeMock.lowerBotSeats).toHaveBeenCalledWith("guild-1", "room-1", 2);
		expect(logMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "bot.slot", actor: { source: "dero" }, payload: expect.objectContaining({ botCount: 2 }) }));
	});

	it("then sits as a player beside the bots that are left, never a bot in playerIds", async () => {
		current = makeRoom("holdem", { casual: true, botSeats: 2, spectatorIds: [JOINER] });

		await startCounted(button(), current);

		expect(openMock).toHaveBeenCalledWith(expect.objectContaining({ playerIds: [HOST, JOINER], botIds: ["dero-bot-red", "dero-bot-orange"] }));
	});

	it("costs no bot for a press that added nobody, so a double click takes one seat", async () => {
		const before = makeRoom("holdem", { casual: true, botSeats: 2, spectatorIds: [JOINER] });

		const after = await yieldBotSeatsTo(client, before, before);

		expect(after).toBe(before);
		expect(storeMock.lowerBotSeats).not.toHaveBeenCalled();
	});

	it("never swaps a seat once the match started", async () => {
		const before = makeRoom("holdem", { casual: true, botSeats: 2, status: "playing" });
		const after = makeRoom("holdem", { casual: true, botSeats: 2, status: "playing", spectatorIds: [JOINER] });

		await yieldBotSeatsTo(client, before, after);

		expect(storeMock.lowerBotSeats).not.toHaveBeenCalled();
	});

	it("joins a Rated table as today, beside any bots the host chose by hand", async () => {
		current = makeRoom("holdem", { botSeats: 2 });
		storeMock.addPoolMember.mockResolvedValue(makeRoom("holdem", { botSeats: 2, spectatorIds: [JOINER] }));

		await joinChallenge(button(JOINER), current);

		expect(storeMock.addPoolMember).toHaveBeenCalledWith("guild-1", "room-1", JOINER);
		expect(storeMock.lowerBotSeats).not.toHaveBeenCalled();
		expect(logMock).not.toHaveBeenCalled();
	});

	it("gives a battleship bot's seat to the first person, who then plays the host", async () => {
		current = makeRoom("battleship", { casual: true, botSeats: 1 });
		storeMock.addPoolMember.mockResolvedValue(makeRoom("battleship", { casual: true, botSeats: 1, spectatorIds: [JOINER] }));
		storeMock.lowerBotSeats.mockResolvedValue(makeRoom("battleship", { casual: true, botSeats: 0, spectatorIds: [JOINER] }));

		await joinChallenge(button(JOINER), current);
		expect(storeMock.lowerBotSeats).toHaveBeenCalledWith("guild-1", "room-1", 0);

		await startCounted(button(), makeRoom("battleship", { casual: true, botSeats: 0, spectatorIds: [JOINER] }));
		expect(openMock).toHaveBeenCalledWith(expect.objectContaining({ playerIds: [HOST, JOINER], botIds: [] }));
	});
});
