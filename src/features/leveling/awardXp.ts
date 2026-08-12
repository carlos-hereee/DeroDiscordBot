import type { Client } from "discord.js";
import type { AnyBulkWriteOperation } from "mongoose";
import { memberLevelStore } from "@db/stores/memberLevelStore.js";
import { xpPeriodStore } from "@db/stores/xpPeriodStore.js";
import type { IXpPeriod } from "@db/models/XpPeriod.js";
import { LOG_MESSAGES } from "@base/constants/log-messages.js";
import { checkLevelingAccess } from "@features/entitlements/levelingAccess.js";
import { getLevelingConfig } from "./levelingConfig.js";
import { periodKeysFor } from "./levelPeriod.js";
import { stage } from "./xpWriter.js";
import { handleLevelCrossing } from "./levelUpAnnouncer.js";
import type { GameOutcome, LevelingGameSlug, LifetimeCounter, XpSource } from "./levelingTypes.js";

// ── awardXp ────────────────────────────────────────────────────────────────
// THE ONE PUBLIC ENTRY POINT for granting xp. Every source in the codebase calls
// this and nothing else: the three passive listeners, all four mini games, the
// game room finish path, the achievement engine, and the admin /xp command.
//
// What:  applies one award, maintains the member's per game record in the same
//        write, and hands any level crossing to the announcer.
// Who:   see above. A game handler must never touch a store, the curve, or the
//        announcer directly. That single rule is what makes adding a game in
//        phases 6 to 8 nearly free: one call, and the whole leveling system
//        already understands the new game.
// When:  after the primary action has already succeeded and the player has
//        already seen its result.
// Where: the entitlement seam is checked HERE rather than at each call site,
//        because this is the only path, so gating here gates the feature by
//        construction and there is no second route to forget.
// How:   ① entitlement and config, ② "message" stages into the buffer while
//        every other source writes through, ③ the crossing goes to the announcer.
//
// ⚠️ IT NEVER THROWS. Every failure is logged and swallowed. An award happens
// after a successful primary write, inside collector callbacks with no caller
// left to catch anything, so a throw here would break a working game to fail at
// bookkeeping. This is convention 7 in CLAUDE.md, under "Conventions and rules".

export interface AwardXpInput {
	client: Client;
	guildId: string;
	userId: string;
	username: string;
	// The pre-multiplier base. Callers that roll (the passive sources) have
	// already applied their multipliers; game hooks pass a flat constant.
	amount: number;
	source: XpSource;
	game?: LevelingGameSlug;
	outcome?: GameOutcome;
	counters?: Partial<Record<LifetimeCounter, number>>;
	// Only read under announceMode "current". Optional because a voice sweep and
	// an admin correction have no channel of their own.
	channelId?: string | null;
}

// "assist" is stored as "assists" because the field is a count. Mapped once here
// so no call site has to remember the difference.
const OUTCOME_FIELD: Record<GameOutcome, string> = {
	won: "won",
	lost: "lost",
	drawn: "drawn",
	assist: "assists",
};

export async function awardXp(input: AwardXpInput): Promise<void> {
	try {
		const amount = Number.isFinite(input.amount) && input.amount > 0 ? Math.floor(input.amount) : 0;
		const counters = input.counters ?? {};
		const hasCounters = Object.values(counters).some((value) => (value ?? 0) > 0);

		// Nothing to write. A zero award with no counters and no game record is a
		// no op rather than an empty database round trip, which matters because
		// callers are encouraged to call unconditionally and let this decide.
		if (amount === 0 && !hasCounters && !input.game) return;
		if (!input.guildId || !input.userId) return;

		// Fails OPEN and, with ENFORCE_LEVELING_TIER unset (production today),
		// returns immediately with zero I/O. See levelingAccess.ts for why it must
		// never be able to deny.
		const access = await checkLevelingAccess(input.guildId);
		if (!access.allowed) return;

		const context = await getLevelingConfig(input.guildId);
		// No config row means the guild never ran /setup. Nothing to earn toward and
		// nowhere to announce, so this is a silent bail rather than an error.
		if (!context || !context.settings.enabled) return;

		const { week, month } = periodKeysFor(new Date(), context.weekStart);

		// ── ② the fork ──
		// "message" is buffered because it arrives faster than a database round
		// trip. Everything else writes through immediately, because a game result or
		// an admin correction should be visible on the very next /account rather
		// than up to a flush window later.
		//
		// ⚠️ "achievement" IS ALSO BUFFERED, and for a completely different reason:
		// it is half of the recursion defense. An achievement's xp bonus is granted
		// from inside the flush's own achievement pass, so writing it through would
		// let it cross a level in the same pass that granted it. Buffering pushes it
		// into the NEXT flush window as an ordinary award, where it is evaluated
		// once, idempotently, like anything else. See achievementEngine.ts.
		if (input.source === "message" || input.source === "achievement") {
			stage({
				guildId: input.guildId,
				userId: input.userId,
				username: input.username,
				xp: amount,
				counters,
				week,
				month,
			});
			return;
		}

		await writeThrough(input, amount, counters, week, month);
	} catch (error) {
		console.error(LOG_MESSAGES.leveling.awardFailed(input.source, input.guildId), error);
	}
}

async function writeThrough(
	input: AwardXpInput,
	amount: number,
	counters: Partial<Record<LifetimeCounter, number>>,
	week: string,
	month: string
): Promise<void> {
	const increments: Record<string, number> = {};
	if (amount > 0) increments.totalXp = amount;
	for (const [counter, value] of Object.entries(counters)) {
		if (value) increments[counter] = value;
	}

	// ⚠️ The per game record rides in the SAME atomic update as the xp, which is
	// the whole reason `game` and `outcome` are parameters of this function rather
	// than a second call. Two writes could partially fail and leave a member's
	// total disagreeing with their win/loss line, and /account renders both.
	if (input.game) {
		increments[`games.${input.game}.played`] = 1;
		if (input.outcome) increments[`games.${input.game}.${OUTCOME_FIELD[input.outcome]}`] = 1;
	}

	if (Object.keys(increments).length === 0) return;

	const doc = await incrementWithRetry(input, increments);
	if (!doc) return;

	// Period rows are best effort relative to the lifetime total: they back the
	// weekly and monthly boards and are derivable, so a failure here must not
	// undo an award that already landed.
	if (amount > 0) {
		try {
			const operations: AnyBulkWriteOperation<IXpPeriod>[] = [week, month].map((period) => ({
				updateOne: {
					filter: { guildId: input.guildId, userId: input.userId, period },
					update: {
						$inc: { xp: amount },
						$setOnInsert: { guildId: input.guildId, userId: input.userId, period },
					},
					upsert: true,
				},
			}));
			await xpPeriodStore.bulkWrite(operations);
		} catch (error) {
			console.warn(LOG_MESSAGES.leveling.awardFailed(input.source, input.guildId), error);
		}
	}

	// $inc is atomic and server side, so the returned post increment document is
	// the truth and the previous total is exactly it minus what was just awarded.
	// No second read, and no window in which another writer could confuse the two.
	await handleLevelCrossing({
		client: input.client,
		guildId: input.guildId,
		userId: input.userId,
		username: input.username,
		oldTotalXp: (doc.totalXp ?? 0) - amount,
		newTotalXp: doc.totalXp ?? 0,
		sourceChannelId: input.channelId ?? null,
	});
}

// Two concurrent upserts on the same MISSING key can both attempt an insert and
// one loses with a duplicate key error. Long standing mongoose behavior (issue
// 7183), not a bug in this repo, and the unique { guildId, userId } index is what
// turns the race into this recoverable error rather than into two rows for one
// member. The retry always succeeds because the document now exists.
async function incrementWithRetry(
	input: AwardXpInput,
	increments: Record<string, number>
): Promise<{ totalXp?: number } | null> {
	try {
		return await memberLevelStore.incrementAndReturn(input.guildId, input.userId, input.username, increments);
	} catch (error) {
		if ((error as { code?: number })?.code !== 11000) throw error;
		console.warn(LOG_MESSAGES.leveling.upsertRaced(input.guildId, input.userId));
		try {
			return await memberLevelStore.incrementAndReturn(input.guildId, input.userId, input.username, increments);
		} catch (retryError) {
			console.error(LOG_MESSAGES.leveling.upsertRetryFailed(input.guildId, input.userId), retryError);
			return null;
		}
	}
}
