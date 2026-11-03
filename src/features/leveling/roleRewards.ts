import { DiscordAPIError, PermissionFlagsBits, type Client, type GuildMember, type Role } from "discord.js";
import { LOG_MESSAGES } from "@base/constants/log-messages.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { getLevelingConfig, invalidateLevelingConfig } from "./levelingConfig.js";
// A runtime only cycle (levelUpAnnouncer imports reconcileRewards from here):
// both sides call the other inside a function body, never at module load, so
// ESM resolves it, and the unlock card keeps the announcer's one send path.
import { announceRoleUnlock } from "./levelUpAnnouncer.js";

// ── roleRewards ────────────────────────────────────────────────────────────
// Grant a Discord role when a member reaches a level.
//
// This is the single most failure prone part of any leveling bot, and almost
// every failure mode is SILENT: the API returns one opaque error for five
// different causes, and a reward that never lands looks exactly like a reward
// nobody earned. So the error taxonomy below is the actual deliverable, not a
// footnote to it.
//
// What:  compute the member's FULL desired role set and apply it in ONE call.
// Who:   the level up path (so the reward lands in the same beat as the
//        celebration) and /account (so an admin who adds a reward retroactively
//        sees it apply without a mass assign).
// When:  lazily, never in a sweep. See NEVER MASS ASSIGN below.
// Where: the pure half (computeDesiredRoles) is exported and unit tested with no
//        discord.js in sight, the same split versusResolve / versusHandler draws.

export interface RewardRule {
	level: number;
	roleId: string;
}

// ── the pure half ──────────────────────────────────────────────────────────
// ⚠️ ONE ATOMIC WRITE, NOT add() THEN remove(). This function exists to produce
// the complete final set so the caller can apply it with a single roles.set.
// Sequential add-then-remove leaves a window in which the member holds both
// roles or neither, and two level ups landing close together can interleave so
// the removal from the first strips the role the second just granted. roles.set
// removes the window rather than guarding it.
export function computeDesiredRoles(
	currentRoleIds: readonly string[],
	rewards: readonly RewardRule[],
	level: number,
	stackRewards: boolean
): { desired: string[]; earned: RewardRule[] } {
	const desired = new Set(currentRoleIds);

	// Drop EVERY reward role first, earned or not. Starting from a clean slate is
	// what makes replace-mode work and what lets a de-configured reward fall off
	// a member without a separate cleanup path.
	for (const reward of rewards) desired.delete(reward.roleId);

	const qualifying = rewards
		.filter((reward) => reward.level <= level)
		.sort((left, right) => left.level - right.level);

	// stack: keep every reward earned along the way.
	// replace: keep ONLY the highest, which is what an admin means by a role
	// LADDER rather than a role collection.
	const earned = stackRewards ? qualifying : qualifying.slice(-1);
	for (const reward of earned) desired.add(reward.roleId);

	return { desired: [...desired], earned };
}

// ── the refusal set ────────────────────────────────────────────────────────
// A role is assignable only if ALL of these hold. They are written as one
// function with a reason per branch, because every one of them produces the SAME
// opaque DiscordAPIError 50013 at the API and they are otherwise
// indistinguishable from each other in a log.
export type RefusalReason = "botMissingManageRoles" | "managed" | "hierarchy" | "administrator" | "manageGuild";

export function refuseReason(role: Role, me: GuildMember): RefusalReason | null {
	if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) return "botMissingManageRoles";

	// Integration roles and the Nitro booster role can never be assigned by a bot,
	// whatever permissions it holds.
	if (role.managed) return "managed";

	// ⚠️ ADMINISTRATOR DOES NOT BYPASS ROLE HIERARCHY. This bot ships with the
	// Administrator permission integer and STILL cannot touch a role positioned at
	// or above its own. A reward role dragged above the bot in Server Settings
	// fails forever, no matter what the bot is allowed to do.
	if (me.roles.highest.comparePositionTo(role) <= 0) return "hierarchy";

	// ⚠️ SECURITY REFUSALS, not convenience checks. A leveling bot handing out
	// Administrator because somebody chatted a lot is a security incident, not a
	// bug. Refused at config time in /leveling settings AND again here, because a
	// config row can be edited directly in Mongo and never passes through the
	// command.
	if (role.permissions.has(PermissionFlagsBits.Administrator)) return "administrator";
	if (role.permissions.has(PermissionFlagsBits.ManageGuild)) return "manageGuild";

	return null;
}

// ── once per guild plus role, never once per member ────────────────────────
// A broken reward in a large guild would otherwise write the same line thousands
// of times into Railway's logs and bury everything else in them. Keyed on guild
// AND role so a second broken reward in the same guild is still reported.
const reported = new Set<string>();

export const _clearRewardReports = (): void => reported.clear();

function reportOnce(guildId: string, roleId: string, message: string, ...rest: unknown[]): void {
	const key = `${guildId}:${roleId}`;
	if (reported.has(key)) return;
	reported.add(key);
	console.warn(message, ...rest);
}

// ── reconcileRewards ───────────────────────────────────────────────────────
// Never throws. Returns the role a member NEWLY gained on this pass, or null,
// so the level up announcement can render its {earned:...} block in the same
// message rather than in a second one.
//
// ⚠️ NEVER MASS ASSIGN. There is deliberately no "apply rewards to everybody"
// sweep anywhere in this feature. Discord does not want it, and at ten thousand
// members it is ten thousand API calls against one per-guild bucket. Reconcile
// happens in exactly two places: lazily on the member's next level up, and on
// demand when they run /account.
//
// That second path looks like an odd place for a role write, so the reason is
// worth stating: without it, an admin who adds a level 10 reward sees NOTHING
// happen for existing level 40 members and reports the feature as broken. Arcane
// shipped exactly this fix on 2025-07-28 "due to a large number of users needing
// the ability to apply role rewards retroactively". A rate limited, resumable,
// opt-in backfill command is a separate future item, not this.
export async function reconcileRewards(
	client: Client,
	guildId: string,
	userId: string,
	level: number
): Promise<string | null> {
	try {
		const context = await getLevelingConfig(guildId);
		if (!context || !context.settings.enabled) return null;

		const rewards = context.settings.rewards;
		if (rewards.length === 0) return null;

		const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
		if (!guild) return null;

		const me = guild.members.me;
		if (!me) return null;

		// Cache first, then fetch. A cold member cache after a restart would
		// otherwise silently skip a legitimate reward.
		const member = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
		if (!member) return null;

		const { desired, earned } = computeDesiredRoles(
			[...member.roles.cache.keys()],
			rewards,
			level,
			context.settings.stackRewards
		);

		// Filter the desired set down to what the bot can actually assign, reporting
		// each refusal once. A role that fails here is dropped from the set rather
		// than failing the whole call, so one broken reward cannot block a working
		// one on the same member.
		const assignable = new Set(desired);
		let newlyEarned: string | null = null;

		for (const reward of earned) {
			const role = guild.roles.cache.get(reward.roleId);
			if (!role) {
				// 10011 by another name: the role was deleted. SELF HEAL rather than
				// failing forever on a reward that can never resolve.
				await dropReward(guildId, reward.roleId, context.settings.rewards);
				assignable.delete(reward.roleId);
				continue;
			}

			const refusal = refuseReason(role, me);
			if (refusal) {
				assignable.delete(reward.roleId);
				reportOnce(guildId, reward.roleId, refusalMessage(refusal, reward.roleId, guildId));
				continue;
			}

			// Newly gained means "in the desired set and not already held", which is
			// what the {earned:...} block should name. The HIGHEST such role wins,
			// because earned is sorted ascending by level.
			if (!member.roles.cache.has(reward.roleId)) newlyEarned = reward.roleId;
		}

		const nextRoles = [...assignable];
		// Nothing to do. Skipping the API call entirely matters: /account calls this
		// on every profile view, and the overwhelming majority are no-ops.
		if (sameSet(nextRoles, [...member.roles.cache.keys()])) return null;

		// ⚠️ ONE atomic PATCH. The audit reason is what an admin sees in the server's
		// audit log, so it names the level rather than saying "bot".
		await member.roles.set(nextRoles, `Level ${level}`);
		// The role unlock card (2026-10 item 243 Phase 4), posted only AFTER the
		// write succeeded and only for a role the member did not hold before, so a
		// member sees it once per role whichever path applied it (a level up,
		// /account, an achievement). Fire and forget: it never throws, and the
		// level up path must not wait on a card before composing its own line.
		if (newlyEarned) void announceRoleUnlock(client, guildId, userId, newlyEarned, level);
		return newlyEarned;
	} catch (error) {
		await handleGrantError(error, guildId);
		return null;
	}
}

// ── the error taxonomy ─────────────────────────────────────────────────────
// ⚠️ Kept even behind a passing precheck, because discord.js can report STALE
// role positions: a hierarchy check can pass against the cache and the API call
// still fail (discordjs issue 3286).
async function handleGrantError(error: unknown, guildId: string): Promise<void> {
	if (error instanceof DiscordAPIError) {
		// 50013 Missing Permissions. Hierarchy, a managed role, or a missing
		// permission. ⚠️ DO NOT RETRY: it will never succeed, and a retry loop
		// against a per-guild bucket is how a bot gets rate limited into a wider
		// outage. Logged once per guild.
		if (error.code === 50013) {
			reportOnce(guildId, "any", LOG_MESSAGES.leveling.rewardFailed(guildId), error);
			return;
		}
		// 10011 Unknown Role. The reward role was deleted between the precheck and
		// the write. The self heal already happened above for the cache-miss case;
		// this is the race.
		if (error.code === 10011) {
			console.warn(LOG_MESSAGES.leveling.rewardRoleDeleted("unknown", guildId));
			return;
		}
	}
	console.error(LOG_MESSAGES.leveling.rewardFailed(guildId), error);
}

function refusalMessage(reason: RefusalReason, roleId: string, guildId: string): string {
	switch (reason) {
		case "hierarchy":
			return LOG_MESSAGES.leveling.rewardHierarchy(roleId, guildId);
		case "managed":
			return LOG_MESSAGES.leveling.rewardManaged(roleId, guildId);
		case "administrator":
		case "manageGuild":
			return LOG_MESSAGES.leveling.rewardRefusedPrivileged(roleId, guildId);
		case "botMissingManageRoles":
			return LOG_MESSAGES.leveling.rewardHierarchy(roleId, guildId);
	}
}

// Remove a reward whose role no longer exists, so the config stops describing a
// grant that can never happen. Self healing rather than logging forever.
async function dropReward(guildId: string, roleId: string, rewards: readonly RewardRule[]): Promise<void> {
	console.warn(LOG_MESSAGES.leveling.rewardRoleDeleted(roleId, guildId));
	await guildConfigStore
		.update(guildId, { "leveling.rewards": rewards.filter((reward) => reward.roleId !== roleId) })
		.catch(() => undefined);
	invalidateLevelingConfig(guildId);
}

const sameSet = (left: readonly string[], right: readonly string[]): boolean =>
	left.length === right.length && left.every((id) => right.includes(id));
