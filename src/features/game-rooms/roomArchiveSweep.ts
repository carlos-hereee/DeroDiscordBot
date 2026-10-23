import { type Client } from "discord.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { mapWithConcurrency } from "@utils/mapWithConcurrency.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { archiveRoom } from "./roomLifecycle.js";

// ── roomArchiveSweep ─────────────────────────────────────────────────
// What:  deletes the channel of every finished room whose archive window has expired.
// Who:   the 5 minute cron registered in ReminderScheduler.startScheduler, and the boot
//        recovery sweep, which runs the same function once at startup so a bot that was
//        down over a room's expiry catches up immediately instead of at the next tick.
// When:  every GAME_ROOM_SWEEP_CRON, and once per boot.
// Where: CROSS GUILD by nature: one tick serves every guild the bot is in, which is why
//        the store query behind it is the one method that does not scope to a guildId.
// How:   bounded fan out, isolated per room. See both notes below; each exists because
//        the unbounded or unisolated version has a specific, known failure.

export interface RoomSweepSummary {
	archived: number;
	failed: number;
}

// Delete every expired room's channel and close its row.
//
// ⚠️ THE SAFETY PROPERTY IS IN THE QUERY, NOT HERE. findExpiredArchives filters on
// status "finished" AND a non-null archiveAt in the past, and archiveAt is stamped by
// roomLifecycle.finish and by nothing else (roomLifecycle.releaseChannel only ever clears
// it, when a rematch takes a finished room's channel over). That single-writer property
// is what makes this loop safe to point at a delete: a live match has a null archiveAt
// and is therefore unreachable from this function no matter what the clock says (risk R3).
export async function sweepExpiredRooms(client: Client, now: Date = new Date()): Promise<RoomSweepSummary> {
	const expired = await gameRoomStore.findExpiredArchives(now);
	if (expired.length === 0) return { archived: 0, failed: 0 };

	// Bounded rather than a naive Promise.all: a guild that let twenty rooms expire
	// while the bot was down would otherwise fire twenty simultaneous channel deletes
	// into one guild's rate limit bucket, and Discord would start 429ing the whole
	// connection, not just this sweep.
	const outcomes = await mapWithConcurrency(expired, BOT_CONSTANTS.SCHEDULER_GUILD_CONCURRENCY, async (room) => {
		try {
			// archiveRoom already treats a missing channel as success, which is the 404
			// case: an admin who deleted the channel by hand did half this job already.
			await archiveRoom(client, room);
			return true;
		} catch (error) {
			// Isolated per ROOM, not per guild. One room whose guild the bot was kicked
			// from must not stop the other nineteen from being cleaned up, and this
			// function runs on a cron with nobody watching it, so a throw here would be
			// swallowed by the cron wrapper and the backlog would grow silently.
			console.error("[game-rooms] archive sweep failed for one room", {
				guildId: room.guildId,
				roomId: room.roomId,
				error,
			});
			return false;
		}
	});

	const archived = outcomes.filter(Boolean).length;
	const summary = { archived, failed: outcomes.length - archived };

	// One line per non-empty tick. Silence on an empty tick keeps the Railway log
	// readable; a sweep that found nothing is the normal state.
	console.log(`[game-rooms] archive sweep: ${summary.archived} archived, ${summary.failed} failed`);
	return summary;
}
