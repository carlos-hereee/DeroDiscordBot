// src/db/models/XpPeriod.ts
import mongoose from "mongoose";
import { v4 } from "uuid";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";

// ── XpPeriod ──
// What:  one row per member per guild per calendar period, holding the xp they
//        earned inside it. `period` is a KEY, "2026-W32" or "2026-08", produced
//        by @features/leveling/levelPeriod.ts.
// Who:   written by xpWriter's flush (one bulkWrite for the week key, one for
//        the month key, in the same flush as the MemberLevel write). Read by
//        /levels, by /account's weekly and monthly rank lines, and by LevelsBoard.
// When:  every flush. A member who earns nothing in a period simply has no row
//        for it, which is the correct rendering of "not on this week's board".
// Where: strictly derivable, disposable aggregate data. MemberLevel.totalXp is
//        the durable truth; nothing here is irreplaceable, which is exactly why
//        this collection carries the TTL that MemberLevel and PlayerActivity
//        deliberately refuse. Read the repo rule as "TTL only what is
//        derivable", not as "this repo does not TTL".
//
// ⚠️ THIS SCHEMA IS THE ENTIRE ANSWER TO "no weekly reset job". There is no
// weekXp field to zero, therefore there is no reset job, therefore there is no
// reset job that can fail. "This week" is a query on the current period key and
// nothing more. Arcane, the market leader, ships a documented and still unfixed
// bug in exactly this spot: their weekly and monthly leaderboards only reset when
// an unrelated notification setting happens to be enabled, which their own
// debugging page records as a known issue with no ETA. A schema with nowhere to
// put that bug beats a job that has to remember to run. Do not add a
// per-period counter to MemberLevel "for speed"; that reintroduces the bug class.

export interface IXpPeriod {
	xpPeriodId: string;
	guildId: string;
	userId: string;
	period: string;
	xp: number;
}

const xpPeriodSchema = new mongoose.Schema<IXpPeriod>(
	{
		// uuid v4 for uniformity with every other model in this repo. Nothing looks
		// a row up by it; the compound key below is the real identity.
		xpPeriodId: { type: String, required: true, unique: true, default: v4 },
		// No standalone index: both compound indexes below lead with guildId and
		// serve guildId-only queries as their prefix.
		guildId: { type: String, required: true },
		userId: { type: String, required: true },
		// "2026-W32" or "2026-08". Zero padded so the keys sort lexically, which is
		// what lets a range query over recent periods work without parsing them.
		period: { type: String, required: true },
		xp: { type: Number, default: 0 },
	},
	{ timestamps: true }
);

// ── Indexes ──

// The board query, exactly: this guild, this period, highest first. Index only,
// so rendering a top ten never touches a document the board will not show.
xpPeriodSchema.index({ guildId: 1, period: 1, xp: -1 });

// ⚠️ REQUIRED, not an optimization, for the same reason as MemberLevel's member
// index: the flush upserts these rows, two concurrent flushes on a missing key
// can both attempt an insert, and the constraint is what turns that into a
// retryable duplicate-key error rather than two rows splitting one member's
// week between them.
xpPeriodSchema.index({ guildId: 1, userId: 1, period: 1 }, { unique: true });

// ── Retention (a TTL here IS correct) ──
// Expiry runs on createdAt, which sits inside the row's own period, so a row
// outlives its period by the retention window and no more. The window is long
// enough that a future "same month last year" comparison is still possible, and
// short enough that the collection cannot grow without bound on a large guild.
// Nothing member-facing is lost when a row expires: the member's lifetime total
// lives on MemberLevel and is untouched.
xpPeriodSchema.index({ createdAt: 1 }, { expireAfterSeconds: BOT_CONSTANTS.LEVELING.XP_PERIOD_RETENTION_SECONDS });

export const XpPeriod = mongoose.model<IXpPeriod>("XpPeriod", xpPeriodSchema);
