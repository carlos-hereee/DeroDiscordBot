import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChannelType, type ButtonInteraction, type StringSelectMenuInteraction } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: {
		findByRoomId: vi.fn(),
		update: vi.fn(),
		// Start's player and pool lists, written as given: the filter against the stored pool is the
		// store's own (gameRoomStore.seatDraft), and stores are not unit tested (house rule 6).
		seatDraft: vi.fn(async (_guildId: string, _roomId: string, _hostId: string, playerIds: string[], spectatorIds: string[]) => ({ playerIds, spectatorIds })),
	},
}));
vi.mock("@features/age-gate/ageGateRules.js", () => ({ hasConfirmedAge: vi.fn(async () => true), replyWithAgeGate: vi.fn() }));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn() } }));
vi.mock("./RoomProvisioner.js", () => ({ RoomProvisioner: { open: vi.fn() }, describeRoomOpenFailure: () => "nope" }));
vi.mock("./soloRooms.js", () => ({ readPrivateQuotaStatus: vi.fn().mockResolvedValue(null), describeSoloOpenFailure: () => "nope" }));
vi.mock("./challengeCard.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("./challengeCard.js")>()), refreshCard: vi.fn() }));
vi.mock("@features/setup/adminLog.js", () => ({ adminLog: { emitFor: vi.fn() } }));

import { handleBotSelect, openBotPicker, confirmStartMatch } from "./challengeBoard.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { RoomProvisioner } from "./RoomProvisioner.js";
import { adminLog } from "@features/setup/adminLog.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { GAME_ROOM_SELECT_PREFIX } from "./gameRoomActions.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { _runStartCountdownsOut } from "./startCountdown.js";
import { startCountdownState } from "./startCountdownState.js";

// ── Play vs bots on the challenge card (2026-10 item 250 Phase 5) ───────────
// The host's private picker is the one door a bot comes through: it refuses a game no
// bot plays, a network table and a server with bots off; the select is re-gated and
// logs a bot.slot line; Start opens against bots alone, and a battleship bot is the
// opponent while the row keeps the host alone in playerIds.

type Mock = ReturnType<typeof vi.fn>;
const HOST = "host-1";
const storeMock = gameRoomStore as unknown as Record<"findByRoomId" | "update", Mock>;
const configMock = guildConfigStore.findByGuildId as unknown as Mock;
const openMock = RoomProvisioner.open as unknown as Mock;
const logMock = adminLog.emitFor as unknown as Mock;

const makeRoom = (game: string, overrides: Partial<IGameRoom> = {}): IGameRoom =>
	({ roomId: "room-1", guildId: "guild-1", game, hostId: HOST, status: "draft", visibility: "invite", spectatorIds: [], botsOffered: true, botSeats: 0, casual: true, ...overrides }) as unknown as IGameRoom;

const category = { id: "cat", type: ChannelType.GuildCategory };
const guild = {
	id: "guild-1",
	channels: { fetch: vi.fn().mockResolvedValue(category) },
	members: { cache: new Map(), fetch: vi.fn().mockResolvedValue(null) },
};

function button(): ButtonInteraction {
	return {
		guildId: "guild-1",
		guild,
		user: { id: HOST },
		client: {},
		reply: vi.fn().mockResolvedValue(undefined),
		deferReply: vi.fn().mockResolvedValue(undefined),
		editReply: vi.fn().mockResolvedValue(undefined),
	} as unknown as ButtonInteraction;
}

function select(userId: string, value: string): StringSelectMenuInteraction {
	return {
		customId: `${GAME_ROOM_SELECT_PREFIX}:bots:room-1`,
		guildId: "guild-1",
		guild,
		user: { id: userId },
		client: {},
		values: [value],
		isModalSubmit: () => false,
		reply: vi.fn().mockResolvedValue(undefined),
		update: vi.fn().mockResolvedValue(undefined),
	} as unknown as StringSelectMenuInteraction;
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
});

describe("the bot picker", () => {
	it("offers none to five bots at Hold'em, with the current count chosen", async () => {
		const interaction = button();
		await openBotPicker(interaction, makeRoom("holdem", { botSeats: 2 }));
		const payload = (interaction.reply as Mock).mock.calls[0][0] as { components: Array<{ toJSON(): { components: Array<{ options: Array<{ value: string; default?: boolean }> }> } }> };
		const options = payload.components[0].toJSON().components[0].options;
		expect(options.map((option) => option.value)).toEqual(["0", "1", "2", "3", "4", "5"]);
		expect(options.find((option) => option.default)?.value).toBe("2");
	});

	it("refuses a game no bot plays, a network table, and a server with bots off", async () => {
		const luck = button();
		await openBotPicker(luck, makeRoom("coinflip"));
		expect(replyText(luck)).toBe(gameRoomsCopy.board.botsNotHere);

		const network = button();
		await openBotPicker(network, makeRoom("holdem", { network: true }));
		expect(replyText(network)).toBe(gameRoomsCopy.board.botsNotHere);

		configMock.mockResolvedValue({ guildId: "guild-1", botOpponentsEnabled: false });
		const off = button();
		await openBotPicker(off, makeRoom("holdem"));
		expect(replyText(off)).toBe(gameRoomsCopy.board.botsOff);
	});
});

describe("the bot count select", () => {
	it("saves the host's count and logs one bot.slot line", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom("monopoly"));
		storeMock.update.mockResolvedValue(makeRoom("monopoly", { botSeats: 3 }));
		const interaction = select(HOST, "3");

		await handleBotSelect(interaction);

		expect(storeMock.update).toHaveBeenCalledWith("guild-1", "room-1", { botSeats: 3 });
		expect(logMock).toHaveBeenCalledWith(interaction, "guild-1", "bot.slot", expect.objectContaining({ game: "monopoly", matchId: "room-1", botCount: 3, actor: HOST }));
		// The count saved is an answer, so the select message becomes it rather than a notice (2026-10 item 263 R3-11).
		expect(interaction.update).toHaveBeenCalledWith(expect.objectContaining({ content: gameRoomsCopy.board.botsSaved(3), components: [] }));
		expect(interaction.reply).not.toHaveBeenCalled();
	});

	it("refuses anybody but the host, and a count the game does not take", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom("battleship"));
		const stranger = select("someone", "1");
		await handleBotSelect(stranger);
		expect(replyText(stranger)).toBe(gameRoomsCopy.board.onlyHostStarts);

		const tooMany = select(HOST, "2");
		await handleBotSelect(tooMany);
		expect(replyText(tooMany)).toBe(gameRoomsCopy.errors.controlRetired);
		expect(storeMock.update).not.toHaveBeenCalled();
	});
});

describe("starting against bots", () => {
	it("opens a Hold'em table with nobody else joined when bots are chosen, seating the bots", async () => {
		await startCounted(button(), makeRoom("holdem", { botSeats: 2 }));
		expect(openMock).toHaveBeenCalledWith(expect.objectContaining({ playerIds: [HOST], botIds: ["dero-bot-red", "dero-bot-orange"] }));
	});

	it("still refuses an empty pool with no bots", async () => {
		const interaction = button();
		await confirmStartMatch(interaction, makeRoom("holdem"));
		expect(replyText(interaction)).toBe(gameRoomsCopy.board.poolEmpty);
		expect(openMock).not.toHaveBeenCalled();
	});

	it("makes the bot a battleship host's opponent, keeping the pool as spectators", async () => {
		await startCounted(button(), makeRoom("battleship", { botSeats: 1, spectatorIds: ["friend"] }));
		expect(openMock).toHaveBeenCalledWith(expect.objectContaining({ playerIds: [HOST], spectatorIds: ["friend"], botIds: ["dero-bot-red"] }));
	});

	it("counts bots against Monopoly's six seats", async () => {
		const interaction = button();
		await confirmStartMatch(interaction, makeRoom("monopoly", { botSeats: 5, spectatorIds: ["a"] }));
		expect(replyText(interaction)).toBe(gameRoomsCopy.monopoly.tooManyWithBots(6, 1, 5));
	});
});
