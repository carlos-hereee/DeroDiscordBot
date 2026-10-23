import { Router, type Request, type Response } from "express";
import {
	buildRenderAnalyticsReport,
	RENDER_ANALYTICS_PERIODS,
	type RenderAnalyticsPeriod,
} from "@features/renderer/renderAnalytics.js";

// ── /api/platform/render-analytics (2026-10 item 244, Phase 2a) ──────
// The platform wide render analytics report as JSON, for Dero's Castle. The
// only caller is nexious-server's botApiClient.ts, a server initiated signed GET
// behind its owner gated /throne/render-analytics route; the platform proxy
// (forwardToBot) never reaches it, because "platform" is not on
// ROK_BOT_PATH_PREFIXES and must never be: these totals span every guild.
//
// Mounted after verifySignature in server.ts and, like /api/pairing, without
// ?guildId=: the rows carry no guild at all (they are keyed by card hash), so a
// guild scope would have nothing to filter. The signature is therefore the whole
// gate. It reads only, and the report is Phase 1's buildRenderAnalyticsReport,
// the same one /render-analytics and the Monday digest show.

const DEFAULT_PERIOD: RenderAnalyticsPeriod = "this-month";

function isPeriod(value: unknown): value is RenderAnalyticsPeriod {
	return typeof value === "string" && (RENDER_ANALYTICS_PERIODS as readonly string[]).includes(value);
}

export function createPlatformAnalyticsRouter(): Router {
	const router = Router();

	router.get("/", async (req: Request, res: Response) => {
		// An absent period reads as this month, the same default the command uses.
		// Anything else that is not one of the three periods (a typo, a repeated
		// ?period= that Express hands over as an array) is refused, never guessed.
		const rawPeriod: unknown = req.query.period;
		if (rawPeriod !== undefined && !isPeriod(rawPeriod)) {
			res.status(400).json({ error: "Invalid query", detail: `period must be one of ${RENDER_ANALYTICS_PERIODS.join(", ")}` });
			return;
		}
		const period = rawPeriod ?? DEFAULT_PERIOD;

		try {
			const report = await buildRenderAnalyticsReport({ period });
			// { data } matches every other bot route and what botApiClient unwraps.
			res.json({ data: report });
		}
		catch (error) {
			// The server answers { available: false } on any non 2xx, so a sparse
			// body is enough here; the detail stays in the bot's log.
			console.error(`[platform analytics route] building the ${period} render analytics report failed`, error);
			res.status(500).json({ error: "Failed to build the render analytics report" });
		}
	});

	return router;
}
