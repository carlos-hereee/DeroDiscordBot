import { Events, type Client, type VoiceState } from "discord.js";
import { postConsentNotice } from "./consentNotice.js";
import { checkRoom, liveMeetingIn } from "./meetingLifecycle.js";

// ── meetingPresence ─────────────────────────────────────────────────────────
// What:  who comes and goes in 🏛️ Meeting Hall while a meeting records (2026-11 item 388,
//        grade note R11). A member who joins the hall mid meeting is pinged once per meeting
//        with the consent notice, and every join or leave recounts who in the hall agreed, so
//        the empty room end (meetingLifecycle.checkRoom) arms and clears on its own.
// Who:   main.ts, once at boot.
// When:  every VoiceStateUpdate, but it does work only in a guild whose recording this
//        process runs, and only for a change that enters or leaves that guild's hall.
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

	const member = newState.member ?? oldState.member;
	if (joined && member && !member.user.bot && !meeting.pinged.has(member.id)) {
		meeting.pinged.add(member.id);
		await postConsentNotice(client, meeting.notesChannelId, meeting.copy, { meetingId: meeting.meetingId, title: meeting.title, hostId: meeting.hostId, memberIds: [member.id] });
	}
	await checkRoom(client, guildId);
}

/** Register the listener. Called once at boot from main.ts. */
export function registerMeetingPresence(client: Client): void {
	client.on(Events.VoiceStateUpdate, (oldState, newState) => {
		onMeetingVoiceState(client, oldState, newState).catch((error: unknown) =>
			console.warn(`[meetings] hall presence check failed guild=${newState.guild.id}`, error instanceof Error ? error.name : "unknown")
		);
	});
}
