// src/db/models/MemberLevel.ts
import mongoose from "mongoose";
import { v4 } from "uuid";
import type { IAchievementUnlock, IGameRecord } from "@features/leveling/levelingTypes.js";

// ── MemberLevel ──
// What:  one row per member per guild, holding everything the leveling system
//        knows about that member: their total xp, their lifetime counters, their
//        per game win/loss/draw/assist record, and the achievements they hold.
// Who:   written ONLY through @features/leveling/awardXp.ts (which batches
//        message xp through xpWriter and writes every other source through
//        immediately) and by the /leveling xp admin command. Read by /account, /account view:levels,
//        LevelsBoard, roleRewards and the achievement engine.
// When:  a row is born on the member's first xp award, upserted, and lives as
//        long as the guild does. There is no TTL: this is the durable record,
//        the same call PlayerActivity.ts and GameRoom.ts both make.
// Where: this is the leveling system's ONLY durable truth. It is a NEW
//        collection beside PlayerActivity, deliberately not an extension of it.
//        PlayerActivity answers "did this warrior show up for this KvK event",
//        keyed { eventId, eventOccurrence, userId }; this answers "how present
//        is this member in this server over time". Folding the second into the
//        first would mean inventing a fake eventId for "just chatting", which
//        corrupts the participation score, the /leaderboard command, the
//        dashboard players route and the pinned board all at once.
// How:   every mutation is atomic and server side ($inc inside findOneAndUpdate
//        or bulkWrite). There is no read-modify-write anywhere in this feature,
//        because message xp arrives faster than a round trip.

export interface IMemberLevel {
	memberLevelId: string;
	guildId: string;
	userId: string;
	username: string;
	totalXp: number;
	announcedLevel: number;
	messages: number;
	reactionsGiven: number;
	voiceMinutes: number;
	fortuneReadings: number;
	games: Map<string, IGameRecord>;
	unlocked: IAchievementUnlock[];
	lastAwardAt: Date | null;
}

// One game's record. _id is disabled because these are values inside a Map keyed
// by game slug, not addressable documents: nothing ever looks a record up by id,
// and a per-entry ObjectId would add 12 bytes to every game every member plays.
const gameRecordSchema = new mongoose.Schema<IGameRecord>(
	{
		played: { type: Number, default: 0 },
		won: { type: Number, default: 0 },
		lost: { type: Number, default: 0 },
		drawn: { type: Number, default: 0 },
		// Only ever non-zero for hangman today. A co-operative game added later is
		// where this earns its keep; duel, rps, blackjack, battleship and holdem
		// have no assist to record.
		assists: { type: Number, default: 0 },
	},
	{ _id: false }
);

// One unlocked achievement tier. Appended with $addToSet, never read-modify-write,
// so two unlocks landing in the same flush cannot overwrite each other.
const achievementUnlockSchema = new mongoose.Schema<IAchievementUnlock>(
	{
		id: { type: String, required: true },
		tier: { type: String, required: true },
		at: { type: Date, required: true },
		earnedBy: { type: String, required: true },
	},
	{ _id: false }
);

const memberLevelSchema = new mongoose.Schema<IMemberLevel>(
	{
		// uuid v4, matching PlayerActivity.activityId and GameRoom.roomId. `unique`
		// here declares the index; do NOT also declare it via schema.index() or
		// Mongoose 8 logs a duplicate-index warning on every boot.
		memberLevelId: { type: String, required: true, unique: true, default: v4 },
		// Deliberately NOT `index: true`. Both compound indexes below lead with
		// guildId and serve every guildId-only query as their prefix, so a
		// standalone index here would cost a write on every flush and buy nothing.
		guildId: { type: String, required: true },
		userId: { type: String, required: true },
		// Display name AT WRITE TIME, using the same precedence ActivityTracker
		// already uses: nickname, then globalName, then username. Denormalized on
		// purpose so /account view:levels can render a board of 10 members without 10 Discord
		// fetches; a member who changes their nickname is corrected on their next
		// award rather than by a backfill.
		username: { type: String, required: true },

		// ⚠️ THE ONLY XP FIELD. `level` is deliberately NOT stored, it is DERIVED
		// from totalXp through @features/leveling/levelCurve.ts on every read. A
		// stored level is a second source of truth that drifts the instant an admin
		// runs /leveling xp set or the guild changes its curve preset or its multiplier, and
		// the drift is silent because nothing recomputes it.
		totalXp: { type: Number, default: 0 },

		// ⚠️ announcedLevel is NOT the member's level. It is a HIGH WATER MARK whose
		// only job is making the level up announcement claim atomic: the announcer
		// updates on { _id, announcedLevel: { $lt: newLevel } } and skips when
		// modifiedCount is 0, because that means another concurrent flush already
		// announced this level. Default 0 sits below level 1, so a brand new
		// member's first level up is claimable. Do NOT "fix" this into a level
		// field, and do not read it as one.
		announcedLevel: { type: Number, default: 0 },

		// Lifetime counters. Every achievement metric reads one of these or a games
		// map field, which is what lets the achievement engine add zero listeners
		// and zero extra writes to the message path.
		messages: { type: Number, default: 0 },
		reactionsGiven: { type: Number, default: 0 },
		voiceMinutes: { type: Number, default: 0 },
		// Backs the hidden dero-knows achievement. Declared from Phase 1 even
		// though nothing increments it until the fortune award hook lands, because
		// an undeclared path is silently dropped by strict mode rather than failing
		// (the schedulePaused post mortem in GuildConfig.ts is that bug shipped).
		fortuneReadings: { type: Number, default: 0 },

		// Keyed by leveling game slug (duel, rps, hangman, blackjack, battleship,
		// holdem). A Map rather than six declared subdocuments so phases 6 to 8 add
		// a game with no migration, and so a game that is later retired leaves no
		// dead columns behind. Written by awardXp as dotted $inc paths
		// ("games.duel.played") in the SAME atomic update as the xp, which is what
		// makes it impossible for a member's xp and their record to disagree.
		games: { type: Map, of: gameRecordSchema, default: () => new Map<string, IGameRecord>() },

		// Achievement tiers this member holds. See achievementUnlockSchema above.
		unlocked: { type: [achievementUnlockSchema], default: () => [] as IAchievementUnlock[] },

		// Last successful award of any source. Diagnostic rather than functional:
		// the per source cooldowns live in xpWriter's in-memory map, deliberately,
		// because a cooldown that cost a database round trip would defeat the whole
		// point of the guard order on the message path.
		lastAwardAt: { type: Date, default: null },
	},
	{ timestamps: true }
);

// ── Indexes ──

// ⚠️ REQUIRED, not an optimization. Two concurrent upserts on the same missing
// key can both attempt an insert, and one loses with a duplicate-key error
// (mongoose issue 7183, long standing and not a bug in this repo). awardXp
// retries once on code 11000 and the retry always succeeds because the document
// now exists, but that recovery only holds if the constraint exists to lose to.
// Without this index the race produces TWO rows for one member instead, and
// every read afterwards silently sees half their xp.
memberLevelSchema.index({ guildId: 1, userId: 1 }, { unique: true });

// What makes rank an INDEX ONLY count. /account resolves one member's rank as
// 1 + countDocuments({ guildId, totalXp: { $gt: mine } }), which is exact and
// stays fast well past the size this bot will ever see, and never sorts the
// guild in application code. Also serves the all-time board's descending scan
// and every guildId-only query as its prefix.
memberLevelSchema.index({ guildId: 1, totalXp: -1 });

// ── Retention NOTE (deliberately no TTL) ──
// Mirrors PlayerActivity and GameRoom: this is the historical record every
// leveling surface reads back, so a blind TTL would silently delete a guild's
// progression. Contrast XpPeriod, which DOES carry one: those rows are derivable
// per period aggregates and are meant to expire. Read the rule as "TTL only what
// is derivable", not as "this repo does not TTL".
//
// Nothing in this feature deletes data. /leveling xp reset-server is the single
// destructive operation, it is admin gated, it requires a confirm button, and it
// is the guild's own data.

export const MemberLevel = mongoose.model<IMemberLevel>("MemberLevel", memberLevelSchema);
