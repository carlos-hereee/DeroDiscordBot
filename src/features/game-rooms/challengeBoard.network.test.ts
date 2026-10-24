import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ButtonInteraction } from "discord.js";

const mocks = vi.hoisted(() => ({
	findByRoomId: vi.fn(),
	update: vi.fn(),
	addPoolMember: vi.fn(),
	findConfig: vi.fn(),
	findRatings: vi.fn(),
	findConsent: vi.fn(),
	findBans: vi.fn(),
}));

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: { findByRoomId: mocks.findByRoomId, update: mocks.update, addPoolMember: mocks.addPoolMember },
}));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findConfig } }));
vi.mock("@db/stores/playerRatingStore.js", () => ({ playerRatingStore: { findForPlayers: mocks.findRatings } }));
vi.mock("@db/stores/networkConsentStore.js", () => ({ networkConsentStore: { findByUserId: mocks.findConsent } }));
vi.mock("@db/stores/networkBanStore.js", () => ({ networkBanStore: { findAgainst: mocks.findBans } }));
vi.mock("./RoomProvisioner.js", () => ({ RoomProvisioner: { open: vi.fn() }, describeRoomOpenFailure: () => "nope" }));
vi.mock("./soloRooms.js", () => ({ readPrivateQuotaStatus: vi.fn().mockResolvedValue(null) }));
vi.mock("./challengeCardRenderer.js", () => ({ renderChallengeCard: vi.fn().mockResolvedValue(null), challengeCardView: vi.fn().mockResolvedValue({}) }));

import { chooseVisibility, joinChallenge, startMatch } from "./challengeBoard.js";
import { openerCardEmbed, openerCardRows, type OpenerCardState } from "./challengeBoardEmbeds.js";
import { consentAcceptId } from "./networkRules.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── the challenge card at a network table (2026-10 item 244 Phase 5b) ──────
// The network choice is offered where it can work, refused server side otherwise, taken
// by the host alone and only with their consent; a network table's Join asks for the
// network notice first; and a network table may open with nobody else in the pool.

const words = rokCommanderCopy.arcadeNetwork;
type Mock = ReturnType<typeof vi.fn>;

const GUILD = "100000000000000001";
const HOST = "host-1";
const JOINER = "joiner-1";

const makeRoom = (overrides: Partial<IGameRoom> = {}): IGameRoom =>
	({
		roomId: "room-1",
		guildId: GUILD,
		game: "holdem",
		hostId: HOST,
		playerIds: [HOST],
		spectatorIds: [],
		pendingJoinIds: [],
		kickedIds: [],
		ratingBand: "any",
		requireApproval: false,
		visibility: "invite",
		network: false,
		status: "draft",
		channelId: null,
		boardMessageId: null,
		...overrides,
	}) as unknown as IGameRoom;

const guild = { id: GUILD, members: { cache: new Map(), fetch: vi.fn().mockResolvedValue(null) } };
const client = { guilds: { cache: new Map([[GUILD, { id: GUILD }]]) } };

function makeButton(userId: string): ButtonInteraction {
	return {
		guildId: GUILD,
		guild,
		user: { id: userId },
		client,
		reply: vi.fn().mockResolvedValue(undefined),
		deferUpdate: vi.fn().mockResolvedValue(undefined),
		deferReply: vi.fn().mockResolvedValue(undefined),
		editReply: vi.fn().mockResolvedValue(undefined),
		followUp: vi.fn().mockResolvedValue(undefined),
	} as unknown as ButtonInteraction;
}

const firstReply = (interaction: ButtonInteraction) => ((interaction.reply as unknown as Mock).mock.calls[0]?.[0] ?? {}) as { content?: string; components?: unknown[] };
const consentButtonIds = (interaction: ButtonInteraction): string[] =>
	((firstReply(interaction).components ?? []) as { toJSON(): { components: { custom_id?: string }[] } }[]).flatMap((row) =>
		row.toJSON().components.map((component) => component.custom_id ?? "")
	);

beforeEach(() => {
	vi.clearAllMocks();
	mocks.findConfig.mockResolvedValue({ guildId: GUILD, challengeReach: "network" });
	mocks.findRatings.mockResolvedValue([]);
	mocks.findConsent.mockResolvedValue({ userId: HOST, version: BOT_CONSTANTS.NETWORK.CONSENT_VERSION });
	mocks.findBans.mockResolvedValue([]);
	mocks.update.mockImplementation(async (_guildId: string, _roomId: string, patch: Partial<IGameRoom>) => makeRoom(patch));
	mocks.findByRoomId.mockResolvedValue(makeRoom());
});

describe("the card's network choice", () => {
	const firstStep = (allowNetwork?: boolean): OpenerCardState => ({ game: "holdem", hostId: HOST, visibility: null, pool: [], allowNetwork });
	const choices = (state: OpenerCardState): string[] =>
		openerCardRows("room-1", state)
			.flatMap((row) => row.toJSON().components)
			.map((component) => ("custom_id" in component ? component.custom_id : ""))
			.filter((id) => id.includes(":vis:"));

	it("offers Open to the network only when the card is told it may", () => {
		expect(choices(firstStep(true))).toEqual(["gameroom:vis:room-1:invite", "gameroom:vis:room-1:public", "gameroom:vis:room-1:network"]);
		expect(choices(firstStep())).toEqual(["gameroom:vis:room-1:invite", "gameroom:vis:room-1:public"]);
	});

	it("says on the card that the table is open to other network servers", () => {
		const embed = openerCardEmbed({ game: "holdem", hostId: HOST, visibility: "public", pool: [], network: true });
		expect(embed.data.description).toContain(words.cardLine(HOST));
	});
});

describe("choosing the network", () => {
	it("opens the host's table to the network as a public room", async () => {
		const interaction = makeButton(HOST);
		await chooseVisibility(interaction, makeRoom(), "network");
		expect(mocks.update).toHaveBeenCalledWith(GUILD, "room-1", { visibility: "public", network: true });
		expect(interaction.deferUpdate).toHaveBeenCalled();
	});

	it("refuses an admin choosing it for the host, because consent is personal", async () => {
		const interaction = makeButton("admin-1");
		await chooseVisibility(interaction, makeRoom(), "network");
		expect(firstReply(interaction).content).toBe(words.hostRefusals.notHost);
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("refuses when the server is not on the network, even from a stale card", async () => {
		mocks.findConfig.mockResolvedValue({ guildId: GUILD, challengeReach: "server" });
		const interaction = makeButton(HOST);
		await chooseVisibility(interaction, makeRoom(), "network");
		expect(firstReply(interaction).content).toBe(words.hostRefusals.notOnNetwork);
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("refuses a game no satellite can mirror", async () => {
		const interaction = makeButton(HOST);
		await chooseVisibility(interaction, makeRoom({ game: "battleship" }), "network");
		expect(firstReply(interaction).content).toBe(words.hostRefusals.notNetworkGame("Battleship"));
	});

	it("refuses a host or a server the owner banned from the network", async () => {
		mocks.findBans.mockResolvedValue([{ kind: "user", targetId: HOST }]);
		const banned = makeButton(HOST);
		await chooseVisibility(banned, makeRoom(), "network");
		expect(firstReply(banned).content).toBe(words.hostRefusals.banned);

		mocks.findBans.mockResolvedValue([{ kind: "guild", targetId: GUILD }]);
		const serverBanned = makeButton(HOST);
		await chooseVisibility(serverBanned, makeRoom(), "network");
		expect(firstReply(serverBanned).content).toBe(words.hostRefusals.serverBanned);
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("shows the host the network notice first when they never accepted it", async () => {
		mocks.findConsent.mockResolvedValue(null);
		const interaction = makeButton(HOST);
		await chooseVisibility(interaction, makeRoom(), "network");
		expect(consentButtonIds(interaction)).toContain(consentAcceptId({ kind: "again" }));
		expect(mocks.update).not.toHaveBeenCalled();
	});
});

describe("a network table's doors on the card", () => {
	it("asks a joiner without consent for the network notice instead of joining them", async () => {
		mocks.findConsent.mockResolvedValue(null);
		const interaction = makeButton(JOINER);
		await joinChallenge(interaction, makeRoom({ visibility: "public", network: true }));
		expect(consentButtonIds(interaction)).toContain(consentAcceptId({ kind: "again" }));
		expect(mocks.addPoolMember).not.toHaveBeenCalled();
	});

	it("lets a network table start with nobody else in the pool, and still refuses that for a server room", async () => {
		const network = makeButton(HOST);
		await startMatch(network, makeRoom({ visibility: "public", network: true }));
		expect(firstReply(network).content).not.toBe(gameRoomsCopy.board.poolEmpty);
		expect(network.deferReply).toHaveBeenCalled();

		const server = makeButton(HOST);
		await startMatch(server, makeRoom({ visibility: "public" }));
		expect(firstReply(server).content).toBe(gameRoomsCopy.board.poolEmpty);
	});
});
