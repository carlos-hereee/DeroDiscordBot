import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { deroVoiceConfigStore } from "@db/stores/deroVoiceConfigStore.js";
import { memberLevelStore } from "@db/stores/memberLevelStore.js";
import { xpPeriodStore } from "@db/stores/xpPeriodStore.js";
import { xpDailyStore } from "@db/stores/xpDailyStore.js";
import { luckStatStore } from "@db/stores/luckStatStore.js";
import { gameResultCountStore } from "@db/stores/gameResultCountStore.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { gameRequestStore } from "@db/stores/gameRequestStore.js";
import { partyGameStore } from "@db/stores/partyGameStore.js";
import { pollResultStore } from "@db/stores/pollResultStore.js";
import { eventOverrideStore } from "@db/stores/eventOverrideStore.js";
import { pendingPairingStore } from "@db/stores/pendingPairingStore.js";
import { activityStore } from "@db/stores/activityStore.js";
import { eventStore } from "@db/stores/eventStore.js";
import { voiceSessions } from "@features/voice/voiceSessions.js";
import { invalidateLevelingConfig } from "@features/leveling/levelingConfig.js";

// ── serverReset ───────────────────────────────────────────────────────────
// What:  the two destructive halves of self destruct (post-launch plan item 10, the
//        owner's choice of "reset, then optional delete" with "channels plus stored
//        records"): resetConfigsToDefault puts every Dero setting back to how a new
//        server starts, and wipeServerData deletes this guild's stored records.
// Who:   selfDestruct.ts only, after its owner checks and confirmations. Neither
//        function checks who is asking; the caller has already decided.
// Where: deliberately NOT the channel teardown. demolishHomebase in selfDestruct.ts
//        still owns that, and runs BEFORE wipeServerData so the homebaseDestroyed flag
//        is set before any record goes.
//
// ⚠️ WHAT IS KEPT, AND WHY. The GuildConfig row stays (reset, flagged destroyed):
// deleting it would make the next boot rebuild a fresh homebase, undoing "stays gone
// until /setup". BotLog stays, because the audit trail is the record that this delete
// happened. DeroVoiceSpend stays, because deleting a month's spend would restart the
// paid speech budget. NetworkBan, NetworkConsent, TagNotice, PlayerRating and
// MatchResult stay: they belong to players across the network, not to this server.
// FortuneBuff is keyed by user alone, for the same reason.

// Every GuildConfig setting and its schema default, in one table so the reset cannot
// half apply. Ids, roles, message anchors, setup state and the plugin choice are NOT
// here: they describe what exists, not how it is configured. schedulePaused is left
// out too, because each event carries its own pause and resetting only the guild's
// flag would leave the two disagreeing.
export const CONFIG_DEFAULTS = {
	customRulesMarkdown: null,
	// The schema default for the whole subtree is an empty object, which every reader
	// normalizes to the shipped values (levelingConfig.normalizeLevelingSettings).
	leveling: {},
	copyOverrides: {},
	autoHealEnabled: true,
	channelNames: {},
	userRemovedChannels: [],
	leaderboardTrackingEnabled: true,
	weekStart: "sunday",
	defaultEventImageUrl: null,
	hiddenChannels: [],
	arcadeMonthlyPost: true,
	challengeReach: "server",
	blockedNetworkGuildIds: [],
} as const;

/**
 * Put every Dero setting in this guild back to its default. Ends a live voice call
 * first, since deleting the voice config switches the voice off and a kill switch
 * that left Dero talking would not be one. Throws on a failed write; nothing here is
 * partial in a way a second run cannot finish.
 */
export async function resetConfigsToDefault(guildId: string): Promise<void> {
	voiceSessions.leave(guildId, "switched_off");
	await deroVoiceConfigStore.deleteByGuildId(guildId);
	await guildConfigStore.resetSettings(guildId, CONFIG_DEFAULTS);
	invalidateLevelingConfig(guildId);
}

/** One named deletion, so a failure can be reported by name. */
interface WipeStep {
	label: string;
	run: (guildId: string) => Promise<unknown>;
}

// Events go through eventStore rather than a deleteMany, because under
// USE_REMOTE_EVENTS the platform server owns them; the store's delete is the same
// retirement the dashboard's delete performs. Attendance is keyed by event, so it is
// read off the same list before the events are retired.
async function retireEventsAndAttendance(guildId: string): Promise<void> {
	const events = await eventStore.findByGuildId(guildId);
	const eventIds = events.map((event) => event.eventId);
	if (eventIds.length > 0) await activityStore.deleteByEvents(eventIds);
	for (const eventId of eventIds) await eventStore.deleteInGuild(eventId, guildId);
}

const WIPE_STEPS: readonly WipeStep[] = [
	{ label: "member levels", run: (guildId) => memberLevelStore.deleteGuild(guildId) },
	{ label: "renown history", run: (guildId) => xpPeriodStore.deleteGuild(guildId) },
	{ label: "daily renown", run: (guildId) => xpDailyStore.deleteGuild(guildId) },
	{ label: "luck", run: (guildId) => luckStatStore.deleteGuild(guildId) },
	{ label: "game tallies", run: (guildId) => gameResultCountStore.deleteGuild(guildId) },
	{ label: "game rooms", run: (guildId) => gameRoomStore.deleteGuild(guildId) },
	{ label: "game requests", run: (guildId) => gameRequestStore.deleteGuild(guildId) },
	{ label: "party games", run: (guildId) => partyGameStore.deleteGuild(guildId) },
	{ label: "poll votes", run: (guildId) => pollResultStore.deleteGuild(guildId) },
	{ label: "event overrides", run: (guildId) => eventOverrideStore.deleteGuild(guildId) },
	{ label: "events and attendance", run: retireEventsAndAttendance },
	{ label: "pairing codes", run: (guildId) => pendingPairingStore.deleteUnclaimedForGuild(guildId) },
];

/**
 * Delete this guild's stored records. Every step runs even when an earlier one
 * fails, because a half wiped server is better than one that stopped at the first
 * error, and the labels of the failed steps come back so the owner can retry.
 */
export async function wipeServerData(guildId: string): Promise<{ failed: string[] }> {
	const failed: string[] = [];
	for (const step of WIPE_STEPS) {
		try {
			await step.run(guildId);
		} catch (error) {
			console.error(`[self-destruct] deleting ${step.label} for guild ${guildId} failed`, error);
			failed.push(step.label);
		}
	}
	return { failed };
}
