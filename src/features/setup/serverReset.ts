import { memberLevelStore } from "@db/stores/memberLevelStore.js";
import { xpPeriodStore } from "@db/stores/xpPeriodStore.js";
import { xpDailyStore } from "@db/stores/xpDailyStore.js";
import { luckStatStore } from "@db/stores/luckStatStore.js";
import { gameResultCountStore } from "@db/stores/gameResultCountStore.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { gameRequestStore } from "@db/stores/gameRequestStore.js";
import { partyGameStore } from "@db/stores/partyGameStore.js";
import { chipWalletStore } from "@db/stores/chipWalletStore.js";
import { serverVaultStore } from "@db/stores/serverVaultStore.js";
import { pollResultStore } from "@db/stores/pollResultStore.js";
import { eventOverrideStore } from "@db/stores/eventOverrideStore.js";
import { pendingPairingStore } from "@db/stores/pendingPairingStore.js";
import { activityStore } from "@db/stores/activityStore.js";
import { eventStore } from "@db/stores/eventStore.js";

// ── serverReset ───────────────────────────────────────────────────────────
// What:  the destructive data half of self destruct's Delete my data (2026-10 item
//        254): wipeServerData deletes this guild's stored records.
// Who:   selfDestruct.ts only, after its owner checks and the CONFIRM word. It never
//        checks who is asking; the caller has already decided.
// Where: deliberately NOT the channel teardown. demolishHomebase in selfDestruct.ts
//        still owns that, and runs BEFORE wipeServerData so the homebaseDestroyed flag
//        is set before any record goes.
//
// ⚠️ WHAT IS KEPT, AND WHY. The GuildConfig row stays (flagged destroyed): deleting
// it would make the next boot rebuild a fresh homebase, undoing "stays gone until
// /setup". BotLog stays, because the audit trail is the record that this delete
// happened. DeroVoiceSpend stays, because deleting a month's spend would restart the
// paid speech budget. NetworkBan, NetworkConsent, TagNotice, PlayerRating and
// MatchResult stay: they belong to players across the network, not to this server.
// FortuneBuff is keyed by user alone, for the same reason. FortuneCooldown stays
// too, because wiping it would hand a member a second reading on the same day.

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
	{ label: "chip wallets", run: (guildId) => chipWalletStore.deleteGuild(guildId) },
	{ label: "server vault", run: (guildId) => serverVaultStore.deleteGuild(guildId) },
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
