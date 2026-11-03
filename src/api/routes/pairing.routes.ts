import { Router, Request, Response } from "express";
import { pendingPairingStore } from "@db/stores/pendingPairingStore.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { BOT_LOG_EVENTS } from "@base/constants/BOT_LOG_EVENTS.js";

// ── /api/pairing/redeem (FUTURE_PLANS item 63, Phase 2) ────────────────
// What:  exchanges a one-time pairing code (issued + DM'd to the guild owner
//        on guildCreate in Phase 1) for the guildId + ownerUserId the code
//        was issued for. The platform server uses the returned guildId to
//        bind this Discord guild into the user's pluginConfig.
// Who:   nexious-server's plugin-proxy forwards the dashboard's "Claim
//        server" form POST to this endpoint. No other caller. The signed
//        proxy is the only entry point because verifySignature gates every
//        /api/* route, there is no Discord-side redemption surface by
//        design (the binding has to land in the platform's pluginConfig,
//        which the bot does not own).
// When:  every successful paste of a claim code into the Company Uno
//        dashboard's plugin panel.
// Where: mounted at /api/pairing under verifySignature in server.ts.
//        Deliberately does NOT carry a ?guildId= query param because the
//        code IS the discriminator, the platform server does not know
//        which guild the code came from until this endpoint tells it.
// How:
//   ① Validate body.code is a non-empty string (400 otherwise). The store
//      handles trim + uppercase normalization, so we pass the raw input
//      through. Empty/whitespace is rejected here because the store would
//      end up running findOneAndUpdate with code:"" which a future schema
//      change could match in unexpected ways.
//   ② Call pendingPairingStore.redeem. The store collapses invalid,
//      expired, and already-consumed into a single null return, deliberate
//      so this endpoint is not an oracle a probing attacker can use to
//      distinguish "code does not exist" from "code is in use." We mirror
//      the collapse with a single 410 Gone response shape for every miss.
//      410 (not 404) because the resource-semantically-existed-but-is-no-
//      longer-redeemable framing fits "expired or consumed" more honestly
//      than the generic "not found."
//   ③ Log PAIRING_REDEEMED via botLogStore. CRITICAL: this log must not
//      block or fail the response. Once redeem returns a doc the code is
//      already atomically consumed (single-use). If we returned 500 on a
//      log failure the platform would retry, get a 410 on the now-consumed
//      code, and never learn the guildId, the code becomes a black hole
//      and the user sees "claim failed" even though the bind data exists.
//      So we try/catch the log call locally and degrade analytics rather
//      than redemption. Metadata key is `ownerId` (not ownerUserId) so it
//      joins cleanly to PAIRING_CODE_SENT's `{ ownerId }` for funnel
//      queries, same shape across both events even though the underlying
//      model field is named `ownerUserId`.
//   ④ Return { data: { guildId, ownerUserId, consumedAt } }. consumedAt
//      lets the platform server stamp the bind row with the moment of
//      redemption without a second round trip. Envelope shape matches the
//      autoHeal/events route convention.
//   ⑤ A 500 wraps any unexpected redeem throw so a Mongo blip surfaces as
//      a transient retryable failure rather than leaking the underlying
//      error to the dashboard. The signed-proxy caller logs the bot-side
//      detail server-side; we keep the body sparse here. A redeem throw
//      is safe to retry: findOneAndUpdate is atomic, so either the code
//      was consumed (next call returns 410, never a double-bind) or it
//      was not consumed (next call succeeds).

interface RedeemBody {
	code?: unknown;
}

export function createPairingRouter(): Router {
	const router = Router();

	router.post("/redeem", async (req: Request, res: Response) => {
		try {
			const body = (req.body ?? {}) as RedeemBody;
			const rawCode = body.code;

			// ① body validation. Reject anything that is not a populated string.
			// Whitespace-only is treated as missing because the store would
			// normalize it down to "" and we want the 400 here, not a 410 that
			// looks like a real lookup miss.
			if (typeof rawCode !== "string" || rawCode.trim().length === 0) {
				res.status(400).json({
					error: "Invalid body",
					detail: "code must be a non-empty string",
				});
				return;
			}

			// ② atomic single-use redeem. Store re-uppercases, re-checks
			// expiresAt against the TTL monitor lag, and returns null on any miss.
			const doc = await pendingPairingStore.redeem(rawCode);

			if (!doc) {
				// ② collapsed miss response. Single body for invalid, expired,
				// or already-consumed so a probing caller cannot distinguish.
				res.status(410).json({
					error: "Pairing code is invalid or expired",
				});
				return;
			}

			// ③ funnel close. Local try/catch because the redeem is already
			// committed atomically; a log failure here must not turn into a
			// 500 that the platform retries (it would get 410 on retry, the
			// code is now consumed, and the user would see "claim failed"
			// for a successful claim). Degrade analytics, not redemption.
			// Metadata key `ownerId` matches PAIRING_CODE_SENT's shape so a
			// single funnel query can join the two on guildId + slice by
			// ownerId without translating field names.
			try {
				await botLogStore.log(doc.guildId, BOT_LOG_EVENTS.PAIRING_REDEEMED, {
					ownerId: doc.ownerUserId,
				});
			} catch (logError) {
				console.warn("[pairing route] PAIRING_REDEEMED log failed; redemption succeeded", logError);
			}

			// ④ envelope mirrors autoHeal/events: { data: ... } so the dashboard
			// can branch on res.body.data without negotiating a second response
			// shape per route.
			res.status(200).json({
				data: {
					guildId: doc.guildId,
					ownerUserId: doc.ownerUserId,
					consumedAt: doc.consumedAt,
				},
			});
		} catch (error) {
			// ⑤ generic 500. Body kept sparse, the signed proxy caller logs
			// detail server-side and a probing attacker should not learn
			// anything from a transient Mongo failure.
			console.error("[pairing route] unhandled error during redeem", error);
			res.status(500).json({ error: "Failed to redeem pairing code" });
		}
	});

	return router;
}
