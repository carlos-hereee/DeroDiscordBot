import type { AnyBulkWriteOperation } from "mongoose";
import type { Client } from "discord.js";
import { memberLevelStore } from "@db/stores/memberLevelStore.js";
import { xpPeriodStore } from "@db/stores/xpPeriodStore.js";
import type { IMemberLevel } from "@db/models/MemberLevel.js";
import type { IXpPeriod } from "@db/models/XpPeriod.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { LOG_MESSAGES } from "@base/constants/log-messages.js";
import type { LifetimeCounter } from "./levelingTypes.js";
import { handleLevelCrossing } from "./levelUpAnnouncer.js";
import { getLevelingConfig } from "./levelingConfig.js";
import { runAchievementPass } from "./achievementUnlock.js";

// ── xpWriter ───────────────────────────────────────────────────────────────
// The three mechanisms that let the bot's FIRST EVER messageCreate listener sit
// on a permanently hot path without becoming a per message database round trip.
//
// What:  ① a synchronous cooldown claim, ② a write buffer flushed on an
//        interval, ③ a sweep that keeps both maps bounded.
// Who:   awardXp is the only intended caller of stage(); the three passive
//        listeners are the only callers of claimCooldown(). main.ts owns the
//        lifecycle (startXpWriter, and flushNow from inside gracefulShutdown).
// When:  claimCooldown runs on literally every message the bot can see. flush
//        runs on its own interval and once more on shutdown.
// Where: this is the only module in the feature that is allowed to be clever
//        about I/O. Everything downstream of it is ordinary code.
// How:   see the three numbered sections below.

// ── ① THE COOLDOWN CLAIM ───────────────────────────────────────────────────
// Keyed `${guildId}:${userId}:${source}` to the timestamp of the last award.
//
// ⚠️ claimCooldown READS AND WRITES WITH NO await BETWEEN THEM, and that single
// property is the entire race defense for the common case. Two messages from one
// member arriving in the same tick cannot both pass, because the second sees the
// first's write without the event loop ever yielding. Do NOT make this async, do
// NOT await anything inside it, and do NOT split it into a check and a record.
//
// That last point is why the existing @utils/cooldownManager.js is deliberately
// NOT used here. Its contract separates check() from record() so a slash command
// only burns the member's window after the action succeeds, which is right there
// and wrong here: for a passive earn event the claim IS the guard, and anything
// that yields between the two halves reopens the race it exists to close.
//
// The repo already uses this discipline twice: startHangmanRound claiming a
// channel slot, and challengeFlow's pair key.
const lastAwardAt = new Map<string, number>();

export function claimCooldown(key: string, windowMs: number, now: number = Date.now()): boolean {
	const previous = lastAwardAt.get(key);
	if (previous !== undefined && now - previous < windowMs) return false;
	lastAwardAt.set(key, now);
	return true;
}

// Release a claim that was taken but whose award then did not happen. Used by the
// reaction path, where the "once per member per message" claim is taken before a
// guard that can still reject the event; without this a rejected reaction would
// burn the member's window for a message they never earned on.
export function releaseCooldown(key: string): void {
	lastAwardAt.delete(key);
}

// ── ② THE WRITE BUFFER ─────────────────────────────────────────────────────
// Message xp is staged in memory and written in batches. The tradeoff, stated
// plainly: buffered xp is LOST on a hard crash, bounded by the flush interval.
// That is acceptable for xp specifically. It would not be acceptable for
// anything a member paid for, and nothing in this feature is.
//
// A graceful Railway redeploy loses nothing, because flushNow() runs as step ⓪
// inside main.ts's existing gracefulShutdown, before Mongo disconnects.

export interface StagedAward {
	guildId: string;
	userId: string;
	username: string;
	xp: number;
	counters: Partial<Record<LifetimeCounter, number>>;
	// Resolved when the award is STAGED, not when it is flushed. An award earned
	// at 23:59:59 on a Saturday must land in that week even if the flush that
	// carries it runs three seconds later in the next one, and the whole point of
	// the period key design is that there is no reset job to paper over a
	// misattribution like that.
	week: string;
	month: string;
}

// Keyed by member AND period pair, so a flush window that straddles midnight
// produces two exact entries rather than one approximate one. At a ten second
// flush interval that is at most two entries per member per boundary.
let pending = new Map<string, StagedAward>();

const pendingKey = (award: StagedAward): string =>
	`${award.guildId}:${award.userId}:${award.week}:${award.month}`;

export function stage(award: StagedAward): void {
	const key = pendingKey(award);
	const existing = pending.get(key);
	if (!existing) {
		// Copy the counters rather than holding the caller's object, so a caller
		// reusing one literal across awards cannot mutate what is already staged.
		pending.set(key, { ...award, counters: { ...award.counters } });
		return;
	}

	existing.xp += award.xp;
	// The freshest display name wins, so a nickname change lands on the next
	// flush rather than waiting for the member's next distinct period.
	existing.username = award.username;
	for (const [counter, value] of Object.entries(award.counters)) {
		const name = counter as LifetimeCounter;
		existing.counters[name] = (existing.counters[name] ?? 0) + (value ?? 0);
	}
}

let flushTimer: ReturnType<typeof setInterval> | null = null;
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let boundClient: Client | null = null;

export function startXpWriter(
	client: Client,
	options: { flushIntervalMs?: number; sweepIntervalMs?: number } = {}
): void {
	// Idempotent: a second call must not leave the first interval running, or a
	// hot reload in development would double every flush.
	stopXpWriter();
	boundClient = client;

	const flushInterval = options.flushIntervalMs ?? BOT_CONSTANTS.LEVELING.FLUSH_INTERVAL_MS;
	const sweepInterval = options.sweepIntervalMs ?? BOT_CONSTANTS.LEVELING.MAP_SWEEP_INTERVAL_MS;

	flushTimer = setInterval(() => void flushNow(), flushInterval);
	sweepTimer = setInterval(() => sweepCooldowns(), sweepInterval);

	// Neither timer should hold the process open on its own. The bot exits through
	// gracefulShutdown's process.exit anyway, but an unref'd interval also keeps a
	// test runner from hanging on a writer somebody forgot to stop.
	flushTimer.unref?.();
	sweepTimer.unref?.();
}

export function stopXpWriter(): void {
	if (flushTimer) clearInterval(flushTimer);
	if (sweepTimer) clearInterval(sweepTimer);
	flushTimer = null;
	sweepTimer = null;
	boundClient = null;
}

// ⚠️ Called from INSIDE main.ts's existing gracefulShutdown as step ⓪, never
// from a second process.on("SIGTERM"). A sibling signal listener would race that
// shutdown: the flush could be cut off mid bulkWrite, or fire after
// disconnectMongoose() had already closed the socket it needs.
export async function flushNow(): Promise<void> {
	// ⚠️ SWAP FIRST, before any await. Everything staged from this line onward
	// accumulates into a clean map instead of into one that is being drained, so
	// no award can be counted twice and none can be silently dropped between the
	// read and the clear.
	if (pending.size === 0) return;
	const batch = pending;
	pending = new Map<string, StagedAward>();

	try {
		const memberOps: AnyBulkWriteOperation<IMemberLevel>[] = [];
		const periodOps: AnyBulkWriteOperation<IXpPeriod>[] = [];
		// Aggregated per MEMBER (not per member and period), because level crossing
		// is a question about a lifetime total and a member who straddled a period
		// boundary in one window still crossed only once.
		const totals = new Map<string, { guildId: string; userId: string; username: string; xp: number }>();
		const stampedAt = new Date();

		for (const award of batch.values()) {
			const increments: Record<string, number> = { totalXp: award.xp };
			for (const [counter, value] of Object.entries(award.counters)) {
				if (value) increments[counter] = value;
			}

			memberOps.push({
				updateOne: {
					filter: { guildId: award.guildId, userId: award.userId },
					update: {
						$inc: increments,
						$set: { username: award.username, lastAwardAt: stampedAt },
						$setOnInsert: { guildId: award.guildId, userId: award.userId },
					},
					upsert: true,
				},
			});

			// One row per period key. Both are written in the same flush so a
			// member's week and month totals can never describe different awards.
			for (const period of [award.week, award.month]) {
				periodOps.push({
					updateOne: {
						filter: { guildId: award.guildId, userId: award.userId, period },
						update: {
							$inc: { xp: award.xp },
							$setOnInsert: { guildId: award.guildId, userId: award.userId, period },
						},
						upsert: true,
					},
				});
			}

			const memberKey = `${award.guildId}:${award.userId}`;
			const running = totals.get(memberKey);
			if (running) running.xp += award.xp;
			else totals.set(memberKey, { guildId: award.guildId, userId: award.userId, username: award.username, xp: award.xp });
		}

		await memberLevelStore.bulkWrite(memberOps);
		await xpPeriodStore.bulkWrite(periodOps);

		await dispatchCrossings(totals);
	} catch (error) {
		// The batch is gone. Deliberately NOT re-staged: a bulkWrite that failed
		// part way through has already applied some of its ops, so replaying the
		// whole batch would double count every member it did reach. Losing one
		// window of xp is recoverable by playing more; silently inflating a
		// leaderboard is not.
		console.error(LOG_MESSAGES.leveling.flushFailed(batch.size), error);
	}
}

// Read back what the flush actually produced and hand every member who crossed a
// level to the announcer.
//
// The read back exists because bulkWrite does not return documents, and the
// alternative (a findOneAndUpdate per member) is exactly the per member round
// trip this whole module exists to avoid. One extra indexed read per flush,
// grouped per guild, is the right price.
async function dispatchCrossings(
	totals: Map<string, { guildId: string; userId: string; username: string; xp: number }>
): Promise<void> {
	const client = boundClient;
	if (!client || totals.size === 0) return;

	const byGuild = new Map<string, string[]>();
	for (const entry of totals.values()) {
		const list = byGuild.get(entry.guildId);
		if (list) list.push(entry.userId);
		else byGuild.set(entry.guildId, [entry.userId]);
	}

	for (const [guildId, userIds] of byGuild) {
		const docs = await memberLevelStore.findManyInGuild(guildId, userIds);
		// Read once per guild, not once per member: the achievement pass below needs
		// the curve to derive a level, and the config read is TTL cached anyway.
		const context = await getLevelingConfig(guildId);

		for (const doc of docs) {
			const entry = totals.get(`${guildId}:${doc.userId}`);
			if (!entry) continue;
			// $inc is atomic and server side, so the document just read back holds
			// the authoritative new total and the previous one is exactly it minus
			// what this flush awarded.
			//
			// A write-through award landing between the bulkWrite and this read
			// would make that subtraction slightly stale. The consequence is bounded
			// to a MISSED announcement, never a duplicate one, because the
			// announcement claim in handleLevelCrossing is a high water mark that
			// only ever moves up.
			await handleLevelCrossing({
				client,
				guildId,
				userId: doc.userId,
				username: doc.username ?? entry.username,
				oldTotalXp: doc.totalXp - entry.xp,
				newTotalXp: doc.totalXp,
			});

			// ⚠️ THIS IS THE ONLY CALL SITE OF THE ACHIEVEMENT PASS in the codebase,
			// and that is load bearing rather than incidental. Running it from
			// anywhere else, and in particular from inside an unlock handler, turns
			// "unlock grants xp, xp crosses a level, a level changes the metrics an
			// unlock is evaluated against" into a loop that feeds itself. Keeping it
			// here means it runs exactly once per flushed member per flush.
			//
			// Deliberately NOT gated on a level crossing: a member can unlock "sent
			// 53 messages" without levelling at all.
			if (context?.settings.enabled) {
				await runAchievementPass(client, guildId, doc, context.settings);
			}
		}
	}
}

// ── ③ THE SWEEP ────────────────────────────────────────────────────────────
// The cooldown map gains an entry per member per source and never loses one on
// its own, so on a busy bot it is a slow leak rather than an immediate failure.
// An entry older than the longest cooldown an admin can configure cannot block
// anything, so it is safe to drop.
//
// The pending map needs no sweep: every flush empties it by construction.
export function sweepCooldowns(now: number = Date.now()): number {
	const maxAgeMs = BOT_CONSTANTS.LEVELING.MAX_COOLDOWN_SECONDS * 1000;
	let removed = 0;
	for (const [key, stamp] of lastAwardAt) {
		if (now - stamp >= maxAgeMs) {
			lastAwardAt.delete(key);
			removed += 1;
		}
	}
	return removed;
}

// ── test seams ──
// Matching the `_clearEarlyAccessCache` / `_clearHangmanRounds` convention.
export const _clearXpWriter = (): void => {
	lastAwardAt.clear();
	pending = new Map<string, StagedAward>();
};
export const _pendingSize = (): number => pending.size;
export const _cooldownSize = (): number => lastAwardAt.size;
