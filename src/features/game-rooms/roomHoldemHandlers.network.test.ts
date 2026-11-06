import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ButtonInteraction, Client } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: { update: vi.fn(), updateSecretIf: vi.fn(), findByRoomId: vi.fn(), addPendingJoin: vi.fn() },
}));
vi.mock("@db/stores/playerRatingStore.js", () => ({ playerRatingStore: { findForPlayers: vi.fn() } }));
vi.mock("@db/stores/networkConsentStore.js", () => ({ networkConsentStore: { findByUserId: vi.fn() } }));
vi.mock("./roomTrail.js", () => ({ roomTrail: { postMove: vi.fn() } }));
// Read by answerInChannel (2026-10 item 257 Phase 5) for the channel the notice posts in.
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn() } }));
vi.mock("./roomLifecycle.js", () => ({ roomLifecycle: { finish: vi.fn() } }));
vi.mock("@features/leveling/awardXp.js", () => ({ awardXp: vi.fn() }));
vi.mock("@features/ratings/recordMatchRatings.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("@features/ratings/recordMatchRatings.js")>()),
	recordMatchRatings: vi.fn(),
}));
// The age gate (2026-11 item 302) runs inside judgeJoin, which handleBuyIn calls for every
// press; every case here is a confirmed member unless a case says otherwise.
vi.mock("@features/age-gate/ageGateRules.js", () => ({ hasConfirmedAge: vi.fn(async () => true), replyWithAgeGate: vi.fn() }));

import { handleBuyIn, removeFromTable } from "./roomHoldemHandlers.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { networkConsentStore } from "@db/stores/networkConsentStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { awardXp } from "@features/leveling/awardXp.js";
import { consentAcceptId } from "./networkRules.js";
import { act, createTable, dealHand, handInProgress, joinTable, whoActs, type HoldemTable } from "@features/games/holdemTable.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── a network Hold'em table's doors and XP (2026-10 item 244 Phase 5b) ─────
// What:  Buy in at a network table asks for the network notice first; and the Hold'em
//        awards are paid per player where networkXp says, so a remote player's
//        placement lands in their tag's server (or the server they clicked from) while
//        a host server player's stays in the host server with the room's channel.

type Mock = ReturnType<typeof vi.fn>;
const storeMock = gameRoomStore as unknown as Record<"update" | "updateSecretIf" | "findByRoomId" | "addPendingJoin", Mock>;
const consentMock = networkConsentStore.findByUserId as unknown as Mock;
const finishMock = roomLifecycle.finish as unknown as Mock;
const awardMock = awardXp as unknown as Mock;

const HOST_GUILD = "host-guild";
const SAT_GUILD = "sat-guild";
const TAG_GUILD = "tag-guild";
const LOCAL = "p0";
const REMOTE = "r1";

function seededRng(seed = 5): () => number {
	let state = seed;
	return () => {
		state = (state * 1664525 + 1013904223) % 4294967296;
		return state / 4294967296;
	};
}

// A heads up tournament between hands, the host server's player and a remote one.
function headsUpBetweenHands(): HoldemTable {
	const table = createTable();
	joinTable(table, LOCAL, "Local");
	joinTable(table, REMOTE, "Remote");
	table.status = "playing";
	dealHand(table, seededRng());
	for (let turn = 0; turn < 20 && handInProgress(table); turn++) act(table, whoActs(table)!, "fold");
	table.boardMessageId = null;
	return table;
}

const makeRoom = (table: HoldemTable, overrides: Partial<IGameRoom> = {}): IGameRoom =>
	({
		roomId: "room-1",
		guildId: HOST_GUILD,
		game: "holdem",
		hostId: LOCAL,
		status: "playing",
		network: true,
		playerIds: [LOCAL, REMOTE],
		kickedIds: [],
		channelId: "host-ch",
		satellites: [{ guildId: SAT_GUILD, channelId: "sat-ch", userIds: [REMOTE], tableMessageId: null }],
		secret: table,
		...overrides,
	}) as unknown as IGameRoom;

function clientWith(identity: { identityGuildId: string; identityEnabled: boolean; tag: string } | null, guilds: string[]): Client {
	return {
		users: { cache: new Map([[REMOTE, { id: REMOTE, primaryGuild: identity }]]), fetch: vi.fn() },
		guilds: { cache: new Map(guilds.map((id) => [id, { id }])) },
		channels: { fetch: vi.fn().mockResolvedValue(null) },
	} as unknown as Client;
}

// The placement award paid to one player, once every award has landed.
async function placementFor(userId: string): Promise<{ guildId: string; channelId: string | null }> {
	await vi.waitFor(() => expect(awardMock.mock.calls.filter((call) => (call[0] as { game?: string }).game === "holdem")).toHaveLength(2));
	const call = awardMock.mock.calls.find((entry) => (entry[0] as { userId: string; game?: string }).userId === userId && (entry[0] as { game?: string }).game === "holdem");
	const input = call?.[0] as { guildId: string; channelId: string | null };
	return { guildId: input.guildId, channelId: input.channelId };
}

beforeEach(() => {
	vi.clearAllMocks();
	storeMock.updateSecretIf.mockResolvedValue({});
	storeMock.findByRoomId.mockResolvedValue(null);
	finishMock.mockResolvedValue(true);
	consentMock.mockResolvedValue({ userId: REMOTE, version: BOT_CONSTANTS.NETWORK.CONSENT_VERSION });
	(guildConfigStore.findByGuildId as ReturnType<typeof vi.fn>).mockResolvedValue({ commandOutputChannelId: "c-commands" });
});

describe("Buy in at a network table", () => {
	it("shows the network notice to a member who never accepted it, in the commands channel, and seats nobody", async () => {
		consentMock.mockResolvedValue(null);
		const send = vi.fn(async () => ({ id: "m1", edit: vi.fn() }));
		const commands = { id: "c-commands", isSendable: () => true, send };
		const reply = vi.fn().mockResolvedValue(undefined);
		const interaction = {
			id: "press-1",
			guildId: HOST_GUILD,
			channelId: "c-commands",
			guild: { members: { cache: { get: () => null } } },
			user: { id: "newcomer", username: "newcomer", globalName: "newcomer" },
			client: { channels: { fetch: vi.fn(async (id: string) => (id === "c-commands" ? commands : null)) } },
			deferred: false,
			replied: false,
			reply,
			deferUpdate: vi.fn().mockResolvedValue(undefined),
			isModalSubmit: () => false,
			isMessageComponent: () => true,
		} as unknown as ButtonInteraction;

		await handleBuyIn(interaction, makeRoom(createTable(), { playerIds: [LOCAL] }));

		expect(reply).not.toHaveBeenCalled();
		const payload = send.mock.calls[0][0] as { content: string; allowedMentions: unknown; components: { toJSON(): { components: { custom_id?: string }[] } }[] };
		expect(payload.content.startsWith("<@newcomer>")).toBe(true);
		expect(payload.allowedMentions).toEqual({ parse: [], users: ["newcomer"] });
		const ids = payload.components.flatMap((row) => row.toJSON().components.map((component) => component.custom_id));
		expect(ids).toContain(consentAcceptId({ kind: "again" }));
		expect(storeMock.updateSecretIf).not.toHaveBeenCalled();
	});
});

describe("where a network table's placement XP lands", () => {
	// The host server's player leaves a heads up table, which ends the tournament and
	// pays both placements: the remote player wins, the local player places second.
	async function endTournament(client: Client): Promise<void> {
		await removeFromTable(client, makeRoom(headsUpBetweenHands()), LOCAL, LOCAL);
	}

	it("keeps a host server player's placement in the host server with the room's channel", async () => {
		await endTournament(clientWith(null, [HOST_GUILD, SAT_GUILD]));
		expect(await placementFor(LOCAL)).toEqual({ guildId: HOST_GUILD, channelId: "host-ch" });
	});

	it("pays a remote player in the server whose tag they wear when Dero is in it", async () => {
		await endTournament(clientWith({ identityGuildId: TAG_GUILD, identityEnabled: true, tag: "ABC" }, [HOST_GUILD, SAT_GUILD, TAG_GUILD]));
		expect(await placementFor(REMOTE)).toEqual({ guildId: TAG_GUILD, channelId: null });
	});

	it("pays a remote player in the server they clicked from when Dero is not in their tag's server", async () => {
		await endTournament(clientWith({ identityGuildId: TAG_GUILD, identityEnabled: true, tag: "ABC" }, [HOST_GUILD, SAT_GUILD]));
		expect(await placementFor(REMOTE)).toEqual({ guildId: SAT_GUILD, channelId: "sat-ch" });
	});

	it("pays a remote player with no tag, or a hidden one, in the server they clicked from", async () => {
		await endTournament(clientWith(null, [HOST_GUILD, SAT_GUILD, TAG_GUILD]));
		expect(await placementFor(REMOTE)).toEqual({ guildId: SAT_GUILD, channelId: "sat-ch" });

		awardMock.mockClear();
		await endTournament(clientWith({ identityGuildId: TAG_GUILD, identityEnabled: false, tag: "ABC" }, [HOST_GUILD, SAT_GUILD, TAG_GUILD]));
		expect(await placementFor(REMOTE)).toEqual({ guildId: SAT_GUILD, channelId: "sat-ch" });
	});
});
