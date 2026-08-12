import cron from "node-cron";
import { Client, TextChannel } from "discord.js";
import { eventStore } from "@db/stores/eventStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { getUpcomingOccurrences } from "@features/events/occurrenceCalculator.js";
import { fireReminder } from "./ReminderJob.js";
import { reminderStore } from "@db/stores/reminderStore.js";
import { eventOverrideStore } from "@db/stores/eventOverrideStore.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { IGameEvent } from "../events/event.types.js";
import { seasonEndEmbed } from "@utils/embedBuilder.js";
import { refreshAllSchedules, refreshSchedule } from "@features/schedule/ScheduleBoard.js";
import { refreshAllLeaderboards } from "@features/leaderboard/LeaderboardBoard.js";
import { refreshAllLevelsBoards } from "@features/leveling/LevelsBoard.js";
import { sweepExpiredRooms } from "@features/game-rooms/roomArchiveSweep.js";
import { sweepBattleshipTurns } from "@features/game-rooms/roomTurnSweep.js";
import { LOG_MESSAGES } from "@base/constants/log-messages.js";
import { getOutboundLatencyStats } from "@utils/serverApi.js";
import { noteFailure as noteServerFailure, noteSuccess as noteServerSuccess } from "./serverHealthNotifier.js";
import { mapWithConcurrency } from "@utils/mapWithConcurrency.js";
import { activityStore } from "@db/stores/activityStore.js";
import { playerActivityRetentionDays } from "@utils/config.js";

// ── resolveOverride ────────────────────────────────────────────────
// What:  given an event + an original occurrence (the cron-computed fire
//        moment, before any edits), look up an EventOverride keyed on that
//        moment and return a merged event payload + the effective fire
//        moment. When no override exists the function returns the event
//        and occurrence verbatim.
// Who:   called from the per-event loop in startScheduler before computing
//        reminderTime and before the dedup check. fireReminder receives the
//        MERGED event so its embed renders the override values; the dedup
//        check still uses the ORIGINAL occurrence so an override applied
//        between cron ticks does not bypass already-fired reminders.
// When:  per event per cron tick. One Mongo findOne per event per tick;
//        with N guilds × M events per guild this is N*M reads per minute,
//        a load the underlying compound unique index handles trivially.
// Where: sits between the cron tick and fireReminder. ReminderJob.fireReminder
//        does NOT consult EventOverride, only the scheduler does, so the
//        contract is "scheduler resolves overrides, fireReminder posts".
async function resolveOverride(
	event: IGameEvent,
	originalOccurrence: Date
): Promise<{ mergedEvent: IGameEvent; fireMoment: Date }> {
	const override = await eventOverrideStore.findOne({
		eventId: event.eventId,
		originalOccurrence,
	});
	if (!override) {
		return { mergedEvent: event, fireMoment: originalOccurrence };
	}
	const mergedEvent: IGameEvent = {
		...event,
		name: override.overrideTitle ?? event.name,
		description: override.overrideDescription ?? event.description,
	};
	const fireMoment = override.overrideTime ?? originalOccurrence;
	return { mergedEvent, fireMoment };
}

// ── F5 observability: fire-rate counters ──
// What: in-process counters tracking successful and failed reminder fires per hour.
//   Logged on the hourly tick alongside outbound HTTP latency stats so Railway logs
//   surface the platform's health at a glance.
// Who: incremented by the scheduler's per-event branches (one-time + recurring).
//   Read by logHourlyMetrics() below.
// When: reset every hour after the log line, a rolling window means a transient
//   spike doesn't hide behind a wall of healthy historical data.
// Where: per-process counters; multi-instance deployments would need to ship to
//   a central metrics store. Single Railway dyno keeps it simple.
let fireSuccessCount = 0;
let fireFailureCount = 0;

const recordFireSuccess = (): void => {
	fireSuccessCount++;
};
const recordFireFailure = (): void => {
	fireFailureCount++;
};

// ── logHourlyMetrics ──
// Emits a single structured log line per hour with everything operators need to
// catch slow drift before it becomes an outage:
//   - bot→server HTTP latency p50/p95/p99 (cron tick budget is 60s; alert if p99 > 500ms)
//   - reminder fire success/failure counts and rate
const logHourlyMetrics = (): void => {
	const latency = getOutboundLatencyStats();
	const total = fireSuccessCount + fireFailureCount;
	const failureRate = total === 0 ? 0 : fireFailureCount / total;
	console.log(
		`[metrics] outbound_p50=${latency.p50}ms outbound_p95=${latency.p95}ms outbound_p99=${latency.p99}ms ` +
			`outbound_samples=${latency.samples} fires_ok=${fireSuccessCount} fires_failed=${fireFailureCount} ` +
			`failure_rate=${failureRate.toFixed(3)}`
	);
	// Alert thresholds. These are warns (not errors) so a single bad hour does not
	// page anyone, but they ARE louder than info so a log scan catches them. The
	// roadmap (F5) calls out "alert if failure rate > 1% over a 1-hour window",
	// that's the threshold here.
	if (latency.p99 > 500 && latency.samples >= 10) {
		console.warn(`[metrics] outbound_p99 ${latency.p99}ms exceeds 500ms threshold, cron tick may overrun its 60s budget`);
	}
	if (failureRate > 0.01 && total >= 10) {
		console.warn(`[metrics] reminder failure rate ${(failureRate * 100).toFixed(1)}% exceeds 1% threshold over the last hour`);
	}
	// Reset counters for the next window.
	fireSuccessCount = 0;
	fireFailureCount = 0;
};

// ── overlapping-tick guard ───────────────────────────────────────────
// node-cron does NOT skip a scheduled run when the previous one is still
// going. At scale a single per-minute tick can exceed its 60s budget (large
// guild fan-out, remote-event HTTP latency under USE_REMOTE_EVENTS, or an
// unindexed Event scan), and the next minute's tick would then start
// concurrently. Two concurrent ticks both pass the reminderStore.exists()
// dedup check before either writes its row, so both call fireReminder and the
// alliance gets a DUPLICATE ping, the compound unique index only catches the
// second reminderStore.create, after the duplicate Discord post is already
// live. This boolean serializes the per-minute tick within the process: if a
// tick is still running when the next fires, the new one is skipped and the
// in-flight one is allowed to finish. Single-process only; a sharded
// deployment would need a shared lock (Mongo/Redis) keyed per shard.
let reminderTickInProgress = false;

// ── scheduled-task registry ──────────────────────────────────────────
// Holds the node-cron tasks startScheduler creates so stopScheduler can halt
// them on graceful shutdown (SIGTERM from Railway on every deploy). Without
// this, the cron keeps firing while main.ts tears down the client and Mongo
// connection, which can cut a reminder fire between its Discord post and its
// dedup-row write (→ a duplicate on the next boot).
const scheduledTasks: ReturnType<typeof cron.schedule>[] = [];

// ── last tick timestamp (audit L2) ──────────────────────────────────
// Set at the start of every per-minute tick. Exported so the readiness probe
// (/api/health/ready) can report whether the scheduler is actually ticking, not
// just whether the process is up. null until the first tick after boot.
export let lastReminderTickAt: Date | null = null;

export function startScheduler(client: Client): void {
	// ── hourly schedule board safety tick ──
	// every event mutation and reminder fire already triggers a board
	// refresh, but this hourly sweep is the floor. if something failed
	// silently (Discord hiccup, stored messageId deleted, etc) the next
	// hour at minute :00 will re synchronize every guild. node-cron's
	// "0 * * * *" fires at the top of every hour.
	scheduledTasks.push(cron.schedule("0 * * * *", async () => {
		try {
			await refreshAllSchedules(client);
		} catch (error) {
			console.error(LOG_MESSAGES.schedule.hourlyRefreshFailed, error);
		}
		// Leaderboard board floor. Beyond catching silent failures like the
		// schedule sweep, this is what resets the weekly window after a week
		// rollover when no activity happened to trigger a refresh on its own.
		try {
			await refreshAllLeaderboards(client);
		} catch (error) {
			console.error(LOG_MESSAGES.leaderboard.hourlyRefreshFailed, error);
		}
		// Levels board floor, the SECOND board in the same channel. Same reasoning
		// as the leaderboard sweep above and, like it, deliberately separate: the
		// two read different collections and answer different questions, so one
		// failing must not stop the other refreshing.
		try {
			await refreshAllLevelsBoards(client);
		} catch (error) {
			console.error(LOG_MESSAGES.leveling.hourlyRefreshFailed, error);
		}
		// Emit hourly metrics line right after the board sweeps so a single
		// log timestamp captures both. The metrics function never throws.
		logHourlyMetrics();
	}));

	// ── daily PlayerActivity retention sweep (audit H7) ──
	// Off unless the owner sets PLAYER_ACTIVITY_RETENTION_DAYS (> 0). PlayerActivity
	// is leaderboard history, so deletion is opt-in: nothing is pruned until a window
	// is chosen. Runs at 04:00 (low traffic) and only deletes rows whose occurrence is
	// older than the window. Pushed to scheduledTasks so stopScheduler halts it on
	// shutdown. The whole branch is skipped (no cron registered) when the window is 0.
	if (playerActivityRetentionDays > 0) {
		scheduledTasks.push(
			cron.schedule("0 4 * * *", async () => {
				try {
					const cutoff = new Date(Date.now() - playerActivityRetentionDays * 24 * 60 * 60 * 1000);
					const deleted = await activityStore.deleteOlderThan(cutoff);
					console.log(
						`[retention] pruned ${deleted} PlayerActivity row(s) older than ${playerActivityRetentionDays}d (before ${cutoff.toISOString()})`
					);
				} catch (err) {
					console.error("[retention] PlayerActivity cleanup failed", err);
				}
			})
		);
	}

	// ── game room archive sweep (game rooms Phase 3) ──
	// Deletes the channel of every finished room past its archiveAt. Its OWN cron and
	// deliberately not a passenger on the per-minute tick below: that tick has a 60s
	// budget and an overlap guard, and a guild that let a backlog of rooms expire while
	// the bot was down would fan out enough channel deletes to blow both.
	//
	// Unconditional, unlike the retention sweep above: this deletes a CHANNEL whose
	// transcript is already safe in Mongo, not the historical record itself, so there is
	// nothing here for an owner to opt into. Pushed to scheduledTasks so stopScheduler
	// halts it on Railway's SIGTERM; without that the sweep would keep firing while
	// main.ts tears the client down and a delete could land against a dead connection.
	scheduledTasks.push(
		cron.schedule(BOT_CONSTANTS.GAME_ROOM_SWEEP_CRON, async () => {
			try {
				// Two sweeps on ONE tick, in this order and not two crons. The turn
				// sweep can FINISH a match, which stamps archiveAt; running it first
				// would then let the archive sweep consider a room that has been
				// finished for zero seconds, and its four hour window means it is not
				// due anyway. Running it second keeps each tick's work to one pass over
				// each concern, and a second cron for one game's clock would cost a
				// tick across every guild to save a casual player five minutes.
				await sweepExpiredRooms(client);
				await sweepBattleshipTurns(client);
			} catch (err) {
				// sweepExpiredRooms already isolates per room, so reaching this means the
				// QUERY itself failed. Log and let the next tick retry; the rooms are
				// still stamped and nothing is lost by waiting five minutes.
				console.error("[game-rooms] archive sweep tick failed", err);
			}
		})
	);

	scheduledTasks.push(cron.schedule(BOT_CONSTANTS.SCHEDULER_CRON, async () => {
		// Skip this run if the previous minute's tick has not finished. See the
		// reminderTickInProgress comment above for why a concurrent tick would
		// double-fire reminders. A skipped minute is self-correcting: the next
		// tick re-scans the same fire window and catches anything still due.
		if (reminderTickInProgress) {
			console.warn(LOG_MESSAGES.scheduler.tickOverlapSkipped);
			return;
		}
		reminderTickInProgress = true;
		lastReminderTickAt = new Date(); // audit L2: the readiness probe reads this
		try {
			// ① Fetch all active events for every guild this bot is in.
			//
			// Why we iterate guilds instead of calling eventStore.findAll():
			//   The Future-A remote API (USE_REMOTE_EVENTS=true) requires a guildId
			//   on every read so the platform server can apply HMAC verification AND
			//   confirm the guild belongs to an installed app. A global-scan endpoint
			//   would expose every guild's events in one signed call, which we do not
			//   want. Iterating client.guilds.cache and calling findByGuildId per
			//   guild keeps the scope tight in both modes; the local-DB mode is just
			//   as fast since the index on { guildId, active } is the same shape.
			//
			// Cache reuse: remoteEventStore caches list reads for 60s keyed by guildId.
			// The scheduler runs every minute so we hit the cache exactly when we want
			// (every other tick), saving the HTTP call on the cold path while still
			// surfacing fresh data within one tick of any write.
			const guildIds = Array.from(client.guilds.cache.keys());
			// Track whether any guild succeeded so we can call noteServerSuccess
			// at most once per tick, each individual guild call doesn't trigger
			// the recovery DM, only "tick had at least one success" does.
			let anySuccess = false;
			let anyUnreachable = false;
			// Fetch events AND guild config per guild in parallel. The config
			// carries the schedule-level pause state (schedulePaused) which we
			// honor BEFORE the per-event paused check below, when the
			// schedule is paused, every event in this guild is skipped this
			// tick regardless of its individual paused flag.
			// Bounded fan-out: read at most SCHEDULER_GUILD_CONCURRENCY guilds at
			// once instead of one unbounded Promise.all over every guild. At scale
			// the unbounded form opened one DB/HTTP call per guild simultaneously,
			// saturating the pool and risking a tick that overruns its 60s budget.
			const guildDataByGuild = await mapWithConcurrency(
				guildIds,
				BOT_CONSTANTS.SCHEDULER_GUILD_CONCURRENCY,
				async (guildId) => {
					try {
						const [e, config] = await Promise.all([
							eventStore.findByGuildId(guildId),
							guildConfigStore.findByGuildId(guildId),
						]);
						anySuccess = true;
						return { guildId, events: e, config };
					} catch (err) {
						// One guild's failure should not block the rest. The remote API
						// will eventually return; the next tick will catch up. Logging
						// at warn (not error) because brief Heroku blips are routine.
						console.warn(LOG_MESSAGES.api.errorFindingEvents, { guildId, err });
						// Notify health tracker, only ServerUnreachableError counts
						// as a platform outage; other errors (validation, auth) don't.
						noteServerFailure(client, err);
						anyUnreachable = true;
						return { guildId, events: [] as IGameEvent[], config: null };
					}
				}
			);

			// Apply schedule-level pause filtering. For each guild whose
			// schedulePaused.paused is true, drop all its events from the
			// processing list. Auto-resume parallels the per-event pattern
			// below: if pausedUntil has elapsed, clear the flag and let
			// events flow through this tick.
			const eventsByGuild: IGameEvent[][] = [];
			for (const { guildId, events: guildEvents, config } of guildDataByGuild) {
				// Skip self-destructed guilds entirely. Their homebase channels are
				// gone, so every fire would throw fetching the deleted announcements
				// channel and log a failure each tick (tripping the F5 alarm). Mirrors
				// the ensureHomebase / ChannelDeleteWatcher gates; cleared by /setup.
				if ((config as unknown as { homebaseDestroyed?: boolean } | null)?.homebaseDestroyed) continue;

				const schedulePaused = (config as unknown as { schedulePaused?: { paused?: boolean; pausedUntil?: Date | null } } | null)?.schedulePaused;
				if (schedulePaused?.paused) {
					const pausedUntil = schedulePaused.pausedUntil;
					if (pausedUntil && Date.now() >= new Date(pausedUntil).getTime()) {
						// Auto-resume from schedule-level pause. Clear the flag
						// and fall through so this guild's events process this
						// tick. The board refresh below will pick up the new
						// state on its next pass.
						try {
							await guildConfigStore.update(guildId, {
								schedulePaused: { paused: false, pausedUntil: null },
							});
						} catch (err) {
							console.warn("[scheduler] schedule-level auto-resume write failed", { guildId, err });
						}
					} else {
						// Still paused. Skip every event for this guild this tick.
						continue;
					}
				}
				eventsByGuild.push(guildEvents);
			}
			// Drive the success/failure tracker once per tick instead of once
			// per guild so a partial outage doesn't toggle state on every guild.
			if (anySuccess) noteServerSuccess(client);
			else if (anyUnreachable) {
				// All guilds failed AND at least one was a server-unreachable error.
				// noteFailure was already called per-guild; nothing to do here.
			}
			const events: IGameEvent[] = eventsByGuild.flat() as IGameEvent[];

			for (const event of events) {
				const now = new Date();

				// ── auto-resume from paused ──────────────────────────────
				// Run BEFORE the paused skip check so a pause whose timer
				// just expired resumes on this same tick instead of waiting
				// one more cycle (a 60s delay is fine, but it would also
				// silently delay the very first reminder if the next
				// occurrence is also overdue, the cleaner contract is
				// "auto-resume always wins on the tick it fires"). Both
				// fields are cleared so the event behaves as if pause never
				// happened: ReminderScheduler can fire, ScheduleBoard drops
				// the paused tag on its next refresh.
				if (event.paused && event.pausedUntil && now.getTime() >= new Date(event.pausedUntil).getTime()) {
					await eventStore.updateInGuild(event.eventId, event.guildId, { paused: false, pausedUntil: null });
					event.paused = false;
					event.pausedUntil = null;
					// fall through into the rest of the loop
				}

				// ── paused ───────────────────────────────────────────────
				// Streamers (and anyone else) can pause an event from the
				// dashboard or via /pause-schedule. Paused events stay in
				// the DB, still render on the schedule board (with a
				// "paused" tag rendered by ScheduleBoard), still appear in
				// /event-list, they simply skip the fire decision until
				// /continue-schedule flips paused back to false.
				//
				// Why this lives BEFORE the seasonEnd check: a paused
				// event whose seasonEnd happens to pass while it is paused
				// should NOT auto archive. The streamer paused on purpose;
				// archiving behind their back would silently destroy the
				// schedule they configured. Skipping the whole loop body
				// keeps both the season-end branch and the fire branch
				// inert until they explicitly resume.
				if (event.paused) continue;

				// ── season ended ─────────────────────────────────────────
				// Skip the season-end branch entirely for events without a
				// seasonEnd (regular announcements, announcementType
				// "regular"). Without this guard, new Date(null) becomes
				// 1970-01-01 and every regular event would get archived
				// and "season ended" announced on the very next tick. The
				// happy path (legacy KvK events with a real Date) is
				// unchanged.
				if (event.seasonEnd && now > new Date(event.seasonEnd)) {
					// Soft-delete, not a generic update: under remote mode the server's PATCH endpoint
					// does not accept `active` in the field whitelist (the soft-delete is its own DELETE
					// route). deleteInGuild routes to the right endpoint for both modes.
					await eventStore.deleteInGuild(event.eventId, event.guildId);
					await announceSeasonEnd(client, event);
					continue;
				}

				if (event.type === "one-time") {
					// ── one-time events (kau karuak difficulties) ───────────
					// Override resolution runs ONCE per event per tick (outside
					// the offsets loop) so we don't pay an extra Mongo round-trip
					// per offset. The merged event flows into fireReminder; the
					// fireMoment shifts the reminder-window math.
					const { mergedEvent, fireMoment } = await resolveOverride(event, event.firstOccurrence);

					for (const offsetMinutes of event.reminderOffsets) {
						const reminderTime = new Date(fireMoment.getTime() - offsetMinutes * 60 * 1000);
						const diff = reminderTime.getTime() - now.getTime();

						if (diff < 0 || diff > BOT_CONSTANTS.REMINDER_FIRE_WINDOW_MS) continue;

						// Dedup key remains the ORIGINAL firstOccurrence so an
						// override applied between cron ticks cannot bypass an
						// already-fired reminder. The compound index
						// (eventId, eventOccurrence, offsetMinutes) anchors on
						// the schedule's source of truth, not the override.
						const alreadyFired = await reminderStore.exists({
							eventId: event.eventId,
							eventOccurrence: event.firstOccurrence,
							offsetMinutes,
						});
						if (alreadyFired) continue;

						// Wrap fire in success/failure metrics. fireReminder swallows its own
						// Discord errors (channel missing, permission denied), so we only see
						// throws on truly unexpected failures, but counting both branches
						// gives operators a real signal in the hourly metric log.
						try {
							await fireReminder(client, mergedEvent, fireMoment, offsetMinutes);
							recordFireSuccess();
						} catch (err) {
							recordFireFailure();
							console.error(LOG_MESSAGES.api.errorTestReminder ?? "fireReminder failed", err);
						}

						// deactivate after the last reminder fires
						// so it doesn't keep getting checked every tick
						if (offsetMinutes === Math.min(...event.reminderOffsets)) {
							// Soft-delete, not a generic update: under remote mode the server's PATCH endpoint
							// does not accept `active` in the field whitelist (the soft-delete is its own DELETE
							// route). deleteInGuild routes to the right endpoint for both modes.
							await eventStore.deleteInGuild(event.eventId, event.guildId);
						}
					}
				} else {
					// ── recurring events (ruins, altar) ────────────────────
					const [nextOccurrence] = getUpcomingOccurrences(event, 1);
					if (!nextOccurrence) continue;

					const { mergedEvent, fireMoment } = await resolveOverride(event, nextOccurrence);

					for (const offsetMinutes of event.reminderOffsets) {
						const reminderTime = new Date(fireMoment.getTime() - offsetMinutes * 60 * 1000);
						const diff = reminderTime.getTime() - now.getTime();

						if (diff < 0 || diff > BOT_CONSTANTS.REMINDER_FIRE_WINDOW_MS) continue;

						// Same rationale as the one-time branch: dedup keys on
						// the original computed occurrence, not on the override
						// moment. See resolveOverride above.
						const alreadyFired = await reminderStore.exists({
							eventId: event.eventId,
							eventOccurrence: nextOccurrence,
							offsetMinutes,
						});
						if (alreadyFired) continue;

						try {
							await fireReminder(client, mergedEvent, fireMoment, offsetMinutes);
							recordFireSuccess();
						} catch (err) {
							recordFireFailure();
							console.error(LOG_MESSAGES.api.errorTestReminder ?? "fireReminder failed", err);
						}
					}
				}
			}
		} catch (error) {
			console.error(LOG_MESSAGES.scheduler.tickError, error);
		} finally {
			// Always clear the guard, even if the tick threw, so a single failed
			// tick cannot wedge the scheduler permanently in the "in progress"
			// state and silence every future reminder.
			reminderTickInProgress = false;
		}
	}));
}

// ── stopScheduler ────────────────────────────────────────────────────
// Halt every cron task started by startScheduler. Called from main.ts'
// graceful-shutdown handler so no new tick begins while the bot is tearing
// down its Discord client and Mongo connection. Best-effort: a task that
// refuses to stop is logged-and-skipped rather than blocking shutdown.
export function stopScheduler(): void {
	for (const task of scheduledTasks) {
		try {
			task.stop();
		} catch (err) {
			console.warn("[scheduler] failed to stop a cron task during shutdown", err);
		}
	}
	scheduledTasks.length = 0;
}

export async function announceSeasonEnd(client: Client, event: IGameEvent): Promise<void> {
	try {
		// resolve the same way as fireReminder: always the guild's configured
		// announcements channel, no per-event override.
		const config = await guildConfigStore.findByGuildId(event.guildId);
		const targetChannelId = config?.announcementsChannelId ?? null;
		if (!targetChannelId) {
			console.error(LOG_MESSAGES.scheduler.seasonEndNoChannel(event.guildId));
			return;
		}

		const channel = await client.channels.fetch(targetChannelId).catch(() => null);
		if (!channel || !(channel instanceof TextChannel)) return;

		// belt and suspenders: the caller already gates on event.seasonEnd
		// being truthy, so this assertion narrows the type for the two
		// new Date() calls below without a non-null bang. If we ever
		// reach here with a null value it is a programmer error upstream
		// and a thrown error is more useful than a silently corrupt
		// reminder log row keyed off the unix epoch.
		if (!event.seasonEnd) {
			console.error(LOG_MESSAGES.scheduler.seasonEndCalledWithoutDate(event.guildId, event.eventId));
			return;
		}
		// Extract once so both the dedup `exists()` lookup and the
		// `create()` write key off the same Date object. Without this
		// shared reference, a future refactor that mutates event.seasonEnd
		// between the two reads (or moves the truthy guard) could land
		// `eventOccurrence: 1970-01-01` on the create, silently
		// breaking dedup since 1970-01-01 is a fixed-point epoch zero
		// every guild would collide on.
		const seasonEndDate = new Date(event.seasonEnd);

		// ── guild-scoped dedup ───────────────────────────────────
		// What:  one season-end announcement per guild per season, not
		//        one per event. The previous keying on event.eventId
		//        meant a guild with N expired events received N copies
		//        of the same "kingdom stands down" embed in the same
		//        cron tick (six in production: ruins, altar, four kau
		//        difficulties).
		// Who:   read+written by this function only. The composite key
		//        (eventId + eventOccurrence + offsetMinutes) in
		//        reminderStore is what gates the channel.send below;
		//        widening eventId to a guild-scoped synthetic key turns
		//        the per-event slot into a per-guild slot. eventOccurrence
		//        stays anchored on event.seasonEnd so a new season (with
		//        a different seasonEnd date) gets its own slot and is
		//        not silenced by the previous season's record.
		// When:  every cron tick that finds at least one expired event
		//        in a guild. The first event creates the record, every
		//        subsequent event in the same guild finds it and short
		//        circuits the channel.send.
		// Where: the loop in startReminderScheduler() is sequential
		//        (for-of with await), so the first call's create() lands
		//        before the second call's exists() runs, no TOCTOU race
		//        within a single tick. Across ticks, the record persists
		//        in reminderStore so the second tick is also a no-op.
		// How:   prefix "season-end:" + event.guildId. The "season-end:"
		//        prefix prevents any future eventId collision with a
		//        real Mongo ObjectId/uuid.
		const guildSeasonKey = `season-end:${event.guildId}`;

		const alreadyAnnounced = await reminderStore.exists({
			eventId: guildSeasonKey,
			eventOccurrence: seasonEndDate,
			offsetMinutes: -1, // ← -1 is a special marker meaning "season end announcement"
		});
		if (alreadyAnnounced) return;

		const embed = seasonEndEmbed();

		// ── crash-window trade-off ───────────────────────────────
		// What:  channel.send fires BEFORE reminderStore.create. If
		//        the process crashes between these two awaits the
		//        dedup row is never persisted and the next cron tick
		//        re-announces (duplicate post in #announcements).
		// Who:   the operator. A duplicate is visible and an admin
		//        can delete the second copy. The inverse ordering
		//        (write the row first, send second) would trade the
		//        duplicate for a silent miss: a Discord 5xx or
		//        permission change after the row lands blocks every
		//        retry on subsequent ticks and the season-end is
		//        skipped without a user-visible signal, a worse
		//        failure mode.
		// When:  the crash window between these two awaits is
		//        sub-second on a healthy host, so a duplicate is the
		//        right cost to pay for guaranteed delivery on every
		//        uncrashed run.
		// Where: any change to this ordering must update the unit
		//        coverage in ReminderScheduler.test.ts which asserts
		//        the post-then-write sequence.
		await channel.send({ embeds: [embed] });

		// log it so we never announce twice. Same guild-scoped key as
		// the exists() check above so subsequent ticks (and subsequent
		// expired events in the same tick) find it on lookup.
		await reminderStore.create({
			eventId: guildSeasonKey,
			eventOccurrence: seasonEndDate,
			offsetMinutes: -1, // ← same special marker
			messageId: "season-end",
			channelId: targetChannelId,
			firedAt: new Date(),
		});

		// flip the pinned schedule board into its "season ended" state. fire
		// and forget so a Discord error here does not prevent the season end
		// log write above from being considered successful.
		refreshSchedule(client, event.guildId).catch((err) => console.error(LOG_MESSAGES.schedule.refreshAfterSeasonEndFailed, err));
	} catch (error) {
		console.error(LOG_MESSAGES.scheduler.seasonEndFailed, error);
	}
}
