import { Router, Request, Response } from "express";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { eventStore } from "@db/stores/eventStore.js";
import { xpPeriodStore } from "@db/stores/xpPeriodStore.js";
import { memberLevelStore } from "@db/stores/memberLevelStore.js";
import { weekKey } from "@features/leveling/levelPeriod.js";
import type { WeekStart } from "@features/leaderboard/leaderboardWindow.js";
import { requireGuildId } from "../middleware/requireGuildId.js";

// ── streamer routes (Dero Live stream companion, Phase 4) ──
// What:  GET /api/streamer/recent-activity, a short STRUCTURED SUMMARY of a
//        guild's recent activity: this week's headline numbers from the
//        leveling system, the top few members, and the active events. Counts
//        and highlights only, never a transcript and never message content.
// Who:   nexious-server's Dero Live ideas generator calls this (signed, via
//        the same HMAC contract as every other /api route) to ground its
//        content ideas in something true about the community. The dashboard
//        proxy can also reach it under the general-events allowlist entry.
// When:  once per ideas generation, only when the app has a guildId
//        configured. The caller treats any failure as "generate ungrounded",
//        so this route being down never breaks the ideas feature.
// Where: mounted behind verifySignature in server.ts like every /api route.
//        READ ONLY by construction: this router registers exactly one GET and
//        touches no store method that writes. Do not add a write here; the
//        platform side advertises this surface as incapable of acting on the
//        guild.
// How:   "this week" is the leveling system's own period key (weekKey with the
//        guild's configured weekStart), so the summary agrees with what
//        /levels and the pinned board already show members. Guild scoping is
//        invariant 2: missing guildId is a 400 (requireGuildId), an unknown
//        guild is a 404.

// The summary stays SMALL on purpose: it is folded into a model prompt, so
// every extra row is token cost, not information.
const TOP_MEMBER_LIMIT = 3;
const ACTIVE_EVENT_LIMIT = 5;

export function createStreamerRouter(): Router {
	const streamerRouter = Router();

	streamerRouter.get("/recent-activity", async (req: Request, res: Response) => {
		const guildId = requireGuildId(req, res);
		if (guildId === null) return;
		try {
			// Unknown guild reads as NOT FOUND, never as an empty summary: an empty
			// summary is a true statement about a quiet guild, and it must not be
			// producible by probing guildIds the bot has never seen.
			const config = await guildConfigStore.findByGuildId(guildId);
			if (!config) {
				res.status(404).json({ error: "Guild not found" });
				return;
			}

			const period = weekKey(new Date(), ((config as { weekStart?: string }).weekStart ?? "sunday") as WeekStart);

			const [stats, topRows, events] = await Promise.all([
				xpPeriodStore.statsForPeriod(guildId, period),
				xpPeriodStore.topInPeriod(guildId, period, TOP_MEMBER_LIMIT),
				eventStore.findByGuildId(guildId),
			]);

			// XpPeriod rows carry userIds only; MemberLevel holds the display names.
			// A member whose name cannot be resolved is reported without one rather
			// than dropped, the xp is still real.
			const levelRows = await memberLevelStore.findManyInGuild(
				guildId,
				topRows.map((row) => row.userId)
			);
			const nameByUserId = new Map(levelRows.map((row) => [row.userId, row.username]));
			const topMembers = topRows.map((row) => ({
				username: nameByUserId.get(row.userId) ?? "",
				xp: row.xp,
			}));

			const activeEvents = events
				.filter((event) => event.active)
				.slice(0, ACTIVE_EVENT_LIMIT)
				.map((event) => ({ name: event.name, type: event.type }));

			res.json({
				data: {
					guildId,
					period,
					activeMembers: stats.activeMembers,
					totalXp: stats.totalXp,
					topMembers,
					activeEvents,
				},
			});
		} catch (error) {
			console.log("[streamer] recent-activity failed", error);
			res.status(500).json({ error: "Failed to build the recent activity summary" });
		}
	});

	return streamerRouter;
}
