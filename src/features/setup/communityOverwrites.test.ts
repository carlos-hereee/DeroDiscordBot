import { describe, it, expect, vi, beforeEach } from "vitest";
import { TextChannel, VoiceChannel, ChannelType, PermissionFlagsBits, PermissionsBitField } from "discord.js";
import type { CategoryChannel, Client, Guild } from "discord.js";

// The store chain opens a real Mongoose connection at import time otherwise, and a
// buffered query against no connection hangs the run instead of failing it.
vi.mock("@db/stores/guildConfigStore.js", () => ({
	guildConfigStore: {
		findByGuildId: vi.fn(),
		create: vi.fn(),
		update: vi.fn(),
		deleteByGuildId: vi.fn(),
	},
}));
// The announcement has its own test file; here only WHETHER the boot sweep hands a
// guild to it matters.
vi.mock("./CommunityGatingAnnouncement.js", () => ({
	CommunityGatingAnnouncement: { post: vi.fn() },
}));

import { GuildSetupManager } from "./GuildSetupManager.js";
import { CommunityGatingAnnouncement } from "./CommunityGatingAnnouncement.js";
import {
	communityOverwritesFor,
	isMemberRoleGated,
	memberRoleGrant,
	overwriteKindOf,
	reconcileChannelOverwrite,
	type IOverwriteEntry,
	type ManagedOverwriteKind,
} from "./communityOverwrites.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { buildBotSelfOverwrite } from "@utils/channelOverwrites.js";

const guildConfigMock = guildConfigStore as unknown as {
	findByGuildId: ReturnType<typeof vi.fn>;
	create: ReturnType<typeof vi.fn>;
	update: ReturnType<typeof vi.fn>;
};
const announcementMock = CommunityGatingAnnouncement as unknown as { post: ReturnType<typeof vi.fn> };

// ── fixtures ──────────────────────────────────────────────────────────

const EVERYONE_ID = "everyone";
const OWNER_ID = "owner-1";
const BOT_ID = "bot-1";
const MEMBER_ROLE_ID = "role-member";
const ADMIN_ROLE_ID = "role-admin";

const { ViewChannel, SendMessages, ReadMessageHistory, Connect, Speak } = PermissionFlagsBits;
const JOIN_AND_SPEAK = [ViewChannel, Connect, Speak];

interface IOverwrite {
	id: string;
	allow?: bigint[];
	deny?: bigint[];
}
interface ICreateCall {
	name: string;
	type: number;
	parent?: string;
	permissionOverwrites?: IOverwrite[];
}

// ── TODAY: the non-Community shapes, written out by hand ──────────────────
// What:  every overwrite array GuildSetupManager produced on a non-Community
//        guild BEFORE the Community branch existed, copied out of the code
//        that built them as literal values rather than derived from anything.
// Why:   the Community branch must leave a non-Community guild byte for byte
//        where it was. A test that derives its expectation from the helper under
//        test would move with the helper; this table cannot, so a regression on
//        a non-Community guild fails here loudly. Order is part of the snapshot.
const BOT = buildBotSelfOverwrite(BOT_ID);
const TODAY = {
	public: [{ id: EVERYONE_ID, allow: [ViewChannel], deny: [SendMessages] }, BOT, { id: OWNER_ID, allow: [ViewChannel, SendMessages] }],
	intro: [{ id: EVERYONE_ID, allow: [ViewChannel, SendMessages] }, BOT, { id: OWNER_ID, allow: [ViewChannel, SendMessages] }],
	admin: [{ id: EVERYONE_ID, deny: [ViewChannel] }, BOT, { id: OWNER_ID, allow: [ViewChannel, SendMessages, ReadMessageHistory] }],
	// 🗒️admin-log (post-launch plan item 11): the one bot write only channel. Not a
	// pre-Community shape, it is new, but it reads the same on both branches.
	adminLog: [
		{ id: EVERYONE_ID, deny: [ViewChannel, SendMessages] },
		BOT,
		{ id: OWNER_ID, allow: [ViewChannel, ReadMessageHistory], deny: [SendMessages] },
	],
	voice: [
		{ id: EVERYONE_ID, allow: [ViewChannel], deny: [Connect, Speak] },
		{ id: BOT_ID, allow: [...BOT.allow, Connect, Speak] },
		{ id: OWNER_ID, allow: JOIN_AND_SPEAK },
	],
	// 💬dero-commands (2026-10 item 257 Phase 2a): new, not a pre-Community shape. On
	// a non-Community guild it reads exactly like introductions, members read and send.
	commandOutput: [{ id: EVERYONE_ID, allow: [ViewChannel, SendMessages] }, BOT, { id: OWNER_ID, allow: [ViewChannel, SendMessages] }],
	// The grants layered on top once /setup has named the roles.
	voiceMemberGrant: { id: MEMBER_ROLE_ID, allow: JOIN_AND_SPEAK },
	voiceAdminGrant: { id: ADMIN_ROLE_ID, allow: [...JOIN_AND_SPEAK, SendMessages] },
	publicAdminGrant: { id: ADMIN_ROLE_ID, allow: [ViewChannel, SendMessages] },
	adminAdminGrant: { id: ADMIN_ROLE_ID, allow: [ViewChannel, SendMessages, ReadMessageHistory] },
	adminLogAdminGrant: { id: ADMIN_ROLE_ID, allow: [ViewChannel, ReadMessageHistory], deny: [SendMessages] },
} as const;

// A created channel of the real class for its type, so every instanceof check in
// the unit under test sees what production would.
function makeCreatedChannel(opts: { name: string; type: number }): unknown {
	if (opts.type === ChannelType.GuildCategory) {
		return { id: `cat-${opts.name}`, type: ChannelType.GuildCategory, children: { cache: { find: () => undefined } } };
	}
	const prototype = opts.type === ChannelType.GuildVoice ? VoiceChannel.prototype : TextChannel.prototype;
	const created = Object.create(prototype) as Record<string, unknown>;
	Object.assign(created, {
		id: `new-${opts.name}`,
		name: opts.name,
		guildId: "guild-1",
		send: vi.fn().mockResolvedValue({ id: `msg-${opts.name}`, pin: vi.fn().mockResolvedValue(undefined) }),
		messages: { fetch: vi.fn().mockResolvedValue(null) },
	});
	return created;
}

function makeGuild(features: string[] = []): Guild & { channels: { create: ReturnType<typeof vi.fn> } } {
	const create = vi.fn(async (opts: { name: string; type: number }) => makeCreatedChannel(opts));
	return {
		id: "guild-1",
		ownerId: OWNER_ID,
		features,
		roles: { everyone: { id: EVERYONE_ID } },
		client: { user: { id: BOT_ID } },
		channels: { create, fetch: vi.fn().mockResolvedValue(null) },
	} as unknown as Guild & { channels: { create: ReturnType<typeof vi.fn> } };
}

function makeStored(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		guildId: "guild-1",
		categoryId: "cat-1",
		gamesCategoryId: "games-cat-1",
		introMessageIds: {},
		adminRoleId: null,
		memberRoleId: null,
		...overrides,
	};
}

// The full build's row, see "a full build builds every managed channel" below.
const FULL_BUILD_ROW = { guildId: "guild-1", categoryId: "deleted-notice-board", setupComplete: true };

function createCalls(guild: { channels: { create: ReturnType<typeof vi.fn> } }): ICreateCall[] {
	return guild.channels.create.mock.calls.map((call) => call[0] as ICreateCall);
}

const packNamesByField = Object.fromEntries(GuildSetupManager.CHANNEL_SPECS.map((spec) => [spec.configField, spec.displayName]));

// The shape TODAY gives each managed channel at create time, by its config field.
function todayCreateShape(field: string): readonly IOverwrite[] {
	if (field === "introChannelId") return TODAY.intro;
	if (field === "commandOutputChannelId") return TODAY.commandOutput;
	const spec = GuildSetupManager.CHANNEL_SPECS.find((entry) => entry.configField === field)!;
	if (spec.kind === "admin") return TODAY.admin;
	if (spec.kind === "adminLog") return TODAY.adminLog;
	if (spec.kind === "voice") return TODAY.voice;
	return TODAY.public;
}

// ── the non-Community snapshot ─────────────────────────────────────────

describe("non-Community guilds keep today's overwrite shapes byte for byte", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		guildConfigMock.create.mockResolvedValue(undefined);
		guildConfigMock.update.mockResolvedValue(undefined);
	});

	// A fresh install builds only 🏰 DERO HEADQUARTERS (2026-11 item 285 Phase 2), so every
	// managed channel is built by the full build that remains: the /setup that rebuilds a
	// self destructed server, a row with no managed id and no role, built with force.
	it("a full build builds every managed channel with today's array", async () => {
		guildConfigMock.findByGuildId.mockResolvedValue(FULL_BUILD_ROW);
		const guild = makeGuild();

		await GuildSetupManager.autoSetup(guild, { guildId: "guild-1", ownerId: OWNER_ID }, { force: true });

		const calls = createCalls(guild);
		for (const spec of GuildSetupManager.CHANNEL_SPECS) {
			const call = calls.find((entry) => entry.name === packNamesByField[spec.configField]);
			expect(call, `${spec.configField} was never created`).toBeDefined();
			expect(call!.permissionOverwrites, spec.configField).toEqual(todayCreateShape(spec.configField));
		}
	});

	it("a forced rebuild of a set up guild grants the stored roles on the voice rooms only", async () => {
		guildConfigMock.findByGuildId.mockResolvedValue(makeStored({ memberRoleId: MEMBER_ROLE_ID, adminRoleId: ADMIN_ROLE_ID }));
		const guild = makeGuild();

		await GuildSetupManager.autoSetup(guild, { guildId: "guild-1", ownerId: OWNER_ID }, { force: true });

		const calls = createCalls(guild);
		for (const spec of GuildSetupManager.CHANNEL_SPECS) {
			const call = calls.find((entry) => entry.name === packNamesByField[spec.configField]);
			const expected =
				spec.kind === "voice" ? [...TODAY.voice, TODAY.voiceMemberGrant, TODAY.voiceAdminGrant] : todayCreateShape(spec.configField);
			expect(call!.permissionOverwrites, spec.configField).toEqual(expected);
		}
	});

	describe("the repair path (repairOneChannel, the boot sweep and the delete watcher)", () => {
		async function repair(field: string, roles: { adminRoleId: string | null; memberRoleId: string | null }): Promise<IOverwrite[]> {
			const guild = makeGuild();
			const spec = GuildSetupManager.CHANNEL_SPECS.find((entry) => entry.configField === field)!;
			const category = { id: "cat-1", children: { cache: { find: () => undefined } } } as unknown as CategoryChannel;
			await GuildSetupManager.repairOneChannel(guild, category, spec, makeStored(roles));
			return createCalls(guild)[0].permissionOverwrites ?? [];
		}

		it.each(GuildSetupManager.CHANNEL_SPECS.map((spec) => spec.configField))("%s before /setup", async (field) => {
			const spec = GuildSetupManager.CHANNEL_SPECS.find((entry) => entry.configField === field)!;
			const overwrites = await repair(field, { adminRoleId: null, memberRoleId: null });
			// A repaired channel gets its create-time shape, the introductions channel
			// included: it is the one channel members may write in.
			expect(overwrites).toEqual(spec.kind === "voice" ? TODAY.voice : todayCreateShape(field));
		});

		it.each(GuildSetupManager.CHANNEL_SPECS.map((spec) => spec.configField))("%s after /setup", async (field) => {
			const spec = GuildSetupManager.CHANNEL_SPECS.find((entry) => entry.configField === field)!;
			const overwrites = await repair(field, { adminRoleId: ADMIN_ROLE_ID, memberRoleId: MEMBER_ROLE_ID });
			const expected = {
				voice: [...TODAY.voice, TODAY.voiceMemberGrant, TODAY.voiceAdminGrant],
				admin: [...TODAY.admin, TODAY.adminAdminGrant],
				adminLog: [...TODAY.adminLog, TODAY.adminLogAdminGrant],
				public: [...todayCreateShape(field), TODAY.publicAdminGrant],
			}[spec.kind];
			expect(overwrites).toEqual(expected);
		});
	});

	it("/setup grants the member role on the voice rooms and nowhere else", async () => {
		guildConfigMock.findByGuildId.mockResolvedValue(
			makeStored(Object.fromEntries(GuildSetupManager.CHANNEL_SPECS.map((spec) => [spec.configField, `ch-${spec.configField}`])))
		);
		const grants: Record<string, Array<[string, Record<string, boolean>]>> = {};
		const guild = {
			id: "guild-1",
			ownerId: OWNER_ID,
			features: [],
			roles: { everyone: { id: EVERYONE_ID } },
			channels: {
				fetch: vi.fn(async (id: string) => ({
					id,
					isTextBased: () => false,
					permissionOverwrites: {
						create: vi.fn(async (roleId: string, perms: Record<string, boolean>) => {
							(grants[id] ??= []).push([roleId, perms]);
						}),
					},
				})),
			},
		} as unknown as Guild;

		await GuildSetupManager.applyAdminRole(guild, { guildId: "guild-1", ownerId: OWNER_ID, adminRoleId: ADMIN_ROLE_ID, memberRoleId: MEMBER_ROLE_ID });

		for (const spec of GuildSetupManager.CHANNEL_SPECS) {
			const expected: Array<[string, Record<string, boolean>]> = {
				voice: [
					[MEMBER_ROLE_ID, { ViewChannel: true, Connect: true, Speak: true }],
					[ADMIN_ROLE_ID, { ViewChannel: true, Connect: true, Speak: true, SendMessages: true }],
				] as Array<[string, Record<string, boolean>]>,
				admin: [[ADMIN_ROLE_ID, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }]] as Array<[string, Record<string, boolean>]>,
				adminLog: [[ADMIN_ROLE_ID, { ViewChannel: true, ReadMessageHistory: true, SendMessages: false }]] as Array<[string, Record<string, boolean>]>,
				public: [[ADMIN_ROLE_ID, { ViewChannel: true, SendMessages: true }]] as Array<[string, Record<string, boolean>]>,
			}[spec.kind];
			expect(grants[`ch-${spec.configField}`], spec.configField).toEqual(expected);
		}
	});
});

// ── the Community branch ───────────────────────────────────────────────

const COMMUNITY = ["COMMUNITY"];
const OWNER = { ownerId: OWNER_ID };
const SET_UP = { memberRoleId: MEMBER_ROLE_ID, adminRoleId: ADMIN_ROLE_ID };
const NO_ROLES = { memberRoleId: null, adminRoleId: null };
const KINDS: ManagedOverwriteKind[] = ["public", "intro", "admin", "voice", "commandOutput"];

const GATED = {
	public: [
		{ id: EVERYONE_ID, deny: [ViewChannel, SendMessages] },
		BOT,
		{ id: OWNER_ID, allow: [ViewChannel, SendMessages] },
		{ id: MEMBER_ROLE_ID, allow: [ViewChannel] },
		TODAY.publicAdminGrant,
	],
	voice: [
		{ id: EVERYONE_ID, deny: [ViewChannel, Connect, Speak] },
		{ id: BOT_ID, allow: [...BOT.allow, Connect, Speak] },
		{ id: OWNER_ID, allow: JOIN_AND_SPEAK },
		TODAY.voiceMemberGrant,
		TODAY.voiceAdminGrant,
	],
	// 💬dero-commands gated: hidden from @everyone, and the member role reads AND sends,
	// because members run their commands there.
	commandOutput: [
		{ id: EVERYONE_ID, deny: [ViewChannel] },
		BOT,
		{ id: OWNER_ID, allow: [ViewChannel, SendMessages] },
		{ id: MEMBER_ROLE_ID, allow: [ViewChannel, SendMessages] },
		TODAY.publicAdminGrant,
	],
} as const;

describe("communityOverwritesFor", () => {
	it("gates the public text channels and the voice rooms on a Community guild with a member role", () => {
		const guild = makeGuild(COMMUNITY);
		expect(communityOverwritesFor("public", guild, OWNER, SET_UP)).toEqual(GATED.public);
		expect(communityOverwritesFor("voice", guild, OWNER, SET_UP)).toEqual(GATED.voice);
	});

	it("keeps the SendMessages deny on a gated public channel, so members stay read only", () => {
		const shape = communityOverwritesFor("public", makeGuild(COMMUNITY), OWNER, SET_UP);
		expect(shape.find((entry) => entry.id === EVERYONE_ID)?.deny).toContain(SendMessages);
		expect(shape.find((entry) => entry.id === MEMBER_ROLE_ID)?.allow).toEqual([ViewChannel]);
	});

	it("leaves introductions and the admin channels the same on both branches", () => {
		for (const kind of ["intro", "admin"] as const) {
			expect(communityOverwritesFor(kind, makeGuild(COMMUNITY), OWNER, SET_UP), kind).toEqual(communityOverwritesFor(kind, makeGuild(), OWNER, SET_UP));
		}
		expect(communityOverwritesFor("intro", makeGuild(COMMUNITY), OWNER, NO_ROLES)).toEqual(TODAY.intro);
		expect(communityOverwritesFor("admin", makeGuild(COMMUNITY), OWNER, NO_ROLES)).toEqual(TODAY.admin);
	});

	it("gives a non-Community guild today's shapes for every kind", () => {
		const guild = makeGuild();
		expect(communityOverwritesFor("public", guild, OWNER, NO_ROLES)).toEqual(TODAY.public);
		expect(communityOverwritesFor("intro", guild, OWNER, NO_ROLES)).toEqual(TODAY.intro);
		expect(communityOverwritesFor("admin", guild, OWNER, NO_ROLES)).toEqual(TODAY.admin);
		expect(communityOverwritesFor("voice", guild, OWNER, NO_ROLES)).toEqual(TODAY.voice);
		// The member role never reaches a text channel off the Community branch.
		expect(communityOverwritesFor("public", guild, OWNER, SET_UP)).toEqual([...TODAY.public, TODAY.publicAdminGrant]);
	});

	it("keeps the open shape on a Community guild until /setup names a member role", () => {
		// Gating with no role would leave nobody able to see in.
		const guild = makeGuild(COMMUNITY);
		expect(isMemberRoleGated(guild, null)).toBe(false);
		expect(communityOverwritesFor("public", guild, OWNER, NO_ROLES)).toEqual(TODAY.public);
		expect(communityOverwritesFor("voice", guild, OWNER, NO_ROLES)).toEqual(TODAY.voice);
	});

	it("keeps the open shape when the member role IS @everyone, with one @everyone entry", () => {
		const guild = makeGuild(COMMUNITY);
		const roles = { memberRoleId: EVERYONE_ID, adminRoleId: null };
		expect(isMemberRoleGated(guild, EVERYONE_ID)).toBe(false);
		expect(communityOverwritesFor("public", guild, OWNER, roles)).toEqual(TODAY.public);
		const voiceEveryone = communityOverwritesFor("voice", guild, OWNER, roles).filter((entry) => entry.id === EVERYONE_ID);
		expect(voiceEveryone).toEqual([{ id: EVERYONE_ID, allow: JOIN_AND_SPEAK }]);
	});

	it("reads the branch live, so a guild that switches Community on gets the gate on the next call", () => {
		const guild = makeGuild();
		expect(communityOverwritesFor("public", guild, OWNER, SET_UP)[0]).toEqual(TODAY.public[0]);
		(guild as unknown as { features: string[] }).features = COMMUNITY;
		expect(communityOverwritesFor("public", guild, OWNER, SET_UP)[0]).toEqual(GATED.public[0]);
	});

	it("carries the bot self overwrite in every shape on both branches", () => {
		for (const features of [[], COMMUNITY]) {
			for (const kind of KINDS) {
				const bot = communityOverwritesFor(kind, makeGuild(features), OWNER, SET_UP).find((entry) => entry.id === BOT_ID);
				expect(bot?.allow, `${kind} ${features.join() || "non-Community"}`).toEqual(expect.arrayContaining(BOT.allow));
			}
		}
	});

	it("gives introductions and 💬dero-commands their own kinds, every other spec its own", () => {
		const ownKinds: Record<string, ManagedOverwriteKind> = { introChannelId: "intro", commandOutputChannelId: "commandOutput" };
		for (const spec of GuildSetupManager.CHANNEL_SPECS) {
			expect(overwriteKindOf(spec), spec.configField).toBe(ownKinds[spec.configField] ?? spec.kind);
		}
	});

	it("gates 💬dero-commands like a public channel, but members still send there", () => {
		expect(communityOverwritesFor("commandOutput", makeGuild(COMMUNITY), OWNER, SET_UP)).toEqual(GATED.commandOutput);
		expect(communityOverwritesFor("commandOutput", makeGuild(), OWNER, NO_ROLES)).toEqual(TODAY.commandOutput);
	});
});

describe("memberRoleGrant", () => {
	it("grants the voice rooms on both branches and a public text channel only while gated", () => {
		expect(memberRoleGrant(makeGuild(), "voice", MEMBER_ROLE_ID)).toEqual({ ViewChannel: true, Connect: true, Speak: true });
		expect(memberRoleGrant(makeGuild(COMMUNITY), "voice", MEMBER_ROLE_ID)).toEqual({ ViewChannel: true, Connect: true, Speak: true });
		expect(memberRoleGrant(makeGuild(COMMUNITY), "public", MEMBER_ROLE_ID)).toEqual({ ViewChannel: true });
		expect(memberRoleGrant(makeGuild(), "public", MEMBER_ROLE_ID)).toBeNull();
		expect(memberRoleGrant(makeGuild(COMMUNITY), "intro", MEMBER_ROLE_ID)).toBeNull();
		expect(memberRoleGrant(makeGuild(COMMUNITY), "admin", MEMBER_ROLE_ID)).toBeNull();
	});
});

// ── the reconcile ──────────────────────────────────────────────────────

interface IFakeOverwrite {
	id: string;
	allow: PermissionsBitField;
	deny: PermissionsBitField;
}

function toFake(entry: IOverwriteEntry | IFakeOverwrite): IFakeOverwrite {
	if (entry.allow instanceof PermissionsBitField) return entry as IFakeOverwrite;
	const plain = entry as IOverwriteEntry;
	return { id: plain.id, allow: new PermissionsBitField(plain.allow ?? []), deny: new PermissionsBitField(plain.deny ?? []) };
}

// A real TextChannel or VoiceChannel instance whose overwrite cache set() rewrites,
// the way discord.js refreshes the cache from the API's answer.
function makeManagedChannel(kind: "text" | "voice", overwrites: ReadonlyArray<IOverwriteEntry>) {
	const channel = Object.create(kind === "voice" ? VoiceChannel.prototype : TextChannel.prototype) as TextChannel;
	const cache = new Map<string, IFakeOverwrite>(overwrites.map((entry) => [entry.id, toFake(entry)]));
	const set = vi.fn(async (next: Array<IOverwriteEntry | IFakeOverwrite>) => {
		cache.clear();
		for (const entry of next) cache.set(entry.id, toFake(entry));
		return channel;
	});
	Object.assign(channel, { id: `ch-${kind}`, permissionOverwrites: { cache, set } });
	return { channel, cache, set };
}

// Overwrites as raw bitfields, so a cache and a shape compare by what Discord stores.
function bitsOf(entries: Iterable<IOverwriteEntry | IFakeOverwrite>): Array<{ id: string; allow: bigint; deny: bigint }> {
	return [...entries].map(toFake).map((entry) => ({ id: entry.id, allow: entry.allow.bitfield, deny: entry.deny.bitfield }));
}

describe("reconcileChannelOverwrite", () => {
	const SET_UP_ROW = { memberRoleId: MEMBER_ROLE_ID, adminRoleId: ADMIN_ROLE_ID };

	it("gates a public channel once: two calls, one write", async () => {
		const guild = makeGuild(COMMUNITY);
		const { channel, cache, set } = makeManagedChannel("text", [...TODAY.public, TODAY.publicAdminGrant]);

		expect(await reconcileChannelOverwrite(guild, channel, "public", SET_UP_ROW)).toBe(true);
		expect(await reconcileChannelOverwrite(guild, channel, "public", SET_UP_ROW)).toBe(false);

		expect(set).toHaveBeenCalledOnce();
		expect(bitsOf(cache.values())).toEqual(bitsOf(GATED.public));
	});

	it("gates a voice room once", async () => {
		const guild = makeGuild(COMMUNITY);
		const { channel, cache, set } = makeManagedChannel("voice", [...TODAY.voice, TODAY.voiceMemberGrant, TODAY.voiceAdminGrant]);

		expect(await reconcileChannelOverwrite(guild, channel, "voice", SET_UP_ROW)).toBe(true);
		expect(await reconcileChannelOverwrite(guild, channel, "voice", SET_UP_ROW)).toBe(false);

		expect(set).toHaveBeenCalledOnce();
		expect(bitsOf(cache.values())).toEqual(bitsOf(GATED.voice));
	});

	it("writes nothing on a non-Community guild already on today's shape", async () => {
		const guild = makeGuild();
		const text = makeManagedChannel("text", [...TODAY.public, TODAY.publicAdminGrant]);
		const voice = makeManagedChannel("voice", [...TODAY.voice, TODAY.voiceMemberGrant, TODAY.voiceAdminGrant]);

		expect(await reconcileChannelOverwrite(guild, text.channel, "public", SET_UP_ROW)).toBe(false);
		expect(await reconcileChannelOverwrite(guild, voice.channel, "voice", SET_UP_ROW)).toBe(false);
		expect(text.set).not.toHaveBeenCalled();
		expect(voice.set).not.toHaveBeenCalled();
	});

	it("leaves an owner's hand tuning alone while the channel is on its side of the branch", async () => {
		// A full comparison would revert this on every boot; the branch only moves a
		// channel whose gate is wrong.
		const tuned = [{ id: EVERYONE_ID, allow: [ViewChannel, SendMessages] }, BOT, { id: OWNER_ID, allow: [ViewChannel, SendMessages] }];
		const { channel, set } = makeManagedChannel("text", tuned);

		expect(await reconcileChannelOverwrite(makeGuild(), channel, "public", SET_UP_ROW)).toBe(false);
		expect(set).not.toHaveBeenCalled();
	});

	it("opens a gated channel again when the guild leaves Community", async () => {
		const { channel, cache, set } = makeManagedChannel("text", GATED.public);

		expect(await reconcileChannelOverwrite(makeGuild(), channel, "public", SET_UP_ROW)).toBe(true);

		expect(set).toHaveBeenCalledOnce();
		expect(cache.get(EVERYONE_ID)?.allow.has(ViewChannel)).toBe(true);
		expect(cache.get(EVERYONE_ID)?.deny.has(SendMessages)).toBe(true);
	});

	it("carries every overwrite Dero does not manage across the write", async () => {
		const custom = { id: "role-custom", allow: [PermissionFlagsBits.AddReactions], deny: [PermissionFlagsBits.AttachFiles] };
		const { channel, cache } = makeManagedChannel("text", [...TODAY.public, custom]);

		await reconcileChannelOverwrite(makeGuild(COMMUNITY), channel, "public", SET_UP_ROW);

		expect(cache.get("role-custom")?.allow.bitfield).toBe(PermissionFlagsBits.AddReactions);
		expect(cache.get("role-custom")?.deny.bitfield).toBe(PermissionFlagsBits.AttachFiles);
	});

	it("never touches introductions or the admin channels", async () => {
		const intro = makeManagedChannel("text", TODAY.intro);
		const admin = makeManagedChannel("text", TODAY.admin);

		expect(await reconcileChannelOverwrite(makeGuild(COMMUNITY), intro.channel, "intro", SET_UP_ROW)).toBe(false);
		expect(await reconcileChannelOverwrite(makeGuild(COMMUNITY), admin.channel, "admin", SET_UP_ROW)).toBe(false);
		expect(intro.set).not.toHaveBeenCalled();
		expect(admin.set).not.toHaveBeenCalled();
	});

	it("does not gate a Community guild with no member role yet", async () => {
		const { channel, set } = makeManagedChannel("text", TODAY.public);
		expect(await reconcileChannelOverwrite(makeGuild(COMMUNITY), channel, "public", NO_ROLES)).toBe(false);
		expect(set).not.toHaveBeenCalled();
	});
});

// ── the call sites on a Community guild ─────────────────────────────────

describe("GuildSetupManager on a Community guild", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		guildConfigMock.create.mockResolvedValue(undefined);
		guildConfigMock.update.mockResolvedValue(undefined);
	});

	it("a full build before /setup stays open: no member role exists yet", async () => {
		guildConfigMock.findByGuildId.mockResolvedValue(FULL_BUILD_ROW);
		const guild = makeGuild(COMMUNITY);

		await GuildSetupManager.autoSetup(guild, { guildId: "guild-1", ownerId: OWNER_ID }, { force: true });

		for (const spec of GuildSetupManager.CHANNEL_SPECS) {
			const call = createCalls(guild).find((entry) => entry.name === packNamesByField[spec.configField]);
			expect(call!.permissionOverwrites, spec.configField).toEqual(todayCreateShape(spec.configField));
		}
	});

	it("a forced rebuild after /setup builds the gate in, member role on, admin role on voice only", async () => {
		guildConfigMock.findByGuildId.mockResolvedValue(makeStored(SET_UP));
		const guild = makeGuild(COMMUNITY);

		await GuildSetupManager.autoSetup(guild, { guildId: "guild-1", ownerId: OWNER_ID }, { force: true });

		const calls = createCalls(guild);
		const gatedPublicWithoutAdmin = GATED.public.filter((entry) => entry.id !== ADMIN_ROLE_ID);
		const expectedByKind: Record<ManagedOverwriteKind, readonly IOverwriteEntry[]> = {
			intro: TODAY.intro,
			admin: TODAY.admin,
			adminLog: TODAY.adminLog,
			public: gatedPublicWithoutAdmin,
			voice: GATED.voice,
			commandOutput: GATED.commandOutput.filter((entry) => entry.id !== ADMIN_ROLE_ID),
		};
		for (const spec of GuildSetupManager.CHANNEL_SPECS) {
			const call = calls.find((entry) => entry.name === packNamesByField[spec.configField]);
			expect(call!.permissionOverwrites, spec.configField).toEqual(expectedByKind[overwriteKindOf(spec)]);
		}
	});

	it("a repair after /setup builds the gate in, admin role included", async () => {
		const guild = makeGuild(COMMUNITY);
		const category = { id: "cat-1", children: { cache: { find: () => undefined } } } as unknown as CategoryChannel;
		const expectedByField: Record<string, readonly IOverwriteEntry[]> = {
			commandsChannelId: GATED.public,
			introChannelId: [...TODAY.intro, TODAY.publicAdminGrant],
			meetingVoiceChannelId: GATED.voice,
		};
		for (const [field, expected] of Object.entries(expectedByField)) {
			guild.channels.create.mockClear();
			const spec = GuildSetupManager.CHANNEL_SPECS.find((entry) => entry.configField === field)!;
			await GuildSetupManager.repairOneChannel(guild, category, spec, makeStored(SET_UP));
			expect(createCalls(guild)[0].permissionOverwrites, field).toEqual(expected);
		}
	});

	it("/setup adds the member role's ViewChannel on the public text channels, then the admin grant as before", async () => {
		guildConfigMock.findByGuildId.mockResolvedValue(
			makeStored(Object.fromEntries(GuildSetupManager.CHANNEL_SPECS.map((spec) => [spec.configField, `ch-${spec.configField}`])))
		);
		const grants: Record<string, Array<[string, Record<string, boolean>]>> = {};
		const recordGrant = (id: string) => async (roleId: string, perms: Record<string, boolean>) => {
			(grants[id] ??= []).push([roleId, perms]);
		};
		const guild = {
			id: "guild-1",
			ownerId: OWNER_ID,
			features: COMMUNITY,
			roles: { everyone: { id: EVERYONE_ID } },
			channels: {
				fetch: vi.fn(async (id: string) => ({ id, isTextBased: () => false, permissionOverwrites: { create: vi.fn(recordGrant(id)) } })),
			},
		} as unknown as Guild;

		await GuildSetupManager.applyAdminRole(guild, { guildId: "guild-1", ownerId: OWNER_ID, ...SET_UP });

		const expectedByKind: Record<ManagedOverwriteKind, Array<[string, Record<string, boolean>]>> = {
			public: [
				[MEMBER_ROLE_ID, { ViewChannel: true }],
				[ADMIN_ROLE_ID, { ViewChannel: true, SendMessages: true }],
			],
			intro: [[ADMIN_ROLE_ID, { ViewChannel: true, SendMessages: true }]],
			admin: [[ADMIN_ROLE_ID, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }]],
			adminLog: [[ADMIN_ROLE_ID, { ViewChannel: true, ReadMessageHistory: true, SendMessages: false }]],
			voice: [
				[MEMBER_ROLE_ID, { ViewChannel: true, Connect: true, Speak: true }],
				[ADMIN_ROLE_ID, { ViewChannel: true, Connect: true, Speak: true, SendMessages: true }],
			],
			commandOutput: [
				[MEMBER_ROLE_ID, { ViewChannel: true, SendMessages: true }],
				[ADMIN_ROLE_ID, { ViewChannel: true, SendMessages: true }],
			],
		};
		for (const spec of GuildSetupManager.CHANNEL_SPECS) {
			expect(grants[`ch-${spec.configField}`], spec.configField).toEqual(expectedByKind[overwriteKindOf(spec)]);
		}
	});
});

// ── the boot sweep ─────────────────────────────────────────────────────

describe("ensureHomebase reconciles the gate and hands the guild to the announcement", () => {
	const STARTING_SHAPE: Record<ManagedOverwriteKind, readonly IOverwriteEntry[]> = {
		public: [...TODAY.public, TODAY.publicAdminGrant],
		intro: TODAY.intro,
		admin: TODAY.admin,
		adminLog: [...TODAY.adminLog, TODAY.adminLogAdminGrant],
		voice: TODAY.voice,
		commandOutput: [...TODAY.commandOutput, TODAY.publicAdminGrant],
	};

	function makeBootWorld(features: string[], memberRoleId: string | null) {
		const stored = makeStored({
			...Object.fromEntries(GuildSetupManager.CHANNEL_SPECS.map((spec) => [spec.configField, `ch-${spec.configField}`])),
			// No schedule anchor, so the ownership probe reads "unknown" and the sweep
			// repairs in place, the path that reaches the reconcile.
			scheduleMessageId: null,
			memberRoleId,
			adminRoleId: ADMIN_ROLE_ID,
		});
		guildConfigMock.findByGuildId.mockResolvedValue(stored);

		const channels = new Map<string, ReturnType<typeof makeManagedChannel>>();
		for (const spec of GuildSetupManager.CHANNEL_SPECS) {
			const kind = overwriteKindOf(spec);
			channels.set(`ch-${spec.configField}`, makeManagedChannel(kind === "voice" ? "voice" : "text", STARTING_SHAPE[kind]));
		}
		const category = { id: "cat-1", children: { cache: { find: () => undefined } } };
		const guild = makeGuild(features);
		guild.channels.fetch = vi.fn(async (id: string) => (id === "cat-1" ? category : (channels.get(id)?.channel ?? null))) as never;
		const client = { user: { id: BOT_ID }, channels: { fetch: vi.fn().mockResolvedValue(null) } } as unknown as Client;
		return { guild, client, channels, stored };
	}

	const isBranchKind = (field: string): boolean => {
		const kind = overwriteKindOf(GuildSetupManager.CHANNEL_SPECS.find((spec) => spec.configField === field)!);
		return kind === "public" || kind === "voice" || kind === "commandOutput";
	};

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => undefined);
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
	});

	it("gates every public text channel and both rooms, then hands the guild over", async () => {
		const { guild, client, channels, stored } = makeBootWorld(COMMUNITY, MEMBER_ROLE_ID);

		const result = await GuildSetupManager.ensureHomebase(client, guild);

		expect(result.action).toBe("skipped");
		for (const spec of GuildSetupManager.CHANNEL_SPECS) {
			const { set } = channels.get(`ch-${spec.configField}`)!;
			expect(set.mock.calls.length, spec.configField).toBe(isBranchKind(spec.configField) ? 1 : 0);
		}
		expect(announcementMock.post).toHaveBeenCalledOnce();
		expect(announcementMock.post).toHaveBeenCalledWith(client, guild, stored);
	});

	it("a second boot writes nothing and still hands the guild over, so a failed post can retry", async () => {
		const { guild, client, channels } = makeBootWorld(COMMUNITY, MEMBER_ROLE_ID);
		await GuildSetupManager.ensureHomebase(client, guild);
		for (const { set } of channels.values()) set.mockClear();

		await GuildSetupManager.ensureHomebase(client, guild);

		for (const { set } of channels.values()) expect(set).not.toHaveBeenCalled();
		expect(announcementMock.post).toHaveBeenCalledTimes(2);
	});

	it("touches nothing and announces nothing on a non-Community guild", async () => {
		const { guild, client, channels } = makeBootWorld([], MEMBER_ROLE_ID);

		await GuildSetupManager.ensureHomebase(client, guild);

		for (const { set } of channels.values()) expect(set).not.toHaveBeenCalled();
		expect(announcementMock.post).not.toHaveBeenCalled();
	});

	it("announces nothing on a Community guild before /setup names a member role", async () => {
		const { guild, client, channels } = makeBootWorld(COMMUNITY, null);

		await GuildSetupManager.ensureHomebase(client, guild);

		for (const { set } of channels.values()) expect(set).not.toHaveBeenCalled();
		expect(announcementMock.post).not.toHaveBeenCalled();
	});

	it("keeps going past a channel Discord refuses, and never throws into the sweep", async () => {
		const { guild, client, channels } = makeBootWorld(COMMUNITY, MEMBER_ROLE_ID);
		channels.get("ch-commandsChannelId")!.set.mockRejectedValue(new Error("Missing Permissions"));

		await expect(GuildSetupManager.ensureHomebase(client, guild)).resolves.toMatchObject({ action: "skipped" });

		expect(channels.get("ch-leaderboardChannelId")!.set).toHaveBeenCalledOnce();
		expect(announcementMock.post).toHaveBeenCalledOnce();
	});
});
