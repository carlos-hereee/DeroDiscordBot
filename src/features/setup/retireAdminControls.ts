// ── retireAdminControls ─────────────────────────────────────────────────────
// What:  deletes a server's 🎛️admin-controls, once, by the id stored in
//        GuildConfig.adminCommandsChannelId, then clears that id and the message ids
//        kept in it (2026-10 item 263 Phase 4a, owner decision 14). Every control it
//        held now lives in its own 🏰 DERO HEADQUARTERS channel, and every admin answer
//        posts in 🛠️server-config. It does NOT build anything, and it never looks a
//        channel up by name: a channel merely named like it is the server's own.
// Who:   GuildSetupManager.ensureHomebase on every boot, before the repair sweep.
//        ChannelDeleteWatcher recognises the deletion as expected, and self destruct
//        still removes a stored id on a server this sweep has not reached.
// How:   ① no stored id → nothing to do, nothing written (a second boot ends here);
//        ② without Manage Channels → one log line, nothing written, retried next boot;
//        ③ the stored id is checked against every other id Dero keeps for the server,
//           so a corrupted row can never point the delete at a live managed channel;
//        ④ fetch by id: a text channel is deleted; one Discord says is gone is only
//           cleared; anything else (another type, a fetch that failed) is not deleted;
//        ⑤ the ids are cleared and, after a real deletion, one admin log line written.
//        Never throws into the boot sweep (rulebook convention 7).
//
// ⚠️ RISK R1: a deleted channel cannot come back. The id is the only key, by the
// owner's decision, and retireAdminControls.test.ts pins that a same named channel
// with another id is untouched.

import { DiscordAPIError, RESTJSONErrorCodes, TextChannel, type Guild } from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { adminLog } from "./adminLog.js";
import { canManageChannels } from "./headquarters.js";
import { setupCopy } from "./setupCopy.js";

/** What one pass did, for the boot log and the tests. */
export type AdminControlsOutcome = "none" | "refused" | "deleted" | "cleared" | "kept";

const RETIRED_FIELD = "adminCommandsChannelId";

// Every id the retired channel carried a message under. The legacy guide key is the
// in-sanctum guide the 2026-06-19 split moved into 🎛️admin-controls; its migration
// retires with the channel, so its anchor is cleared too.
const CLEARED_IDS: Readonly<Record<string, null>> = {
	[RETIRED_FIELD]: null,
	[`introMessageIds.${RETIRED_FIELD}`]: null,
	"introMessageIds.adminCommandGuideId": null,
	[`powerUpMessageIds.${RETIRED_FIELD}`]: null,
};

// The suffixes of every GuildConfig field holding a channel or category id Dero keeps.
const MANAGED_ID_SUFFIXES = ["ChannelId", "CategoryId"] as const;

/** Every channel or category id the row keeps besides the retired one. */
export function otherManagedIds(row: Record<string, unknown>): Set<string> {
	const ids = new Set<string>();
	for (const [field, value] of Object.entries(row)) {
		if (field === RETIRED_FIELD || typeof value !== "string" || value.length === 0) continue;
		if (field === "categoryId" || MANAGED_ID_SUFFIXES.some((suffix) => field.endsWith(suffix))) ids.add(value);
	}
	return ids;
}

type StoredChannel = { kind: "found"; channel: unknown } | { kind: "gone" } | { kind: "unknown" };

// Only Discord's own Unknown Channel answer means gone; any other failure (an outage,
// a rate limit) leaves the id in place so the next boot looks again.
async function fetchStoredChannel(guild: Guild, channelId: string): Promise<StoredChannel> {
	try {
		const channel = await guild.channels.fetch(channelId);
		return channel ? { kind: "found", channel } : { kind: "gone" };
	} catch (error) {
		if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownChannel) return { kind: "gone" };
		console.warn(`[admin-controls] guild ${guild.id}: could not read the stored 🎛️admin-controls ${channelId}; it is left for the next boot`, error);
		return { kind: "unknown" };
	}
}

async function clearRetiredIds(guild: Guild): Promise<void> {
	await guildConfigStore.update(guild.id, { ...CLEARED_IDS });
}

/** Delete the stored 🎛️admin-controls, once, by its id. Never throws. */
export async function retireAdminControls(guild: Guild): Promise<AdminControlsOutcome> {
	try {
		const row = (await guildConfigStore.findByGuildId(guild.id)) as unknown as Record<string, unknown> | null;
		const storedId = row?.[RETIRED_FIELD];
		if (!row || typeof storedId !== "string" || storedId.length === 0) return "none";

		if (!canManageChannels(guild)) {
			console.log(`[admin-controls] guild ${guild.id}: Dero lacks Manage Channels; 🎛️admin-controls stays until a boot with the permission`);
			return "refused";
		}

		// A row whose retired id is also another managed slot's is corrupt: clearing the
		// pointer is safe, deleting through it would take a live channel.
		if (otherManagedIds(row).has(storedId)) {
			console.warn(`[admin-controls] guild ${guild.id}: the stored 🎛️admin-controls id ${storedId} is another managed channel's; the pointer is cleared and nothing is deleted`);
			await clearRetiredIds(guild);
			return "cleared";
		}

		const stored = await fetchStoredChannel(guild, storedId);
		if (stored.kind === "unknown") return "kept";
		if (stored.kind === "gone") {
			console.log(`[admin-controls] guild ${guild.id}: the stored 🎛️admin-controls is already gone; its ids are cleared`);
			await clearRetiredIds(guild);
			return "cleared";
		}
		// Only a text channel was ever built in that slot, so anything else under the id
		// (a category, a voice room) is no 🎛️admin-controls and is never deleted.
		if (!(stored.channel instanceof TextChannel) || stored.channel.id !== storedId) {
			console.warn(`[admin-controls] guild ${guild.id}: the stored 🎛️admin-controls id ${storedId} is not a text channel; the pointer is cleared and nothing is deleted`);
			await clearRetiredIds(guild);
			return "cleared";
		}

		try {
			await stored.channel.delete(setupCopy.retiredAdminControls.deleteReason);
		} catch (error) {
			// The id stays, so the next boot tries again.
			console.warn(`[admin-controls] guild ${guild.id}: deleting 🎛️admin-controls ${storedId} failed; it is left for the next boot`, error);
			return "kept";
		}
		await clearRetiredIds(guild);
		await adminLog.write({
			guild: { id: guild.id, client: guild.client },
			kind: "config.change",
			actor: { source: "dero" },
			payload: { subject: setupCopy.retiredAdminControls.subject, detail: setupCopy.retiredAdminControls.detail },
		});
		console.log(`[admin-controls] guild ${guild.id}: deleted 🎛️admin-controls ${storedId}; every control lives in its Headquarters channel`);
		return "deleted";
	} catch (error) {
		console.warn(`[admin-controls] guild ${guild.id}: retiring 🎛️admin-controls failed; the next boot tries again`, error);
		return "kept";
	}
}

/** True when a deleted channel is the stored 🎛️admin-controls, whose deletion is expected. */
export function isRetiredAdminControls(row: Record<string, unknown> | null | undefined, channelId: string): boolean {
	return typeof row?.[RETIRED_FIELD] === "string" && row[RETIRED_FIELD] === channelId;
}
