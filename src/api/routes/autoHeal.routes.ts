import { Router, Request, Response } from "express";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { requireGuildId } from "../middleware/requireGuildId.js";

// ── /api/auto-heal ────────────────────────────────────────────────────
// What:  HTTP twin of /configure-auto-heal slash command. Lets the
//        Settings tab toggle GuildConfig.autoHealEnabled without the
//        admin opening Discord. Body: { enabled: boolean }. Same
//        idempotency contract as the slash command, re-writing the
//        same state is a no-op with a clear "already that way" response.
// Who:   called by the nexious-server plugin proxy when the dashboard's
//        Settings auto-heal toggle button is clicked.
// When:  every click of that button.
// Where: mounted at /api/auto-heal. Behind verifySignature.
// How:   ① validate enabled is a boolean;
//        ② load GuildConfig + idempotency check;
//        ③ write GuildConfig.autoHealEnabled and return new state so the
//           dashboard updates without a follow-up GET.

interface ToggleBody {
	enabled?: unknown;
}

export function createAutoHealRouter(): Router {
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

			if (config.autoHealEnabled === enabled) {
				res.status(200).json({ data: { ok: true, autoHealEnabled: enabled, unchanged: true } });
				return;
			}

			await guildConfigStore.update(guildId, { autoHealEnabled: enabled });
			res.status(200).json({ data: { ok: true, autoHealEnabled: enabled, unchanged: false } });
		} catch (error) {
			console.error("[auto-heal route] unhandled error", error);
			res.status(500).json({ error: "Failed to update auto-heal" });
		}
	});

	return router;
}
