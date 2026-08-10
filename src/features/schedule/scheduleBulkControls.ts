import { eventStore } from "@db/stores/eventStore.js";

// ── scheduleBulkControls ───────────────────────────────────────────────
// Guild-wide pause/resume primitives extracted so the schedule channel
// power-up button (v1.6 Phase 5, item 36) can reuse the bulk logic. A single
// button cannot pick an event the way /pause-schedule does, so the channel
// control operates on every event at once, the same intent as the
// /pause-all-schedules and /continue-all-schedules commands.
//
// DEBT: those two commands still carry equivalent inline loops. They predate
// this helper and were intentionally left untouched (narrow change); a future
// cleanup pass can route them through these functions too.

export interface IBulkScheduleResult {
	// every event in the guild, paused or not
	total: number;
	// events this call actually flipped
	changed: number;
	// events already in the target state (skipped to preserve any per-event
	// pausedUntil the streamer set individually)
	skipped: number;
	// events whose write threw
	failed: number;
}

// Pause every not-yet-paused event in the guild. pausedUntil is cleared to null
// (indefinite), the button is the no-argument panic switch; the slash command
// remains the path for a timed pause.
export async function pauseAllGuildEvents(guildId: string): Promise<IBulkScheduleResult> {
	const events = await eventStore.findByGuildId(guildId);
	const toPause = events.filter((event) => !event.paused);
	let changed = 0;
	let failed = 0;
	for (const event of toPause) {
		try {
			await eventStore.updateInGuild(event.eventId, guildId, { paused: true, pausedUntil: null });
			changed += 1;
		} catch (err) {
			failed += 1;
			console.error("[scheduleBulkControls] pause failed", { guildId, eventId: event.eventId }, err);
		}
	}
	return { total: events.length, changed, skipped: events.length - toPause.length, failed };
}

// Resume every paused event in the guild, clearing pausedUntil alongside paused
// (a stale expiry could otherwise be re-used by a later pause).
export async function resumeAllGuildEvents(guildId: string): Promise<IBulkScheduleResult> {
	const events = await eventStore.findByGuildId(guildId);
	const toResume = events.filter((event) => event.paused);
	let changed = 0;
	let failed = 0;
	for (const event of toResume) {
		try {
			await eventStore.updateInGuild(event.eventId, guildId, { paused: false, pausedUntil: null });
			changed += 1;
		} catch (err) {
			failed += 1;
			console.error("[scheduleBulkControls] resume failed", { guildId, eventId: event.eventId }, err);
		}
	}
	return { total: events.length, changed, skipped: events.length - toResume.length, failed };
}
