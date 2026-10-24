import { describe, it, expect, vi } from "vitest";
import type { Client } from "discord.js";
import { hostDestinationFor, resolveHoldemXpDestination, type XpRoom } from "./networkXp.js";

// ── where a network table's Hold'em XP lands (2026-10 item 244 Phase 5b) ────
// The owner's rule, case by case: a host server player keeps the host server and the
// room's channel; a satellite player earns in the server whose tag they wear when Dero
// is in it (no channel there), else in the server they clicked from, with the
// satellite's channel. The tag is read at the award, from the client's user cache.

const HOST_GUILD = "host-guild";
const SAT_GUILD = "sat-guild";
const TAG_GUILD = "tag-guild";
const REMOTE = "remote-1";
const LOCAL = "local-1";

const room: XpRoom = {
	guildId: HOST_GUILD,
	channelId: "host-ch",
	satellites: [{ guildId: SAT_GUILD, channelId: "sat-ch", userIds: [REMOTE], tableMessageId: null }],
};

type Identity = { identityGuildId: string | null; identityEnabled: boolean | null; tag: string | null } | null;

// A client whose cache holds the remote player with `identity` and which shares `guilds`.
function clientWith(identity: Identity, guilds: string[]): { client: Client; fetchUser: ReturnType<typeof vi.fn> } {
	const fetchUser = vi.fn();
	const users = new Map([[REMOTE, { id: REMOTE, primaryGuild: identity }]]);
	const client = {
		users: { cache: users, fetch: fetchUser },
		guilds: { cache: new Map(guilds.map((id) => [id, { id }])) },
	} as unknown as Client;
	return { client, fetchUser };
}

describe("a host server player", () => {
	it("keeps the host server and the room's channel, answered at once without a lookup", async () => {
		expect(hostDestinationFor(room, LOCAL)).toEqual({ guildId: HOST_GUILD, channelId: "host-ch" });
		const { client, fetchUser } = clientWith(null, []);
		expect(await resolveHoldemXpDestination(client, room, LOCAL)).toEqual({ guildId: HOST_GUILD, channelId: "host-ch" });
		expect(fetchUser).not.toHaveBeenCalled();
	});

	it("answers null for a satellite player, whose tag decides", () => {
		expect(hostDestinationFor(room, REMOTE)).toBeNull();
	});
});

describe("a satellite player", () => {
	it("earns in the server whose tag they wear when Dero is in it, with no table channel there", async () => {
		const { client } = clientWith({ identityGuildId: TAG_GUILD, identityEnabled: true, tag: "ABC" }, [HOST_GUILD, SAT_GUILD, TAG_GUILD]);
		expect(await resolveHoldemXpDestination(client, room, REMOTE)).toEqual({ guildId: TAG_GUILD, channelId: null });
	});

	it("earns in the server they clicked from when Dero is not in their tag's server", async () => {
		const { client } = clientWith({ identityGuildId: TAG_GUILD, identityEnabled: true, tag: "ABC" }, [HOST_GUILD, SAT_GUILD]);
		expect(await resolveHoldemXpDestination(client, room, REMOTE)).toEqual({ guildId: SAT_GUILD, channelId: "sat-ch" });
	});

	it("earns in the server they clicked from when they wear no tag", async () => {
		const { client } = clientWith(null, [HOST_GUILD, SAT_GUILD, TAG_GUILD]);
		expect(await resolveHoldemXpDestination(client, room, REMOTE)).toEqual({ guildId: SAT_GUILD, channelId: "sat-ch" });
	});

	it("earns in the server they clicked from when they hide their tag", async () => {
		const { client } = clientWith({ identityGuildId: TAG_GUILD, identityEnabled: false, tag: "ABC" }, [HOST_GUILD, SAT_GUILD, TAG_GUILD]);
		expect(await resolveHoldemXpDestination(client, room, REMOTE)).toEqual({ guildId: SAT_GUILD, channelId: "sat-ch" });
	});

	it("keeps the satellite's channel when the tag they wear is the satellite's own server", async () => {
		const { client } = clientWith({ identityGuildId: SAT_GUILD, identityEnabled: true, tag: "SAT" }, [HOST_GUILD, SAT_GUILD]);
		expect(await resolveHoldemXpDestination(client, room, REMOTE)).toEqual({ guildId: SAT_GUILD, channelId: "sat-ch" });
	});

	it("reads the tag at the award: a tag changed mid tournament moves the next award", async () => {
		const { client } = clientWith({ identityGuildId: TAG_GUILD, identityEnabled: true, tag: "ABC" }, [HOST_GUILD, SAT_GUILD, TAG_GUILD]);
		expect((await resolveHoldemXpDestination(client, room, REMOTE)).guildId).toBe(TAG_GUILD);
		(client.users.cache.get(REMOTE) as unknown as { primaryGuild: Identity }).primaryGuild = null;
		expect((await resolveHoldemXpDestination(client, room, REMOTE)).guildId).toBe(SAT_GUILD);
	});

	it("asks Discord only for a player the cache does not hold, and a failed read counts as no tag", async () => {
		const { client, fetchUser } = clientWith(null, [HOST_GUILD, SAT_GUILD]);
		(client.users.cache as unknown as Map<string, unknown>).delete(REMOTE);
		fetchUser.mockRejectedValue(new Error("unknown user"));
		expect(await resolveHoldemXpDestination(client, room, REMOTE)).toEqual({ guildId: SAT_GUILD, channelId: "sat-ch" });
		expect(fetchUser).toHaveBeenCalledWith(REMOTE);
	});
});
