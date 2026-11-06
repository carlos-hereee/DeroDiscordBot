import { TextChannel, VoiceChannel, type CategoryChannel, type Guild } from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import type { ICopyConfig } from "@base/copy/getCopy.js";
import { GuildSetupManager } from "./GuildSetupManager.js";
import { asPlainRow } from "./plainRow.js";
import { adminLog } from "./adminLog.js";
import { setupCopy } from "./setupCopy.js";
import { refreshHeadquartersCards } from "./headquartersCards.js";
import { createGuildQueue } from "@utils/guildQueue.js";

// ── onDemandChannel ─────────────────────────────────────────────────────────
// What:  the one way a 🪧 NOTICE BOARD channel is built after install (2026-11 item 285
//        Phase 3). A Headquarters only install has no notice board; each of its channels
//        is built when an admin asks for it, and the notice board category with the first
//        one. ensureOnDemandChannel hands back the live channel, building it (and the
//        category) only when the slot is empty.
// Who:   the onboarding step cards alone (tutorialCards.ts, an admin's Add this channel).
//        Nothing builds unasked: a level up, a decree and a member answer leave an empty
//        slot empty (2026-11 item 289).
// Where: it builds nothing itself. The category comes from GuildSetupManager's managed
//        category helpers (found by stored id, then adopted by name, then created), and
//        the channel from repairOneChannel, the same primitive the boot sweep and the
//        delete watcher use, so an on demand channel gets the same overwrites, the same
//        adoption of the server's own welcome or rules channel, the same intro post and
//        the same stored ids as a repaired one.
// How:   calls for one guild run one after another (a per guild queue), so two presses
//        asking for the same slot at once build it once and both get the same channel.
//        The first notice board write is also conditional on categoryId still being null
//        (guildConfigStore.claimEmptySlot), so even a second process cannot store a
//        second category. That first write lists every other empty notice board slot in
//        onDemandChannels, which the boot sweep skips; without it the next boot would
//        build the whole notice board and undo the tutorial.

/** What ensureOnDemandChannel may be asked for: a slot under 🪧 NOTICE BOARD. */
export type OnDemandField =
	| "introChannelId"
	| "commandsChannelId"
	| "leaderboardChannelId"
	| "scheduleChannelId"
	| "announcementsChannelId"
	| "nextDecreeChannelId"
	| "welcomeChannelId"
	| "rulesChannelId"
	| "meetingVoiceChannelId"
	| "commandOutputChannelId";

/** Options for one call. */
export interface EnsureOptions {
	// An admin asked for this channel by name (a step card's button). It then outranks an
	// earlier removal of the same slot, which any other call never does.
	explicitRequest?: boolean;
	// Who asked, for the admin log line; a call that names nobody is logged as Dero.
	actorUserId?: string | null;
}

/** A notice board channel: every notice board slot is a text channel but the Meeting Hall. */
export type NoticeBoardChannel = TextChannel | VoiceChannel;

// The stored row as this module reads it; it is also the copy selector the names are read through.
type OnDemandRow = Record<string, unknown> &
	ICopyConfig & {
	adminRoleId?: string | null;
	categoryId?: string | null;
	homebaseDestroyed?: boolean | null;
	autoHealEnabled?: boolean | null;
	userRemovedChannels?: string[];
	onDemandChannels?: string[];
};

// Read lazily rather than at module load: GuildSetupManager reaches this module back
// through headquartersCards and tutorialCards, so CHANNEL_SPECS may not exist yet while
// the import cycle is still loading. It is computed once, on the first call.
let noticeBoardFields: ReadonlySet<string> | null = null;
function onDemandFields(): ReadonlySet<string> {
	noticeBoardFields ??= new Set(GuildSetupManager.specFieldsUnder("categoryId"));
	return noticeBoardFields;
}

/** True for a GuildConfig field this module may build: one under the notice board. */
export function isOnDemandField(field: string): field is OnDemandField {
	return onDemandFields().has(field);
}

// See the module header for why calls are serialized. This queue is the build's own: a card
// sync has another, because a build awaits nothing on a queue it could be sitting in.
const buildQueue = createGuildQueue();

/**
 * The live notice board channel for `configField`, built (with the notice board category
 * when there is none) when its slot is empty. Null when nothing may or could be built:
 * no row, a self destructed homebase, a slot an admin removed (unless `explicitRequest`),
 * a deleted channel on a server with auto heal off, or Discord refusing the build.
 * Throws for a field outside the notice board, a developer error; a Discord failure
 * while building is rethrown too, for the caller to log.
 */
export async function ensureOnDemandChannel(guild: Guild, configField: string, options: EnsureOptions = {}): Promise<NoticeBoardChannel | null> {
	if (!isOnDemandField(configField)) {
		throw new Error(`[on-demand] ${configField} is not a notice board channel, so ensureOnDemandChannel cannot build it`);
	}
	return buildQueue.run(guild.id, () => ensureNow(guild, configField, options));
}

// ── one call, with the queue held ───────────────────────────────────────────
// ① read the row, fresh, since a queued call before this one may have just built it;
// ② a live stored channel is the answer, with no write;
// ③ refuse what an admin removed, or a deleted channel where auto heal is off;
// ④ resolve the notice board category, building and claiming it on first use;
// ⑤ build the channel through repairOneChannel, then take the slot off the waiting lists.
async function ensureNow(guild: Guild, configField: OnDemandField, options: EnsureOptions): Promise<NoticeBoardChannel | null> {
	const row = asPlainRow(await guildConfigStore.findByGuildId(guild.id)) as OnDemandRow | null;
	if (!row || row.homebaseDestroyed) return null;

	const storedId = typeof row[configField] === "string" ? (row[configField] as string) : null;
	if (storedId) {
		const live = await guild.channels.fetch(storedId).catch(() => null);
		if (live instanceof TextChannel || live instanceof VoiceChannel) return live;
		// The channel was deleted. The boot sweep and the delete watcher rebuild it unless
		// auto heal is off, and this build must not overrule that switch.
		if (row.autoHealEnabled === false) return null;
	}

	const removedByAdmin = (row.userRemovedChannels ?? []).includes(configField);
	if (removedByAdmin && !options.explicitRequest) return null;

	const resolved = await resolveNoticeBoard(guild, row, configField);
	if (!resolved) return null;

	const spec = GuildSetupManager.CHANNEL_SPECS.find((entry) => entry.configField === configField)!;
	const { newChannel } = await GuildSetupManager.repairOneChannel(guild, resolved.category, spec, resolved.row);
	await guildConfigStore.pullFromLists(guild.id, ["onDemandChannels", "userRemovedChannels"], configField);

	// A channel adopted where it stands (the server's own welcome or rules) was already
	// logged by the adoption, so only a channel inside the notice board gets this line.
	if (newChannel.parentId === resolved.category.id) {
		const actor = options.actorUserId ? { userId: options.actorUserId } : { source: "dero" as const };
		adminLog.emit({
			guild: { id: guild.id, client: guild.client },
			kind: "config.change",
			actor,
			payload: { subject: setupCopy.adminLog.noticeBoardChannel(newChannel.name), detail: setupCopy.adminLog.builtOnFirstUse(newChannel.id) },
		});
	}
	// Its tutorial card turns done whoever asked for the channel.
	refreshHeadquartersCards(guild, "onboarding");
	return newChannel;
}

/**
 * The notice board category and the row as it stands once the category is stored. The
 * category is built only on a row that holds none. A row whose stored category is gone is
 * the boot sweep's (ensureHomebase rebuilds it whole), so nothing is built here then, unless
 * every slot is held back: no rebuild is owed on that row, so waiting for one would only
 * refuse an admin's press until the next restart, and the dead id is forgotten here instead.
 */
async function resolveNoticeBoard(guild: Guild, row: OnDemandRow, configField: OnDemandField): Promise<{ category: CategoryChannel; row: OnDemandRow } | null> {
	const storedCategoryId = row.categoryId ?? null;
	const found = await GuildSetupManager.findExistingManagedCategory(guild, "categoryId", storedCategoryId, row);
	if (found === "unreachable") return null;
	if (found && found.id === storedCategoryId) return { category: found, row };
	const isDeadIdHeldBack = storedCategoryId !== null && GuildSetupManager.holdsEveryNoticeBoardSlot(row);
	if (storedCategoryId && !isDeadIdHeldBack) {
		console.warn(`[on-demand] guild ${guild.id}: the stored notice board ${storedCategoryId} is gone; the boot sweep rebuilds it, so ${configField} waits`);
		return null;
	}

	const category = found ?? (await GuildSetupManager.createManagedCategory(guild, "categoryId", guild.ownerId, row.adminRoleId ?? null, row));
	if (!category) return null;
	// Forgotten only once a category stands, so a refused build leaves the row as it was. The
	// claim below lands only on a null categoryId, which is why this write comes first.
	if (isDeadIdHeldBack) await guildConfigStore.update(guild.id, { categoryId: null, onDemandChannels: [] });
	const waiting = GuildSetupManager.specFieldsUnder("categoryId").filter((field) => field !== configField && !row[field]);
	const claimed = await guildConfigStore.claimEmptySlot(guild.id, "categoryId", category.id, { onDemandChannels: waiting });
	if (claimed) return { category, row: asPlainRow(claimed) as OnDemandRow };

	// Another process stored a notice board first. Its category is the one to use, and one
	// this call just built would be a second NOTICE BOARD, so it goes.
	if (!found) await category.delete().catch((error: unknown) => console.warn(`[on-demand] guild ${guild.id}: removing a duplicate notice board ${category.id} failed`, error));
	const winner = asPlainRow(await guildConfigStore.findByGuildId(guild.id)) as OnDemandRow | null;
	const winnerId = winner?.categoryId ?? null;
	const winnerCategory = winnerId ? await GuildSetupManager.findExistingManagedCategory(guild, "categoryId", winnerId, winner) : null;
	if (!winner || !winnerCategory || winnerCategory === "unreachable") return null;
	return { category: winnerCategory, row: winner };
}
