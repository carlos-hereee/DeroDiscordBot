import { Router, Request, Response } from "express";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { requireGuildId } from "../middleware/requireGuildId.js";

// ── /api/leaderboard-tracking ─────────────────────────────────────────
// What:  HTTP twin of /server leaderboard tracking slash command. Lets
//        the Command Center dashboard button toggle
//        GuildConfig.leaderboardTrackingEnabled without the admin opening
//        Discord. Body: { enabled: boolean }. Same idempotency contract
//        as the slash command, re-writing the same state is a no-op
//        with a clear "already that way" response.
// Who:   called by the nexious-server plugin proxy when the dashboard's
//        Command Center leaderboard pause/continue button is clicked.
// When:  every click of that button.
// Where: mounted at /api/leaderboard-tracking. Behind verifySignature.
// How:   ① validate enabled is a boolean;
//        ② load GuildConfig + idempotency check;
//        ③ on enable, also clear "leaderboardChannelId" from
//           userRemovedChannels so the channel rebuilds on the next
//           sweep, same behavior the slash command's enable path has;
//        ④ return new state so the dashboard updates without GET.

interface ToggleBody {
	enabled?: unknown;
}

export function createLeaderboardTrackingRouter(): Router {
	const router = Router({ mergeParams: true });

	router.post("/", async (req: Request, res: Response) => {
		const guildId = requireGuildId(req, res);
		if (guildId === null) return;

		try {
			const body = (req.body ?? {}) as ToggleBody;
			if (typeof body.enabled !== "boolean") {
				res.status(400).json({ error: "Invalid body", detail: "enabled must be a boolean" });
				return;
			}
			const enabled = body.enabled;

			const config = await guildConfigStore.findByGuildId(guildId);
			if (!config) {
				res.status(409).json({ error: "Setup incomplete", reason: "guild_not_configured" });
				return;
			}

			// Idempotency: same value already set returns 200 with no DB write.
			// Mirrors the slash command's "already that way" reply.
			if (config.leaderboardTrackingEnabled === enabled) {
				res.status(200).json({
					data: { ok: true, leaderboardTrackingEnabled: enabled, unchanged: true },
				});
				return;
			}

			// Mirror the slash command's enable-side flag clearing: if the
			// admin previously removed the leaderboard channel via the
			// button, clear that flag on toggle-on so auto-heal rebuilds
			// the channel on the next sweep.
			const removedSlots = new Set<string>(
				(config as unknown as { userRemovedChannels?: string[] }).userRemovedChannels ?? []
			);
			const updatePayload: Record<string, unknown> = { leaderboardTrackingEnabled: enabled };
			if (enabled && removedSlots.has("leaderboardChannelId")) {
				removedSlots.delete("leaderboardChannelId");
				updatePayload.userRemovedChannels = Array.from(removedSlots);
			}
			await guildConfigStore.update(guildId, updatePayload);

			res.status(200).json({
				data: { ok: true, leaderboardTrackingEnabled: enabled, unchanged: false },
			});
		} catch (error) {
			console.error("[leaderboard-tracking route] unhandled error", error);
			res.status(500).json({ error: "Failed to update leaderboard tracking" });
		}
	});

	return router;
}
