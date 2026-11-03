import type { Client } from "discord.js";
import { creatorId, renderAnalyticsEnabled } from "@utils/config.js";
import { infoEmbed } from "@utils/embedBuilder.js";
import { formatRenderAnalyticsReport } from "@features/renderer/renderAnalyticsSubcommand.js";
import { buildRenderAnalyticsReport } from "./renderAnalytics.js";
import { renderAnalyticsCopy } from "./renderAnalyticsCopy.js";

// ── render analytics weekly digest ───────────────────────────────────
// The platform owner's Monday DM of this month's render analytics so far
// (2026-10 item 244, Phase 2a). ReminderScheduler.startScheduler fires it on
// BOT_CONSTANTS.RENDER_ANALYTICS.DIGEST_CRON in the owner's time zone; a test
// fires it by hand through sendRenderAnalyticsDigest. It builds nothing of its
// own: the report is Phase 1's buildRenderAnalyticsReport and the embed text is
// the same formatter /platform analytics uses, so the DM and the command can
// never disagree about a number. It never writes, and it never throws into the
// cron, because a missed digest costs one DM and the scheduler must keep running.

export type RenderAnalyticsDigestOutcome = "sent" | "skipped-no-owner" | "skipped-disabled" | "failed";

/**
 * Builds the month to date report and DMs it to CREATOR_DISCORD_ID. Answers what
 * happened rather than throwing: a skip (no owner configured, or the kill switch
 * off) logs one line, and a failed read or a refused DM logs and answers "failed".
 */
export async function sendRenderAnalyticsDigest(client: Client, now: Date = new Date()): Promise<RenderAnalyticsDigestOutcome> {
	if (!creatorId) {
		console.log("[render-analytics] weekly digest skipped: CREATOR_DISCORD_ID is not set, so there is no owner to DM.");
		return "skipped-no-owner";
	}
	// With the kill switch off nothing is counted, so a digest would report a month of zeros as if it were real.
	if (!renderAnalyticsEnabled) {
		console.log("[render-analytics] weekly digest skipped: RENDER_ANALYTICS_ENABLED is off, so nothing was counted.");
		return "skipped-disabled";
	}

	try {
		const report = await buildRenderAnalyticsReport({ period: "this-month", now });
		const embed = infoEmbed(renderAnalyticsCopy.digestTitle, formatRenderAnalyticsReport(report));
		// Same owner DM path as outageWatcher: fetch the user, then send.
		const owner = await client.users.fetch(creatorId);
		await owner.send({ embeds: [embed] });
		return "sent";
	}
	catch (error) {
		// A closed DM, a wrong owner id or an Atlas blip all land here. There is no
		// higher channel to escalate to, so the log line is the whole signal.
		console.warn("[render-analytics] weekly digest to the platform owner failed (report read or DM send)", error);
		return "failed";
	}
}
