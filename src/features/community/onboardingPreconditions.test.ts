import { describe, it, expect } from "vitest";
import { ChannelType, PermissionFlagsBits, type Guild } from "discord.js";
import { communityCopy } from "./communityCopy.js";
import { MIN_EVERYONE_SENDABLE_CHANNELS, checkOnboardingPreconditions, everyoneSendableChannelIds, isRoleBelowBot } from "./onboardingPreconditions.js";

// ── onboardingPreconditions (2026-10 item 247 Phase 4) ──────────────────────
// Each clause in isolation, passing and failing, in the order the check runs them:
// Community on, Dero holding Manage Server and Manage Roles, a member role that is
// real and below Dero's highest role, and at least five channels where @everyone
// can send, counted from resolved permissions with the server's own channels in.

const EVERYONE = "guild-1";
const MEMBER_ROLE = "role-member";
const copy = communityCopy.onboarding.preconditions;

interface IChannelOptions {
	type?: ChannelType;
	view?: boolean;
	send?: boolean;
}

// A channel whose resolved @everyone permissions are whatever the test says.
function channel(id: string, { type = ChannelType.GuildText, view = true, send = true }: IChannelOptions = {}) {
	const allowed = new Map([
		[PermissionFlagsBits.ViewChannel, view],
		[PermissionFlagsBits.SendMessages, send],
	]);
	return {
		id,
		type,
		permissionsFor: (role: { id: string }) => ({ has: (flags: bigint[]) => role.id === EVERYONE && flags.every((flag) => allowed.get(flag) === true) }),
	};
}

interface IGuildOptions {
	features?: string[];
	permissions?: bigint[] | "administrator";
	meMissing?: boolean;
	botHighestPosition?: number;
	memberRolePosition?: number;
	memberRoleExists?: boolean;
	channels?: Array<ReturnType<typeof channel>>;
}

const openChannels = (count: number, prefix = "open") => Array.from({ length: count }, (_, index) => channel(`${prefix}-${index}`));

function makeGuild(options: IGuildOptions = {}): Guild {
	const granted = options.permissions ?? "administrator";
	const roles = new Map<string, { id: string; name: string; position: number }>();
	if (options.memberRoleExists ?? true) roles.set(MEMBER_ROLE, { id: MEMBER_ROLE, name: "Member", position: options.memberRolePosition ?? 2 });
	const channels = options.channels ?? openChannels(MIN_EVERYONE_SENDABLE_CHANNELS);
	return {
		id: "guild-1",
		features: options.features ?? ["COMMUNITY"],
		roles: { everyone: { id: EVERYONE }, cache: roles },
		members: {
			me: options.meMissing
				? null
				: {
					permissions: { has: (flag: bigint) => granted === "administrator" || granted.includes(flag) },
					roles: { highest: { position: options.botHighestPosition ?? 5 } },
				},
		},
		channels: { cache: new Map(channels.map((entry) => [entry.id, entry])) },
	} as unknown as Guild;
}

const stored = { memberRoleId: MEMBER_ROLE };

describe("checkOnboardingPreconditions", () => {
	it("passes a Community server with the permissions, a member role below Dero and five sendable channels", () => {
		expect(checkOnboardingPreconditions(makeGuild(), stored)).toEqual({ ok: true });
	});

	it("a. refuses a server without Community, with the plan's sentence", () => {
		expect(checkOnboardingPreconditions(makeGuild({ features: ["NEWS"] }), stored)).toEqual({ ok: false, code: "community-off", reason: copy.communityOff });
	});

	it("b. refuses when Dero lacks Manage Server or Manage Roles, and passes with exactly those two", () => {
		const withoutRoles = makeGuild({ permissions: [PermissionFlagsBits.ManageGuild] });
		expect(checkOnboardingPreconditions(withoutRoles, stored)).toEqual({ ok: false, code: "missing-permissions", reason: copy.missingPermissions });
		const withoutServer = makeGuild({ permissions: [PermissionFlagsBits.ManageRoles] });
		expect(checkOnboardingPreconditions(withoutServer, stored)).toMatchObject({ ok: false, code: "missing-permissions" });
		const exactly = makeGuild({ permissions: [PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ManageRoles] });
		expect(checkOnboardingPreconditions(exactly, stored)).toEqual({ ok: true });
	});

	it("b. says it could not read its own permissions when Dero's member is not cached", () => {
		expect(checkOnboardingPreconditions(makeGuild({ meMissing: true }), stored)).toEqual({
			ok: false,
			code: "permissions-unreadable",
			reason: communityCopy.errors.permissionsUnreadable,
		});
	});

	it("c. refuses when /setup never set a member role, and names the stale cases on their own", () => {
		expect(checkOnboardingPreconditions(makeGuild(), { memberRoleId: null })).toEqual({ ok: false, code: "no-member-role", reason: copy.noMemberRole });
		expect(checkOnboardingPreconditions(makeGuild(), {})).toMatchObject({ code: "no-member-role" });
		expect(checkOnboardingPreconditions(makeGuild(), { memberRoleId: EVERYONE })).toEqual({
			ok: false,
			code: "member-role-everyone",
			reason: copy.memberRoleIsEveryone,
		});
		expect(checkOnboardingPreconditions(makeGuild({ memberRoleExists: false }), stored)).toEqual({ ok: false, code: "member-role-gone", reason: copy.memberRoleGone });
	});

	it("d. refuses a member role at or above Dero's highest role, naming the role to move above", () => {
		const above = checkOnboardingPreconditions(makeGuild({ memberRolePosition: 7, botHighestPosition: 5 }), stored);
		expect(above).toEqual({ ok: false, code: "member-role-above-bot", reason: copy.memberRoleAboveBot("Member") });
		expect(above.ok === false && above.reason).toContain("Please move me above Member.");
		expect(checkOnboardingPreconditions(makeGuild({ memberRolePosition: 5, botHighestPosition: 5 }), stored)).toMatchObject({ code: "member-role-above-bot" });
	});

	it("e. refuses fewer than five sendable channels, naming the exact count and how many to add", () => {
		const result = checkOnboardingPreconditions(makeGuild({ channels: openChannels(3) }), stored);
		expect(result).toEqual({ ok: false, code: "too-few-sendable-channels", reason: copy.tooFewSendableChannels(3, MIN_EVERYONE_SENDABLE_CHANNELS) });
		expect(result.ok === false && result.reason).toBe(
			"Discord requires at least 5 channels where everyone can send messages before I can turn on Onboarding. You currently have 3; please add 2 more and try again."
		);
	});

	it("runs the clauses in order: the first failure is the answer", () => {
		const everythingWrong = makeGuild({ features: [], permissions: [], memberRoleExists: false, channels: [] });
		expect(checkOnboardingPreconditions(everythingWrong, { memberRoleId: null })).toMatchObject({ code: "community-off" });
		const communityOn = makeGuild({ permissions: [], memberRoleExists: false, channels: [] });
		expect(checkOnboardingPreconditions(communityOn, { memberRoleId: null })).toMatchObject({ code: "missing-permissions" });
		const permitted = makeGuild({ memberRolePosition: 9, channels: [] });
		expect(checkOnboardingPreconditions(permitted, stored)).toMatchObject({ code: "member-role-above-bot" });
	});
});

describe("everyoneSendableChannelIds", () => {
	it("counts resolved @everyone View and Send, across the server's own channels, and nothing gated or read only", () => {
		const guild = makeGuild({
			channels: [
				channel("intro"),
				channel("own-general"),
				channel("own-news", { type: ChannelType.GuildAnnouncement }),
				channel("own-forum", { type: ChannelType.GuildForum }),
				channel("dero-gated", { view: false, send: false }),
				channel("read-only", { send: false }),
				channel("voice", { type: ChannelType.GuildVoice }),
				channel("thread", { type: ChannelType.PublicThread }),
				channel("category", { type: ChannelType.GuildCategory }),
			],
		});
		expect(everyoneSendableChannelIds(guild)).toEqual(["intro", "own-general", "own-news", "own-forum"]);
	});
});

describe("isRoleBelowBot", () => {
	it("is true only strictly below Dero's highest role", () => {
		const guild = makeGuild({ botHighestPosition: 5 });
		expect(isRoleBelowBot(guild, { position: 4 })).toBe(true);
		expect(isRoleBelowBot(guild, { position: 5 })).toBe(false);
		expect(isRoleBelowBot(makeGuild({ meMissing: true }), { position: 0 })).toBe(false);
	});
});
