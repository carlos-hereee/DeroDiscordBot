import { Router, type Request, type Response } from "express";
import type { Client } from "discord.js";
import { creatorLabDmEnabled } from "@utils/config.js";
import { sendDirectMessage, type DirectMessageOutcome } from "@utils/directMessage.js";
import { creatorLabLinkStore } from "@db/stores/creatorLabLinkStore.js";
import { buildAnalysisDmEmbed, parseAnalysisSummary } from "@features/creator-lab/analysisDm.js";
import { buildTipsDmEmbed, parseTipsDm } from "@features/creator-lab/tipsDm.js";

// ── /api/creator-lab (Dero: Creator Lab, 2026-11 item 283 Phases 4 and 5) ─────
// Three server initiated signed POSTs, all from nexious-server's postBotData (botApiClient.ts):
//   POST /link/redeem { code }               → { data: { discordUserId, discordUsername } }, 410 on a miss
//   POST /dm { discordUserId, summary }      → { data: { delivered: true } }, 422 when Discord refuses
//   POST /tips-dm { discordUserId, tips }    → the same answers as /dm (Phase 5, the weekly tips)
// The platform proxy (forwardToBot) never reaches either, because "creator-lab" is not on the
// server's ROK_BOT_PATH_PREFIXES and must never be: these carry one person's Discord id and their
// analysis, not an app's guild data. Mounted after verifySignature and, like /api/pairing, without
// ?guildId=: a Creator Lab link belongs to a person, not a guild, so the signature is the whole gate.
// All answer 503 while CREATOR_LAB_DM_ENABLED is off (Risk R6). None logs a code, an id, a summary or a tip.

const DISCORD_ID_PATTERN = /^\d{5,25}$/;

const isDiscordId = (value: unknown): value is string => typeof value === "string" && DISCORD_ID_PATTERN.test(value);

/** The one answer both DM routes give for what Discord did with the message. */
function answerDelivery(res: Response, outcome: DirectMessageOutcome): void {
	if (outcome === "sent") {
		res.status(200).json({ data: { delivered: true } });
		return;
	}
	// 422: Discord refused this user (DMs closed, or no shared server); the server keeps the link and,
	// for the weekly tips, falls back to an in-app notification.
	if (outcome === "closed") {
		res.status(422).json({ error: "This user does not accept DMs from Dero" });
		return;
	}
	res.status(502).json({ error: "Discord did not deliver the DM" });
}

export function createCreatorLabRouter(client: Client): Router {
	const router = Router();

	router.use((_req: Request, res: Response, next) => {
		if (creatorLabDmEnabled) {
			next();
			return;
		}
		res.status(503).json({ error: "Creator Lab DMs are switched off" });
	});

	router.post("/link/redeem", async (req: Request, res: Response) => {
		const code: unknown = (req.body as { code?: unknown } | undefined)?.code;
		if (typeof code !== "string" || code.trim() === "") {
			res.status(400).json({ error: "Invalid body", detail: "code must be a non-empty string" });
			return;
		}
		try {
			const doc = await creatorLabLinkStore.redeem(code);
			// One answer for invalid, expired and used, so the route is no oracle for live codes.
			if (!doc) {
				res.status(410).json({ error: "Link code is invalid or expired" });
				return;
			}
			res.status(200).json({ data: { discordUserId: doc.discordUserId, discordUsername: doc.discordUsername } });
		}
		catch (error) {
			// Safe for the server to retry: the redeem is atomic, so a code is either still live or spent.
			console.error("[creator lab route] link redeem failed", error instanceof Error ? error.name : "unknown");
			res.status(500).json({ error: "Failed to redeem link code" });
		}
	});

	router.post("/dm", async (req: Request, res: Response) => {
		const body = (req.body ?? {}) as { discordUserId?: unknown; summary?: unknown };
		const summary = parseAnalysisSummary(body.summary);
		if (!isDiscordId(body.discordUserId) || !summary) {
			res.status(400).json({ error: "Invalid body", detail: "discordUserId and a complete summary are required" });
			return;
		}
		answerDelivery(res, await sendDirectMessage(client, body.discordUserId, { embeds: [buildAnalysisDmEmbed(summary)] }));
	});

	router.post("/tips-dm", async (req: Request, res: Response) => {
		const body = (req.body ?? {}) as { discordUserId?: unknown; tips?: unknown };
		const tips = parseTipsDm(body.tips);
		if (!isDiscordId(body.discordUserId) || !tips) {
			res.status(400).json({ error: "Invalid body", detail: "discordUserId and one to three tips are required" });
			return;
		}
		answerDelivery(res, await sendDirectMessage(client, body.discordUserId, { embeds: [buildTipsDmEmbed(tips)] }));
	});

	return router;
}
