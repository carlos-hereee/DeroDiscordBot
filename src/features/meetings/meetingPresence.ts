import { Events, type Client, type VoiceState } from "discord.js";
import { askUnaskedInHall, checkRoom, endForDeletedNotesChannel, liveMeetingIn } from "./meetingLifecycle.js";
import { getMeetingRecorder } from "./meetingRecorder.js";

// ── meetingPresence ─────────────────────────────────────────────────────────
// What:  who comes and goes in 🏛️ Meeting Hall while a meeting records (2026-11 item 388,
//        grade note R11). Every join or leave asks whoever in the hall has no accepted consent
//        notice yet (a member whose notice Discord refused is asked again here) and recounts who
//        in the hall agreed, so the empty room end (meetingLifecycle.checkRoom) arms and clears
//        on its own. A leave also gives the leaver's recording slot back (L12). Also the end of a recording whose 📝meeting-notes is deleted.
// Who:   main.ts, once at boot.
// When:  every VoiceStateUpdate and ChannelDelete, but it does work only in a guild whose
//        recording this process runs, and only for a change that enters or leaves that guild's
//        hall or deletes that recording's notes channel.
//
// ⚠️ This is a THIRD ChannelDelete listener, on purpose (2026-11 item 420, L2), beside
// features/setup/ChannelDeleteWatcher.ts (rebuilding homebase channels) and
// features/game-rooms/satelliteSeats.ts (seating out a network table's satellite). The watcher
// stops at its auto heal and opt out gates, and a deleted notes channel ends a recording whatever
// those say, because every withdraw button went with it.
//
// ⚠️ This is a FOURTH VoiceStateUpdate listener, on purpose, beside
// features/activity-tracking/ActivityTracker.ts:131 (KvK participation minutes) and
// features/voice/voiceSessionWatchers.ts:141 (Dero's own call: moved, kicked, idle), plus the
// voice XP sweep that reads cached states rather than listening. Each answers a different
// question, and folding this into the watcher would make the command call's idle rule and the
// meeting's consent rule share one code path that must never mix them (R5).

/** One voice state change, for the tests without a client. Never throws on a member's state. */
export async function onMeetingVoiceState(client: Client, oldState: VoiceState, newState: VoiceState): Promise<void> {
	const guildId = newState.guild.id;
	const meeting = liveMeetingIn(guildId);
	if (!meeting) return;
	const joined = newState.channelId === meeting.hallId && oldState.channelId !== meeting.hallId;
	const left = oldState.channelId === meeting.hallId && newState.channelId !== meeting.hallId;
	if (!joined && !left) return;

	// Before anything is awaited, so a member who comes straight back is not released after it.
	if (left) getMeetingRecorder(meeting.meetingId)?.releaseSpeaker(newState.id);
	await askUnaskedInHall(client, guildId);
	await checkRoom(client, guildId);
}

/** Register the listeners. Called once at boot from main.ts. */
export function registerMeetingPresence(client: Client): void {
	client.on(Events.VoiceStateUpdate, (oldState, newState) => {
		onMeetingVoiceState(client, oldState, newState).catch((error: unknown) =>
			console.warn(`[meetings] hall presence check failed guild=${newState.guild.id}`, error instanceof Error ? error.name : "unknown")
		);
	});
	client.on(Events.ChannelDelete, (channel) => {
		endForDeletedNotesChannel(client, channel.id).catch((error: unknown) =>
			console.error(`[meetings] end after the notes channel was deleted failed channel=${channel.id}`, error instanceof Error ? error.name : "unknown")
		);
	});
}
