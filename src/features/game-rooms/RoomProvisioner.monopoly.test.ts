import { describe, it, expect, vi, beforeEach } from "vitest";
import { AttachmentBuilder, type CategoryChannel, type Guild } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: {
		findOpenByHost: vi.fn(),
		countOpenInGuild: vi.fn(),
		countOpenInGuildByVisibility: vi.fn(),
		create: vi.fn(),
		setStatus: vi.fn(),
		update: vi.fn(),
		findByRoomId: vi.fn(),
	},
}));
vi.mock("@db/stores/botLogStore.js", () => ({ botLogStore: { log: vi.fn() } }));
vi.mock("@features/entitlements/gameRoomAccess.js", () => ({ checkGameRoomAccess: vi.fn() }));
// The challenge reach read a public open makes (2026-10 item 244 Phase 4); no config reads as "server".
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn().mockResolvedValue(null) } }));
// The board picture. Mocked so the first board is the text map unless a case hands
// the renderer a picture, whatever art is on disk where the suite runs.
vi.mock("@features/games/monopolyRenderer.js", () => ({ renderBoard: vi.fn() }));

import { RoomProvisioner, _clearInflightOpens, type RoomOpenInput } from "./RoomProvisioner.js";
import { renderBoard } from "@features/games/monopolyRenderer.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { checkGameRoomAccess } from "@features/entitlements/gameRoomAccess.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import type { MonopolyState } from "@features/games/monopolyState.js";

// ── a Monopoly room ──────────────────────────────────────────────────
// The provisioner's monopoly branch: the match is built from the room's players,
// stored on the row with the board message it edits, and posted on its own board
// message while the pinned opener stays a plain card (the self boarded path).

const storeMock = gameRoomStore as unknown as Record<string, ReturnType<typeof vi.fn>>;
const renderMock = renderBoard as unknown as ReturnType<typeof vi.fn>;

type SentPayload = {
	embeds: { data: { title?: string; description?: string; image?: { url: string } } }[];
	components?: { toJSON(): { components: { custom_id?: string }[] } }[];
	files?: AttachmentBuilder[];
};

function makeGuild() {
	let messageCount = 0;
	const send = vi.fn(async () => ({ id: `message-${++messageCount}`, pin: vi.fn().mockResolvedValue(undefined) }));
	const created = { id: "room-channel-1", send, delete: vi.fn(), createInvite: vi.fn(async () => ({ code: "invite-1" })) };
	const guild = {
		id: "guild-1",
		roles: { everyone: { id: "everyone" } },
		client: { user: { id: "bot-1" }, channels: { fetch: vi.fn().mockResolvedValue(null) } },
		channels: { create: vi.fn(async () => created) },
	} as unknown as Guild;
	return { guild, send };
}

const category = { id: "arcade-cat", children: { cache: { map: () => [] } } } as unknown as CategoryChannel;

const input = (guild: Guild): RoomOpenInput => ({
	guild,
	category,
	game: "monopoly",
	hostId: "host-1",
	hostDisplayName: "Host",
	playerIds: ["host-1", "player-2", "player-3"],
	spectatorIds: [],
	visibility: "public",
	adminRoleId: null,
});

const storedState = () =>
	(storeMock.update.mock.calls.find((call) => "secret" in (call[2] as object))?.[2] as { secret: MonopolyState }).secret;

const sentPayloads = (send: ReturnType<typeof vi.fn>) => send.mock.calls.map((call) => call[0] as SentPayload);

beforeEach(() => {
	vi.clearAllMocks();
	_clearInflightOpens();
	storeMock.findOpenByHost.mockResolvedValue(null);
	storeMock.countOpenInGuild.mockResolvedValue(0);
	storeMock.create.mockResolvedValue({ roomId: "room-1", guildId: "guild-1" });
	storeMock.setStatus.mockResolvedValue({ roomId: "room-1", guildId: "guild-1", status: "playing" });
	storeMock.update.mockResolvedValue(undefined);
	(botLogStore.log as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
	(checkGameRoomAccess as ReturnType<typeof vi.fn>).mockResolvedValue({ allowed: true, privateQuota: Number.POSITIVE_INFINITY });
	renderMock.mockResolvedValue(null);
});

const boardPayload = (send: ReturnType<typeof vi.fn>) =>
	sentPayloads(send).find((payload) => payload.embeds[0]?.data.title === gameRoomsCopy.monopoly.boardTitle);

describe("RoomProvisioner.open for monopoly", () => {
	// 2026-10 item 263 R3-24: the first seat's turn line goes up as the room opens and pings
	// that seat, so the opener pings every other member player and each is pinged exactly once.
	it("pings each member player once in total across the opener and the first turn line", async () => {
		const { guild, send } = makeGuild();
		const roomChannel = await (guild.channels.create as unknown as () => Promise<{ id: string; send: unknown }>)();
		(guild.client.channels.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ...roomChannel, isSendable: () => true, isTextBased: () => true, isDMBased: () => false });
		(guild.channels.create as unknown as ReturnType<typeof vi.fn>).mockClear();
		storeMock.findByRoomId.mockImplementation(async () => ({
			roomId: "room-1",
			guildId: "guild-1",
			game: "monopoly",
			hostId: "host-1",
			status: "playing",
			channelId: "room-channel-1",
			playerIds: ["host-1", "player-2", "player-3"],
			secret: storedState(),
			turnPrompt: null,
		}));

		await RoomProvisioner.open(input(guild));

		const pings = sentPayloads(send).flatMap((payload) => (payload as { allowedMentions?: { users?: string[] } }).allowedMentions?.users ?? []);
		expect(pings.sort()).toEqual(["host-1", "player-2", "player-3"]);
		const opener = sentPayloads(send)[0] as { content?: string; allowedMentions?: { users?: string[] } };
		expect(opener.content).toBe(gameRoomsCopy.opener.playersCall(["host-1", "player-2", "player-3"]));
		expect(opener.allowedMentions?.users).toEqual(["player-2", "player-3"]);
	});

	it("provisions the room and stores a fresh match, seated in player order, on the row", async () => {
		const { guild } = makeGuild();
		const result = await RoomProvisioner.open(input(guild));

		expect(result.ok).toBe(true);
		const state = storedState();
		expect(state.seats.map((seat) => seat.userId)).toEqual(["host-1", "player-2", "player-3"]);
		expect(state.seats.every((seat) => seat.chips === 1500 && seat.position === 0)).toBe(true);
		expect(state.phase).toBe("pre-roll");
		expect(state.activeSeatIndex).toBe(0);
	});

	// 2026-10 item 250 Phase 5: the host's Dero bots sit after the members, each on the
	// token its name says, and never in the row's playerIds.
	it("seats the host's Dero bots after the members, on their own tokens", async () => {
		const { guild } = makeGuild();
		await RoomProvisioner.open({ ...input(guild), botIds: ["dero-bot-gold", "dero-bot-green"] });
		const seats = storedState().seats.map((seat) => seat.userId);
		expect(seats.slice(-2)).toEqual(["dero-bot-gold", "dero-bot-green"]);
		expect(seats.slice(0, -2)).toEqual(input(guild).playerIds);
	});

	it("opens with auctions off when the host did not turn them on", async () => {
		const { guild } = makeGuild();
		await RoomProvisioner.open(input(guild));
		expect(storedState().settings.auctionsEnabled).toBe(false);
	});

	it("opens with auctions on when the host turned them on at the challenge card", async () => {
		const { guild } = makeGuild();
		await RoomProvisioner.open({ ...input(guild), monopolyAuctions: true });
		expect(storedState().settings.auctionsEnabled).toBe(true);
	});

	it("posts the board with the first seat's Roll control and stores that message id", async () => {
		const { guild, send } = makeGuild();
		await RoomProvisioner.open(input(guild));

		const board = sentPayloads(send).find((payload) => payload.embeds[0]?.data.title === gameRoomsCopy.monopoly.boardTitle);
		expect(board).toBeDefined();
		const ids = (board?.components ?? []).flatMap((row) => row.toJSON().components.map((button) => button.custom_id));
		expect(ids).toEqual(["gameroom:mroll:room-1", "gameroom:mtrade:room-1", "gameroom:minventory:room-1", "gameroom:msurrender:room-1"]);
		expect(board?.embeds[0].data.description).toContain(gameRoomsCopy.monopoly.onTheClock("host-1"));
		// The opener is message-1, the board message-2.
		expect(storedState().boardMessageId).toBe("message-2");
	});

	it("takes the self boarded path: the pinned opener carries the rules and only the host's Remove a player", async () => {
		const { guild, send } = makeGuild();
		await RoomProvisioner.open(input(guild));

		const opener = sentPayloads(send)[0];
		expect(opener.embeds[0].data.title).toBe(gameRoomsCopy.opener.title("monopoly"));
		expect(opener.embeds[0].data.description).toContain(gameRoomsCopy.monopoly.openerRules());
		// The game's own controls stay on its board; the opener carries the one host
		// control that belongs to the room rather than the turn (2026-10 item 244 Phase 4).
		const ids = (opener.components ?? []).flatMap((row) => row.toJSON().components.map((button) => button.custom_id));
		expect(ids).toEqual(["gameroom:kick:room-1"]);
	});

	it("still stores the match when the board post fails, with no message id to edit", async () => {
		const { guild, send } = makeGuild();
		send.mockImplementationOnce(async () => ({ id: "message-1", pin: vi.fn().mockResolvedValue(undefined) }));
		send.mockImplementationOnce(async () => {
			throw new Error("Missing Access");
		});

		await RoomProvisioner.open(input(guild));

		expect(storedState().seats).toHaveLength(3);
		expect(storedState().boardMessageId).toBeNull();
	});

	it("attaches the board picture to the first board when the renderer has one", async () => {
		const attachment = new AttachmentBuilder(Buffer.from("png"), { name: "monopoly-board-1.png" });
		renderMock.mockResolvedValue({ attachment, ref: "attachment://monopoly-board-1.png" });
		const { guild, send } = makeGuild();

		await RoomProvisioner.open(input(guild));

		// The picture is of the match about to be stored, seated in player order.
		expect(renderMock).toHaveBeenCalledWith(expect.objectContaining({ phase: "pre-roll", activeSeatIndex: 0 }), expect.any(Number), expect.any(Map));
		const board = boardPayload(send);
		expect(board?.files).toEqual([attachment]);
		expect(board?.embeds[0].data.image?.url).toBe("attachment://monopoly-board-1.png");
	});

	it("posts the text board with no file when the renderer has no picture", async () => {
		const { guild, send } = makeGuild();
		await RoomProvisioner.open(input(guild));

		const board = boardPayload(send);
		expect(board?.files).toEqual([]);
		expect(board?.embeds[0].data.image).toBeUndefined();
		expect(board?.embeds[0].data.description).toContain(gameRoomsCopy.monopoly.boardMapLabel);
	});
});
