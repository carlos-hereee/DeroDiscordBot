import { Client, EmbedBuilder } from "discord.js";
import { getServerReachabilityState } from "@utils/serverApi.js";
import { creatorId } from "@utils/config.js";
import { COLORS, FOOTER } from "@base/copy/brand.js";

// ── outageWatcher ──
// What: polls serverApi's reachability state on a 60-second tick. When the bot
//   has been failing to reach nexious-server continuously for 5 minutes, DMs
//   the platform owner once. When the server becomes reachable again after a
//   notice was already sent, DMs a recovery notice once. Idempotent, does not
//   spam the owner during a long outage, does not send duplicate recovery
//   notices on a flapping outage.
// Who: registered from main.ts after the Discord client is ready. Reads
//   serverApi.getServerReachabilityState() (no direct coupling to the request
//   path) and creatorId from config (the platform owner's Discord user ID).
// When: every 60 seconds for the lifetime of the process. Cheap, one read of
//   in-memory state plus a comparison. The DM only fires on threshold crossing.
// Where: lives in features/observability/ alongside any future ops-side code
//   (latency alerts, fire-rate alerts, etc). Fire-and-forget; failures DMing
//   the owner are logged and swallowed because there is no higher escalation
//   path inside the bot.
// How:
//   ① On every tick read the reachability state from serverApi.
//   ② If currentlyFailing AND failureDurationMs >= threshold AND we have not
//      already sent a notice for this outage → send the outage DM, mark
//      noticeFiredAt = now.
//   ③ If NOT currentlyFailing AND a notice was previously sent (noticeFiredAt
//      is set) → send the recovery DM, clear noticeFiredAt.
//   ④ Otherwise no-op. Most ticks are no-ops because the server is reachable.

// The threshold is deliberately generous. A short outage (Heroku slow-warming
// after sleep, transient DNS hiccup) should NOT page the owner. Five minutes
// is long enough that anything tripping it is real, short enough that the
// owner can act before the cron tick falls behind on a meaningful number of
// reminders.
const OUTAGE_THRESHOLD_MS = 5 * 60 * 1000;

// Tick cadence. 60s matches the bot's other periodic work (cron tick, cache
// TTL) so we never miss a state transition by more than one cycle.
const TICK_INTERVAL_MS = 60 * 1000;

// In-memory record of when we last DM'd the owner about an outage. Null means
// "no notice currently outstanding." Set to a timestamp when a notice fires;
// cleared when recovery fires. Survives only as long as the process, a bot
// restart resets the outage state to "no notice outstanding," which is the
// right behavior because the owner already knows the bot is up if it just
// restarted.
let noticeFiredAt: number | null = null;

// Public so tests (or a future /metrics endpoint) can introspect the watcher
// state without poking module internals.
export const getOutageNoticeState = (): { noticeFiredAt: number | null } => ({ noticeFiredAt });

const outageEmbed = (failureDurationMinutes: number): EmbedBuilder =>
	new EmbedBuilder()
		.setTitle("⚠️ Dero Discord Bot: platform unreachable")
		.setDescription(
			[
				`The bot has been unable to reach nexious-server for **${failureDurationMinutes} minutes**.`,
				"",
				"While this continues:",
				"• Reminder fires for guilds with cached events keep working until the 60-second cache TTL expires.",
				"• Slash commands that try to write events will fail with a user-facing error.",
				"• The dashboard's calendar view will likely error too (it reads the same server).",
				"",
				"**Most likely causes:** Heroku is restarting, the server crashed, or DNS/network between Railway and Heroku is degraded.",
				"",
				"This DM fires once per outage. You will get a recovery DM when the server becomes reachable again.",
			].join("\n")
		)
		.setColor(COLORS.ERROR)
		.setFooter({ text: FOOTER });

const recoveryEmbed = (outageDurationMinutes: number): EmbedBuilder =>
	new EmbedBuilder()
		.setTitle("✅ Dero Discord Bot: platform reachable again")
		.setDescription(
			[
				`nexious-server is responding to the bot again after a **${outageDurationMinutes}-minute** outage.`,
				"",
				"Cron tick should resume reading fresh events on its next cycle (within 60 seconds).",
				"",
				"If you saw user-visible reminder failures during the outage window, check the bot logs for `ServerUnreachableError` to confirm the timing.",
			].join("\n")
		)
		.setColor(COLORS.SCHEDULE)
		.setFooter({ text: FOOTER });

const dmOwner = async (client: Client, embed: EmbedBuilder): Promise<void> => {
	if (!creatorId) {
		// No CREATOR_DISCORD_ID configured, log instead of throwing so the
		// watcher keeps running. Operators who care about outage alerts will
		// notice this in startup logs and set the env var.
		console.warn(
			"[outageWatcher] CREATOR_DISCORD_ID not set; cannot DM platform owner about outage. Set it on Railway and restart."
		);
		return;
	}
	try {
		const user = await client.users.fetch(creatorId);
		await user.send({ embeds: [embed] });
	} catch (err) {
		// DM failure means the owner has DMs disabled, blocked the bot, or
		// the user id is wrong. We log loudly because there is no other
		// channel for outage alerts; otherwise an outage would happen and
		// nobody would know.
		console.error("[outageWatcher] failed to DM platform owner about outage state change:", err);
	}
};

export const registerOutageWatcher = (client: Client): void => {
	// Run on a setInterval rather than node-cron because (a) the cadence is
	// dead simple, (b) we do not need cron's calendar-aware scheduling, and
	// (c) keeping this off cron avoids any risk of a scheduler-tick collision
	// blocking the watcher tick.
	setInterval(async () => {
		try {
			const state = getServerReachabilityState();

			// ① Outage threshold crossed and no notice outstanding yet.
			if (state.currentlyFailing && state.failureDurationMs >= OUTAGE_THRESHOLD_MS && noticeFiredAt === null) {
				const minutes = Math.floor(state.failureDurationMs / 60_000);
				console.warn(
					`[outageWatcher] server unreachable for ${minutes} minute(s), DMing platform owner`
				);
				await dmOwner(client, outageEmbed(minutes));
				noticeFiredAt = Date.now();
				return;
			}

			// ② Recovery: server is reachable AND we previously fired an outage notice.
			if (!state.currentlyFailing && noticeFiredAt !== null) {
				const outageDurationMs = Date.now() - noticeFiredAt;
				const minutes = Math.floor(outageDurationMs / 60_000);
				console.log(
					`[outageWatcher] server reachable again after ~${minutes} minute(s), DMing platform owner`
				);
				await dmOwner(client, recoveryEmbed(minutes));
				noticeFiredAt = null;
				return;
			}
			// ③ All other states are no-ops: not failing yet (most ticks),
			// failing but below threshold, failing with notice already sent.
		} catch (err) {
			// Defensive: the watcher itself must never crash the bot. Swallow
			// any error so the next tick still runs.
			console.error("[outageWatcher] tick failed:", err);
		}
	}, TICK_INTERVAL_MS);

	console.log(
		`[outageWatcher] registered, will DM platform owner if server is unreachable for >= ${OUTAGE_THRESHOLD_MS / 60_000} minute(s)`
	);
};
