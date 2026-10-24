import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "discord.js";

const mocks = vi.hoisted(() => ({
	findNetworkBoardConfigs: vi.fn(),
	findAllBans: vi.fn(),
	allConsenting: vi.fn(),
	ratingsOf: vi.fn(),
}));

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findNetworkBoardConfigs: mocks.findNetworkBoardConfigs } }));
vi.mock("@db/stores/networkBanStore.js", () => ({ networkBanStore: { findAll: mocks.findAllBans } }));
vi.mock("@db/stores/networkConsentStore.js", () => ({ networkConsentStore: { allConsentingUserIds: mocks.allConsenting } }));
vi.mock("@db/stores/playerRatingStore.js", () => ({ playerRatingStore: { findForPlayersInAllGames: mocks.ratingsOf } }));

import { eligibleServers, rankServers, serverBoard, topMeanRating, type EligibleServer, type TagWearer } from "./serverRatings.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";

// ── server ratings (2026-10 item 244 Phase 5b) ─────────────────────────────
// The owner's rule: a server's rating is the mean of the top 5 display ratings among the
// consenting players who wear and show its tag; it is ranked only when it is on the
// network, Discord gives it GUILD_TAGS, and at least 5 such players stand behind it.

const MIN = BOT_CONSTANTS.NETWORK.SERVER_BOARD_MIN_MEMBERS;
const TAGGED = "100000000000000001";
const UNTAGGED = "200000000000000002";
const OFF_NETWORK = "300000000000000003";

const rating = (userId: string, game: string, displayRating: number) => ({ userId, game, displayRating });
const wearersOf = (guildId: string, count: number, prefix = guildId): TagWearer[] =>
	Array.from({ length: count }, (_unused, index) => ({ userId: `${prefix}-${index}`, guildId, tag: "TAG" }));

describe("topMeanRating", () => {
	it("averages the top five and rounds", () => {
		expect(topMeanRating([1000, 1100, 1200, 1300, 1400, 900])).toBe(1200);
		expect(topMeanRating([1001, 1002, 1002, 1002, 1002])).toBe(1002);
	});

	it("gives no rating below five", () => {
		expect(topMeanRating([1500, 1500, 1500, 1500])).toBeNull();
	});
});

describe("rankServers", () => {
	const servers: EligibleServer[] = [
		{ guildId: "s1", name: "First" },
		{ guildId: "s2", name: "Second" },
	];

	it("ranks a server only once five rated wearers stand behind it in the game", () => {
		const wearers = [...wearersOf("s1", MIN), ...wearersOf("s2", MIN - 1)];
		const ratings = wearers.map((wearer) => rating(wearer.userId, "holdem", 1100));
		const rows = rankServers(servers, wearers, ratings, "holdem");
		expect(rows.map((row) => row.guildId)).toEqual(["s1"]);
		expect(rows[0]).toMatchObject({ rating: 1100, members: MIN, tag: "TAG" });
	});

	it("counts only the ratings of players who wear the server's tag", () => {
		const wearers = wearersOf("s1", MIN);
		const ratings = [...wearers.map((wearer) => rating(wearer.userId, "holdem", 1000)), rating("not-a-wearer", "holdem", 2000)];
		expect(rankServers(servers, wearers, ratings, "holdem")[0].rating).toBe(1000);
	});

	it("ranks across every game by the mean of the games a server qualifies in", () => {
		const wearers = wearersOf("s1", MIN);
		const ratings = [
			...wearers.map((wearer) => rating(wearer.userId, "holdem", 1000)),
			...wearers.map((wearer) => rating(wearer.userId, "battleship", 1200)),
			rating(wearers[0].userId, "monopoly", 1600),
		];
		expect(rankServers(servers, wearers, ratings, null)[0]).toMatchObject({ guildId: "s1", rating: 1100, members: MIN });
	});

	it("orders best first", () => {
		const wearers = [...wearersOf("s1", MIN), ...wearersOf("s2", MIN)];
		const ratings = wearers.map((wearer) => rating(wearer.userId, "holdem", wearer.guildId === "s2" ? 1300 : 1100));
		expect(rankServers(servers, wearers, ratings, "holdem").map((row) => row.name)).toEqual(["Second", "First"]);
	});
});

describe("eligibleServers", () => {
	const client = {
		guilds: {
			cache: new Map([
				[TAGGED, { id: TAGGED, name: "Tagged", features: [BOT_CONSTANTS.NETWORK.GUILD_TAGS_FEATURE] }],
				[UNTAGGED, { id: UNTAGGED, name: "Untagged", features: [] }],
				[OFF_NETWORK, { id: OFF_NETWORK, name: "Off", features: [BOT_CONSTANTS.NETWORK.GUILD_TAGS_FEATURE] }],
			]),
		},
	} as unknown as Client;
	const configs = [
		{ guildId: TAGGED, challengeReach: "network" },
		{ guildId: UNTAGGED, challengeReach: "network" },
		{ guildId: OFF_NETWORK, challengeReach: "server" },
	];

	it("keeps only servers on the network that Discord gives server tags", () => {
		expect(eligibleServers(client, configs, () => false)).toEqual([{ guildId: TAGGED, name: "Tagged" }]);
	});

	it("drops a server the owner banned from the network", () => {
		expect(eligibleServers(client, configs, (guildId) => guildId === TAGGED)).toEqual([]);
	});
});

describe("serverBoard", () => {
	type Identity = { identityGuildId: string; identityEnabled: boolean; tag: string } | null;

	function clientWithPlayers(identities: Record<string, Identity>): Client {
		return {
			guilds: { cache: new Map([[TAGGED, { id: TAGGED, name: "Tagged", features: [BOT_CONSTANTS.NETWORK.GUILD_TAGS_FEATURE] }]]) },
			users: {
				cache: new Map(Object.entries(identities).map(([id, identity]) => [id, { id, primaryGuild: identity }])),
				fetch: vi.fn().mockRejectedValue(new Error("unknown")),
			},
		} as unknown as Client;
	}

	const wearing: Identity = { identityGuildId: TAGGED, identityEnabled: true, tag: "TG" };
	const players = Array.from({ length: MIN }, (_unused, index) => `p${index}`);

	beforeEach(() => {
		mocks.findNetworkBoardConfigs.mockResolvedValue([{ guildId: TAGGED, challengeReach: "network" }]);
		mocks.findAllBans.mockResolvedValue([]);
		mocks.allConsenting.mockResolvedValue(players);
		mocks.ratingsOf.mockImplementation(async (ids: string[]) => ids.map((id) => rating(id, "holdem", 1100)));
	});

	it("ranks a tagged network server with five consenting wearers", async () => {
		const client = clientWithPlayers(Object.fromEntries(players.map((id) => [id, wearing])));
		expect(await serverBoard(client, "holdem")).toEqual([{ guildId: TAGGED, name: "Tagged", tag: "TG", rating: 1100, members: MIN }]);
	});

	it("leaves a server off when one of its five hides the tag", async () => {
		const identities: Record<string, Identity> = Object.fromEntries(players.map((id) => [id, wearing]));
		identities[players[0]] = { ...wearing, identityEnabled: false };
		expect(await serverBoard(clientWithPlayers(identities), "holdem")).toEqual([]);
	});

	it("counts only players who accepted the network notice", async () => {
		mocks.allConsenting.mockResolvedValue(players.slice(1));
		expect(await serverBoard(clientWithPlayers(Object.fromEntries(players.map((id) => [id, wearing]))), "holdem")).toEqual([]);
	});

	it("leaves out a player the owner banned from the network", async () => {
		mocks.findAllBans.mockResolvedValue([{ kind: "user", targetId: players[0] }]);
		expect(await serverBoard(clientWithPlayers(Object.fromEntries(players.map((id) => [id, wearing]))), "holdem")).toEqual([]);
	});
});
