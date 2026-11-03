import cron from "node-cron";
import { DiscordAPIError, type Client, type Guild } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { weeklyDigestSentEvent } from "@base/constants/BOT_LOG_EVENTS.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { memberLevelStore } from "@db/stores/memberLevelStore.js";
import { xpPeriodStore } from "@db/stores/xpPeriodStore.js";
import { avatarRequestFor, isRenderPayload, withRenderFallback } from "@features/renderer/index.js";
import { getLevelingConfig, type GuildLevelingContext } from "./levelingConfig.js";
import { buildWeeklyDigestEmbed, type WeeklyDigestView } from "./levelingEmbeds.js";
import { levelFromTotalXp } from "./levelCurve.js";
import { weekKey } from "./levelPeriod.js";
import { renderWeeklyDigestCard, WEEKLY_DIGEST_AVATAR_SIZE } from "./weeklyDigestRenderer.js";

// ── weeklyDigest ─────────────────────────────────────────────────────
// The weekly digest (2026-10 item 243 Phase 4): once a week, the most active
// members of each server get a direct message recapping their own week there,
// the XP they earned, where that put them, and their level, as a rendered card
// with the digest embed as its fallback.
//
// Who:   main.ts starts the Monday 9 am Central cron with startWeeklyDigest, and
//        runs one pass at boot when WEEKLY_DIGEST_RUN_ON_BOOT is 1 (the owner's
//        hand trigger for a test guild).
// When:  a guild is skipped when leveling is off, when announcements are off
//        (the admin's existing "stay quiet" switch), or when its homebase is gone.
// Where: the week recapped is the one containing the moment seven days before
//        the run, which is the most recent COMPLETE week for any weekStart.
// How:   ① per guild, claim the week in BotLog before the first DM, so a restart
//        or a second trigger can never DM a member the same week twice; ② read the
//        top members of that week from XpPeriod, capped, and the week's active
//        count; ③ per member, build the view, render, DM, then pause.
//
// It never throws: every failure is logged per guild or per member and the run
// moves on, since nothing waits on a digest (house rule 7).

const DAY_MS = 24 * 60 * 60 * 1000;
const RECAP_OFFSET_MS = 7 * DAY_MS;
// Discord's "Cannot send messages to this user": the member closed DMs from
// server members. Expected and common, so it is counted, not logged as a failure.
const CANNOT_DM_USER = 50007;

/** The calls a run makes that a test swaps for fakes. */
export interface WeeklyDigestDeps {
	sleep(ms: number): Promise<void>;
	now(): Date;
}

export const defaultWeeklyDigestDeps: WeeklyDigestDeps = {
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	now: () => new Date(),
};

/** How one guild's pass went, for the run's one log line per guild. */
export interface GuildDigestOutcome {
	guildId: string;
	status: "sent" | "skipped" | "alreadySent" | "failed";
	sent: number;
	closedDms: number;
}

/** One digest pass over every guild the bot is in. Never throws. */
export async function runWeeklyDigest(client: Client, deps: WeeklyDigestDeps = defaultWeeklyDigestDeps): Promise<GuildDigestOutcome[]> {
	const outcomes: GuildDigestOutcome[] = [];
	for (const guild of client.guilds.cache.values()) {
		const outcome = await digestGuild(guild, deps);
		outcomes.push(outcome);
		if (outcome.status === "sent") {
			console.log(`[weekly-digest] guild=${guild.id} sent=${outcome.sent} closedDms=${outcome.closedDms}`);
		}
	}
	return outcomes;
}

async function digestGuild(guild: Guild, deps: WeeklyDigestDeps): Promise<GuildDigestOutcome> {
	const outcome: GuildDigestOutcome = { guildId: guild.id, status: "skipped", sent: 0, closedDms: 0 };
	try {
		const context = await getLevelingConfig(guild.id);
		if (!context || !isDigestOn(context)) return outcome;

		const period = weekKey(new Date(deps.now().getTime() - RECAP_OFFSET_MS), context.weekStart);
		// ① claimed BEFORE any DM: a crash mid run costs digests, never a duplicate.
		const event = weeklyDigestSentEvent(period);
		if (await botLogStore.has(guild.id, event)) return { ...outcome, status: "alreadySent" };
		await botLogStore.log(guild.id, event, { period });

		// ②
		const rows = await xpPeriodStore.topInPeriod(guild.id, period, BOT_CONSTANTS.LEVELING.WEEKLY_DIGEST_MAX_MEMBERS);
		const earners = rows.filter((row) => row.xp > 0);
		if (earners.length === 0) return { ...outcome, status: "sent" };
		const { activeMembers } = await xpPeriodStore.statsForPeriod(guild.id, period);
		const levels = await memberLevelStore.findManyInGuild(
			guild.id,
			earners.map((row) => row.userId)
		);
		const totalXpByUser = new Map(levels.map((level) => [level.userId, level.totalXp]));

		// ③
		for (const row of earners) {
			const totalXp = totalXpByUser.get(row.userId) ?? 0;
			const result = await sendDigest(guild, row.userId, {
				weekXp: row.xp,
				// The same index-only count /account's weekly rank line uses, so a tie
				// reads the same in both places.
				weekRank: await xpPeriodStore.rankInPeriod(guild.id, period, row.xp),
				activeMembers,
				level: levelFromTotalXp(totalXp, context.settings.curve, context.settings.curveMultiplier, context.settings.maxLevel),
			});
			if (result === "sent") outcome.sent += 1;
			if (result === "closedDms") outcome.closedDms += 1;
			await deps.sleep(BOT_CONSTANTS.LEVELING.WEEKLY_DIGEST_DM_SPACING_MS);
		}
		return { ...outcome, status: "sent" };
	} catch (error) {
		console.error(`[weekly-digest] the digest pass for guild ${guild.id} failed`, error);
		return { ...outcome, status: "failed" };
	}
}

// Leveling on, announcements not switched off, and a homebase to belong to. The
// digest reuses the announce switch rather than adding its own, so an admin who
// already asked Dero to stay quiet about levels is not surprised by DMs.
function isDigestOn(context: GuildLevelingContext): boolean {
	if (context.homebaseDestroyed) return false;
	return context.settings.enabled && context.settings.announceMode !== "off";
}

type SendResult = "sent" | "closedDms" | "skipped" | "failed";
type DigestNumbers = Pick<WeeklyDigestView, "weekXp" | "weekRank" | "activeMembers" | "level">;

async function sendDigest(guild: Guild, userId: string, numbers: DigestNumbers): Promise<SendResult> {
	const member = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
	// A member who left, or a bot, gets nothing: the digest is for people still here.
	if (!member || member.user.bot) return "skipped";
	const view: WeeklyDigestView = {
		...numbers,
		guildName: guild.name,
		displayName: member.displayName,
		avatar: avatarRequestFor(member.user, WEEKLY_DIGEST_AVATAR_SIZE),
	};
	const card = await withRenderFallback(
		() => renderWeeklyDigestCard(view),
		() => buildWeeklyDigestEmbed(view)
	);
	try {
		await member.send(
			isRenderPayload(card) ? { embeds: [buildWeeklyDigestEmbed(view, card.ref)], files: [card.attachment] } : { embeds: [card] }
		);
		return "sent";
	} catch (error) {
		if (error instanceof DiscordAPIError && error.code === CANNOT_DM_USER) return "closedDms";
		console.warn(`[weekly-digest] the digest DM to member ${userId} in guild ${guild.id} failed`, error);
		return "failed";
	}
}

/**
 * Schedules the digest for Monday at 9 am Central and answers the task, so
 * gracefulShutdown can stop it with the rest of the crons. noOverlap keeps a
 * slow run (many guilds, each paced) from ever starting a second one on top of it.
 */
export function startWeeklyDigest(client: Client): { stop(): void } {
	const task = cron.schedule(
		BOT_CONSTANTS.LEVELING.WEEKLY_DIGEST_CRON,
		async () => {
			await runWeeklyDigest(client);
		},
		{ timezone: BOT_CONSTANTS.LEVELING.WEEKLY_DIGEST_TIMEZONE, noOverlap: true, name: "weekly-digest" }
	);
	return { stop: () => void task.stop() };
}
