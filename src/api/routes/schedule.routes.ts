import { Router, Request, Response } from "express";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { requireGuildId } from "../middleware/requireGuildId.js";

// ── /api/schedule ─────────────────────────────────────────────────────
// What:  HTTP twin of the schedule-level pause/resume affordances on the
//        Command Center. Two endpoints:
//          POST /pause , set GuildConfig.schedulePaused.paused = true
//          POST /resume, set GuildConfig.schedulePaused.paused = false
//        Both also clear / set the optional pausedUntil so the
//        ReminderScheduler's auto-resume contract works.
// Who:   called by the nexious-server plugin proxy when the dashboard's
//        Command Center button is clicked. Eventually surfaced to admins
//        through a banner + button pair on PluginHome.
// When:  every click of the pause/resume control on Command Center.
// Where: mounted at /api/schedule. Behind verifySignature like the rest
//        of the dashboard-facing surface.
// How:   ① resolve guildId via the same middleware events.routes uses;
//        ② validate the body's pausedUntil if present (must parse as
//           a Date in the future);
//        ③ write GuildConfig.schedulePaused via guildConfigStore.update;
//        ④ return the new state so the dashboard does not have to do
//           a follow-up GET to render the banner.

interface PauseBody {
	pausedUntil?: unknown;
}

export function createScheduleRouter(): Router {
	const router = Router({ mergeParams: true });

	// POST /api/schedule/pause
	// Body: { pausedUntil?: ISO date string | null }
	// pausedUntil omitted or null = indefinite pause.
	router.post("/pause", async (req: Request, res: Response) => {
		const guildId = requireGuildId(req, res);
		if (guildId === null) return;

		try {
			const body = (req.body ?? {}) as PauseBody;
			let pausedUntil: Date | null = null;
			if (body.pausedUntil !== undefined && body.pausedUntil !== null) {
				const parsed = new Date(body.pausedUntil as string);
				if (Number.isNaN(parsed.getTime())) {
					res.status(400).json({ error: "Invalid pausedUntil", detail: "Could not parse as a Date." });
					return;
				}
				if (parsed.getTime() <= Date.now()) {
					res.status(400).json({
						error: "Invalid pausedUntil",
						detail: "pausedUntil must be in the future. Omit it for an indefinite pause.",
					});
					return;
				}
				pausedUntil = parsed;
			}

			const config = await guildConfigStore.findByGuildId(guildId);
			if (!config) {
				res.status(409).json({ error: "Setup incomplete", reason: "guild_not_configured" });
				return;
			}

			await guildConfigStore.update(guildId, {
				schedulePaused: { paused: true, pausedUntil },
			});

			res.status(200).json({
				data: {
					ok: true,
					schedulePaused: { paused: true, pausedUntil: pausedUntil ? pausedUntil.toISOString() : null },
				},
			});
		} catch (error) {
			console.error("[schedule pause route] unhandled error", error);
			res.status(500).json({ error: "Failed to pause schedule" });
		}
	});

	// POST /api/schedule/resume
	// Body: {}, resume always clears both paused and pausedUntil.
	router.post("/resume", async (req: Request, res: Response) => {
		const guildId = requireGuildId(req, res);
		if (guildId === null) return;

		try {
			const config = await guildConfigStore.findByGuildId(guildId);
			if (!config) {
				res.status(409).json({ error: "Setup incomplete", reason: "guild_not_configured" });
				return;
			}

			await guildConfigStore.update(guildId, {
				schedulePaused: { paused: false, pausedUntil: null },
			});

			res.status(200).json({
				data: {
					ok: true,
					schedulePaused: { paused: false, pausedUntil: null },
				},
			});
		} catch (error) {
			console.error("[schedule resume route] unhandled error", error);
			res.status(500).json({ error: "Failed to resume schedule" });
		}
	});

	return router;
}
