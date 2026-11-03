import { Client } from "discord.js";
import { ServerUnreachableError } from "@utils/serverApi.js";
import { creatorId } from "@utils/config.js";

// ── serverHealthNotifier ──
// What: trips an owner-DM notice after the bot has been failing to reach the
//   nexious-server continuously for 5 minutes. Resets when a call succeeds.
//   Mirrors the M9.3 ops posture in the bot CLAUDE.md.
// Who: called once per call attempt by callers that want this behavior. The
//   scheduler's per-guild fetch is the primary call site, every cron tick
//   either succeeds or fails, and the notifier accumulates across ticks.
// When: the owner gets at most ONE DM per outage. The flag stays set until
//   `noteSuccess()` is called, then the next outage can re-trip.
// Where: pure module-state. Not persisted across bot restarts (a restart resets
//   the timer, which is the right behavior, if the bot restarted, the outage
//   may have just been the bot itself).
// How:
//   ① noteFailure(err) records the first failure timestamp if not already set.
//      If 5 minutes have elapsed since that timestamp AND we have not yet
//      sent a notice for this outage, DM the creator.
//   ② noteSuccess() clears all state so the next failure starts a fresh timer.
//   ③ Errors that aren't ServerUnreachableError don't count, those are 4xx
//      validation issues and should not page the owner.

const OUTAGE_THRESHOLD_MS = 5 * 60 * 1000;

interface OutageState {
	firstFailureAt: number | null;
	noticeSentForThisOutage: boolean;
}

const state: OutageState = {
	firstFailureAt: null,
	noticeSentForThisOutage: false,
};

// Public for tests; production never reads this.
export const _peekState = (): Readonly<OutageState> => state;

// ── noteFailure ──
// Record an outbound call failure. If the failure type indicates the platform
// server is unreachable AND we've been failing for >= 5 minutes AND we haven't
// already DM'd the owner for this outage, send the DM.
//
// Discord side effects are fire-and-forget: a failure to DM (e.g. owner blocked
// the bot, DMs disabled) logs but does not throw, because the caller is
// already in an error path and we don't want to compound the failure.
export const noteFailure = (client: Client, err: unknown): void => {
	// Only count "server unreachable", ignore validation errors, signature
	// mismatches, etc. Those are not platform-down conditions.
	const isUnreachable = err instanceof ServerUnreachableError;
	if (!isUnreachable) return;

	const now = Date.now();
	if (state.firstFailureAt === null) {
		state.firstFailureAt = now;
		state.noticeSentForThisOutage = false;
		return;
	}

	const outageDuration = now - state.firstFailureAt;
	if (outageDuration < OUTAGE_THRESHOLD_MS) return;
	if (state.noticeSentForThisOutage) return;
	if (!creatorId) {
		console.warn(
			`[serverHealthNotifier] platform unreachable for ${Math.round(outageDuration / 1000)}s but CREATOR_DISCORD_ID is not set; cannot DM owner`
		);
		state.noticeSentForThisOutage = true; // suppress further log spam this outage
		return;
	}

	// Mark sent BEFORE awaiting so a slow Discord API call doesn't allow a
	// concurrent caller to also send. The notice goes once per outage even if
	// Discord briefly fails, we'll log the Discord failure and move on.
	state.noticeSentForThisOutage = true;

	(async () => {
		try {
			const user = await client.users.fetch(creatorId);
			const minutes = Math.round(outageDuration / 60_000);
			await user.send(
				`⚠️ **Platform server unreachable**\n` +
					`The bot has been unable to reach nexious-server for ${minutes} minute${minutes === 1 ? "" : "s"}. ` +
					`Reminder reads are falling back to the 60-second cache; new reminder writes from slash commands will fail with a "platform unreachable" message until the server recovers.\n\n` +
					`Check Heroku status. The bot will auto-recover when the server is reachable again.`
			);
			console.warn(
				`[serverHealthNotifier] sent owner notice (outage duration ${minutes}m)`
			);
		} catch (dmErr) {
			console.error("[serverHealthNotifier] failed to DM owner:", dmErr);
		}
	})();
};

// ── noteSuccess ──
// Clear the outage state. Called after any successful outbound call so the
// next failure starts a fresh 5-minute timer. Idempotent: calling repeatedly
// during steady-state operation is a no-op.
export const noteSuccess = (client: Client): void => {
	if (state.firstFailureAt === null) return;
	const recoveredAfterMs = Date.now() - state.firstFailureAt;
	const wasNoticed = state.noticeSentForThisOutage;
	state.firstFailureAt = null;
	state.noticeSentForThisOutage = false;
	// Only DM the recovery message if we'd previously DM'd the outage, no
	// point pinging the owner with "recovered" if they never knew about it.
	if (wasNoticed && creatorId) {
		(async () => {
			try {
				const user = await client.users.fetch(creatorId);
				const minutes = Math.round(recoveredAfterMs / 60_000);
				await user.send(
					`✅ **Platform server recovered**\n` +
						`nexious-server is reachable again after ${minutes} minute${minutes === 1 ? "" : "s"}. ` +
						`Reminder firing has resumed normal operation.`
				);
			} catch (dmErr) {
				console.error("[serverHealthNotifier] failed to DM recovery notice:", dmErr);
			}
		})();
	}
};
