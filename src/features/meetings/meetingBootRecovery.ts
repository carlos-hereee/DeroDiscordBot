import type { Client } from "discord.js";
import { meetingStore } from "@db/stores/meetingStore.js";
import { voiceSessions } from "@features/voice/voiceSessions.js";
import { endMeeting } from "./meetingLifecycle.js";

// ── meetingBootRecovery ─────────────────────────────────────────────────────
// What:  ends every meeting a restart cut off (2026-11 item 388, assumption A3). A recording
//        lives in this process's memory (the recorder, its clocks), so a Railway deploy or a
//        crash leaves its row marked recording with nothing behind it. Each such row ends as
//        interrupted through the one end path, which summarizes the segments already written
//        (each chunk is persisted as it is made, so at most one unflushed chunk per speaker
//        was lost) or says nothing was recorded.
// Who:   main.ts, once after the client is ready.
// Why a live session is skipped: recovery runs once at boot, before any recording can start,
//        so in practice no meeting has one; the check keeps a late call from ending a meeting
//        this process did start.

/** End every recording meeting with no live session as interrupted. Returns how many it ended. */
export async function recoverInterruptedMeetings(client: Client): Promise<number> {
	const stranded = await meetingStore.findAllRecording();
	let ended = 0;
	for (const meeting of stranded) {
		if (voiceSessions.get(meeting.guildId)?.meetingId === meeting.meetingId) continue;
		try {
			if (await endMeeting(client, meeting.guildId, meeting.meetingId, "interrupted")) ended += 1;
		}
		catch (error) {
			console.error(`[meetings] boot recovery failed guild=${meeting.guildId} meeting=${meeting.meetingId}`, error instanceof Error ? error.name : "unknown");
		}
	}
	if (stranded.length > 0) console.info(`[meetings] boot recovery ended=${ended} of ${stranded.length}`);
	return ended;
}
