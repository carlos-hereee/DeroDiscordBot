import { Client, Events, MessageReaction, User, VoiceState, PartialMessageReaction, PartialUser } from "discord.js";
import { reminderStore } from "@db/stores/reminderStore.js";
import { activityStore } from "@db/stores/activityStore.js";
import { eventStore } from "@db/stores/eventStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { openWindowStart } from "@features/events/occurrenceCalculator.js";
import { IVoiceSession } from "./activity.types.js";
import { computeScore } from "./ParticipationStore.js";
import { scheduleLeaderboardRefresh } from "@features/leaderboard/LeaderboardBoard.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { LOG_MESSAGES } from "@base/constants/log-messages.js";

// in-memory map of active voice sessions
// key is userId, value is the session details
// this resets if the bot restarts, acceptable for a single server bot
const activeSessions = new Map<string, IVoiceSession>();

export function registerActivityListeners(client: Client): void {
	// ─────────────────────────────────────────
	// LISTENER 1, Reaction tracking
	// fires when any user reacts to any message
	//
	// ⚠️ THIS IS NOT THE ONLY MessageReactionAdd LISTENER. A second one lives in
	// src/features/leveling/reactionXp.ts and both are registered from main.ts.
	// Two listeners on one event reads as a bug on sight, so this comment exists
	// to say it is not. The differences are total:
	//
	//   this one     filters to the ✅ emoji, ONLY on a message that is a stored
	//                ReminderLog, ONLY when that log is not a test fire, and
	//                writes PlayerActivity (did this warrior show up for this
	//                KvK event).
	//   reactionXp   accepts ANY emoji on ANY message, ignores ReminderLog
	//                entirely, and writes MemberLevel (how present is this member
	//                in this server over time).
	//
	// Neither may touch the other's model, and neither may be folded into the
	// other: leveling through PlayerActivity would need a fake eventId for "just
	// chatting", which corrupts the participation score, /leaderboard, the
	// dashboard players route and the pinned board all at once.
	// ─────────────────────────────────────────

	client.on(
		Events.MessageReactionAdd,
		async (
			reaction: MessageReaction | PartialMessageReaction, // ← union type
			user: User | PartialUser // ← union type
		) => {
			try {
				if (user.bot) return;
				if (reaction.emoji.name !== "✅") return;

				// always fetch partials before accessing their properties
				// this is now necessary since reaction could be partial
				const fullReaction = reaction.partial ? await reaction.fetch() : reaction;

				// leaderboard tracking toggle gate. when off, the admin has
				// explicitly opted out of new participation writes. existing
				// PlayerActivity rows stay in the DB so /leaderboard keeps
				// rendering historical data; this listener simply stops
				// adding new ones. early-return BEFORE the reminderStore
				// lookup so we also save the DB round trip on every ✅
				// reaction in a tracking-disabled guild.
				const reactionGuildId = fullReaction.message.guildId;
				if (reactionGuildId) {
					const cfg = await guildConfigStore.findByGuildId(reactionGuildId);
					if (cfg && cfg.leaderboardTrackingEnabled === false) return;
				}

				const fullUser = user.partial ? await user.fetch() : user;

				const log = await reminderStore.findByMessageId(fullReaction.message.id);
				if (!log) return;

				// ── test reminder safety guard ─────────────────────────
				// test fires from the dashboard are stored in ReminderLog with
				// the TEST sentinel offset so they appear in the audit trail
				// but are never counted as real participation. if a warrior
				// manually adds a ✅ to a [TEST] embed we ignore it here. this
				// is the critical invariant from the dashboard spec section 7.9.
				if (log.offsetMinutes === BOT_CONSTANTS.REMINDER_LOG_OFFSETS.TEST) return;

				// ── display name resolution ────────────────────────────
				// What:  prefer the per guild nickname over the global Discord
				//        username so the leaderboard reads as warriors know each
				//        other in this kingdom (e.g. "Lord Silent" not the
				//        opaque legacy handle "silent6804").
				// Who:   every leaderboard / players list rendered by the
				//        dashboard. activityStore.upsert writes this string into
				//        PlayerActivity.username and the players API returns it
				//        verbatim.
				// When:  resolved at write time on every activity event so the
				//        cached display name follows nickname renames within a
				//        single occurrence. Older records keep the username
				//        they had at the time of the activity (acceptable,
				//        they reflect what was true that day).
				// Where: the message guild gives us a GuildMember to read the
				//        nickname from. Fallback to globalName (the new Discord
				//        display name) and finally the legacy username so we
				//        never write an empty string.
				const guild = fullReaction.message.guild;
				const member = guild ? await guild.members.fetch(fullUser.id).catch(() => null) : null;
				const displayName = member?.displayName ?? fullUser.globalName ?? fullUser.username;

				await activityStore.upsert({
					eventId: log.eventId,
					eventOccurrence: log.eventOccurrence,
					userId: fullUser.id,
					username: displayName,
					data: {
						acknowledgedReminder: true,
						acknowledgedAt: new Date(),
					},
				});

				await updateScore(log.eventId, log.eventOccurrence, fullUser.id);

				// nudge the pinned leaderboard board so this week's standings
				// reflect the new acknowledgement. Coalesced per guild so a flurry
				// of ✅ reactions produces one edit, not dozens.
				if (reactionGuildId) scheduleLeaderboardRefresh(client, reactionGuildId);
			} catch (error) {
				console.error(LOG_MESSAGES.activity.reactionError, error);
			}
		}
	);

	// ─────────────────────────────────────────
	// LISTENER 2, Voice join/leave tracking
	// fires whenever any user's voice state changes
	// ─────────────────────────────────────────
	client.on(Events.VoiceStateUpdate, async (oldState: VoiceState, newState: VoiceState) => {
		try {
			const member = newState.member ?? oldState.member;
			if (!member || member.user.bot) return;

			// leaderboard tracking toggle gate. mirror of the reaction
			// listener's gate above. when off, no new voice-session
			// PlayerActivity rows get written; existing rows continue
			// to show on /leaderboard. early-return BEFORE the in-memory
			// session bookkeeping so a tracking-disabled guild does not
			// accumulate orphan sessions in activeSessions either.
			const voiceGuildId = (newState.guild?.id ?? oldState.guild?.id) as string | undefined;
			if (voiceGuildId) {
				const cfg = await guildConfigStore.findByGuildId(voiceGuildId);
				if (cfg && cfg.leaderboardTrackingEnabled === false) return;
			}

			const userId = member.id;
			// member.displayName is the canonical "what to call this person in this
			// guild" string in discord.js v14: it returns nickname when set, then
			// globalName, then legacy username. Same precedence we use in the
			// reaction listener so both code paths write the same string into
			// PlayerActivity.username.
			const username = member.displayName ?? member.user.globalName ?? member.user.username;

			const joined = !oldState.channelId && newState.channelId;
			const left = oldState.channelId && !newState.channelId;

			// ── player joined voice ──
			if (joined) {
				// VoiceState.guild is always populated for guild voice channels, the
				// only path with no guild is direct DM voice, which doesn't reach this
				// listener.
				const guildId = newState.guild?.id ?? oldState.guild?.id ?? "";
				if (!guildId) return;
				// check if any event window is currently open in this guild
				const activeEvent = await getActiveEvent(guildId);
				if (!activeEvent) return; // no event happening right now, don't track

				// cache session in memory
				activeSessions.set(userId, {
					userId,
					eventId: activeEvent.eventId,
					eventOccurrence: activeEvent.occurrence,
					joinedAt: Date.now(),
				});

				// mark that they joined, voiceMinutes updated when they leave
				await activityStore.upsert({
					eventId: activeEvent.eventId,
					eventOccurrence: activeEvent.occurrence,
					userId,
					username,
					data: { joinedVoiceDuring: true },
				});

				// coalesced leaderboard refresh, see the reaction listener note.
				scheduleLeaderboardRefresh(client, guildId);
			}

			// ── player left voice ──
			if (left) {
				const session = activeSessions.get(userId);
				if (!session) return; // they joined before bot started, no session data

				// calculate how long they were in VC
				const voiceMinutes = Math.floor((Date.now() - session.joinedAt) / 60_000);
				activeSessions.delete(userId);

				// get existing record to add to their running total
				// (they might have left and rejoined multiple times)
				const existing = await activityStore.findOne(session.eventId, session.eventOccurrence, userId);

				const totalMinutes = (existing?.voiceMinutes ?? 0) + voiceMinutes;

				await activityStore.upsert({
					eventId: session.eventId,
					eventOccurrence: session.eventOccurrence,
					userId,
					username,
					data: { voiceMinutes: totalMinutes },
				});

				await updateScore(session.eventId, session.eventOccurrence, userId);

				// coalesced leaderboard refresh, see the reaction listener note.
				if (voiceGuildId) scheduleLeaderboardRefresh(client, voiceGuildId);
			}
		} catch (error) {
			console.error(LOG_MESSAGES.activity.voiceError, error);
		}
	});

	// ─────────────────────────────────────────
	// LISTENER 3, Presence tracking
	// fires when a user's online status changes
	// ─────────────────────────────────────────
	client.on(Events.PresenceUpdate, async (oldPresence, newPresence) => {
		try {
			if (!newPresence.member || newPresence.member.user.bot) return;

			// only care about transitions TO online/idle/dnd FROM offline
			const wasOffline = !oldPresence || oldPresence.status === "offline";
			const isOnline = newPresence.status !== "offline";
			if (!wasOffline || !isOnline) return;

			// PresenceUpdate fires with a guild context (presence is per-guild). Pull
			// guildId off the new presence, without it the per-guild event lookup
			// can't run.
			const guildId = newPresence.guild?.id ?? "";
			if (!guildId) return;

			// check if an event just started (within the first 10 minutes)
			const activeEvent = await getActiveEvent(guildId, 10);
			if (!activeEvent) return;

			const userId = newPresence.member.id;
			// Same per guild displayName precedence as the voice and reaction
			// listeners, keep the three write paths in sync so a leaderboard
			// row never flips between nickname and raw username depending on
			// which event happened to write last.
			const username = newPresence.member.displayName ?? newPresence.member.user.globalName ?? newPresence.member.user.username;

			await activityStore.upsert({
				eventId: activeEvent.eventId,
				eventOccurrence: activeEvent.occurrence,
				userId,
				username,
				data: { wasOnlineAtStart: true },
			});

			await updateScore(activeEvent.eventId, activeEvent.occurrence, userId);
		} catch (error) {
			console.error(LOG_MESSAGES.activity.presenceError, error);
		}
	});
}

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────

// checks if any active event is currently in its window
// windowMinutes lets presence tracking use a tighter 10min window
//
// Refactored from findAll() to findByGuildId(): under USE_REMOTE_EVENTS the global
// scan is unavailable. Every caller (voice/reaction/presence listeners) has a guild
// context, so threading guildId in keeps both modes working with the same code.
async function getActiveEvent(guildId: string, windowMinutes = 60) {
	if (!guildId) return null;
	const events = await eventStore.findByGuildId(guildId);

	for (const event of events) {
		// The occurrence that just started: a one time event's own start, or the
		// recurring occurrence before the next one (one local week for a weekly event
		// with a zone, one interval otherwise). 2026-10 item 280.
		const occurrence = openWindowStart(event, new Date(), windowMinutes);
		if (!occurrence) continue;

		return { ...event, occurrence };
	}

	return null;
}

// recomputes and saves participation score after any activity update
async function updateScore(eventId: string, eventOccurrence: Date, userId: string) {
	const record = await activityStore.findOne(eventId, eventOccurrence, userId);
	if (!record) return;

	const score = computeScore(record);
	await activityStore.upsert({
		eventId,
		eventOccurrence,
		userId,
		username: record.username,
		data: { participationScore: score },
	});
}
