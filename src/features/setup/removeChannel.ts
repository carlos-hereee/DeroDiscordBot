import { CategoryChannel, type Guild } from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { revokeDeroVoiceRooms } from "@features/voice/deroVoiceRooms.js";
import { createGuildQueue } from "@utils/guildQueue.js";
import { readAdoptedChannelIds } from "./adoption.js";
import { GuildSetupManager } from "./GuildSetupManager.js";
import type { OnDemandField } from "./onDemandChannel.js";
import { demolishChannels } from "./selfDestruct.js";

// ── removeChannel ───────────────────────────────────────────────────────────
// What:  the one way a card takes a 🪧 NOTICE BOARD channel away (2026-11 item 289). A channel
//        Dero built is deleted. A channel Dero adopted is the server's own, so it is never
//        deleted: Dero only stops using it. Either way the slot empties, its step stays moved
//        past, and an emptied notice board category goes with its last channel.
// Who:   tutorialCards.handleRemove, once an admin confirmed. That press owns the prompt, the
//        log line and the redraw, so nothing here posts.
// Where: the delete is selfDestruct.demolishChannels, the one channel delete, and the way
//        back is the card's Add this channel through ensureOnDemandChannel, whose explicit
//        request outranks userRemovedChannels and re-adopts a server's own channel.
// How:   one Remove at a time per guild, so two prompts cannot both read one slot, and the
//        opt out is written before any delete, or ChannelDeleteWatcher could read the old
//        row and rebuild the channel it just saw go.

/** What a Remove came to: the channel went, Dero let go of it, Discord said no, or it was already empty. */
export type RemoveOutcome = "deleted" | "released" | "refused" | "gone";

// A row read field by field: a hydrated row is never spread, and these slots are strings or null.
type RemoveRow = Record<string, unknown> & { categoryId?: string | null };

// The messages that live in a slot's channel besides its intro. Each of these is read as "my
// message is still there" by its board, so an anchor left behind would point at a deleted
// message once the channel comes back. powerUpMessageIds stays out: nothing posts those panels
// and the boot cleanup clears them.
const SLOT_ANCHORS: Partial<Record<OnDemandField, readonly string[]>> = {
	scheduleChannelId: ["scheduleMessageId"],
	leaderboardChannelId: ["leaderboardMessageId", "levelsMessageId"],
	commandsChannelId: ["introMessageIds.inviteCardId"],
};

// See the module header for why one Remove runs at a time.
const removeQueue = createGuildQueue();

/**
 * Take one notice board slot away: delete or release its channel and empty the slot, and take
 * the category with its last channel. `stepId` is the step listed as moved past, so the
 * tutorial never walks backward. Rethrows a failed row write for the caller to log; a refused
 * delete is an outcome, and a failed category tidy costs only an empty category.
 */
export async function removeNoticeBoardChannel(guild: Guild, field: OnDemandField, stepId: string): Promise<RemoveOutcome> {
	return removeQueue.run(guild.id, () => removeNow(guild, field, stepId));
}

// ── one Remove, with the queue held ──────────────────────────────────────────
// ① re-read the row, since the confirm waited up to a minute;
// ② list the opt out, before anything can be deleted;
// ③ delete a built channel, and roll the opt out back if Discord refused;
// ④ empty the slot, its intro and its anchors in one write;
// ⑤ keep the step moved past, release the Meeting Hall and tidy the category.
async function removeNow(guild: Guild, field: OnDemandField, stepId: string): Promise<RemoveOutcome> {
	const row = (await guildConfigStore.findByGuildId(guild.id)) as unknown as RemoveRow | null;
	const channelId = typeof row?.[field] === "string" ? (row[field] as string) : null;
	if (!channelId) return "gone";

	const adoptedIds = readAdoptedChannelIds(row);
	const isAdopted = adoptedIds.includes(channelId);

	await guildConfigStore.addToList(guild.id, "userRemovedChannels", field);
	const deleted = isAdopted ? 0 : await demolishChannels(guild, [channelId], new Set(), "channel-remove");

	// demolishChannels swallows a refusal, so a channel still standing is the one sign of it.
	// Discord refuses a channel Community requires (error 50074). Nothing else has been
	// written yet, so pulling the opt out leaves the slot exactly as it was.
	if (!isAdopted && deleted === 0 && (await guild.channels.fetch(channelId).catch(() => null))) {
		await guildConfigStore.pullFromLists(guild.id, ["userRemovedChannels"], field);
		return "refused";
	}

	const emptied = await guildConfigStore.update(guild.id, slotRelease(field, channelId, adoptedIds));
	await guildConfigStore.addToList(guild.id, "setupStepsSkipped", stepId);
	if (field === "meetingVoiceChannelId") await revokeDeroVoiceRooms(guild.id, [channelId]);
	await tidyNoticeBoard(guild, emptied as unknown as RemoveRow | null, deleted > 0 ? channelId : null).catch((error: unknown) =>
		console.warn(`[remove-channel] guild ${guild.id}: tidying the notice board after removing ${field} failed`, error)
	);
	return isAdopted ? "released" : "deleted";
}

// adoptedChannelChoices stays out on purpose: a stale answer is read by id and is harmless,
// and re-adopting the channel keeps it.
function slotRelease(field: OnDemandField, channelId: string, adoptedIds: readonly string[]): Record<string, unknown> {
	const anchors = (SLOT_ANCHORS[field] ?? []).map((anchor) => [anchor, null]);
	return {
		[field]: null,
		[`introMessageIds.${field}`]: null,
		...Object.fromEntries(anchors),
		adoptedChannelIds: adoptedIds.filter((id) => id !== channelId),
	};
}

/**
 * Delete the notice board category once its last slot is empty and it holds nothing else.
 * `deletedId` is left out of the children because the gateway event can lag the delete; a
 * released adopted channel passes null, because it is a live child that keeps the category.
 * A plain delete, never demolishCategory: that one deletes children, and a channel an admin
 * filed here must survive.
 */
async function tidyNoticeBoard(guild: Guild, row: RemoveRow | null, deletedId: string | null): Promise<void> {
	const categoryId = row?.categoryId ?? null;
	if (!row || !categoryId) return;
	if (GuildSetupManager.specFieldsUnder("categoryId").some((field) => row[field])) return;

	const category = await guild.channels.fetch(categoryId).catch(() => null);
	if (!(category instanceof CategoryChannel)) return;
	if ([...category.children.cache.keys()].some((childId) => childId !== deletedId)) return;

	// Written first: a stored category that is gone tells the boot sweep to rebuild the whole
	// notice board, which would undo every Remove that led here.
	await guildConfigStore.update(guild.id, { categoryId: null, onDemandChannels: [] });
	await category.delete();
}
