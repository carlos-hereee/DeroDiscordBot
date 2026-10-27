import { describe, it, expect, vi } from "vitest";
import { PermissionFlagsBits, TextChannel, type CategoryChannel, type Guild } from "discord.js";
import { canManageChannels, moveIntoHeadquarters } from "./headquarters.js";

const BOT_ID = "bot-1";
const OWNER_ID = "owner-1";
const HEADQUARTERS_ID = "hq-1";
const ROLES = { memberRoleId: null, adminRoleId: "role-admin" };

function makeGuild(permissions: bigint[] | null): Guild {
	return {
		id: "guild-1",
		ownerId: OWNER_ID,
		roles: { everyone: { id: "everyone" } },
		client: { user: { id: BOT_ID } },
		members: { me: permissions === null ? null : { permissions: { has: (bit: bigint) => permissions.includes(bit) } } },
	} as unknown as Guild;
}

function makeChannel(parentId: string) {
	const channel = Object.create(TextChannel.prototype) as TextChannel;
	const cache = new Map<string, { id: string }>([
		["everyone", { id: "everyone" }],
		["role-custom", { id: "role-custom" }],
	]);
	const setParent = vi.fn(async () => channel);
	const set = vi.fn(async () => channel);
	Object.assign(channel, { id: "ch-admin", parentId, setParent, permissionOverwrites: { cache, set } });
	return { channel, setParent, set };
}

const headquarters = { id: HEADQUARTERS_ID } as unknown as CategoryChannel;

describe("moveIntoHeadquarters", () => {
	it("moves the channel without syncing it to the category, then re-applies its spec's overwrites", async () => {
		const { channel, setParent, set } = makeChannel("cat-1");

		expect(await moveIntoHeadquarters(makeGuild([]), channel, headquarters, "admin", ROLES)).toBe(true);

		expect(setParent).toHaveBeenCalledExactlyOnceWith(HEADQUARTERS_ID, { lockPermissions: false });
		const written = set.mock.calls[0][0] as unknown as Array<{ id: string; deny?: bigint[] }>;
		expect(written.find((entry) => entry.id === "everyone")?.deny).toEqual([PermissionFlagsBits.ViewChannel]);
		expect(written.map((entry) => entry.id)).toEqual(expect.arrayContaining([BOT_ID, OWNER_ID, "role-admin", "role-custom"]));
	});

	it("writes nothing when the channel is already in Headquarters", async () => {
		const { channel, setParent, set } = makeChannel(HEADQUARTERS_ID);

		expect(await moveIntoHeadquarters(makeGuild([]), channel, headquarters, "admin", ROLES)).toBe(false);

		expect(setParent).not.toHaveBeenCalled();
		expect(set).not.toHaveBeenCalled();
	});
});

describe("canManageChannels", () => {
	it("reads the bot's own guild permission", () => {
		expect(canManageChannels(makeGuild([PermissionFlagsBits.ManageChannels]))).toBe(true);
		expect(canManageChannels(makeGuild([]))).toBe(false);
	});

	it("reads an uncached bot member as not known to have it", () => {
		expect(canManageChannels(makeGuild(null))).toBe(false);
	});
});
