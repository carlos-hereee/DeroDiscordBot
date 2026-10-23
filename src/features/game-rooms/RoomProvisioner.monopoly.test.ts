import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CategoryChannel, Guild } from "discord.js";

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

import { RoomProvisioner, _clearInflightOpens, type RoomOpenInput } from "./RoomProvisioner.js";
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

type SentPayload = {
	embeds: { data: { title?: string; description?: string } }[];
	components?: { toJSON(): { components: { custom_id?: string }[] } }[];
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
});

describe("RoomProvisioner.open for monopoly", () => {
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

	// ⚠️ AUCTIONS ARE OFF IN PHASE 4. applySkip opens an auction when they are on, and
	// no Phase 4 control can bid on or close one, so a single pass would strand the match.
	it("opens every Phase 4 match with auctions off", async () => {
		const { guild } = makeGuild();
		await RoomProvisioner.open(input(guild));
		expect(storedState().settings.auctionsEnabled).toBe(false);
	});

	it("posts the board with the first seat's Roll control and stores that message id", async () => {
		const { guild, send } = makeGuild();
		await RoomProvisioner.open(input(guild));

		const board = sentPayloads(send).find((payload) => payload.embeds[0]?.data.title === gameRoomsCopy.monopoly.boardTitle);
		expect(board).toBeDefined();
		const ids = (board?.components ?? []).flatMap((row) => row.toJSON().components.map((button) => button.custom_id));
		expect(ids).toEqual(["gameroom:mroll:room-1", "gameroom:minventory:room-1"]);
		expect(board?.embeds[0].data.description).toContain(gameRoomsCopy.monopoly.onTheClock("host-1"));
		// The opener is message-1, the board message-2.
		expect(storedState().boardMessageId).toBe("message-2");
	});

	it("takes the self boarded path: the pinned opener carries the rules and no controls", async () => {
		const { guild, send } = makeGuild();
		await RoomProvisioner.open(input(guild));

		const opener = sentPayloads(send)[0];
		expect(opener.embeds[0].data.title).toBe(gameRoomsCopy.opener.title("monopoly"));
		expect(opener.embeds[0].data.description).toContain(gameRoomsCopy.monopoly.openerRules());
		expect(opener).not.toHaveProperty("components");
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
});
