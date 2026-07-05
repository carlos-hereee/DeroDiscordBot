import { Router, Request, Response } from "express";
import { Client, EmbedBuilder, TextChannel } from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { buildAudienceMention } from "@utils/mentions.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { requireGuildId } from "../middleware/requireGuildId.js";

// ── /api/events/:eventId/go-live-now ──
// What: HTTP twin of the /go-live-soon slash command. Mirrors the embed shape,
//   the lead-time choices, and the allowedMentions discipline of the slash
//   command exactly so the dashboard's "Go live now" button posts the same
//   announcement a streamer would otherwise post manually with /go-live-soon.
// Who: called by the nexious-server plugin proxy when the dashboard hits
//   POST /api/proxy/{pluginId}/events/{eventId}/go-live-now. The :eventId
//   param is currently unused (the announcement is event-agnostic — it just
//   needs the guild's configured channel + role) but the dashboard URL keeps
//   the eventId so the same button can later evolve into "announce this
//   specific event is going live" without a route shape change.
// When: every click of the Go-live-now button on EventDetailPage.
// Where: mounted as a sub-router under /api/events. Behind verifySignature
//   along with the rest of the events surface.
// How:
//   ① Resolve the guild's config; bail with 400 if no announcements channel.
//   ② Read the lead-time choice from the body (defaults to "now"); bail with
//      400 if it's not one of the canonical keys.
//   ③ Compose the embed using the SAME helpers the slash command uses.
//   ④ Send to the announcements channel with allowedMentions whitelisting
//      only the chosen role (or @here when no member role is configured).
//   ⑤ Return 200 with { ok: true, ... } on success, 4xx with a typed
//      reason on failure so the dashboard can render an actionable message.

// In-memory cooldown tracker. 60s per guild — same window as TestReminderJob's
// per-event cooldown but keyed by guild because go-live-now does not target a
// specific event. Resets on bot restart, which is acceptable for an anti-spam
// guard (an attacker who can restart the bot can also post by hand).
const COOLDOWN_MS = 60_000;
const lastFiredAt = new Map<string, number>();

// Same closed set the slash command uses. Keep these in sync — diverging would
// produce two different sets of valid lead-time strings between the dashboard
// path and the slash command path.
const LEAD_TIMES: Record<string, { minutes: number; label: string }> = {
	now: { minutes: 0, label: "now" },
	"10m": { minutes: 10, label: "in 10 minutes" },
	"30m": { minutes: 30, label: "in 30 minutes" },
	"1h": { minutes: 60, label: "in 1 hour" },
	"3h": { minutes: 180, label: "in 3 hours" },
	"6h": { minutes: 360, label: "in 6 hours" },
};

interface AnnounceBody {
	when?: unknown;
	note?: unknown;
	mentionRoleId?: unknown;
}

export function createAnnounceRouter(client: Client): Router {
	const router = Router({ mergeParams: true });

	router.post("/:eventId/go-live-now", async (req: Request, res: Response) => {
		const guildId = requireGuildId(req, res);
		if (guildId === null) return;

		try {
			const body = (req.body ?? {}) as AnnounceBody;

			// ② Lead time. Default to "now" so a body-less POST (the dashboard's
			// minimal click-the-button case) still works without forcing the UI
			// to send the field.
			const whenKey = typeof body.when === "string" ? body.when : "now";
			const lead = LEAD_TIMES[whenKey];
			if (!lead) {
				res.status(400).json({
					error: "Invalid lead time",
					detail: rokCommanderCopy.goLiveSoon.invalidLeadTime,
				});
				return;
			}

			// ① Guild config + announcements channel.
			const config = await guildConfigStore.findByGuildId(guildId);
			if (!config?.announcementsChannelId) {
				res.status(409).json({
					error: "Setup incomplete",
					reason: "guild_not_configured",
					detail: rokCommanderCopy.goLiveSoon.setupRequired,
				});
				return;
			}

			// ── per-guild cooldown ──
			// Prevents accidental double-clicks from posting two embeds. 60s window
			// matches the test-reminder cooldown for consistency.
			const last = lastFiredAt.get(guildId);
			const now = Date.now();
			if (last && now - last < COOLDOWN_MS) {
				const retryAfterMs = COOLDOWN_MS - (now - last);
				res.status(429).json({
					error: "Cooldown in effect",
					retryAfterMs,
					retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
				});
				return;
			}

			// Resolve the audience. An explicit override (body.mentionRoleId) targets
			// exactly that role; otherwise the default is the member role PLUS the
			// opt-in "🔔 Announcements" role (config.notificationsRoleId), so opting in
			// via Toggle pings adds you without shrinking reach. The helper returns the
			// content string and allowedMentions together so a malicious note can never
			// smuggle an @everyone past the whitelist.
			const overrideRoleId = typeof body.mentionRoleId === "string" && body.mentionRoleId ? body.mentionRoleId : null;
			const { content: mention, allowedMentions } = buildAudienceMention({
				overrideRoleId,
				memberRoleId: config.memberRoleId,
				notificationsRoleId: config.notificationsRoleId,
			});

			// Sanitize the note. The slash command caps at 500 chars via Discord's
			// option validation; we replicate that here since HTTP callers have
			// no such constraint.
			const noteRaw = typeof body.note === "string" ? body.note.trim() : "";
			const note = noteRaw && noteRaw.length > 0 ? noteRaw.slice(0, 500) : null;

			const startUnix = Math.floor((Date.now() + lead.minutes * 60_000) / 1000);

			// ── resolve the destination channel ──
			let channel;
			try {
				channel = await client.channels.fetch(config.announcementsChannelId);
			} catch (err) {
				console.error("[go-live-now route] channel fetch failed", err);
				res.status(409).json({
					error: "Channel not reachable",
					reason: "channel_not_found",
					detail: rokCommanderCopy.goLiveSoon.postFailed,
				});
				return;
			}
			if (!channel || !(channel instanceof TextChannel)) {
				res.status(409).json({
					error: "Channel is not a text channel",
					reason: "channel_wrong_type",
					detail: rokCommanderCopy.goLiveSoon.postFailed,
				});
				return;
			}

			// ③ Compose the embed using the EXACT same builder the slash command
			//    uses so the two surfaces produce visually identical announcements.
			const embed = new EmbedBuilder()
				.setTitle(rokCommanderCopy.goLiveSoon.announcementTitle)
				.setDescription(rokCommanderCopy.goLiveSoon.announcementBody(lead.label, startUnix, note))
				.setColor(rokCommanderCopy.COLORS.ANNOUNCEMENTS)
				.setFooter({ text: rokCommanderCopy.FOOTER });

			// ④ Send. allowedMentions (from buildAudienceMention) whitelists exactly
			//    the roles named in `content`, never a wildcard that would let a
			//    malicious note string smuggle through @everyone.
			const message = await channel.send({
				content: mention,
				embeds: [embed],
				allowedMentions,
			});

			// ⑤ Record the cooldown only AFTER a successful post. Failed posts
			//    do not count against the rate limit.
			lastFiredAt.set(guildId, now);

			res.status(200).json({
				data: {
					ok: true,
					messageId: message.id,
					channelId: channel.id,
					leadMinutes: lead.minutes,
					startUnix,
					cooldownMs: COOLDOWN_MS,
				},
			});
		} catch (error) {
			console.error("[go-live-now route] unhandled error", error);
			res.status(500).json({ error: "Failed to post announcement" });
		}
	});

	return router;
}

// ── /api/go-live-now (standalone, no eventId) ─────────────────────────
// Twin of the event-bound /api/events/:eventId/go-live-now route above
// but for the Command Center button which is not scoped to a specific
// event. Same embed/cooldown/mention logic — only the URL shape differs.
// Lifting the implementation here lets us share the LEAD_TIMES table
// and the per-guild cooldown map declared at the top of this module
// rather than duplicating them in a new file.
export function createStandaloneGoLiveRouter(client: Client): Router {
	const router = Router({ mergeParams: true });

	router.post("/", async (req: Request, res: Response) => {
		const guildId = requireGuildId(req, res);
		if (guildId === null) return;

		try {
			const body = (req.body ?? {}) as AnnounceBody;

			const whenKey = typeof body.when === "string" ? body.when : "now";
			const lead = LEAD_TIMES[whenKey];
			if (!lead) {
				res.status(400).json({
					error: "Invalid lead time",
					detail: rokCommanderCopy.goLiveSoon.invalidLeadTime,
				});
				return;
			}

			const config = await guildConfigStore.findByGuildId(guildId);
			if (!config?.announcementsChannelId) {
				res.status(409).json({
					error: "Setup incomplete",
					reason: "guild_not_configured",
					detail: rokCommanderCopy.goLiveSoon.setupRequired,
				});
				return;
			}

			// Share the per-guild cooldown map with the event-bound route so
			// rapid clicks across both surfaces still throttle to one
			// announcement per minute. The map is keyed by guildId only,
			// so an admin who hits Command Center's Go Live Now and then
			// the Event detail's Go Live Now within 60s gets the second
			// click rejected as a cooldown hit — which is the right
			// behavior for "do not spam the announcements channel."
			const last = lastFiredAt.get(guildId);
			const now = Date.now();
			if (last && now - last < COOLDOWN_MS) {
				const retryAfterMs = COOLDOWN_MS - (now - last);
				res.status(429).json({
					error: "Cooldown in effect",
					retryAfterMs,
					retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
				});
				return;
			}

			const overrideRoleId = typeof body.mentionRoleId === "string" && body.mentionRoleId ? body.mentionRoleId : null;
			const { content: mention, allowedMentions } = buildAudienceMention({
				overrideRoleId,
				memberRoleId: config.memberRoleId,
				notificationsRoleId: config.notificationsRoleId,
			});

			const noteRaw = typeof body.note === "string" ? body.note.trim() : "";
			const note = noteRaw && noteRaw.length > 0 ? noteRaw.slice(0, 500) : null;

			const startUnix = Math.floor((Date.now() + lead.minutes * 60_000) / 1000);

			let channel;
			try {
				channel = await client.channels.fetch(config.announcementsChannelId);
			} catch (err) {
				console.error("[go-live-now standalone] channel fetch failed", err);
				res.status(409).json({
					error: "Channel not reachable",
					reason: "channel_not_found",
					detail: rokCommanderCopy.goLiveSoon.postFailed,
				});
				return;
			}
			if (!channel || !(channel instanceof TextChannel)) {
				res.status(409).json({
					error: "Channel is not a text channel",
					reason: "channel_wrong_type",
					detail: rokCommanderCopy.goLiveSoon.postFailed,
				});
				return;
			}

			const embed = new EmbedBuilder()
				.setTitle(rokCommanderCopy.goLiveSoon.announcementTitle)
				.setDescription(rokCommanderCopy.goLiveSoon.announcementBody(lead.label, startUnix, note))
				.setColor(rokCommanderCopy.COLORS.ANNOUNCEMENTS)
				.setFooter({ text: rokCommanderCopy.FOOTER });

			const message = await channel.send({
				content: mention,
				embeds: [embed],
				allowedMentions,
			});

			lastFiredAt.set(guildId, now);

			res.status(200).json({
				data: {
					ok: true,
					messageId: message.id,
					channelId: channel.id,
					leadMinutes: lead.minutes,
					startUnix,
					cooldownMs: COOLDOWN_MS,
				},
			});
		} catch (error) {
			console.error("[go-live-now standalone] unhandled error", error);
			res.status(500).json({ error: "Failed to post announcement" });
		}
	});

	return router;
}
