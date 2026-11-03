import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ButtonInteraction, Client, Guild, StringSelectMenuInteraction } from "discord.js";

const mocks = vi.hoisted(() => ({
	findByRoomId: vi.fn(),
	addNetworkPendingJoin: vi.fn(),
	findConfig: vi.fn(),
	findBans: vi.fn(),
	findConsent: vi.fn(),
	acceptConsent: vi.fn(),
	findRatings: vi.fn(),
	openSatellite: vi.fn(),
	redrawTable: vi.fn(),
	seatAccepted: vi.fn(),
	scheduleRefresh: vi.fn(),
}));

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: { findByRoomId: mocks.findByRoomId, addNetworkPendingJoin: mocks.addNetworkPendingJoin },
}));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findConfig } }));
vi.mock("@db/stores/networkBanStore.js", () => ({ networkBanStore: { findAgainst: mocks.findBans } }));
vi.mock("@db/stores/networkConsentStore.js", () => ({ networkConsentStore: { findByUserId: mocks.findConsent, accept: mocks.acceptConsent } }));
vi.mock("@db/stores/playerRatingStore.js", () => ({ playerRatingStore: { findForPlayers: mocks.findRatings } }));
vi.mock("./satelliteSeats.js", () => ({ openSatelliteWithTable: mocks.openSatellite }));
vi.mock("./roomHoldemHandlers.js", () => ({ redrawTable: mocks.redrawTable, seatAcceptedPlayer: mocks.seatAccepted }));
vi.mock("./networkBoard.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./networkBoard.js")>()),
	scheduleNetworkBoardRefresh: mocks.scheduleRefresh,
}));

import { handleNetworkBoardSelect, handleNetworkConsentButton, requestNetworkSeat, seatAcceptedRemotePlayer } from "./networkJoin.js";
import { consentAcceptId } from "./networkRules.js";
import { createTable, joinTable } from "@features/games/holdemTable.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── asking for a seat at another server's network table (2026-10 item 244 Phase 5b) ──
// Every refusal path the owner named, in the owner's order: no consent, a banned member,
// a banned server, a blocked server, the host's band and the host's approval; then the
// satellite. And the network notice's buttons, which carry a board request on.

const words = rokCommanderCopy.arcadeNetwork;

const HOST_GUILD = "100000000000000001";
const FROM_GUILD = "200000000000000002";
const HOST = "host-1";
const JOINER = "joiner-1";
const SETTLED = BOT_CONSTANTS.RATINGS.PROVISIONAL_GAMES;

const fromGuild = { id: FROM_GUILD, members: { fetch: vi.fn().mockResolvedValue({ displayName: "Joiner" }) } } as unknown as Guild;
const client = {
	guilds: {
		cache: new Map<string, unknown>([
			[HOST_GUILD, { id: HOST_GUILD }],
			[FROM_GUILD, fromGuild],
		]),
	},
} as unknown as Client;

function joiningTable() {
	const table = createTable();
	joinTable(table, HOST, "Host");
	return table;
}

function makeRoom(overrides: Partial<IGameRoom> = {}): IGameRoom {
	return {
		roomId: "room-1",
		guildId: HOST_GUILD,
		game: "holdem",
		hostId: HOST,
		status: "playing",
		network: true,
		playerIds: [HOST],
		pendingJoinIds: [],
		pendingNetworkJoins: [],
		kickedIds: [],
		satellites: [],
		ratingBand: "any",
		requireApproval: false,
		seatsOpen: false,
		secret: joiningTable(),
		...overrides,
	} as unknown as IGameRoom;
}

const onNetwork = (guildId: string, blocked: string[] = []) => ({ guildId, challengeReach: "network", blockedNetworkGuildIds: blocked });
const rated = (userId: string, displayRating: number) => ({ userId, game: "holdem", mu: 25, sigma: 1, displayRating, ratedGames: SETTLED, lastRatedAt: new Date() });

beforeEach(() => {
	vi.clearAllMocks();
	mocks.findByRoomId.mockResolvedValue(makeRoom());
	mocks.findConfig.mockImplementation(async (guildId: string) => onNetwork(guildId));
	mocks.findBans.mockResolvedValue([]);
	mocks.findConsent.mockResolvedValue({ userId: JOINER, version: BOT_CONSTANTS.NETWORK.CONSENT_VERSION });
	mocks.findRatings.mockResolvedValue([]);
	mocks.openSatellite.mockResolvedValue({ ok: true, room: makeRoom(), channelId: "sat-ch" });
	mocks.addNetworkPendingJoin.mockResolvedValue(makeRoom({ pendingJoinIds: [JOINER] }));
	mocks.seatAccepted.mockResolvedValue(null);
});

const ask = () => requestNetworkSeat(client, fromGuild, JOINER, HOST_GUILD, "room-1");

describe("requestNetworkSeat: the doors before the seat", () => {
	it("refuses when the asker's own server is no longer on the network, before reading the table", async () => {
		mocks.findConfig.mockImplementation(async (guildId: string) => (guildId === FROM_GUILD ? { guildId, challengeReach: "server" } : onNetwork(guildId)));
		expect(await ask()).toEqual({ kind: "refused", text: words.joinRefusals.serverOffNetwork });
		expect(mocks.findByRoomId).not.toHaveBeenCalled();
	});

	it("refuses a table that no longer takes players: closed seats mid tournament, or not a network table", async () => {
		const playing = joiningTable();
		playing.status = "playing";
		mocks.findByRoomId.mockResolvedValue(makeRoom({ secret: playing, seatsOpen: false }));
		expect(await ask()).toEqual({ kind: "refused", text: words.joinRefusals.tableGone });

		mocks.findByRoomId.mockResolvedValue(makeRoom({ network: false }));
		expect(await ask()).toEqual({ kind: "refused", text: words.joinRefusals.tableGone });
		expect(mocks.openSatellite).not.toHaveBeenCalled();
	});

	it("asks for the network notice first when the member never accepted it, and writes nothing", async () => {
		mocks.findConsent.mockResolvedValue(null);
		expect(await ask()).toEqual({ kind: "consent" });
		expect(mocks.findBans).not.toHaveBeenCalled();
		expect(mocks.openSatellite).not.toHaveBeenCalled();
	});

	it("counts a consent to an older notice as no consent", async () => {
		mocks.findConsent.mockResolvedValue({ userId: JOINER, version: BOT_CONSTANTS.NETWORK.CONSENT_VERSION - 1 });
		expect(await ask()).toEqual({ kind: "consent" });
	});

	it("refuses a member the owner banned from the network", async () => {
		mocks.findBans.mockResolvedValue([{ kind: "user", targetId: JOINER }]);
		expect(await ask()).toEqual({ kind: "refused", text: words.joinRefusals.bannedUser });
		expect(mocks.openSatellite).not.toHaveBeenCalled();
	});

	it("refuses a member whose server the owner banned", async () => {
		mocks.findBans.mockResolvedValue([{ kind: "guild", targetId: FROM_GUILD }]);
		expect(await ask()).toEqual({ kind: "refused", text: words.joinRefusals.bannedServer });
	});

	it("refuses a seat at a table whose server, or whose host, the owner banned", async () => {
		mocks.findBans.mockResolvedValue([{ kind: "guild", targetId: HOST_GUILD }]);
		expect(await ask()).toEqual({ kind: "refused", text: words.joinRefusals.hostServerClosed });
		mocks.findBans.mockResolvedValue([{ kind: "user", targetId: HOST }]);
		expect(await ask()).toEqual({ kind: "refused", text: words.joinRefusals.hostServerClosed });
	});

	it("refuses when the host's server blocked the asker's server, and when the asker's server blocked the host's", async () => {
		mocks.findConfig.mockImplementation(async (guildId: string) => (guildId === HOST_GUILD ? onNetwork(guildId, [FROM_GUILD]) : onNetwork(guildId)));
		expect(await ask()).toEqual({ kind: "refused", text: words.joinRefusals.blocked });

		mocks.findConfig.mockImplementation(async (guildId: string) => (guildId === FROM_GUILD ? onNetwork(guildId, [HOST_GUILD]) : onNetwork(guildId)));
		expect(await ask()).toEqual({ kind: "refused", text: words.joinRefusals.blocked });
		expect(mocks.openSatellite).not.toHaveBeenCalled();
	});

	it("refuses a settled rating outside the host's band", async () => {
		mocks.findByRoomId.mockResolvedValue(makeRoom({ ratingBand: "tight" }));
		mocks.findRatings.mockResolvedValue([rated(HOST, 1300), rated(JOINER, 1000)]);
		expect(await ask()).toEqual({ kind: "refused", text: words.joinRefusals.outsideBand("Texas hold em") });
		expect(mocks.openSatellite).not.toHaveBeenCalled();
	});

	it("refuses a member the host removed from that table", async () => {
		mocks.findByRoomId.mockResolvedValue(makeRoom({ kickedIds: [JOINER] }));
		expect(await ask()).toEqual({ kind: "refused", text: words.joinRefusals.removed });
	});
});

describe("requestNetworkSeat: approval and the seat", () => {
	it("puts the request on the host's list with the server it came from when the host approves each player, and opens nothing", async () => {
		mocks.findByRoomId.mockResolvedValue(makeRoom({ requireApproval: true }));
		expect(await ask()).toEqual({ kind: "asked" });
		expect(mocks.addNetworkPendingJoin).toHaveBeenCalledWith(HOST_GUILD, "room-1", JOINER, FROM_GUILD);
		expect(mocks.redrawTable).toHaveBeenCalled();
		expect(mocks.openSatellite).not.toHaveBeenCalled();
	});

	it("says the request is already with the host instead of asking twice", async () => {
		mocks.findByRoomId.mockResolvedValue(makeRoom({ requireApproval: true, pendingJoinIds: [JOINER] }));
		expect(await ask()).toEqual({ kind: "refused", text: words.alreadyAsked });
		expect(mocks.addNetworkPendingJoin).not.toHaveBeenCalled();
	});

	it("opens a satellite in the asker's server when every door passes, and asks the board to redraw", async () => {
		expect(await ask()).toEqual({ kind: "seated", channelId: "sat-ch" });
		expect(mocks.openSatellite).toHaveBeenCalledWith(expect.objectContaining({ roomId: "room-1" }), fromGuild, [JOINER]);
		expect(mocks.scheduleRefresh).toHaveBeenCalled();
	});

	it("points a member already seated from this server at their channel", async () => {
		mocks.findByRoomId.mockResolvedValue(makeRoom({ satellites: [{ guildId: FROM_GUILD, channelId: "sat-ch", userIds: [JOINER], tableMessageId: null }] }));
		expect(await ask()).toEqual({ kind: "alreadySeated", channelId: "sat-ch" });
		expect(mocks.openSatellite).not.toHaveBeenCalled();
	});

	it("passes on the satellite's own refusal, such as a server with no arcade category", async () => {
		mocks.openSatellite.mockResolvedValue({ ok: false, reason: "notSetUp" });
		expect(await ask()).toEqual({ kind: "refused", text: rokCommanderCopy.arcadeSatellites.refusals.notSetUp });
	});
});

describe("the network board's select", () => {
	function selectPress(value: string) {
		const editReply = vi.fn(async () => undefined);
		const reply = vi.fn(async () => undefined);
		const interaction = {
			customId: "networkBoard:join",
			values: [value],
			guild: fromGuild,
			user: { id: JOINER },
			client,
			deferReply: vi.fn(async () => undefined),
			editReply,
			reply,
		} as unknown as StringSelectMenuInteraction;
		return { interaction, editReply, reply };
	}

	it("shows the network notice with a continuation that carries the table, for a member without consent", async () => {
		mocks.findConsent.mockResolvedValue(null);
		const { interaction, editReply } = selectPress(`${HOST_GUILD}:room-1`);
		await handleNetworkBoardSelect(interaction);
		const payload = (editReply.mock.calls[0] as unknown as [{ components: { components: { data: { custom_id: string } }[] }[] }])[0];
		const ids = payload.components[0].components.map((button) => button.data.custom_id);
		expect(ids).toContain(consentAcceptId({ kind: "join", hostGuildId: HOST_GUILD, roomId: "room-1" }));
	});

	it("refuses a malformed value without reading anything", async () => {
		const { interaction, reply } = selectPress("not-a-guild:room-1");
		await handleNetworkBoardSelect(interaction);
		expect(reply).toHaveBeenCalled();
		expect(mocks.findByRoomId).not.toHaveBeenCalled();
	});
});

describe("the network notice's buttons", () => {
	function buttonPress(customId: string) {
		const update = vi.fn(async () => undefined);
		const editReply = vi.fn(async () => undefined);
		const interaction = {
			customId,
			guild: fromGuild,
			user: { id: JOINER },
			client,
			update,
			editReply,
			deferUpdate: vi.fn(async () => undefined),
			reply: vi.fn(async () => undefined),
		} as unknown as ButtonInteraction;
		return { interaction, update, editReply };
	}

	it("stores consent at the current version, then carries the board request on to the seat", async () => {
		const { interaction, editReply } = buttonPress(consentAcceptId({ kind: "join", hostGuildId: HOST_GUILD, roomId: "room-1" }));
		await handleNetworkConsentButton(interaction);
		expect(mocks.acceptConsent).toHaveBeenCalledWith(JOINER, BOT_CONSTANTS.NETWORK.CONSENT_VERSION, expect.any(Date));
		const text = (editReply.mock.calls[0] as unknown as [{ content: string }])[0].content;
		expect(text).toContain(words.seatReady("sat-ch"));
	});

	it("asks the member to press again for a door in their own server", async () => {
		const { interaction, update } = buttonPress(consentAcceptId({ kind: "again" }));
		await handleNetworkConsentButton(interaction);
		expect(mocks.acceptConsent).toHaveBeenCalled();
		expect((update.mock.calls[0] as unknown as [{ content: string }])[0].content).toBe(words.consent.acceptedPressAgain);
	});

	it("stores nothing when the member declines", async () => {
		const { interaction, update } = buttonPress("networkConsent:no");
		await handleNetworkConsentButton(interaction);
		expect(mocks.acceptConsent).not.toHaveBeenCalled();
		expect((update.mock.calls[0] as unknown as [{ content: string }])[0].content).toBe(words.consent.declined);
	});
});

describe("seatAcceptedRemotePlayer: the host accepts a member from another server", () => {
	it("opens their satellite in the server they asked from and seats them like their own Buy in", async () => {
		expect(await seatAcceptedRemotePlayer(client, makeRoom(), JOINER, FROM_GUILD)).toBeNull();
		expect(mocks.openSatellite).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: FROM_GUILD }), [JOINER]);
		expect(mocks.seatAccepted).toHaveBeenCalledWith(client, expect.anything(), JOINER, "Joiner");
	});

	it("says their server is gone when it left the network while they waited", async () => {
		mocks.findConfig.mockImplementation(async (guildId: string) => (guildId === FROM_GUILD ? { guildId, challengeReach: "server" } : onNetwork(guildId)));
		expect(await seatAcceptedRemotePlayer(client, makeRoom(), JOINER, FROM_GUILD)).toBe(words.hostAccept.serverGone);
		expect(mocks.openSatellite).not.toHaveBeenCalled();
	});

	it("says the network closed to them when a ban landed while they waited", async () => {
		mocks.findBans.mockResolvedValue([{ kind: "user", targetId: JOINER }]);
		expect(await seatAcceptedRemotePlayer(client, makeRoom(), JOINER, FROM_GUILD)).toBe(words.hostAccept.closed);
		expect(mocks.openSatellite).not.toHaveBeenCalled();
	});
});
