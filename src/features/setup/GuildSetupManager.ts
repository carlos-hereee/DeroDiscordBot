import {
	Guild,
	PermissionFlagsBits,
	ChannelType,
	CategoryChannel,
	GuildChannel,
	Client,
	TextChannel,
	VoiceChannel,
	DiscordAPIError,
	RESTJSONErrorCodes,
	ActionRowBuilder,
	ButtonBuilder,
	EmbedBuilder,
	Embed,
	Message,
	type AttachmentBuilder,
	type MessageActionRowComponentBuilder,
	type MessageEditOptions,
} from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import type {
	ISetupConfig,
	IAdminRoleConfig,
	IEnsureHomebaseResult,
	IBuiltGroup,
	IHomebaseChannelIds,
	IHomebaseChannelObjects,
	IArcadeChannelIds,
	IArcadeChannelObjects,
	IHeadquartersChannelIds,
	IHeadquartersChannelObjects,
} from "./setup.types.js";
import { ChannelContent } from "./ChannelContent.js";
import { getPluginCopy, type ICopyConfig } from "@base/copy/getCopy.js";
import type { IPluginCopy } from "@base/copy/types.js";
import { buildSuggestionBoxButton } from "@features/suggestion-box/SuggestionBox.js";
import { buildSelfDestructButton } from "@features/setup/selfDestruct.js";
import { buildArcadeHostRow, buildHangmanCategoryStartRow } from "@features/games/arcadeHost.js";
import { buildPartyGamesRow } from "@features/game-rooms/partyGames.js";
import { buildMarketRow } from "@features/economy/coinMarketPanel.js";
import { buildSoloLuckRow } from "@features/games/soloLuck.js";
import { boardStartRows } from "@features/game-rooms/challengeBoardEmbeds.js";
import { buildGameRequestRow } from "@features/game-rooms/gameRequestHandlers.js";
import { buildMemberControlButtons, buildIcebreakerButton, buildFortuneButton, buildClaimButton, buildProfileButtons } from "@features/power-ups/PowerUps.js";
import { buildVoiceRoomControlRow } from "@features/voice/voiceRoomControls.js";
import { allowDeroVoiceRooms, replaceDeroVoiceRoom } from "@features/voice/deroVoiceRooms.js";
import { DOMAIN_CHANNEL_FIELDS, HEADQUARTERS_DOMAINS, syncAllHeadquarters, syncHeadquartersChannel } from "./headquartersCards.js";
import { buildDeroGifAttachment } from "@base/copy/brand.js";
import {
	communityOverwritesFor,
	dependsOnCommunityState,
	headquartersCategoryOverwrites,
	isMemberRoleGated,
	memberRoleGrant,
	overwriteKindOf,
	reconcileChannelOverwrite,
	type IOverwriteEntry,
	type IOverwriteRoles,
	type ManagedOverwriteKind,
} from "./communityOverwrites.js";
import { moveIntoCategory, canManageChannels } from "./headquarters.js";
import { retireAdminControls } from "./retireAdminControls.js";
import { asPlainRow } from "./plainRow.js";
import { CommunityGatingAnnouncement } from "./CommunityGatingAnnouncement.js";
import { fetchAcceptsDeroContent, findRulesChannel, findWelcomeChannel, readAdoptedChannelIds, readAdoptionChoice, type IAdoptionCandidate } from "./adoption.js";
import { moveChosenChannel } from "./adoptionChoice.js";
import { arcadeSwitchesToWrite } from "./arcadeDefaults.js";
import { mustStayReadable, readOnboardingSafeChannels } from "@features/community/onboardingChannels.js";
import { adminLog } from "./adminLog.js";
import { setupCopy } from "./setupCopy.js";
import { buildRulesEditRow, carriesRulesEditButton, type IRulesConfig } from "./rulesContent.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { LOG_MESSAGES } from "@base/constants/log-messages.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { BOT_LOG_EVENTS } from "@base/constants/BOT_LOG_EVENTS.js";

// ── auto-leave grace period (v1.5.1 item 9, 2026-05-12) ─────────
// Number of days a guild can sit in failed-permission state before the
// bot leaves it. Chosen at 7 because real installs resolve within 24h
// and a week is a comfortable buffer for admins in slow-response time
// zones. Exported so the value is visible in one place and so tests
// can override it via dependency injection if needed.
const AUTO_LEAVE_GRACE_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** A managed channel's key in a pack's setup.channels, where every channel name lives. */
type ChannelNameKey = keyof IPluginCopy["setup"]["channels"];

/** The managed categories other than the notice board, each resolved and built by one helper set. */
type SecondaryCategoryField = "gamesCategoryId" | "headquartersCategoryId";
/** Every managed category, keyed by the GuildConfig field that stores its id. */
type ManagedCategoryField = "categoryId" | SecondaryCategoryField;

// Each managed category's name in a pack's setup block.
const CATEGORY_NAME_KEYS: Record<ManagedCategoryField, "categoryName" | "gamesCategoryName" | "headquartersCategoryName"> = {
	categoryId: "categoryName",
	gamesCategoryId: "gamesCategoryName",
	headquartersCategoryId: "headquartersCategoryName",
};

// What: a managed category's name in the guild's pack, with the dev suffix appended
//       when NODE_ENV === "development".
// Who:  the build, the boot sweep's rename and adoption by name, and switchTemplate.
// When: evaluated at runtime, not module load, so env changes between runs are respected.
// Where: the copy packs (@base/copy/packs) own the base name and suffix string; this
//        helper owns the env branching so the pack stays free of environment logic. All
//        three categories branch on env identically here, because a dev instance that
//        suffixed one category but not another would collide with prod on exactly one
//        of them. The names are identical in both packs today (the 2026-05-22 decision),
//        but they are read through the guild's pack like every channel name, so a pack
//        that ever names them differently needs no change here.
function resolveCategoryName(field: ManagedCategoryField, copyConfig: ICopyConfig | null): string {
	const setup = getPluginCopy(copyConfig).setup;
	const name = setup[CATEGORY_NAME_KEYS[field]];
	return process.env.NODE_ENV === "development" ? name + setup.devSuffix : name;
}

// The copy selector of any stored row shape: a GuildConfig row carries pluginId and
// copyOverrides, which is all getPluginCopy reads. null (a fresh install) is the default pack.
function copyConfigOf(row: unknown): ICopyConfig | null {
	return (row ?? null) as ICopyConfig | null;
}

/** Which managed categories a stored row records, read loosely because the arcade and Headquarters ids sit outside the inferred row type. */
type IManagedCategoryIds = Partial<Record<ManagedCategoryField, string | null>>;

/** True when the row records any managed category, which is what "Dero already built here" means. */
function hasManagedCategory(row: unknown): boolean {
	const ids = (row ?? {}) as IManagedCategoryIds;
	return Boolean(ids.categoryId || ids.gamesCategoryId || ids.headquartersCategoryId);
}

/**
 * True for a row a fresh install built with 🏰 DERO HEADQUARTERS alone (2026-11 item 285
 * Phase 2): no 🪧 NOTICE BOARD id, a Headquarters id. Every legacy row holds categoryId,
 * so none reads as Headquarters only.
 */
export function isHeadquartersOnly(row: unknown): boolean {
	const ids = (row ?? {}) as IManagedCategoryIds;
	return !ids.categoryId && Boolean(ids.headquartersCategoryId);
}

// Every managed category a forced rebuild may settle slot by slot instead of building:
// the two secondary ones when they survive (2026-10 item 273), and 🪧 NOTICE BOARD when
// its channels survive their deleted category (2026-10 item 275).
type SettledCategoryField = ManagedCategoryField;

/** Options for GuildSetupManager.autoSetup. */
export interface IAutoSetupOptions {
	// Build even though a row exists: the rebuild paths (ensureHomebase, ScheduleBoard,
	// /setup after a self destruct) set it.
	force?: boolean;
	// The stored homebase was authored by another bot (ensureHomebase's "foreign" branch,
	// ScheduleBoard's stale author). Every channel is then built new, even inside a reused
	// category, so Dero never keeps a channel another bot owns (2026-10 item 273, D1).
	foreignHomebase?: boolean;
}

// Every overwrite shape a first build hands out, one per posture (channelPostures).
type IChannelPostures = Record<"public" | "intro" | "admin" | "adminLog" | "commandOutput" | "voice", IOverwriteEntry[]>;

// How each secondary category is logged and overwritten (its name is resolveCategoryName's,
// from the guild's pack). One table, so the arcade and Headquarters are found, adopted by
// name and built by the same code.
// The arcade's shape mirrors the notice board's, owner allow and nothing else (see
// findExistingManagedCategory). Headquarters is admin only, so it takes the admin
// channels' shape (headquartersCategoryOverwrites says why its bot entry differs).
const SECONDARY_CATEGORIES: Record<
	SecondaryCategoryField,
	{ logTag: string; overwrites: (guild: Guild, ownerId: string, adminRoleId: string | null) => IOverwriteEntry[] }
> = {
	gamesCategoryId: {
		logTag: "arcade-category",
		overwrites: (_guild, ownerId) => [
			{ id: ownerId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
		],
	},
	headquartersCategoryId: {
		logTag: "headquarters-category",
		overwrites: (guild, ownerId, adminRoleId) => headquartersCategoryOverwrites(guild, { ownerId }, { memberRoleId: null, adminRoleId }),
	},
};

/** One bot managed channel: its GuildConfig field, its name, its overwrite kind and its parent. */
export interface IChannelSpec {
	configField: (typeof GuildSetupManager.CHANNEL_FIELDS)[number];
	// The channel's key in a pack's setup.channels. Its real name is read through the
	// guild's pack (GuildSetupManager.channelNameFor), so a template switch renames it.
	nameKey: ChannelNameKey;
	// The default pack's name, derived from nameKey (withDefaultNames) so the two cannot
	// disagree. Log lines and labels only; never a channel's name in a guild.
	displayName: string;
	// "voice" builds a GuildVoice room with the voice shape, its intro posted in
	// the room's built in text chat; the other two build text channels. One
	// table for all three, so the repair
	// sweep, the delete watcher, the drift rename, the admin grant and self
	// destruct reach a voice room through the same walk as everything else.
	// "adminLog" is the one bot write only channel, the audit trail.
	kind: "public" | "admin" | "adminLog" | "voice";
	// ⚠️ REQUIRED ON PURPOSE, and that is the entire mitigation for risk R2.
	// There are TWO managed categories now, and every consumer that builds or
	// repairs a channel has to know which parent it belongs under. An optional
	// field with a "categoryId" default would let a games spec silently inherit
	// the homebase category, which produces 📋arcade-rules under 🪧 NOTICE BOARD,
	// an adopt-before-build scan that searches the wrong parent, and therefore
	// duplicate channels. None of that throws. Making it required turns that
	// entire class of mistake into a compile error at the moment a spec is
	// added, which is the only place anyone would ever get it wrong.
	// 🏰 DERO HEADQUARTERS made it three (2026-10 item 257 Phase 2a); the reasoning
	// is unchanged, and a test asserts every spec names one of the three.
	categoryField: "categoryId" | SecondaryCategoryField;
}

// Every spec's displayName from its nameKey in the default pack.
function withDefaultNames(specs: Array<Omit<IChannelSpec, "displayName">>): IChannelSpec[] {
	const names = getPluginCopy(null).setup.channels;
	return specs.map((spec) => ({ ...spec, displayName: names[spec.nameKey] }));
}

export class GuildSetupManager {
	// ── channel overwrites ────────────────────────────────────
	// Every overwrite shape a managed channel gets, text and voice, comes from
	// ./communityOverwrites.ts, which branches on the guild's Discord Community state
	// (2026-10 item 247 Phase 1). createChannels, buildSingleChannel, applyAdminRole
	// and the boot reconcile below all read it, so the create path and the repair
	// path cannot drift and no second copy of a shape lives in this file.

	// ── Phase 1: auto-construct on join / restart ─────────────
	// What: build the homebase category + six channels, then persist a
	//       GuildConfig row describing them.
	// Who:  called from guildCreate in main.ts (first time the bot joins a
	//       guild) and from ensureHomebase when a rebuild is warranted.
	// When: once per guild per lifecycle of this bot installation, unless
	//       the caller sets options.force.
	// How:  the early return guard skips the build when an existing
	//       GuildConfig row for this guildId is found, UNLESS force is set.
	//       The force flag is the escape hatch ensureHomebase uses when it
	//       has already determined the stored row is foreign (owned by a
	//       different bot), in that case we must proceed and build our own
	//       homebase without touching the foreign row. Schema has a unique
	//       index on guildId, so if the foreign row is still in the same
	//       collection the create call will throw a duplicate key error.
	//       We log that loudly and bail rather than silently corrupting
	//       anything. Expectation is that the operator runs dev and prod
	//       against separate MongoDB clusters; this guard is defense in
	//       depth against a misconfigured MONGOOSE_URI.
	// Per-guild mutex for autoSetup. Parallel calls for the same guildId both
	// pass the early-return check below before either persists, so both create
	// Discord channels and only one wins the unique-index race, leaving an
	// orphaned duplicate category (hit this 2026-05-05 on first join to a new
	// test server). The mutex caches the first call's promise so a second call
	// returns the same work instead of starting a parallel run. Single-process
	// bot only; multi-process would need a distributed lock.
	private static inflightAutoSetups = new Map<string, Promise<void>>();

	static async autoSetup(guild: Guild, config: ISetupConfig, options: IAutoSetupOptions = {}): Promise<void> {
		const inflight = GuildSetupManager.inflightAutoSetups.get(config.guildId);
		if (inflight) return inflight;

		const work = GuildSetupManager.runAutoSetup(guild, config, options);
		GuildSetupManager.inflightAutoSetups.set(config.guildId, work);
		try {
			await work;
		} finally {
			GuildSetupManager.inflightAutoSetups.delete(config.guildId);
		}
	}

	private static async runAutoSetup(guild: Guild, config: ISetupConfig, options: IAutoSetupOptions = {}): Promise<void> {
		const existing = await guildConfigStore.findByGuildId(config.guildId);
		// default behavior: if a row exists, assume the homebase is already
		// constructed (by this bot) and skip. ensureHomebase is the only
		// caller that knows the row is stale or foreign and sets force to
		// bypass. A "stale" row means the category or channels were deleted
		// in Discord but the row in our DB still points at those dead ids,
		// we want to refresh the ids on THAT row, not insert a second one.
		// ANY stored category id counts as built, because a Headquarters only row (below)
		// stores no notice board id: reading only categoryId would full build it on the next
		// call. Every legacy row holds categoryId, so this widening changes nothing for them.
		if (hasManagedCategory(existing) && !options.force) return;

		// ⚠️ A FRESH INSTALL BUILDS ONLY 🏰 DERO HEADQUARTERS (2026-11 item 285 Phase 2).
		// No row means Dero never built here, so 🪧 NOTICE BOARD and 🎮 ARCADE GAMES are
		// left out and their ids stay null; the onboarding tutorial (Phase 3) builds the
		// notice board on demand, and the arcade is stored off exactly as turnArcadeOff
		// leaves it, so the boot sweep never builds it until /arcade on lifts the opt out.
		// Any existing row (every forced rebuild, a self destruct's /setup) is a legacy
		// build and takes the full path below, byte for byte as before. This flag is the
		// one branch; every step it touches reads it rather than deciding again.
		const headquartersOnly = existing === null;

		// The SECOND category is LOOKED UP before the homebase category is built, and
		// only CREATED after it, so the sidebar order stays NOTICE BOARD then ARCADE
		// GAMES (Discord orders categories by creation). Looking first matters because
		// a stored id Discord could not confirm either way stops the pass here, with
		// nothing built: a NOTICE BOARD created and then abandoned unpersisted would
		// itself be a duplicate on the next pass (the post-launch plan's item 1).
		// ⚠️ THREAD THE STORED ARCADE ID. This used to hardcode null, which made the
		// helper's reuse branch dead on this path and always created a category. That
		// is harmless on a fresh install (the id genuinely is null) but this is NOT
		// only the fresh-install path: rebuildFromStaleConfig and ScheduleBoard
		// .rebuildHomebase both call in with force: true, which walks straight past
		// the early return above. An admin deleting only the NOTICE BOARD category
		// therefore got a SECOND 🎮 ARCADE GAMES built beside the live one, with
		// gamesCategoryId repointed at it, permanently orphaning the original
		// category, its channels, and every in-progress room channel parented under
		// it (selfDestruct's MANAGED_CATEGORY_FIELDS reads the stored id, so
		// /self-destruct could not reach them either). repairMissingChannels passes
		// the stored id for exactly this reason; this is the same call.
		const storedArcadeId = (existing as unknown as { gamesCategoryId?: string | null } | null)?.gamesCategoryId ?? null;
		const existingArcade = headquartersOnly
			? null
			: await GuildSetupManager.findExistingManagedCategory(guild, "gamesCategoryId", storedArcadeId, copyConfigOf(existing));
		if (existingArcade === "unreachable") return;
		// 🏰 DERO HEADQUARTERS (2026-10 item 257 Phase 2a), looked up first and created
		// third for the same two reasons: the sidebar reads NOTICE BOARD, ARCADE GAMES,
		// DERO HEADQUARTERS, and a forced rebuild reuses the live category.
		const storedHeadquartersId = (existing as unknown as { headquartersCategoryId?: string | null } | null)?.headquartersCategoryId ?? null;
		const existingHeadquarters = await GuildSetupManager.findExistingManagedCategory(guild, "headquartersCategoryId", storedHeadquartersId, copyConfigOf(existing));
		if (existingHeadquarters === "unreachable") return;

		// What:  build the homebase category. Owner is granted explicit
		//        view/send/read; @everyone is intentionally NOT denied
		//        ViewChannel here.
		// Why:   denying @everyone on the category was a noop for UX
		//        (Discord shows any category that has at least one visible
		//        child, and the six public children are visible to
		//        everyone anyway). It was also actively harmful: it
		//        clobbered the bot's own ViewChannel inheritance via
		//        @everyone-role membership and triggered 50013 either
		//        on child creation (when no bot overwrite was present)
		//        or on the category create itself (when a bot member
		//        overwrite tried to escalate ManageRoles/ManageChannels
		//        in the same call). Privacy is enforced at the child
		//        channel level, adminOverwrites in createChannels has
		//        @everyone deny ViewChannel, which is the only place it
		//        ever actually mattered.
		// How:   only the owner allow remains. dev suffix logic on the
		//        category name is unchanged so a dev bot can still
		//        coexist with prod in a shared guild.
		// v1.5.1 item 9: wrap the category create in a 50013 catch so the
		// bot can track guilds it cannot serve and eventually leave them
		// after the grace period. Other Discord errors keep their existing
		// throw-through behavior so legitimate failures still surface.
		// A Headquarters only build makes no notice board, so its 50013 is caught by
		// createManagedCategory on the Headquarters create below instead.
		let category: CategoryChannel | null = null;
		if (!headquartersOnly) {
			try {
				category = await guild.channels.create({
					name: resolveCategoryName("categoryId", copyConfigOf(existing)),
					type: ChannelType.GuildCategory,
					permissionOverwrites: [
						{
							id: config.ownerId,
							allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
						},
					],
				});
			} catch (error) {
				if (error instanceof DiscordAPIError && error.code === 50013) {
					await GuildSetupManager.handlePermissionFailure(guild);
					return;
				}
				throw error;
			}
		}

		// A null return means a 50013 already routed through handlePermissionFailure,
		// so bail exactly as the homebase category create above does.
		let gamesCategory: CategoryChannel | null = null;
		if (!headquartersOnly) {
			gamesCategory = existingArcade ?? (await GuildSetupManager.createManagedCategory(guild, "gamesCategoryId", config.ownerId, null, copyConfigOf(existing)));
			if (!gamesCategory) return;
		}
		// The stored admin role rides along so a forced rebuild's category opens to
		// admins at once; null on a fresh install, where /setup grants it later.
		const headquartersCategory =
			existingHeadquarters ?? (await GuildSetupManager.createManagedCategory(guild, "headquartersCategoryId", config.ownerId, existing?.adminRoleId ?? null, copyConfigOf(existing)));
		if (!headquartersCategory) return;

		// The voice rooms are the one posture that names a role (owner decision D3,
		// member role only), so a forced rebuild of a guild that already ran /setup
		// threads its stored roles through and the rebuilt rooms open to members at
		// once instead of waiting for /setup to run again. Both null on a fresh install.
		const storedRoles = { memberRoleId: existing?.memberRoleId ?? null, adminRoleId: existing?.adminRoleId ?? null };
		// The text channels take the stored admin role only while the row says /setup
		// finished (2026-10 item 272, owner decision D2). A forced rebuild of a set up
		// server then grants it exactly as the repair path's buildSingleChannel does, so
		// admins keep 🔒inner-sanctum and the rest of Headquarters. A self destructed row
		// keeps its old adminRoleId but has setupComplete false, and the /setup that
		// rebuilds it grants the role it was just given through applyAdminRole, so trusting
		// the old id there would re-grant a role the owner may have meant to replace.
		const textRoles = { memberRoleId: storedRoles.memberRoleId, adminRoleId: existing?.setupComplete ? storedRoles.adminRoleId : null };
		const roles = { voice: storedRoles, text: textRoles };

		// ⚠️ A REUSED CATEGORY KEEPS ITS LIVE CHANNELS (2026-10 item 273). Building its
		// group here as well put a second set of every arcade and Headquarters channel
		// beside the live one, repointed the row at the copies and orphaned the originals
		// with their pins and history. So a reused category's group is not built here;
		// settleReusedCategoryChildren keeps or repairs each of its slots once the row is
		// stored. A foreign homebase builds every group as before, so Dero never keeps a
		// channel another bot owns (owner decision D1).
		const reusedCategories: Array<{ field: SettledCategoryField; category: CategoryChannel }> = [];
		// ⚠️ THE NOTICE BOARD'S SURVIVORS ARE MOVED, NOT REBUILT (2026-10 item 275). Discord
		// keeps a deleted category's channels, uncategorized, so building the notice board
		// group new left a second set beside the originals and their history. When any of
		// Dero's own notice board channels may still exist, the group is settled like a
		// reused category (first, so its slots settle before the arcade's), and the
		// survivors are moved into the new category. When every one is confirmed gone (a
		// self destruct, a fresh install) the group is built in bulk exactly as before (D2).
		if (category && existing && !options.foreignHomebase && (await GuildSetupManager.mayHaveNoticeBoardSurvivors(guild, existing))) {
			reusedCategories.push({ field: "categoryId", category });
		}
		if (existingArcade && gamesCategory && !options.foreignHomebase) reusedCategories.push({ field: "gamesCategoryId", category: gamesCategory });
		if (existingHeadquarters && !options.foreignHomebase) reusedCategories.push({ field: "headquartersCategoryId", category: headquartersCategory });
		const keepsChildrenOf = (field: SettledCategoryField): boolean => reusedCategories.some((entry) => entry.field === field);

		// The stored row rides along twice: createChannels' adoption scan must not take
		// a channel that already fills another slot, and the rules post keeps the
		// owner's saved rules through a forced rebuild.
		const storedRow = existing as unknown as (Record<string, unknown> & IRulesConfig) | null;
		const built = await GuildSetupManager.createChannels(
			guild,
			{
				category: keepsChildrenOf("categoryId") ? null : category,
				gamesCategory: keepsChildrenOf("gamesCategoryId") ? null : gamesCategory,
				headquartersCategory: keepsChildrenOf("headquartersCategoryId") ? null : headquartersCategory,
			},
			config,
			roles,
			storedRow
		);
		const { adoptedChannelIds, adoptions } = built;
		const { scheduleMessageId, introMessageIds } = await GuildSetupManager.populateChannels(
			guild,
			{ homebase: built.homebase?.objects ?? null, arcade: built.arcade?.objects ?? null, headquarters: built.headquarters?.objects ?? null },
			{ adoptedChannelIds, rulesConfig: storedRow, adminRoleId: textRoles.adminRoleId, copyConfig: copyConfigOf(storedRow) }
		);

		// What: persist the freshly built channel ids.
		// When: two mutually exclusive persist paths, chosen by the state of
		//       `existing`:
		//         path A, no row exists yet: create a new row.
		//         path B, a row exists AND force is true: update in place.
		//                  This is the "our row but the Discord side was
		//                  wiped" case. We never hit this path unless the
		//                  caller has already proven ownership (ensureHomebase
		//                  runs the ownership probe first) or is handling a
		//                  missing category (which can only belong to us if
		//                  our row holds its id).
		// How:   path B uses update which matches on guildId and $set's the
		//        fresh ids. The adminRoleId / memberRoleId / setupComplete
		//        flags are preserved because we do not set them in the
		//        update payload, any prior Phase 2 state carries over to
		//        the repaired homebase. A reused category's channel slots are
		//        left out the same way, so they keep pointing at the live channels.
		// Where: path A's create is wrapped in a duplicate-key guard for the
		//        shared cluster misconfig case (dev bot running against the
		//        same MongoDB collection as prod). We REFUSE to overwrite a
		//        foreign row; the Discord side is already built so the least
		//        bad outcome is that the bot logs loudly and bails on persist.
		const persistPayload = {
			// ⚠️ EVERY ID A BUILT GROUP RETURNS IS STORED HERE, NO EXCEPTIONS, by spreading
			// the group whole, and the exception this payload used to carry is why that is
			// worth stating: 🔜upcoming-events was built alongside the others but its id was
			// left out, so the row held null until the next boot's repair sweep adopted the
			// orphan, and NextUpBoard, which bails on a null pointer, posted nothing in between.
			// 👋welcome and 📘rules ride the homebase group, replaced rather than merged: a
			// build re-derives every adoption, and an id from a prior build points at a
			// channel this one either re-adopted or never saw.
			// A settled or reused category writes only its own id (the notice board's is new,
			// and a reused one may have been adopted by name under a new id); its channel
			// slots stay as stored, and the settle step writes any it rebuilds.
			// A Headquarters only build stores both unbuilt category ids as null.
			...(built.homebase?.ids ?? { categoryId: category?.id ?? null }),
			...(built.arcade?.ids ?? { gamesCategoryId: gamesCategory?.id ?? null }),
			...(built.headquarters?.ids ?? { headquartersCategoryId: headquartersCategory.id }),
			// A settled notice board leaves the adopted list as stored: repairOneChannel
			// writes it for any 👋welcome or 📘rules slot it settles.
			...(built.homebase ? { adoptedChannelIds } : {}),
			// The arcade is built, so its switches are written on (2026-10 item 257,
			// owner item 11), except one this server already turned off. A Headquarters
			// only build stores it off instead, every arcade slot opted out the way
			// turnArcadeOff leaves it, which is what keeps repairMissingChannels from
			// building it on the next boot and what lets /arcade on bring it back.
			...(headquartersOnly ? { userRemovedChannels: GuildSetupManager.specFieldsUnder("gamesCategoryId") } : arcadeSwitchesToWrite(existing)),
			// v1.5.1 item 9: clear any previously-tracked permission failure
			// so a guild that recovered from missing-permissions state stops
			// being on the auto-leave countdown. Safe to set unconditionally
			// because Mongo treats setting null to an already-null field as
			// a no-op.
			firstPermissionFailureAt: null,
			// scheduleMessageId anchors the pinned schedule board that
			// ScheduleBoard.refreshSchedule keeps up to date. see
			// src/features/schedule/ScheduleBoard.ts for the lifecycle. A settled notice
			// board keeps the stored one (a kept 📅event-schedule keeps its board, and a
			// rebuilt one gets its anchor from repairOneChannel).
			...(scheduleMessageId ? { scheduleMessageId } : {}),
			// introMessageIds anchors every other intro embed so
			// refreshIntroEmbeds can edit them in place on subsequent boots
			// when the copy packs (@base/copy/packs) change. This is the field that
			// makes "rebuild the bot copy without nuking the homebase"
			// possible. A reused category's stored anchors are carried over, so a kept
			// channel's intro is edited in place rather than posted a second time.
			introMessageIds: { ...GuildSetupManager.storedAnchorsUnder(existing, reusedCategories), ...introMessageIds },
		};

		if (existing) {
			// path B, in place update of our existing row. Phase 2 state
			// (adminRoleId, memberRoleId, setupComplete) is intentionally
			// not overwritten so a repair preserves it.
			await guildConfigStore.update(config.guildId, persistPayload);
		} else {
			try {
				// path A, fresh insert. initialize Phase 2 fields to null so the
				// unsetup state matches a clean install.
				await guildConfigStore.create({
					guildId: config.guildId,
					adminRoleId: null,
					memberRoleId: null,
					...persistPayload,
					setupComplete: false,
				});
			} catch (error) {
				// MongoDB duplicate key (code 11000) means a row for this guildId
				// already exists, almost certainly the shared DB scenario where
				// another bot's row is in the collection. We REFUSE to overwrite
				// it (that would corrupt the other bot's state). The Discord side
				// channels are already built at this point so this is the least
				// bad outcome: bot stays online but cannot persist its config
				// until the operator separates the DBs. Logged loudly so the
				// smell is impossible to miss.
				const code = (error as { code?: number }).code;
				if (code === 11000) {
					console.error(LOG_MESSAGES.setup.guildConfigDuplicateKey(config.guildId));
				}
				throw error;
			}
		}

		GuildSetupManager.afterAdoptionPersisted(guild, adoptions);
		// AWAITED, not fire and forget: the boot's refreshIntroEmbeds and /setup's own
		// check read the row next, and must see the settled slots and anchors.
		const { keptFields } = await GuildSetupManager.settleReusedCategoryChildren(guild, reusedCategories, roles);
		// Dero may join the voice rooms this build made (2026-10 item 257, owner item 8).
		// Only the rooms a built group created: a kept 🎮 Arcade Lounge is on the list
		// already and a rebuilt one was swapped there by repairOneChannel, so a dead stored
		// id is never added.
		// A moved 🏛️ Meeting Hall keeps its id, so its entry is already right.
		void allowDeroVoiceRooms(config.guildId, [built.homebase?.ids.meetingVoiceChannelId, built.arcade?.ids.arcadeVoiceChannelId]);
		GuildSetupManager.syncHeadquartersAfterBuild(guild, built.headquarters !== null, keptFields);
	}

	// The stored intro anchors of every slot under the given settled categories (and each
	// category's second message: the 🕹️games Challenge Board, the #command-center invite
	// card), carried into the rebuilt row so a kept channel keeps the anchor
	// refreshIntroEmbeds edits in place. A slot that is gone gets its anchor from
	// repairOneChannel, which overwrites this one.
	private static readonly SECOND_MESSAGE_ANCHORS: Partial<Record<SettledCategoryField, string>> = {
		gamesCategoryId: "arcadeGamesBoardId",
		categoryId: "inviteCardId",
	};

	private static storedAnchorsUnder(
		stored: unknown,
		reused: ReadonlyArray<{ field: SettledCategoryField }>
	): Record<string, string | null> {
		const anchors = (asPlainRow(stored)?.introMessageIds ?? {}) as Record<string, string | null | undefined>;
		const carried: Record<string, string | null> = {};
		for (const { field } of reused) {
			const slots: string[] = GuildSetupManager.CHANNEL_SPECS.filter((spec) => spec.categoryField === field).map((spec) => spec.configField);
			const secondMessage = GuildSetupManager.SECOND_MESSAGE_ANCHORS[field];
			if (secondMessage) slots.push(secondMessage);
			for (const slot of slots) {
				const anchor = anchors[slot];
				if (anchor !== undefined) carried[slot] = anchor;
			}
		}
		return carried;
	}

	// ── a reused or settled category's channels on a forced rebuild (2026-10 items 273, 275) ──
	// What:  for every slot under a category this build reused, keep the stored channel
	//        when it is still alive and build only what is gone, through repairOneChannel,
	//        the boot sweep's own primitive, so a forced rebuild never builds a second set.
	// Who:   runAutoSetup, after the row is stored and before its side effects.
	// When:  a forced rebuild that found 🎮 ARCADE GAMES or 🏰 DERO HEADQUARTERS alive, or
	//        a fresh row that adopted one by name (a reset database, owner decision D4);
	//        and a rebuild whose 🪧 NOTICE BOARD channels may have survived their deleted
	//        category (item 275), which walks first. Never on a foreign homebase (D1).
	// How:   ① read the stored row as a plain object (it now holds the new homebase anchors);
	//        ② walk the reused categories' specs in order, skipping a slot the admin
	//           removed (an arcade switched off stays off, D3);
	//        ③ keep a live stored channel of the spec's kind wherever it is (D2): the boot
	//           sweep moves a Headquarters channel found outside Headquarters, and an arcade
	//           channel an admin moved stays where they put it, as the sweep treats it. A
	//           notice board survivor left uncategorized is first moved into the new
	//           category (moveNoticeBoardSurvivor);
	//        ④ skip a slot Discord could not confirm either way, so a transient failure
	//           never builds a duplicate; the next boot's sweep settles it;
	//        ⑤ hand a gone slot to repairOneChannel with the CHAINED row. It writes the whole
	//           introMessageIds map merged onto the row it is given, so a stale row, or two
	//           repairs in parallel, would erase anchors: sequential on purpose.
	//        One slot's failure is logged and the walk continues; the boot sweep retries it.
	// Returns the slots it kept, which syncHeadquartersAfterBuild reads.
	private static async settleReusedCategoryChildren(
		guild: Guild,
		reused: ReadonlyArray<{ field: SettledCategoryField; category: CategoryChannel }>,
		roles: { voice: IOverwriteRoles; text: IOverwriteRoles }
	): Promise<{ keptFields: Set<string> }> {
		const keptFields = new Set<string>();
		if (reused.length === 0) return { keptFields };
		// ⚠️ PLAIN, NOT HYDRATED: the row is chained by spread below, and a spread Mongoose
		// document keeps none of its fields (plainRow.ts).
		let row = asPlainRow(await guildConfigStore.findByGuildId(guild.id));
		if (!row) return { keptFields };
		const removedSlots = new Set((row.userRemovedChannels as string[] | undefined) ?? []);

		for (const { field, category } of reused) {
			for (const spec of GuildSetupManager.CHANNEL_SPECS.filter((entry) => entry.categoryField === field)) {
				if (removedSlots.has(spec.configField)) continue;
				const storedId = row[spec.configField];
				if (typeof storedId === "string" && storedId.length > 0) {
					const live = await GuildSetupManager.fetchStoredChannel(guild, storedId, GuildSetupManager.isChannelOfSpecKind(spec));
					if (live === "unreachable") {
						console.warn(`[setup] guild ${guild.id}: could not confirm ${spec.configField} ${storedId}; building nothing for it this pass`);
						continue;
					}
					if (live) {
						if (field === "categoryId") await GuildSetupManager.moveNoticeBoardSurvivor(guild, live, category, spec, row, roles);
						keptFields.add(spec.configField);
						continue;
					}
				}
				try {
					const result = await GuildSetupManager.repairOneChannel(guild, category, spec, GuildSetupManager.rowViewFor(spec, row, roles));
					// The view carried the admin role this rebuild trusts, not the row's: put the
					// stored one back so the next spec's view starts from the truth.
					row = { ...result.stored, adminRoleId: roles.voice.adminRoleId };
				} catch (error) {
					console.error(LOG_MESSAGES.setup.channelRepairFailed(spec.displayName, guild.id), error);
				}
			}
		}
		return { keptFields };
	}

	// Whether a fetched channel is the kind a spec builds. A text channel an admin named
	// like the voice room is not the voice room (the same rule repairOneChannel's scan keeps).
	private static isChannelOfSpecKind(spec: (typeof GuildSetupManager.CHANNEL_SPECS)[number]): (channel: unknown) => channel is TextChannel | VoiceChannel {
		return (channel: unknown): channel is TextChannel | VoiceChannel => (spec.kind === "voice" ? channel instanceof VoiceChannel : channel instanceof TextChannel);
	}

	// The row repairOneChannel builds one slot from. A voice room takes the stored roles as
	// is and a text channel the admin role a forced rebuild trusts (only once /setup has
	// finished, 2026-10 item 272), because repairOneChannel reads stored.adminRoleId for both
	// the overwrites and the admin intro. Never persisted: repairOneChannel writes only the
	// slot, its anchor and the adopted list.
	private static rowViewFor(
		spec: (typeof GuildSetupManager.CHANNEL_SPECS)[number],
		row: Record<string, unknown>,
		roles: { voice: IOverwriteRoles; text: IOverwriteRoles }
	): Record<string, unknown> & { adminRoleId: string | null } {
		const trusted = GuildSetupManager.rolesFor(spec, roles);
		return { ...row, adminRoleId: trusted.adminRoleId, memberRoleId: trusted.memberRoleId };
	}

	// The roles a forced rebuild trusts for one spec's overwrites: the stored pair for a
	// voice room, the setupComplete gated admin role for a text channel (item 272).
	private static rolesFor(spec: (typeof GuildSetupManager.CHANNEL_SPECS)[number], roles: { voice: IOverwriteRoles; text: IOverwriteRoles }): IOverwriteRoles {
		return spec.kind === "voice" ? roles.voice : roles.text;
	}

	// Whether any of Dero's own stored notice board channels may still exist (2026-10 item
	// 275, D2). False only when every one is confirmed gone or was never stored, which is
	// what a self destruct and a fresh install leave, so those keep the bulk build. A slot
	// Discord could not confirm counts as "may": settling skips it rather than building a
	// duplicate. A server's own channel adopted in place (👋welcome, 📘rules) is not
	// Dero's, survives a self destruct by design, and so does not count.
	private static async mayHaveNoticeBoardSurvivors(guild: Guild, stored: unknown): Promise<boolean> {
		const row = asPlainRow(stored);
		if (!row) return false;
		const adoptedIds = readAdoptedChannelIds(row);
		for (const spec of GuildSetupManager.CHANNEL_SPECS.filter((entry) => entry.categoryField === "categoryId")) {
			const storedId = row[spec.configField];
			if (typeof storedId !== "string" || storedId.length === 0 || adoptedIds.includes(storedId)) continue;
			if ((await GuildSetupManager.fetchStoredChannel(guild, storedId, GuildSetupManager.isChannelOfSpecKind(spec))) !== null) return true;
		}
		return false;
	}

	// A notice board channel that outlived its deleted category, moved into the rebuilt
	// 🪧 NOTICE BOARD (2026-10 item 275) with its messages, pins and every overwrite an
	// owner added by hand (moveIntoCategory). Only an UNCATEGORIZED one moves, which is
	// exactly what Discord leaves behind (D1): one an admin put into a category of their
	// own stays there, and a server's own channel adopted in place is never moved (D3).
	// A failed move is logged and the channel stays where it is, still kept: nothing is
	// built in its place.
	private static async moveNoticeBoardSurvivor(
		guild: Guild,
		channel: TextChannel | VoiceChannel,
		category: CategoryChannel,
		spec: (typeof GuildSetupManager.CHANNEL_SPECS)[number],
		row: Record<string, unknown>,
		roles: { voice: IOverwriteRoles; text: IOverwriteRoles }
	): Promise<void> {
		if (channel.parentId) return;
		if (readAdoptedChannelIds(row).includes(channel.id)) return;
		try {
			await moveIntoCategory(guild, channel, category, overwriteKindOf(spec), GuildSetupManager.rolesFor(spec, roles));
		} catch (error) {
			console.warn(`[setup] guild ${guild.id}: could not move ${spec.configField} into the rebuilt 🪧 NOTICE BOARD; it stays where it is`, error);
		}
	}

	// Each 🏰 DERO HEADQUARTERS config channel gets its steps card and chart under its intro
	// (2026-10 item 257 Phase 2b), fire and forget. A Headquarters this build made syncs
	// every domain; a reused one syncs only the channels it kept, because repairOneChannel
	// already synced each one it rebuilt, and a second sync of the same channel in flight
	// could post a second steps card.
	private static syncHeadquartersAfterBuild(guild: Guild, builtHeadquarters: boolean, keptFields: ReadonlySet<string>): void {
		if (builtHeadquarters) {
			void syncAllHeadquarters(guild);
			return;
		}
		for (const domain of HEADQUARTERS_DOMAINS) {
			if (keptFields.has(DOMAIN_CHANNEL_FIELDS[domain])) void syncHeadquartersChannel(guild, domain);
		}
	}

	// ── auto-leave (v1.5.1 item 9, 2026-05-12) ───────────────────
	// Handle a permission failure during category creation. Tracks the
	// first failure timestamp on a minimal GuildConfig row, and if the
	// failure has persisted past AUTO_LEAVE_GRACE_DAYS, fires the
	// auto-leave flow. Idempotent: re-running the handler on a guild
	// already past the grace window will just re-attempt the leave.
	// Idempotent on first call too because findOneAndUpdate is safe to
	// repeat with the same now-timestamp.
	private static async handlePermissionFailure(guild: Guild): Promise<void> {
		console.warn(`[autoSetup] missing permissions during category create for guild ${guild.id}`);
		const existing = await guildConfigStore.findByGuildId(guild.id);
		const now = new Date();

		// Read firstPermissionFailureAt off the existing row defensively.
		// The field is declared on the schema but legacy rows may load
		// without it; treat undefined as "never failed before."
		const stored = existing as unknown as { firstPermissionFailureAt?: Date | null } | null;
		const firstFailureAt = stored?.firstPermissionFailureAt ?? null;

		if (!firstFailureAt) {
			// First detected failure for this guild. Record the timestamp
			// so subsequent checks know how long the guild has been in
			// failed state. Write only the failure timestamp; do NOT
			// populate channel ids or category id because none exist yet.
			if (existing) {
				await guildConfigStore.update(guild.id, { firstPermissionFailureAt: now });
			} else {
				// No GuildConfig row at all. We need one to track the
				// failure timestamp, but we cannot create a full row
				// because the schema requires categoryId and the channel
				// ids that we cannot mint. Skipping persistence for now;
				// next failure will see no existing row and re-enter this
				// branch. The grace period effectively starts on the
				// first successful guildConfigStore.create after the bot
				// gets permissions, which is acceptable: a guild with no
				// row at all means the bot has not yet succeeded at
				// anything, so the worst case is the grace period starts
				// fresh on first row-creation rather than first failure.
				console.warn(`[autoSetup] no GuildConfig row exists for ${guild.id}; cannot track failure timestamp yet`);
			}
			return;
		}

		const failedFor = now.getTime() - new Date(firstFailureAt).getTime();
		const gracePeriodMs = AUTO_LEAVE_GRACE_DAYS * MS_PER_DAY;

		if (failedFor < gracePeriodMs) {
			const daysLeft = Math.ceil((gracePeriodMs - failedFor) / MS_PER_DAY);
			console.warn(
				`[autoSetup] guild ${guild.id} still in failed-permissions state; ${daysLeft} day(s) of grace remaining`
			);
			return;
		}

		// Grace period exhausted. Fire the leave flow.
		await GuildSetupManager.executeAutoLeave(guild, failedFor);
	}

	// Execute the auto-leave flow: DM the owner with an Administrator-
	// invite explanation, audit-log the leave, then call guild.leave().
	// Each step is best-effort; downstream failures should not prevent
	// the leave call itself from firing. The DM is the most likely
	// failure (some owners block DMs from non-friends) so it is wrapped
	// in its own try/catch and the success boolean threads into the
	// audit metadata for later review.
	private static async executeAutoLeave(guild: Guild, failedForMs: number): Promise<void> {
		const failedForDays = Math.round(failedForMs / MS_PER_DAY);
		console.warn(`[autoSetup] auto-leaving guild ${guild.id} after ${failedForDays} day(s) of failed permissions`);

		// Attempt owner DM. The invite URL re-includes Administrator scope
		// (permissions=8) since the underlying reason the bot left was
		// channel-creation perm issues; re-inviting with full admin is
		// the most reliable path back. See memory at
		// project_rok_commander_invite_url for the rationale on shipping
		// with permissions=8 in the current version.
		const botUserId = guild.client.user?.id;
		const inviteUrl = botUserId
			? `https://discord.com/oauth2/authorize?client_id=${botUserId}&permissions=8&scope=bot+applications.commands`
			: null;

		let dmSent = false;
		try {
			const owner = await guild.fetchOwner();
			const dmBody = [
				`I've been in your server **${guild.name}** for ${failedForDays} day(s) but cannot create the channels I need to operate.`,
				`This usually means I'm missing the permission to create channels and categories.`,
				inviteUrl
					? `If you'd like me back, please re-invite me with this URL (it requests the Administrator scope I need):\n${inviteUrl}`
					: `Re-invite me with Administrator scope if you'd like me back.`,
				`Otherwise no action needed, I'll leave shortly to make room for other guilds.`,
			].join("\n\n");
			await owner.send(dmBody);
			dmSent = true;
		} catch (error) {
			// DM-blocked or owner not fetchable. Continue with the leave;
			// the audit row captures dmSent: false so the operator can
			// reach the owner via another channel if needed.
			console.warn(`[autoSetup] could not DM owner of ${guild.id} before auto-leave`, error);
		}

		// Audit log the leave so operators can trace why the bot left.
		// botLogStore.log is generic key-value; failedForDays plus dmSent
		// is enough to reconstruct the decision without extra context.
		try {
			await botLogStore.log(guild.id, BOT_LOG_EVENTS.AUTO_LEFT_GUILD, {
				failedForDays,
				dmSent,
				guildName: guild.name,
			});
		} catch (error) {
			console.error(`[autoSetup] failed to write auto-leave audit row for ${guild.id}`, error);
		}

		// Finally, leave the guild. If leave itself throws (rare), the
		// bot stays in the guild and the next autoSetup tick re-evaluates;
		// the audit row above will already be written so we have proof
		// the decision was made even if the action failed.
		try {
			await guild.leave();
		} catch (error) {
			console.error(`[autoSetup] guild.leave() failed for ${guild.id}`, error);
		}
	}

	// ── Phase 1.5: self heal on wake up ───────────────────────
	// What: when the bot comes online, scan each guild's homebase for damage.
	//       Three possible outcomes per guild:
	//         - category is gone or was never ours → rebuild everything via
	//           autoSetup and announce "castle rebuilt" in the new inner
	//           sanctum.
	//         - category is ours and intact but individual channels were
	//           deleted → rebuild just those channels under the existing
	//           category, update GuildConfig with the new ids, and post a
	//           per channel repair notice to the inner sanctum.
	//         - everything present and ours → no op.
	// Who:  called from client.once("ready") in main.ts for each guild the
	//       bot is cached in. Never adopts a homebase this bot did not
	//       create; that invariant is enforced by the ownership probe
	//       before any repair work runs.
	// When: once per guild per process boot. Any repair performed here will
	//       update GuildConfig, so the next boot skips straight through.
	// Where: pairs with rebuildHomebase in ScheduleBoard.ts. That path is
	//        triggered at runtime when a schedule refresh detects author
	//        mismatch. This path is the boot time counterpart and adds per
	//        channel repair coverage the schedule path does not have.
	// How:  ① load GuildConfig. If missing, build fresh (arrival DM flows
	//          from the caller in main.ts).
	//       ② Fetch the stored category; if gone, full rebuild.
	//       ③ Probe ownership via the stored schedule message; if foreign,
	//          full rebuild.
	//       ④ Run repairMissingChannels. If anything was rebuilt, post
	//          per channel notices to the (possibly just rebuilt) inner
	//          sanctum.
	//       ⑤ Otherwise, skip.
	static async ensureHomebase(client: Client, guild: Guild): Promise<IEnsureHomebaseResult> {
		// emit a sweep-start marker. without this it is hard to tell from
		// production logs whether ensureHomebase actually ran for a given
		// guild or was masked by an earlier error in the ready loop.
		console.log(LOG_MESSAGES.setup.ensureHomebaseStart(guild.id));

		const stored = await guildConfigStore.findByGuildId(guild.id);

		// ⓪ self-destructed → the owner demolished this homebase and it must stay
		//    gone until /setup rebuilds it. Skip all build/repair so the boot
		//    sweep does not resurrect what was deliberately torn down.
		if (stored?.homebaseDestroyed) {
			console.log(`[ensureHomebase] guild ${guild.id} homebase is self-destructed; skipping (run /setup to rebuild)`);
			return { action: "skipped", repairedChannels: [] };
		}

		// ① no config at all → never built for this guild. build fresh.
		if (!stored) {
			await GuildSetupManager.autoSetup(guild, { guildId: guild.id, ownerId: guild.ownerId });
			console.log(LOG_MESSAGES.setup.ensureHomebaseDone(guild.id, "built"));
			return { action: "built", repairedChannels: [] };
		}

		// ①.5 a Headquarters only install (2026-11 item 285 Phase 2) has no notice board to
		//      fetch, probe or rename, and a null categoryId must never read as "the
		//      category is gone", which would full build it in step ②. So only the sweep
		//      runs, with no notice board: Headquarters and its six channels are resolved
		//      and repaired as on any guild, the notice board's specs are skipped, and the
		//      arcade's stay off through the userRemovedChannels opt out the build stored.
		if (isHeadquartersOnly(stored)) {
			const repairedChannels = await GuildSetupManager.repairMissingChannels(client, guild, null);
			await GuildSetupManager.reconcileCommunityGating(client, guild);
			const action = repairedChannels.length > 0 ? "repaired" : "skipped";
			console.log(LOG_MESSAGES.setup.ensureHomebaseDone(guild.id, action));
			return { action, repairedChannels };
		}

		// ② category gone? null from fetch catch, or a Discord 10003 on the
		//    direct fetch path. Either way the stored homebase doesn't exist.
		// A null categoryId here is a row with no category at all, which step ① let
		// through; the missing category branch rebuilds it exactly as before.
		const category = stored.categoryId ? await guild.channels.fetch(stored.categoryId).catch(() => null) : null;
		if (!category) {
			console.warn(LOG_MESSAGES.setup.homebaseCategoryMissing(stored.categoryId, guild.id));
			await GuildSetupManager.rebuildFromStaleConfig(guild);
			await GuildSetupManager.postCastleRebuiltNotice(client, guild.id);
			console.log(LOG_MESSAGES.setup.ensureHomebaseDone(guild.id, "rebuilt"));
			return { action: "rebuilt", repairedChannels: [] };
		}

		// ③ category exists but is it ours? Discord does not expose a
		//    creator/owner field on CategoryChannel, so we fall back to the
		//    same signal ScheduleBoard uses at refresh time: fetch the
		//    stored scheduleMessageId and compare authors. Every autoSetup
		//    posts exactly this message, so it is a reliable provenance
		//    marker for the whole homebase.
		const ownership = await GuildSetupManager.isHomebaseOwnedByThisBot(client, guild.id, stored);
		// Rebuild ONLY when the homebase is positively foreign (anchor exists,
		// authored by a different bot). "unknown" (missing/deleted anchor) falls
		// through to repair-in-place: rebuilding there would duplicate our OWN
		// homebase on a benign missing schedule message, and clobber any
		// /server channels rename names (the rebuild path uses pack defaults). The schedule
		// board reposts its missing message on the next refresh.
		if (ownership === "foreign") {
			console.warn(LOG_MESSAGES.setup.homebaseNotOwned(guild.id));
			// Foreign: every channel is built new, none of the other bot's is kept (2026-10 item 273, D1).
			await GuildSetupManager.rebuildFromStaleConfig(guild, { foreignHomebase: true });
			await GuildSetupManager.postCastleRebuiltNotice(client, guild.id);
			console.log(LOG_MESSAGES.setup.ensureHomebaseDone(guild.id, "rebuilt"));
			return { action: "rebuilt", repairedChannels: [] };
		}

		// ③.5 reconcile category name. Existing guilds paired before the
		//      2026-05-22 universal-category rename still carry their old
		//      pack-specific name (🔱 BY DIVINE DECREE for ROK,
		//      📺 Stream Hub for streamer). Compare to the currently
		//      desired name and rename in place if stale. Failure here
		//      (rate limit, missing perms) is non fatal, the channel
		//      sweep below still runs, and the next boot retries. One
		//      PATCH per guild per restart at worst; no-op on subsequent
		//      boots because the names will match.
		const desiredCategoryName = resolveCategoryName("categoryId", copyConfigOf(stored));
		if (category instanceof CategoryChannel && category.name !== desiredCategoryName) {
			const previousName = category.name;
			try {
				await category.edit({ name: desiredCategoryName });
				console.log(`[ensureHomebase] renamed category in guild ${guild.id} from "${previousName}" to "${desiredCategoryName}"`);
			} catch (error) {
				console.warn(`[ensureHomebase] failed to rename category in guild ${guild.id} to "${desiredCategoryName}"`, error);
			}
		}

		// ③.6 🎛️admin-controls is retired (2026-10 item 263 Phase 4a, owner decision 14):
		//      deleted once, by its stored id only, never by name. Before the repair so
		//      the sweep below never sees a channel that is about to go. Never throws.
		await retireAdminControls(guild);

		// ④ category is ours. scan each of the six child channels and
		//    rebuild any that were deleted while the bot was offline.
		//    repairMissingChannels also posts the per channel notices so
		//    this method stays focused on branching logic.
		const repairedChannels = await GuildSetupManager.repairMissingChannels(client, guild, category as CategoryChannel);
		// ④.5 a guild whose welcome log is still Dero's own 👋welcome moves it to the
		//      server's own welcome channel when it has one (post-launch plan item 2).
		await GuildSetupManager.reconcileWelcomeAdoption(guild, category as CategoryChannel);
		if (repairedChannels.length > 0) {
			await GuildSetupManager.reconcileCommunityGating(client, guild);
			console.log(LOG_MESSAGES.setup.ensureHomebaseDone(guild.id, "repaired"));
			return { action: "repaired", repairedChannels };
		}

		// ⑤ happy path: stored homebase exists, is owned by this bot, and
		//    all six channels are present.
		await GuildSetupManager.reconcileCommunityGating(client, guild);
		console.log(LOG_MESSAGES.setup.ensureHomebaseDone(guild.id, "skipped"));
		return { action: "skipped", repairedChannels: [] };
	}

	// ── Community gating reconcile (2026-10 item 247 Phase 1) ─────
	// What:  move every existing managed channel onto the shape the guild's
	//        CURRENT Community state calls for, then hand the guild to the one
	//        time gating announcement when the member role gates it.
	// Who:   ensureHomebase, after a repair and on the happy path. Not after a
	//        build or a rebuild: createChannels already read the branch live.
	// When:  every boot, and on a re-invite. A channel already on its side of the
	//        branch costs a cached read and no write, so a steady boot writes nothing,
	//        and a non-Community guild that was never gated is never written to.
	// How:   ① re-read the row, since a repair just moved ids; ② reconcile each
	//        spec whose shape depends on the branch, one channel failing never
	//        stopping the rest; ③ when the member role gates the guild and at least
	//        one public text channel now carries the gate, call
	//        CommunityGatingAnnouncement.post. It posts once per guild for good: the
	//        BotLog key it checks makes every later call a no-op, and calling it on
	//        a boot where nothing moved is what lets a failed post retry, since the
	//        boot after a failure finds the gate already in place.
	//        Fire and forget: nothing here throws back into the boot sweep.
	private static async reconcileCommunityGating(client: Client, guild: Guild): Promise<void> {
		try {
			const stored = await guildConfigStore.findByGuildId(guild.id);
			if (!stored) return;
			const ids = stored as unknown as Record<string, string | null | undefined>;
			const gated = isMemberRoleGated(guild, stored.memberRoleId);
			const adoptedIds = new Set(readAdoptedChannelIds(stored));
			// Read only when the reconcile could hide something: an ungated shape keeps
			// @everyone's ViewChannel, which Onboarding never refuses.
			const safe = gated ? await readOnboardingSafeChannels(guild) : null;

			let moved = 0;
			let failed = 0;
			let publicChannelsOnBranch = 0;
			for (const spec of GuildSetupManager.CHANNEL_SPECS) {
				const kind = overwriteKindOf(spec);
				const channelId = ids[spec.configField];
				if (!dependsOnCommunityState(kind) || !channelId) continue;
				const channel = await guild.channels.fetch(channelId).catch(() => null);
				if (!(channel instanceof TextChannel || channel instanceof VoiceChannel)) continue;
				// A channel adopted IN PLACE (a system channel that is the server's main
				// chat, post-launch plan item 2) never sat under the notice board, and its
				// permissions are the owner's: gating it would lock members out of it.
				if (adoptedIds.has(channel.id) && channel.parentId !== stored.categoryId) continue;
				// A channel Discord Onboarding uses (or the guild's rules channel) must stay
				// readable by everyone, and Discord refuses the gate with 350003 on every
				// boot otherwise (2026-10 item 257, Log 1). One line, never a stack trace.
				if (safe && mustStayReadable(safe, channel.id, adoptedIds.has(channel.id))) {
					console.log(`[community-gating] guild ${guild.id} skipped ${spec.configField}: Discord Onboarding needs it readable by everyone`);
					continue;
				}
				try {
					if (await reconcileChannelOverwrite(guild, channel, kind, stored)) moved += 1;
					if (kind === "public") publicChannelsOnBranch += 1;
				} catch (error) {
					// One channel Discord refuses (a 50013, or a channel Community itself
					// holds open) must not leave the rest on the wrong side of the branch.
					failed += 1;
					console.warn(`[community-gating] guild ${guild.id} could not reconcile ${spec.configField}`, error);
				}
			}

			if (moved > 0 || failed > 0) {
				console.log(`[community-gating] guild ${guild.id} gated ${gated}: moved ${moved} channel(s), failed ${failed}`);
			}
			if (gated && publicChannelsOnBranch > 0) await CommunityGatingAnnouncement.post(client, guild, stored);
		} catch (error) {
			console.warn(`[community-gating] guild ${guild.id} reconcile failed; the next boot retries`, error);
		}
	}

	// ── channel spec type ─────────────────────────────────────
	// What: describes one of the six homebase channels enough to rebuild it.
	// Who:  repairMissingChannels (boot sweep) and ChannelDeleteWatcher
	//       (realtime). Both consume the same specs so the repair posture
	//       stays identical regardless of which entry point fired.
	// Where: exported as CHANNEL_SPECS below so the realtime listener can
	//        map a deleted channel id to a spec by walking the list.
	// How:   `intro` is a thunk on GuildSetupManager + the shared stored row
	//        because the admin channel's intro needs the fresh adminRoleId.
	//        Callers pass in a guild + stored getter pair so the thunk can
	//        resolve values lazily at post time.
	static readonly CHANNEL_FIELDS = [
		"introChannelId",
		"commandsChannelId",
		"leaderboardChannelId",
		"scheduleChannelId",
		"announcementsChannelId",
		"adminChannelId",
		// seventh homebase channel. home of the NextUpBoard, a new post
		// per upcoming event (or same day group) inside the 24h rolling
		// horizon, so leaders get a scrollable audit trail separate from
		// the living calendar in scheduleChannelId.
		"nextDecreeChannelId",
		// 🎛️admin-controls (adminCommandsChannelId) is NOT here since 2026-10 item 263
		// Phase 4a: it is retired, never built or repaired, and retireAdminControls deletes
		// a server's old one by its stored id.
		// 🗒️admin-log, the audit trail under the homebase (post-launch plan item 11).
		"adminLogChannelId",
		// 👋welcome and 📘rules, under the homebase (2026-10 item 247 Phase 2).
		"welcomeChannelId",
		"rulesChannelId",
		// ── ninth and tenth, under the SECOND category ────────────
		// 📋arcade-rules and ⚔️challenges. This array is consumed in TYPE positions
		// only (it types configField, the resolveIntroEmbed switch, and the
		// introMessageIds map); the repair sweep and the delete watcher walk
		// CHANNEL_SPECS instead. Listing them here therefore widens the union and
		// forces the switch to grow a case, without arming anything. Which CATEGORY
		// each belongs under is carried by its spec's categoryField, never inferred
		// from position in this array.
		"arcadeRulesChannelId",
		"arcadeChallengesChannelId",
		// 🕹️games, the third arcade channel (2026-10 item 245 Phase 4a).
		"arcadeGamesChannelId",
		// 🎉party-games, the fourth (post-launch plan item 3).
		"partyGamesChannelId",
		// 🏆rated-challenges, the fifth (2026-10 item 254, Arcade 5).
		"arcadeRatedChallengesChannelId",
		// 🏪dero-market, the sixth (2026-10 item 267 Session 2a).
		"deroMarketChannelId",
		// ── the two VOICE rooms, one under each category (2026-10 item 235) ──
		// They widen the resolveIntroEmbed switch like every other field; each
		// carries the small /dero card in its text chat (2026-10 item 245 Phase 4b).
		"meetingVoiceChannelId",
		"arcadeVoiceChannelId",
		// ── the three admin config channels under 🏰 DERO HEADQUARTERS, and the public
		// 💬dero-commands under the notice board (2026-10 item 257 Phase 2a) ──
		"deroConfigChannelId",
		"onboardingConfigChannelId",
		"arcadeControlChannelId",
		// 🛠️server-config, the fourth config channel (2026-10 item 263 Phase 4a).
		"serverConfigChannelId",
		"commandOutputChannelId",
	] as const;

	// exported so ChannelDeleteWatcher can map a deleted channel id to its
	// spec without re declaring the list. Keep in sync with CHANNEL_FIELDS.
	static readonly CHANNEL_SPECS: IChannelSpec[] = withDefaultNames([
		{ configField: "introChannelId", nameKey: "intro", kind: "public", categoryField: "categoryId" },
		// Commands channel is read-only for members on purpose. The pinned
		// command-center embed is the channel's reason for existing; opening
		// SendMessages here would let unrelated chatter bury that message.
		// Slash commands work in any channel anyway, so locking this one
		// down does not block functionality.
		{ configField: "commandsChannelId", nameKey: "commands", kind: "public", categoryField: "categoryId" },
		{ configField: "leaderboardChannelId", nameKey: "leaderboard", kind: "public", categoryField: "categoryId" },
		{ configField: "scheduleChannelId", nameKey: "schedule", kind: "public", categoryField: "categoryId" },
		{ configField: "announcementsChannelId", nameKey: "announcements", kind: "public", categoryField: "categoryId" },
		// The three admin channels live under 🏰 DERO HEADQUARTERS (2026-10 item 257 Phase 2a).
		// On an existing guild the boot sweep MOVES each one there (moveIntoCategory),
		// never rebuilds it, so its messages and pins stay.
		{ configField: "adminChannelId", nameKey: "admin", kind: "admin", categoryField: "headquartersCategoryId" },
		// 🛡️ seventh, next-decree. public so mortals see the board
		// posts, bot only writes (the category level overwrites already
		// gate SendMessages for "public" kind).
		{ configField: "nextDecreeChannelId", nameKey: "nextDecree", kind: "public", categoryField: "categoryId" },
		// 🗒️ the audit trail (post-launch plan item 11). ⚠️ THIS LINE ARMS THE BOOT
		// REPAIR SWEEP for every existing guild, the way the welcome and arcade specs
		// did: a legacy row loads adminLogChannelId as null, the sweep reads null as
		// case ③ "missing, build it", and the channel appears once on the next boot.
		// Its own kind, because it is the one channel nobody but the bot may post in.
		{ configField: "adminLogChannelId", nameKey: "adminLog", kind: "adminLog", categoryField: "headquartersCategoryId" },

		// ── 👋welcome and 📘rules (2026-10 item 247 Phase 2) ──
		// ⚠️ THESE TWO LINES ARM THE BOOT REPAIR SWEEP for every existing guild, the way
		// the arcade and voice specs did: a legacy row loads both ids as null, the sweep
		// reads null as case ③ "missing", and the next boot gives each guild its own.
		// Unlike every spec above, the missing channel may already EXIST under another
		// name: repairOneChannel and createChannels first look for the server's own
		// welcome or rules channel (ADOPTION_PATTERNS below) and adopt it into the
		// notice board, and only build when there is none. Members read both, the bot
		// writes: the join log is Dero's ledger and the rules post is a reference.
		{ configField: "welcomeChannelId", nameKey: "welcome", kind: "public", categoryField: "categoryId" },
		{ configField: "rulesChannelId", nameKey: "rules", kind: "public", categoryField: "categoryId" },

		// ── 🎮 ARCADE GAMES, the two specs under the SECOND category ──
		// ⚠️ THESE TWO LINES ARM THE BOOT REPAIR SWEEP, and they were deliberately
		// held back until repairMissingChannels learned to resolve a parent from
		// categoryField (task 2.7, landed with them). The sweep treats a null
		// stored id as case ③, "legacy guild predating a new channel spec, build
		// it", so on the next boot of every existing guild these two get built.
		// That is correct ONLY because the sweep now creates and passes the arcade
		// category; with the old single-category call they would have landed under
		// 🪧 NOTICE BOARD silently, and the adopt-before-build scan would then have
		// searched the wrong parent forever after and produced duplicates.
		//
		// Both are member facing on purpose: the rules card answers "who can play
		// what" and the board is where a match starts, so a member who cannot see
		// them cannot play at all. The per match ROOM channels are NOT specs and
		// never will be, because they are created and destroyed per match and live
		// on their own GameRoom rows; ChannelDeleteWatcher depends on that
		// distinction to avoid rebuilding a deleted room as a managed channel.
		{ configField: "arcadeRulesChannelId", nameKey: "arcadeRules", kind: "public", categoryField: "gamesCategoryId" },
		{ configField: "arcadeChallengesChannelId", nameKey: "arcadeChallenges", kind: "public", categoryField: "gamesCategoryId" },
		// 🕹️games (2026-10 item 245 Phase 4a). ⚠️ THIS LINE ARMS THE BOOT REPAIR SWEEP
		// for every existing guild, exactly as the two above once did: a legacy row
		// loads arcadeGamesChannelId as null, the sweep reads null as case ③ "missing,
		// build it", and the channel appears under 🎮 ARCADE GAMES on the next boot,
		// once, because the id is persisted the moment it is built. autoHealEnabled
		// false and userRemovedChannels both stop it, like every other spec. Public,
		// like its siblings: members press its buttons, the bot writes the messages.
		{ configField: "arcadeGamesChannelId", nameKey: "arcadeGames", kind: "public", categoryField: "gamesCategoryId" },
		// 🎉party-games (post-launch plan item 3). ⚠️ THIS LINE ARMS THE BOOT REPAIR SWEEP
		// for every existing guild, like 🕹️games before it: a legacy row loads
		// partyGamesChannelId as null and the next boot builds it under 🎮 ARCADE GAMES,
		// once. "public" is the posture the plan asks for: members read and press its
		// buttons, the owner and the admin role may post, Dero writes the rounds.
		// arcadeSwitch reads the arcade's specs by category, so arcade off takes it too.
		{ configField: "partyGamesChannelId", nameKey: "partyGames", kind: "public", categoryField: "gamesCategoryId" },
		// 🏆rated-challenges (2026-10 item 254, Arcade 5). ⚠️ THIS LINE ARMS THE BOOT REPAIR
		// SWEEP for every existing guild, exactly as 🕹️games and 🎉party-games did: a legacy
		// row loads arcadeRatedChallengesChannelId as null, the sweep reads null as case ③
		// "missing, build it", and the channel appears under 🎮 ARCADE GAMES on the next
		// boot, once, because the id is persisted the moment it is built. Public like
		// ⚔️challenges: members read the cards and press their buttons, Dero writes them.
		// arcadeSwitch reads the arcade's specs by category, so arcade off takes it too.
		{ configField: "arcadeRatedChallengesChannelId", nameKey: "arcadeRatedChallenges", kind: "public", categoryField: "gamesCategoryId" },
		// 🏪dero-market (2026-10 item 267 Session 2a, owner decision 5). ⚠️ THIS LINE ARMS THE
		// BOOT REPAIR SWEEP for every existing guild, exactly as 🏆rated-challenges did: a
		// legacy row loads deroMarketChannelId as null, the sweep reads null as case ③
		// "missing, build it", and the channel appears under 🎮 ARCADE GAMES on the next boot,
		// once. "public" because members only press its two buttons and read the trades Dero
		// posts; nobody types there. arcadeSwitch reads the arcade's specs by category, so
		// arcade off takes it too.
		{ configField: "deroMarketChannelId", nameKey: "deroMarket", kind: "public", categoryField: "gamesCategoryId" },

		// ── the two VOICE rooms (2026-10 item 235) ──
		// ⚠️ THESE ARM THE BOOT REPAIR SWEEP for every existing guild, by the owner's
		// decision D1: a legacy row loads both ids as null, the sweep reads null as
		// case ③ "missing, build it", and both rooms appear on the next boot, the
		// same way the arcade channels arrived. Each is filed under its own
		// category, which only categoryField and the spec test can enforce.
		// Plain voice channels, groundwork for meeting notes: nothing listens.
		{ configField: "meetingVoiceChannelId", nameKey: "meetingVoice", kind: "voice", categoryField: "categoryId" },
		{ configField: "arcadeVoiceChannelId", nameKey: "arcadeVoice", kind: "voice", categoryField: "gamesCategoryId" },

		// ── 🏰 DERO HEADQUARTERS and 💬dero-commands (2026-10 item 257 Phase 2a) ──
		// ⚠️ THESE FOUR LINES ARM THE BOOT REPAIR SWEEP for every existing guild, exactly
		// as 🏆rated-challenges did: a legacy row loads each id as null, the sweep reads
		// null as case ③ "missing, build it", and each channel appears once on the next
		// boot, the Headquarters three under a category the sweep builds on demand.
		// The three config channels are admin only, like 🔒inner-sanctum; their setup
		// steps arrive in Phase 2b.
		{ configField: "deroConfigChannelId", nameKey: "deroConfig", kind: "admin", categoryField: "headquartersCategoryId" },
		{ configField: "onboardingConfigChannelId", nameKey: "onboardingConfig", kind: "admin", categoryField: "headquartersCategoryId" },
		{ configField: "arcadeControlChannelId", nameKey: "arcadeControl", kind: "admin", categoryField: "headquartersCategoryId" },
		// 🛠️server-config (2026-10 item 263 Phase 4a). ⚠️ THIS LINE ARMS THE BOOT REPAIR SWEEP
		// for every existing guild like the three above: a legacy row loads
		// serverConfigChannelId as null, and the next boot builds it once under 🏰 DERO
		// HEADQUARTERS. It takes 🎛️admin-controls' place as the home of every admin answer.
		{ configField: "serverConfigChannelId", nameKey: "serverConfig", kind: "admin", categoryField: "headquartersCategoryId" },
		// "public" for every reader of a spec's kind (the admin grant, the visibility
		// list); overwriteKindOf gives it its own member-writable shape, because members
		// run their commands here (owner decision 7).
		{ configField: "commandOutputChannelId", nameKey: "commandOutput", kind: "public", categoryField: "categoryId" },
	]);

	/** The config field of every managed channel parented under the given category. */
	static specFieldsUnder(categoryField: IChannelSpec["categoryField"]): string[] {
		return GuildSetupManager.CHANNEL_SPECS.filter((spec) => spec.categoryField === categoryField).map((spec) => spec.configField);
	}

	// ── intro content resolver ────────────────────────────────
	// What: pick the right ChannelContent embed for a given spec, reading
	//       adminRoleId off the currently known stored config so post Phase 2
	//       guilds get the populated admin welcome instead of the placeholder.
	// Who:  repairOneChannel. Also usable by the realtime watcher.
	// How:   plain switch on configField so a future spec addition becomes
	//        a compile error here until the case is added. null means the
	//        channel carries no intro at all, and every caller skips its intro
	//        work on null; every managed channel has one today.
	private static resolveIntroEmbed(
		field: (typeof GuildSetupManager.CHANNEL_FIELDS)[number],
		guild: Guild,
		adminRoleId: string | null,
		// Pack selector. Callers that have the loaded GuildConfig (repairOneChannel,
		// refreshIntroEmbeds) pass it so a non-ROK guild renders neutral intros;
		// undefined falls back to the rok-commander default (correct on first build).
		guildConfig?: ICopyConfig | null
	): EmbedBuilder | null {
		switch (field) {
			case "introChannelId":
				return ChannelContent.introduction(guildConfig);
			case "commandsChannelId":
				return ChannelContent.commandGuide(guildConfig);
			case "leaderboardChannelId":
				return ChannelContent.leaderboardIntro(guildConfig);
			case "scheduleChannelId":
				return ChannelContent.scheduleIntro(guildConfig);
			case "announcementsChannelId":
				return ChannelContent.announcementsIntro(guildConfig);
			case "adminChannelId":
				// after Phase 2 the admin channel's intro is the populated
				// adminWelcome with the real adminRoleId. before Phase 2 it is
				// the "role pending" placeholder.
				return adminRoleId
					? ChannelContent.adminWelcome(guild.ownerId, adminRoleId, guildConfig)
					: ChannelContent.adminPending(guildConfig);
			case "nextDecreeChannelId":
				// pinned header above the NextUpBoard audit trail posts.
				// Does not depend on adminRoleId because this is a public
				// channel, mortals read, bot writes.
				return ChannelContent.nextDecreeIntro(guildConfig);
			// The header above the audit lines adminLog.ts posts.
			case "adminLogChannelId":
				return ChannelContent.adminLogIntro(guildConfig);
			// ── 👋welcome and 📘rules ──
			// The rules post reads the owner's saved rules off the stored row, which is
			// why callers pass the loaded GuildConfig here rather than only a pack id.
			case "welcomeChannelId":
				return ChannelContent.welcomeIntro(guildConfig);
			case "rulesChannelId":
				return ChannelContent.rulesIntro(guildConfig as IRulesConfig | null | undefined);
			// ── 🎮 ARCADE GAMES ────────────────────────────────────────
			// Neither depends on adminRoleId: both channels are member facing, and
			// the rules card is the answer to "who can play what" for everyone
			// rather than an admin surface.
			case "arcadeRulesChannelId":
				return ChannelContent.arcadeRulesIntro(guildConfig);
			case "arcadeChallengesChannelId":
				return ChannelContent.arcadeChallengesIntro(guildConfig);
			// The first of 🕹️games' two messages; the Challenge Board beneath it is kept
			// by maintainGamesBoard, because it is not this channel's intro.
			case "arcadeGamesChannelId":
				return ChannelContent.arcadeGamesIntro(guildConfig);
			case "partyGamesChannelId":
				return ChannelContent.partyGamesIntro(guildConfig);
			case "arcadeRatedChallengesChannelId":
				return ChannelContent.arcadeRatedChallengesIntro(guildConfig);
			// The rate, the cap, and closed on a server with chips off: the stored row carries
			// the switch, which is why the market's intro takes the whole config.
			case "deroMarketChannelId":
				return ChannelContent.deroMarketIntro(guildConfig);
			// ── the voice rooms ──
			// One small card in each room's built in text chat, carrying /dero's
			// Join, Leave and Status (2026-10 item 245 Phase 4b, the owner's decision).
			// It is never pinned: a pin there would be the first thing every caller
			// scrolls past, and the card only has to be found by the people in the call.
			case "meetingVoiceChannelId":
			case "arcadeVoiceChannelId":
				return ChannelContent.voiceRoomIntro(guildConfig);
			// ── 🏰 DERO HEADQUARTERS and 💬dero-commands (2026-10 item 257 Phase 2a) ──
			case "deroConfigChannelId":
				return ChannelContent.deroConfigIntro(guildConfig);
			case "onboardingConfigChannelId":
				return ChannelContent.onboardingConfigIntro(guildConfig);
			case "arcadeControlChannelId":
				return ChannelContent.arcadeControlIntro(guildConfig);
			case "serverConfigChannelId":
				return ChannelContent.serverConfigIntro(guildConfig);
			case "commandOutputChannelId":
				return ChannelContent.commandOutputIntro(guildConfig);
		}
	}

	// ── resolveIntroComponents ────────────────────────────────────
	// What:  returns the action row(s) that accompany a given channel's intro
	//        embed, or null if it has no buttons (the common case). The
	//        #command-center guide carries the member buttons, 🔒inner-sanctum's
	//        intro the owner only Self destruct, and each voice room /dero's Join,
	//        Leave and Status (2026-10 item 245 Phase 4b).
	//        The standalone "power-up" panels were retired, every button rides on
	//        these guides. Five rows of five buttons is Discord's ceiling for one
	//        message; the guide test holds every row set to it.
	// Who:   populateChannels on first build and refreshIntroEmbeds on every boot
	//        (both the edit-in-place and repost paths must pass components or
	//        Discord silently drops them).
	// When:  called per spec during the intro sweep.
	// Where: the powerup-prefixed buttons (the three /account views, toggle pings,
	//        fortune, refresh standings, post hangman) keep their customIds so
	//        PowerUps.handlePowerUpButton routes them; suggestion box and self
	//        destruct come from bare button factories so they share those rows.
	// How:   compose the ActionRow(s) per channel: #command-center takes two rows
	//        (the /account views, then the rest). null means "no buttons."
	private static resolveIntroComponents(
		field: (typeof GuildSetupManager.CHANNEL_FIELDS)[number],
		// Pack selector for the rows whose labels live in the copy packs (the rules
		// card's ballot button and 🕹️games' play now rows), read exactly the way
		// resolveIntroEmbed reads it: undefined is the rok-commander default, which is
		// correct on a first build.
		guildConfig?: ICopyConfig | null
	): ActionRowBuilder<MessageActionRowComponentBuilder>[] | null {
		switch (field) {
			case "commandsChannelId":
				// #command-center guide, two rows: the three /account views, then
				// Suggestion Box and Toggle pings. Each answers privately. The invite
				// button and the Icebreaker button are NOT here: they live on the
				// standalone Summon Dero card (inviteCardComponents). Fortune left both
				// for the 🕹️games daily row (2026-10 item 254), since it is a game.
				return [
					new ActionRowBuilder<ButtonBuilder>().addComponents(...buildProfileButtons()),
					new ActionRowBuilder<ButtonBuilder>().addComponents(buildSuggestionBoxButton(), ...buildMemberControlButtons()),
				];
			case "adminChannelId":
				// 🔒inner-sanctum, the owner's channel, carries the owner only Self destruct
				// (2026-10 item 263 Phase 4a, owner decision 14), its gate unchanged in
				// selfDestruct.ts. An existing intro takes it in place on the next boot
				// (componentsAreEquivalent in refreshIntroEmbeds).
				return [new ActionRowBuilder<ButtonBuilder>().addComponents(buildSelfDestructButton())];
			case "meetingVoiceChannelId":
			case "arcadeVoiceChannelId":
				return [buildVoiceRoomControlRow(getPluginCopy(guildConfig).channelContent.voiceRoom)];
			case "arcadeRulesChannelId":
				// The rules card's one control (2026-10 item 245 Phase 4a): the game
				// request ballot, opened privately. The Host a game row it used to carry
				// moved to 🕹️games with the roster, so this card is rules and nothing else.
				return [buildGameRequestRow(getPluginCopy(guildConfig).channelContent.arcadeRules.voteButtonLabel)];
			case "arcadeGamesChannelId":
				return GuildSetupManager.gamesIntroRows(guildConfig);
			case "partyGamesChannelId":
				// The admin host and schedule buttons (post-launch plan item 3). Public on the
				// card because a message cannot show a button to admins only; partyGames
				// refuses anyone else on the press.
				return [buildPartyGamesRow()];
			case "deroMarketChannelId":
				// Buy coins and Sell coins (2026-10 item 267 Session 2a). Each press reads the
				// chip switch again, so a closed market refuses even under an older intro.
				return [buildMarketRow()];
			case "rulesChannelId":
				// Edit rules, the owner and admins' way to replace the rules post's text
				// (2026-10 item 247 Phase 2). It rides the public post because a message
				// button cannot be shown to admins only; rulesEdit refuses anyone else.
				return [buildRulesEditRow(guildConfig)];
			default:
				// introductions + every other channel: intro embed only, no buttons.
				// ⚔️challenges lands here too since Phase 4a: its start board moved to
				// 🕹️games, and it holds only the challenge posts themselves.
				return null;
		}
	}

	// ── 🕹️games, two messages ─────────────────────────────────────
	// Every host button lives in 🕹️games, and they need SEVEN rows: the host row, the
	// solo luck row against Dero, the hangman category select (a select takes a whole
	// row to itself), the daily row (Fortune and Claim daily rewards, 2026-10 item
	// 254), and the Challenge Board's three rows of start buttons. Discord allows five
	// rows a message and rejects the whole send past that, so the channel carries two
	// messages: the intro with the four play now rows, and the board below it. The
	// intro is this channel's anchor like every other spec's; the board is
	// introMessageIds.arcadeGamesBoardId, kept by maintainGamesBoard. A changed row
	// set re-edits the intro on every existing guild's next boot (componentsAreEquivalent).
	private static gamesIntroRows(guildConfig?: ICopyConfig | null): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
		const c = getPluginCopy(guildConfig).channelContent.arcadeGames;
		return [
			buildArcadeHostRow(),
			buildSoloLuckRow(c.soloLuckLabels),
			buildHangmanCategoryStartRow(c.hangmanCategoryPlaceholder),
			new ActionRowBuilder<ButtonBuilder>().addComponents(buildFortuneButton(c.dailyLabels.fortune), buildClaimButton(c.dailyLabels.claim)),
		];
	}

	// The board message's whole content. The start buttons are boardStartRows, the same
	// rows ⚔️challenges carried until Phase 4a; their customIds did not change, so a
	// press routes through the challenge board exactly as before, and the card it opens
	// is still posted in ⚔️challenges (challengeBoard resolves that channel by its id).
	private static gamesBoardContent(guildConfig?: ICopyConfig | null): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
		return { embeds: [ChannelContent.arcadeGamesBoard(guildConfig)], components: boardStartRows() };
	}

	// ── the controls that moved to 🕹️games ─────────────────────────
	// What:  strip the Host a game row and the Challenge Board's start buttons off the
	//        SUPERSEDED intros in 📋arcade-rules and ⚔️challenges, the two channels that
	//        carried them until 2026-10 item 245 Phase 4a. Only the buttons go: the edit
	//        names no embed and no file, so the old copy stays exactly as it was posted,
	//        and nothing is deleted (the owner's never delete rule for intro channels).
	// Who:   refreshIntroEmbeds, at the one moment it supersedes an intro there: when it
	//        posts the new intro, or adopts a matching one, in place of the tracked one.
	// Why:   the intro sweep reposts on a copy change and leaves the old message in
	//        history, so without this an existing guild kept a second, working Challenge
	//        Board in ⚔️challenges beside the one in 🕹️games.
	// How:   a candidate is the tracked old intro plus every bot message in the window
	//        the adopt scan already fetched, so this costs no extra read. A message is
	//        stripped only when one of its customIds is a moved control, derived from the
	//        builders themselves: a challenge card's Join, Start and Cancel and the open
	//        blackjack table's buttons are other customIds, so they are never touched.
	private static readonly CHANNELS_WITH_MOVED_CONTROLS: ReadonlyArray<(typeof GuildSetupManager.CHANNEL_FIELDS)[number]> = [
		"arcadeRulesChannelId",
		"arcadeChallengesChannelId",
	];

	private static async stripMovedArcadeControls(
		field: (typeof GuildSetupManager.CHANNEL_FIELDS)[number],
		candidates: ReadonlyArray<Message | null | undefined>,
		options: { keepId: string; selfId: string | undefined; guildId: string }
	): Promise<number> {
		if (!GuildSetupManager.CHANNELS_WITH_MOVED_CONTROLS.includes(field)) return 0;

		const movedIds = new Set(GuildSetupManager.customIdsOf([buildArcadeHostRow(), ...boardStartRows()]));
		const seen = new Set<string>();
		let stripped = 0;
		for (const message of candidates) {
			if (!message || message.id === options.keepId || seen.has(message.id)) continue;
			seen.add(message.id);
			if (options.selfId && message.author.id !== options.selfId) continue;
			if (!GuildSetupManager.customIdsOf(message.components).some((id) => movedIds.has(id))) continue;
			try {
				await message.edit({ components: [] });
				stripped += 1;
			} catch (error) {
				// Fire and forget: a failed strip leaves an old button that still works,
				// which is untidy, not broken. The new intro is already in place.
				console.warn(LOG_MESSAGES.setup.introRefreshEditFailed("superseded arcade intro", options.guildId), error);
			}
		}
		return stripped;
	}

	// Every customId on a set of rows, read through toJSON so a builder and a fetched
	// message's rows read the same way (the shape componentsAreEquivalent compares).
	private static customIdsOf(rows: ReadonlyArray<{ toJSON(): unknown }>): string[] {
		return rows.flatMap((row) => {
			const json = row.toJSON() as { components?: Array<{ custom_id?: string }> };
			return (json.components ?? []).flatMap((component) => (component.custom_id ? [component.custom_id] : []));
		});
	}

	// ── maintainGamesBoard ────────────────────────────────────────
	// What:  keep 🕹️games' second message, the Challenge Board, present and current,
	//        and hand back the id to persist on introMessageIds.arcadeGamesBoardId.
	// Who:   refreshIntroEmbeds on every boot, and repairOneChannel when it builds or
	//        adopts 🕹️games (so a channel rebuilt by the delete watcher has its board
	//        at once rather than at the next boot). populateChannels posts the first
	//        one itself, straight after the intro.
	// How:   edited IN PLACE, like the invite card, rather than reposted on change: it
	//        is a panel of controls, not copy with an audit trail. Adopted by embed
	//        identity when the stored id is gone, so a lost id cannot duplicate it.
	//        `forcePost` is set when the intro above it was just posted fresh: the board
	//        has to sit BELOW the intro, and an older board left above a new intro
	//        would invert the channel, so a new one is posted beneath it (the old one
	//        stays in history; nothing here deletes a message).
	private static async maintainGamesBoard(
		channel: TextChannel,
		options: { storedId: string | null | undefined; selfId: string | undefined; guildConfig?: ICopyConfig | null; forcePost: boolean }
	): Promise<{ id: string | null; outcome: "kept" | "edited" | "posted" | "failed" }> {
		const content = GuildSetupManager.gamesBoardContent(options.guildConfig);
		const [embed] = content.embeds;

		let message: Message | null = null;
		if (!options.forcePost) {
			message = options.storedId ? await channel.messages.fetch(options.storedId).catch(() => null) : null;
			if (!message) {
				const recent = await channel.messages.fetch({ limit: 20 }).catch(() => null);
				message =
					recent?.find((msg) => (!options.selfId || msg.author.id === options.selfId) && GuildSetupManager.embedsAreEquivalent(embed, msg.embeds[0])) ??
					null;
			}
		}

		if (message) {
			const drifted =
				!GuildSetupManager.embedsAreEquivalent(embed, message.embeds[0]) ||
				!GuildSetupManager.componentsAreEquivalent(content.components, message.components);
			if (!drifted) return { id: message.id, outcome: "kept" };
			try {
				await message.edit(content);
				return { id: message.id, outcome: "edited" };
			} catch (error) {
				console.warn(LOG_MESSAGES.setup.introRefreshEditFailed("games board", channel.guildId), error);
				return { id: message.id, outcome: "failed" };
			}
		}

		try {
			const posted = await channel.send(content);
			return { id: posted.id, outcome: "posted" };
		} catch (error) {
			// Skipped and retried on the next boot, the same posture as an intro post.
			console.warn(LOG_MESSAGES.setup.introRefreshEditFailed("games board", channel.guildId), error);
			return { id: options.storedId ?? null, outcome: "failed" };
		}
	}

	// ── invite card button row ────────────────────────────────────
	// The Summon Dero card's buttons: the Summon (Link) button + the "Icebreaker"
	// button (moved off the command guide row 2026-06). The card is posted in
	// #command-center, so its Fortune moved to the 🕹️games daily row with the
	// guide's (2026-10 item 254). Shared by the initial post (populateChannels) and boot
	// maintenance (refreshIntroEmbeds) so the two stay in lockstep, the
	// componentsAreEquivalent check on boot keys off this exact row, so adding a
	// button here re-edits the card on every existing guild's next boot.
	private static inviteCardComponents(guildConfig?: ICopyConfig | null): ActionRowBuilder<ButtonBuilder>[] {
		return [
			new ActionRowBuilder<ButtonBuilder>().addComponents(ChannelContent.buildInviteButton(guildConfig), buildIcebreakerButton()),
		];
	}

	// ── resolveIntroFiles ─────────────────────────────────────────
	// What:  the files a channel's intro embed points at through attachment://.
	//        Only the introductions welcome has one, Dero's v2 welcome pose
	//        (2026-10 item 245 Phase 3b, ChannelContent.introductionImage); every
	//        other intro answers [].
	// Who:   every send and edit of an intro: populateChannels, the repair post
	//        and adopt, and refreshIntroEmbeds' in place edit and repost. Like
	//        components, a file has to ride each one: an embed whose
	//        attachment:// image arrives without its file shows an empty slot.
	private static resolveIntroFiles(field: (typeof GuildSetupManager.CHANNEL_FIELDS)[number]): AttachmentBuilder[] {
		if (field !== "introChannelId") return [];
		const { attachment } = ChannelContent.introductionImage();
		return attachment ? [attachment] : [];
	}

	// The file half of an intro edit. `attachments: []` replaces the copy the
	// message already holds, or every edit would stack another one under the
	// embed; an intro with no file gets nothing, so its edits stay as they were.
	private static introEditFiles(field: (typeof GuildSetupManager.CHANNEL_FIELDS)[number]): Pick<MessageEditOptions, "files" | "attachments"> {
		const files = GuildSetupManager.resolveIntroFiles(field);
		return files.length > 0 ? { files, attachments: [] } : {};
	}

	// ── embed equivalence check ──────────────────────────────────
	// What: returns true when a freshly generated intro embed has the
	//       same user-visible content as the embed attached to an
	//       already posted message. Used by refreshIntroEmbeds to skip
	//       the "post a new copy" path when nothing has actually
	//       changed, without this guard the owner's "never edit,
	//       never delete" policy would cause a fresh post on every boot
	//       whether the copy changed or not, drowning every channel in
	//       duplicate intros.
	// Who:  refreshIntroEmbeds; not exported because the comparison
	//       rules are specific to the intro sweep. Other call sites
	//       that need embed diffing should author their own helpers
	//       tuned to their own content shape.
	// When: once per spec per boot.
	// Where: title + description + fields are the user-visible surface.
	//        Footer text and color are derived from constants that do
	//        not change per boot, so skipping them keeps the check
	//        cheap and stable against non-copy drift (eg. timestamps
	//        embed builders may stamp for their own reasons).
	// How:  extract the comparable fields from both sides and JSON
	//       stringify. Arrays of fields are compared by stringification
	//       so field order matters, which is correct: a reorder is a
	//       user-visible change worth posting a new copy for.
	private static embedsAreEquivalent(
		fresh: EmbedBuilder,
		stored: Embed | undefined
	): boolean {
		if (!stored) return false;
		const a = fresh.data;
		const aFields = Array.isArray(a.fields) ? a.fields : [];
		const bFields = Array.isArray(stored.fields) ? stored.fields : [];

		if ((a.title ?? null) !== (stored.title ?? null)) return false;
		if ((a.description ?? null) !== (stored.description ?? null)) return false;
		// Image comparison. A bundled-attachment image (setImage("attachment://x"))
		// comes back from a posted message as a Discord CDN url ending in the same
		// filename, so a literal compare would never match and the embed would
		// re-post/re-edit every boot. For attachment refs, compare by filename; for
		// plain urls (e.g. the hosted gif the introductions welcome falls back to),
		// compare literally so a real image change still counts as drift worth
		// reposting.
		const freshImageUrl = a.image?.url ?? null;
		const storedImageUrl = stored.image?.url ?? null;
		if (freshImageUrl?.startsWith("attachment://")) {
			const fileName = freshImageUrl.slice("attachment://".length);
			if (!storedImageUrl || !storedImageUrl.includes(fileName)) return false;
		} else if (freshImageUrl !== storedImageUrl) {
			return false;
		}
		if (aFields.length !== bFields.length) return false;

		// Field-by-field compare. Name + value are the only fields that
		// affect what the mortal reads; inline is rarely set on our
		// intros but we compare anyway in case a future intro uses it.
		for (let i = 0; i < aFields.length; i++) {
			const af = aFields[i];
			const bf = bFields[i];
			if (!af || !bf) return false;
			if (af.name !== bf.name) return false;
			if (af.value !== bf.value) return false;
			if ((af.inline ?? false) !== (bf.inline ?? false)) return false;
		}
		return true;
	}

	// ── component equivalence check ──────────────────────────────
	// What: returns true when the resolved button rows already match the rows on
	//       a posted message. embedsAreEquivalent compares only the EMBED, so
	//       without this a button relocation (same copy, different buttons, e.g.
	//       the 2026-06 controls fold-in) would never reach existing guilds:
	//       refreshIntroEmbeds short-circuits on embed equivalence and never
	//       re-sends components.
	// How:  reduce each side to a per-row, per-button signature (customId | url |
	//       label | style | emoji) via toJSON so a Builder and a live message
	//       component compare on the same API shape. Row boundaries are part of
	//       the signature, so a pure row-restructure (same buttons, regrouped
	//       across rows, e.g. the 4-in-one-row → 3+1 split) is also detected.
	private static componentsAreEquivalent(
		// Any row builder: 🕹️games' intro carries a select row beside its button rows,
		// and a select's custom_id reaches the signature the same way a button's does.
		resolved: ReadonlyArray<{ toJSON(): unknown }> | null,
		current: ReadonlyArray<{ toJSON(): unknown }>
	): boolean {
		const signature = (rows: ReadonlyArray<{ toJSON(): unknown }>): string =>
			rows
				.map((row) => {
					const json = row.toJSON() as { components?: Array<Record<string, unknown>> };
					return (json.components ?? [])
						.map((c) => {
							const emoji = c.emoji as { name?: string; id?: string } | undefined;
							return `${c.custom_id ?? ""}|${c.url ?? ""}|${c.label ?? ""}|${c.style ?? ""}|${emoji?.name ?? emoji?.id ?? ""}`;
						})
						.join("~~");
				})
				.join(" ;; ");
		return signature(resolved ?? []) === signature(current);
	}

	// ── welcome and rules adoption (2026-10 item 247 Phase 2) ──────────
	// What:  the specs whose missing channel may be one the server already has,
	//        and the three steps every build path shares for them: find it, move it
	//        into the notice board, and only then decide whether Dero may post its
	//        intro there. adoption.ts holds the mechanics; this holds the policy.
	// Who:   createChannels (fresh install, forced rebuild), repairOneChannel (boot
	//        sweep, ChannelDeleteWatcher), populateChannels and refreshIntroEmbeds.
	// Where: an adopted id goes on GuildConfig.adoptedChannelIds, which selfDestruct
	//        and renameDriftedChannels read to leave the owner's channel alone.

	/** The adoption pattern list for each adoptable spec; a spec absent here is always built. */
	private static readonly ADOPTION_PATTERNS: Partial<Record<(typeof GuildSetupManager.CHANNEL_FIELDS)[number], readonly string[]>> = {
		welcomeChannelId: BOT_CONSTANTS.WELCOME_ADOPTION_PATTERNS,
		rulesChannelId: BOT_CONSTANTS.RULES_ADOPTION_PATTERNS,
	};

	/**
	 * Adopt the server's own channel for one adoptable spec: find it, then use it IN
	 * PLACE, unless an admin already chose to move that channel into the notice board
	 * (adoptionChoice), in which case it moves now. Null only when the spec is not
	 * adoptable or nothing matches, and the caller then builds Dero's own: a refused
	 * move still adopts the channel where it is, so Dero never builds a second rules or
	 * welcome channel while the server has one (2026-10 item 257, item 2). `skipIds`
	 * are passed over too (the boot reconcile passes the slot's current channel, which
	 * is Dero's own). The admin log line is written here unless `deferAdminLog` is set,
	 * which a first build sets because its admin log channel is not stored yet.
	 */
	private static async adoptExistingChannel(
		guild: Guild,
		category: CategoryChannel,
		spec: (typeof GuildSetupManager.CHANNEL_SPECS)[number],
		stored: Record<string, unknown> | null,
		roles: { memberRoleId: string | null; adminRoleId: string | null },
		skipIds: readonly string[] = [],
		options: { deferAdminLog?: boolean } = {}
	): Promise<TextChannel | null> {
		const patterns = GuildSetupManager.ADOPTION_PATTERNS[spec.configField];
		if (!patterns) return null;
		const exclusions = {
			// A channel already filling another slot on this row is never taken for this one.
			ids: new Set([...GuildSetupManager.idsStoredOutside(stored, spec.configField), ...skipIds]),
			names: new Set([GuildSetupManager.channelNameFor(spec, copyConfigOf(stored)), GuildSetupManager.effectiveChannelName(stored, spec)]),
		};
		const candidate: IAdoptionCandidate | null =
			spec.configField === "welcomeChannelId"
				? findWelcomeChannel(guild, category, patterns, exclusions)
				: findRulesChannel(guild, category, patterns, exclusions);
		if (!candidate) return null;
		const match = candidate.channel;
		const movedByChoice = !candidate.inPlace && readAdoptionChoice(stored, match.id) === "move";
		const outcome = movedByChoice ? await moveChosenChannel(guild, match, category, roles) : null;
		console.log(`[adoption] guild ${guild.id} adopted channel ${match.id} as ${spec.configField}${outcome === "moved" ? ", moved into the notice board as an admin chose" : " in place"}`);
		if (!options.deferAdminLog) GuildSetupManager.logAdoption(guild, spec.configField, match.id);
		return match;
	}

	// After a build's row is stored: the adoption admin log lines, which need the admin
	// log channel id the row now holds. Fire and forget, like every line after a primary
	// write. Where each adopted channel goes is asked on 🧭onboarding's step 2, which names
	// the channels, never in a card of its own (2026-10 item 263 Phase 4b, R3-19).
	private static afterAdoptionPersisted(guild: Guild, adoptions: ReadonlyArray<{ field: string; channelId: string }>): void {
		for (const adoption of adoptions) GuildSetupManager.logAdoption(guild, adoption.field, adoption.channelId);
	}

	/**
	 * Whether Dero may post its intro in this channel. Always for a channel Dero
	 * built. For an adopted one, only when it is empty or already holds Dero's own
	 * intro (that intro's title, or the Edit rules button), so the owner's own
	 * welcome or rules text is never buried under Dero's.
	 */
	private static async adoptedChannelAcceptsIntro(
		guild: Guild,
		channel: TextChannel | VoiceChannel,
		introEmbed: EmbedBuilder,
		adoptedChannelIds: readonly string[]
	): Promise<boolean> {
		if (!adoptedChannelIds.includes(channel.id)) return true;
		const selfId = guild.client.user?.id;
		const introTitle = introEmbed.data.title ?? null;
		return fetchAcceptsDeroContent(
			channel,
			(message) =>
				selfId !== undefined &&
				message.author.id === selfId &&
				(carriesRulesEditButton(message) || (introTitle !== null && message.embeds[0]?.title === introTitle))
		);
	}

	// The name a slot's channel carries: the /server channels rename override when one is set,
	// else the default in the guild's pack. Excluded from adoption alongside the default, so
	// Dero never adopts its own renamed channel as if the server had made it.
	private static effectiveChannelName(stored: Record<string, unknown> | null, spec: (typeof GuildSetupManager.CHANNEL_SPECS)[number]): string {
		return GuildSetupManager.persistedChannelName(stored, spec.configField) || GuildSetupManager.channelNameFor(spec, copyConfigOf(stored));
	}

	/** A managed channel's default name in the guild's pack (the kingdom pack for a null config). */
	static channelNameFor(spec: (typeof GuildSetupManager.CHANNEL_SPECS)[number], copyConfig: ICopyConfig | null): string {
		return getPluginCopy(copyConfig).setup.channels[spec.nameKey];
	}

	/** A managed category's name in the guild's pack, dev suffix included. */
	static managedCategoryName(field: ManagedCategoryField, copyConfig: ICopyConfig | null): string {
		return resolveCategoryName(field, copyConfig);
	}

	/**
	 * The name an admin set for a slot with /server channels rename, or undefined. The
	 * Mongoose Map arrives as a Map from a hydrated row and as a plain object from a lean
	 * or spread one, so both shapes are read.
	 */
	static persistedChannelName(row: unknown, configField: string): string | undefined {
		const names = (row as { channelNames?: Map<string, string> | Record<string, string> | null } | null)?.channelNames;
		return (names instanceof Map ? names.get(configField) : names?.[configField]) || undefined;
	}

	// One admin log line per adoption (plan risk R4: the decision is logged so an admin
	// who disagrees can see it and pick another channel with /server channels). Dero is the
	// actor: no member pressed anything. Fire and forget, like every admin log line.
	private static logAdoption(guild: Guild, field: string, channelId: string): void {
		const subject = field === "welcomeChannelId" ? setupCopy.adminLog.subjects.welcomeLog : setupCopy.adminLog.subjects.rulesChannel;
		adminLog.emit({ guild: { id: guild.id, client: guild.client }, kind: "config.change", actor: { source: "dero" }, payload: { subject, detail: setupCopy.adminLog.adopted(channelId) } });
	}

	// ── welcome reconcile on boot (post-launch plan item 2) ────────────
	// What:  move a guild whose welcome log is Dero's OWN 👋welcome onto the server's
	//        own welcome channel (#spawn-point, a #welcome, or the system channel),
	//        and demote Dero's to a plain channel: it leaves the slot, so the join log,
	//        the intro sweep, the repair sweep and the drift rename stop touching it.
	//        It is not deleted and nothing in it is edited (the owner's never edit,
	//        never delete rule for intro channels); a self destruct still removes it
	//        with the rest of the notice board, since Dero built it.
	// Who:   ensureHomebase, on the repair and the happy path alike.
	// When:  every boot. A guild whose slot already holds an adopted channel, or that
	//        opted out (auto heal off, or the slot removed by hand), costs one read.
	// How:   ① read the row; ② find the server's channel, passing over Dero's own;
	//        ③ adopt it (in place, or moved when an admin chose so); ④ persist the slot, the adopted list and
	//        a null intro anchor in one write, so refreshIntroEmbeds, which runs after
	//        this sweep, posts Dero's intro there only if the channel is empty.
	//        Never throws: a failure is logged and the next boot retries.
	static async reconcileWelcomeAdoption(guild: Guild, category: CategoryChannel): Promise<boolean> {
		try {
			const stored = (await guildConfigStore.findByGuildId(guild.id)) as
				| (Record<string, unknown> & { welcomeChannelId?: string | null; autoHealEnabled?: boolean | null; userRemovedChannels?: string[] })
				| null;
			const currentId = stored?.welcomeChannelId;
			if (!stored || !currentId || stored.autoHealEnabled === false) return false;
			if ((stored.userRemovedChannels ?? []).includes("welcomeChannelId")) return false;
			const adoptedIds = readAdoptedChannelIds(stored);
			if (adoptedIds.includes(currentId)) return false;

			const spec = GuildSetupManager.CHANNEL_SPECS.find((entry) => entry.configField === "welcomeChannelId")!;
			const roles = { memberRoleId: typeof stored.memberRoleId === "string" ? stored.memberRoleId : null, adminRoleId: typeof stored.adminRoleId === "string" ? stored.adminRoleId : null };
			const adopted = await GuildSetupManager.adoptExistingChannel(guild, category, spec, stored, roles, [currentId]);
			if (!adopted) return false;

			const priorIntroIds = (stored.introMessageIds as Record<string, string | null> | undefined) ?? {};
			await guildConfigStore.update(guild.id, {
				welcomeChannelId: adopted.id,
				adoptedChannelIds: [...new Set([...adoptedIds, adopted.id])],
				introMessageIds: { ...priorIntroIds, welcomeChannelId: null },
			});
			console.log(`[adoption] guild ${guild.id} moved its welcome log from Dero's channel ${currentId} to ${adopted.id}; ${currentId} is now a plain channel`);
			return true;
		} catch (error) {
			console.warn(`[adoption] guild ${guild.id} welcome reconcile failed; the next boot retries`, error);
			return false;
		}
	}

	// Every channel id the row stores under a slot other than `field`.
	private static idsStoredOutside(stored: Record<string, unknown> | null, field: string): Set<string> {
		const ids = new Set<string>();
		if (!stored) return ids;
		for (const other of GuildSetupManager.CHANNEL_FIELDS) {
			const id = stored[other];
			if (other !== field && typeof id === "string") ids.add(id);
		}
		return ids;
	}

	// ── single channel repair primitive ───────────────────────
	// What: rebuild one homebase channel under the given category, repost the
	//       intro, persist the new channel id on GuildConfig. Shared between
	//       the boot sweep (repairMissingChannels) and the realtime listener
	//       (ChannelDeleteWatcher) so the repair posture is identical across
	//       entry points.
	// Who:  repairMissingChannels, ChannelDeleteWatcher.
	// When: caller has already proven (a) the homebase category is intact and
	//       bot owned, (b) the specific channel this spec targets is missing.
	// Where: returns the fresh stored config object with the new channel id
	//        applied so the caller can pass it into postRepairNotices without
	//        a second DB read. Callers must NOT reuse the `stored` they
	//        passed in, fields will be stale.
	// How:   ① buildSingleChannel with the spec's kind + the known adminRoleId
	//           (and memberRoleId, which only a voice room reads).
	//        ② fire-and-forget the intro embed. failures are logged and
	//           swallowed because the channel is already functional. A voice
	//           room's intro goes into its built in text chat like any other.
	//        ③ persist: { [configField]: newChannel.id } plus, for the
	//           schedule channel, scheduleMessageId: null so ScheduleBoard
	//           reposts a fresh pinned board on its next refresh.
	//        ④ return the merged stored so caller has the fresh adminChannelId
	//           if the admin channel itself was the one repaired. It is a plain
	//           object whatever the caller passed, so its fields survive a spread.
	static async repairOneChannel(
		guild: Guild,
		category: CategoryChannel,
		spec: (typeof GuildSetupManager.CHANNEL_SPECS)[number],
		stored: Record<string, unknown> & { adminRoleId?: string | null }
	): Promise<{ newChannel: TextChannel | VoiceChannel; stored: typeof stored }> {
		// ── adopt-before-build guard ───────────────────────────────
		// What:  before creating a brand new channel, scan the category
		//        for an existing text channel whose name matches this
		//        spec's name in the guild's pack. If one exists, adopt it: persist
		//        its id onto GuildConfig and reuse the existing channel
		//        as-is.
		// Why:   the "stored id is null" branch in repairMissingChannels
		//        would otherwise rebuild a channel whose name already
		//        exists under the category, producing a duplicate. This
		//        happens on any guild where a previous deploy created
		//        the channel in Discord but failed to persist the id
		//        before the process exited (eg. the seventh-channel
		//        migration race seen on guild 910668785856413707 where
		//        two `🛡️next-decree` channels ended up side by side
		//        after yesterday's null-id rebuild fix landed).
		// Who:   repairOneChannel; this is the single choke point for
		//        both the boot sweep and the realtime delete watcher.
		// When:  runs every repair, but the expensive create is only
		//        skipped on match. The category's .children cache is
		//        already populated, no extra network round trip.
		// Where: the emoji-prefixed displayName (🛡️next-decree,
		//        📜introductions, etc) makes accidental collisions with
		//        admin-created channels effectively impossible; no
		//        reasonable admin types the leading emoji by hand.
		// How:   find by case-sensitive name match + TextChannel
		//        instance check. Fall through to buildSingleChannel only
		//        when no existing channel qualifies.
		// Read the per-slot custom-name override (set by /server channels rename)
		// before falling back to the guild pack's default. This is the rule the
		// streamer-feedback announcement promises: admin renames persist
		// across rebuilds. The Mongoose Map can be either a true Map (when
		// stored was hydrated as a document) or a plain object (when it was
		// .lean()'d upstream), so probe both shapes defensively.
		const channelNamesRaw = (stored as unknown as { channelNames?: Map<string, string> | Record<string, string> }).channelNames;
		const overrideName =
			channelNamesRaw instanceof Map
				? channelNamesRaw.get(spec.configField)
				: (channelNamesRaw as Record<string, string> | undefined)?.[spec.configField];
		const effectiveName = overrideName || GuildSetupManager.channelNameFor(spec, copyConfigOf(stored));

		// Adopt only a channel of the KIND this spec builds. A text channel an admin
		// happened to name "🏛️ Meeting Hall" is not the voice room, and adopting it
		// would persist a text channel id under a voice field.
		const isExpectedType = (child: unknown): child is TextChannel | VoiceChannel =>
			spec.kind === "voice" ? child instanceof VoiceChannel : child instanceof TextChannel;
		const existingByName = category.children.cache.find(
			(child): child is TextChannel | VoiceChannel => isExpectedType(child) && child.name === effectiveName
		);
		// Read defensively: the caller's row type carries an index signature, so
		// a narrow here is cheaper than widening every caller's cast.
		const memberRoleId = typeof stored.memberRoleId === "string" ? stored.memberRoleId : null;
		const adminRoleId = stored.adminRoleId ?? null;
		// Dero's own channel by name comes first; only then the server's own welcome or
		// rules channel (2026-10 item 247 Phase 2), and a build only when neither exists.
		const adopted = existingByName ? null : await GuildSetupManager.adoptExistingChannel(guild, category, spec, stored, { memberRoleId, adminRoleId });
		// overwriteKindOf, not spec.kind: the introductions channel is a "public" spec
		// but takes its own member-writable shape, the one createChannels gives it.
		const newChannel =
			existingByName ?? adopted ?? (await GuildSetupManager.buildSingleChannel(guild, category, effectiveName, overwriteKindOf(spec), adminRoleId, memberRoleId));
		if (existingByName) {
			console.warn(LOG_MESSAGES.setup.channelAdopted(effectiveName, guild.id));
		}

		// The slot's adopted ids: the channel it replaces leaves the list (it is gone,
		// or it was Dero's), and a newly adopted one joins it.
		const priorAdoptedIds = readAdoptedChannelIds(stored);
		const replacedId = stored[spec.configField];
		const nextAdoptedIds = [...new Set([...priorAdoptedIds.filter((id) => id !== replacedId), ...(adopted ? [adopted.id] : [])])];

		// ── intro message resolution ────────────────────────────────
		// postOrAdoptRepairIntro carries the post or adopt rules. A null embed
		// means this channel has no intro and nothing is posted, and so does an
		// adopted channel that already holds the owner's own content.
		const introEmbed = GuildSetupManager.resolveIntroEmbed(spec.configField, guild, adminRoleId, stored as unknown as ICopyConfig);
		const mayPostIntro =
			introEmbed !== null && (await GuildSetupManager.adoptedChannelAcceptsIntro(guild, newChannel, introEmbed, nextAdoptedIds));
		const intro =
			introEmbed && mayPostIntro
				? await GuildSetupManager.postOrAdoptRepairIntro(
						guild,
						newChannel,
						spec,
						introEmbed,
						Boolean(existingByName || adopted),
						stored as unknown as ICopyConfig
					)
				: { id: null, posted: false };
		const introMessageId = intro.id;

		// persist new ids. three pieces move together on a repair:
		//   - spec.configField → new channel id
		//   - introMessageIds[spec.configField] → new intro message id (or
		//     null if the intro post failed; refreshIntroEmbeds will repost
		//     on the next boot)
		//   - scheduleMessageId → the fresh pinned board anchor if this was
		//     the schedule channel, else left alone.
		// The prior introMessageIds sub fields are preserved by merging onto
		// whatever the caller passed in.
		const priorIntroIds =
			(stored.introMessageIds as Record<string, string | null> | undefined) ?? {};
		const nextIntroIds: Record<string, string | null> = { ...priorIntroIds, [spec.configField]: introMessageId };
		// 🕹️games has a second message, the Challenge Board, which has to exist the
		// moment the channel does: a channel rebuilt by the delete watcher would
		// otherwise sit without its start buttons until the next boot's refresh. A
		// freshly posted intro forces a fresh board beneath it (see maintainGamesBoard).
		if (spec.configField === "arcadeGamesChannelId" && newChannel instanceof TextChannel) {
			const board = await GuildSetupManager.maintainGamesBoard(newChannel, {
				storedId: priorIntroIds.arcadeGamesBoardId,
				selfId: guild.client.user?.id,
				guildConfig: stored as unknown as ICopyConfig,
				forcePost: intro.posted,
			});
			nextIntroIds.arcadeGamesBoardId = board.id;
		}

		const update: Record<string, unknown> = { [spec.configField]: newChannel.id };
		// A channel with no intro has no introMessageIds slot, so its repair
		// leaves the map exactly as it was.
		if (introEmbed) update.introMessageIds = nextIntroIds;
		// Written only for the adoptable slots, so every other repair leaves the list
		// exactly as it was.
		if (GuildSetupManager.ADOPTION_PATTERNS[spec.configField]) update.adoptedChannelIds = nextAdoptedIds;
		if (spec.configField === "scheduleChannelId") {
			// scheduleMessageId tracks the pinned board anchor. on a schedule
			// channel repair the newly posted intro IS the fresh anchor.
			update.scheduleMessageId = introMessageId;
		}
		await guildConfigStore.update(guild.id, update);
		console.warn(LOG_MESSAGES.setup.channelRepaired(spec.displayName, guild.id));
		// A rebuilt voice room keeps its place on Dero's voice allow list under its new id
		// (2026-10 item 257, owner item 8); the dead id comes off.
		if (spec.kind === "voice") void replaceDeroVoiceRoom(guild.id, stored[spec.configField] as string | null | undefined, newChannel.id);
		// A rebuilt config channel gets its steps card and chart back at once, beneath a
		// freshly posted intro, rather than waiting for the next boot.
		const domain = HEADQUARTERS_DOMAINS.find((candidate) => DOMAIN_CHANNEL_FIELDS[candidate] === spec.configField);
		if (domain) void syncHeadquartersChannel(guild, domain, { forcePost: intro.posted });

		// merge so caller sees the fresh ids without a second round trip. ⚠️ Merged onto the
		// PLAIN row: a caller usually passes the store's hydrated Mongoose document, and a
		// spread of one keeps none of its fields (plainRow.ts), which left every caller that
		// read the return with only this slot (2026-10 item 274).
		return { newChannel, stored: { ...(asPlainRow(stored) ?? stored), ...update } };
	}

	// ── repair intro, post or adopt ───────────────────────────
	// The intro half of repairOneChannel, split out so a channel that carries no
	// intro (a voice room) skips it with one guard instead of another nesting
	// level. Returns the intro message id, or null when the post failed, which
	// refreshIntroEmbeds treats as "repost on the next boot", and whether the id
	// is a FRESH post, which 🕹️games needs to keep its board below its intro.
	//
	// Two paths, merged:
	//   A. Fresh build (!adoptedExisting): post an intro embed, capture the new
	//      message id. A newly created channel has no intro yet.
	//   B. Adopted existing channel: scan the most recent messages for a
	//      bot-authored embed that matches the spec's intro. If found, reuse its
	//      id, DO NOT post a duplicate. If not found (eg. the existing channel was
	//      emptied by an admin), fall through to the same post-a-fresh-intro path
	//      as A so the adopted channel still ends up with its intro.
	//
	// Why the scan only looks at the latest ~20 messages: a stray intro embed
	// further back in history is rare (bot is the only author in its own homebase
	// channels) and the scan is cheap. If the adopted channel has 500 messages
	// from a prior setup cycle, we accept that a very old intro won't be adopted,
	// the fresh one we post beneath it is correct, and the historical one is just
	// harmless scrollback. Most guilds hitting this branch have NO messages (the
	// channel was just created but never had its id persisted).
	private static async postOrAdoptRepairIntro(
		guild: Guild,
		channel: TextChannel | VoiceChannel,
		spec: (typeof GuildSetupManager.CHANNEL_SPECS)[number],
		introEmbed: EmbedBuilder,
		adoptedExisting: boolean,
		guildConfig: ICopyConfig | null
	): Promise<{ id: string | null; posted: boolean }> {
		const introComponents = GuildSetupManager.resolveIntroComponents(spec.configField, guildConfig);
		let introMessageId: string | null = null;
		let posted = false;

		try {
			if (adoptedExisting) {
				// Scan for an existing bot-authored intro embed with a
				// matching title. Embed titles are stable identifiers
				// for each intro (nextDecreeIntro → "🔜 Upcoming Events",
				// etc.) so title comparison is the cheapest way to
				// recognize our own prior post without storing a hash.
				const selfId = guild.client.user?.id;
				const targetTitle = introEmbed.data.title ?? null;

				const recent = await channel.messages.fetch({ limit: 20 }).catch(() => null);
				const existingIntro = recent?.find((msg) => {
					if (!selfId || msg.author.id !== selfId) return false;
					if (msg.embeds.length === 0) return false;
					const firstTitle = msg.embeds[0]?.title ?? null;
					return firstTitle !== null && firstTitle === targetTitle;
				});

				if (existingIntro) {
					// Adopt the existing intro. Also run an in-place
					// edit so any copy changes in the copy packs
					// (@base/copy/packs) since the prior post land
					// immediately (same contract as
					// refreshIntroEmbeds but scoped to this one message).
					introMessageId = existingIntro.id;
					try {
						await existingIntro.edit({ embeds: [introEmbed], components: introComponents ?? [], ...GuildSetupManager.introEditFiles(spec.configField) });
					} catch (editError) {
						// edit failure is non fatal, the old embed stands.
						console.warn(LOG_MESSAGES.setup.channelRepairFailed(spec.displayName, guild.id), editError);
					}
				}
			}

			if (!introMessageId) {
				// Fresh post path: either a brand new channel (path A
				// above) or an adopted channel with no matching intro.
				const introMessage = await channel.send({
					embeds: [introEmbed],
					components: introComponents ?? [],
					files: GuildSetupManager.resolveIntroFiles(spec.configField),
				});
				introMessageId = introMessage.id;
				posted = true;
				// No pin: the schedule channel is read-only, so the board stays put
				// without one (2026-06 pinning policy, only introductions is pinned).
			}
		} catch (error) {
			console.warn(LOG_MESSAGES.setup.channelRepairFailed(spec.displayName, guild.id), error);
		}
		return { id: introMessageId, posted };
	}

	// ── channel level self heal (boot sweep) ─────────────────
	// What: for each of the six homebase channels stored on GuildConfig,
	//       verify the channel still exists in Discord. Rebuild any that
	//       are missing using repairOneChannel, then post one per channel
	//       notice into the inner sanctum.
	// Who:  ensureHomebase.
	// When: only when the category itself is intact and bot owned.
	// Where: delegates the per channel rebuild work to repairOneChannel so
	//        the realtime listener shares the same primitive.
	// How:  walk CHANNEL_SPECS, skip specs whose channels still exist,
	//       delegate rebuilds to repairOneChannel, accumulate display names,
	//       post notices at the end. Errors on a single spec do not stop
	//       the others.
	// A null category is a Headquarters only guild (2026-11 item 285 Phase 2): there is
	// no 🪧 NOTICE BOARD to build under, so its specs are skipped rather than built
	// anywhere else, and the arcade and Headquarters groups sweep as on any guild.
	static async repairMissingChannels(client: Client, guild: Guild, category: CategoryChannel | null): Promise<string[]> {
		// re read the config here so we pick up the freshest admin role /
		// owner / channel ids. the caller only passed us the initial state. Read
		// plain, like the repairs it chains (2026-10 item 274).
		let stored = asPlainRow(await guildConfigStore.findByGuildId(guild.id)) as
			| (Record<string, unknown> & { adminRoleId?: string | null; adminChannelId: string; autoHealEnabled?: boolean })
			| null;
		if (!stored) return [];

		// auto-heal toggle gate. when off, the admin has explicitly opted out
		// of automatic channel rebuilds. count what WOULD have been repaired
		// so we can emit a single summary log line (not one-per-channel) and
		// then return without doing any repair work. This is the boot-side
		// counterpart to ChannelDeleteWatcher's realtime gate, so a restart
		// will not undo the admin's decision.
		if (stored.autoHealEnabled === false) {
			let wouldRepairCount = 0;
			for (const spec of GuildSetupManager.CHANNEL_SPECS) {
				if (!category && spec.categoryField === "categoryId") continue;
				const storedId = stored[spec.configField] as string | null | undefined;
				if (!storedId) {
					wouldRepairCount += 1;
					continue;
				}
				const existing = await guild.channels.fetch(storedId).catch(() => null);
				if (!existing) wouldRepairCount += 1;
			}
			if (wouldRepairCount > 0) {
				console.log(
					`[auto-heal] skipped repair of ${wouldRepairCount} channel(s) in guild ${guild.id} because autoHealEnabled is false; run /server auto-heal enabled:True to resume.`
				);
			}
			return [];
		}

		// Read the user-removed list once at the top of the sweep. configField
		// names listed here represent channels the admin explicitly removed via
		// the dashboard or a follow-up button, they supersede autoHealEnabled
		// because the toggle is "do not auto-rebuild THIS specific slot" rather
		// than "do not auto-rebuild any slot." This is the inverse semantics
		// of the legacy null-storedId branch below.
		const userRemovedSlots = ((stored as unknown as { userRemovedChannels?: string[] }).userRemovedChannels ?? []) as string[];

		const repaired: string[] = [];

		// ── the secondary categories, each resolved ONCE per sweep ──────
		// ⚠️ Cached in a local rather than read back off `stored`, and that is not
		// an optimization. The loop below reassigns `stored` from repairOneChannel's
		// return on every repair, which overwrites any gamesCategoryId written
		// here; the second arcade spec would then read null again and create a
		// SECOND category beside the first. A test caught exactly that. The same
		// holds for 🏰 DERO HEADQUARTERS, so both live in this one map.
		// A missing key means not yet resolved, `null` means resolution failed
		// (50013 already reported, or no Manage Channels for Headquarters) and that
		// category's specs are to be skipped.
		const resolvedCategories = new Map<SecondaryCategoryField, CategoryChannel | null>();
		// A server that withheld Manage Channels gets ONE line per sweep about
		// Headquarters (2026-10 item 257 Phase 2a, owner decision 4), however many of
		// its specs ask for the category or a move.
		let headquartersRefusalLogged = false;
		const logHeadquartersRefused = (): void => {
			if (headquartersRefusalLogged) return;
			headquartersRefusalLogged = true;
			console.log(`[headquarters] guild ${guild.id}: Dero lacks Manage Channels; 🏰 DERO HEADQUARTERS is not built and the admin channels stay where they are`);
		};
		const resolveCategory = async (field: SecondaryCategoryField): Promise<CategoryChannel | null> => {
			if (resolvedCategories.has(field)) return resolvedCategories.get(field) ?? null;
			const resolved = await GuildSetupManager.resolveSecondaryCategoryForSweep(guild, field, stored!, logHeadquartersRefused);
			resolvedCategories.set(field, resolved);
			return resolved;
		};
		// The admin channels moved into Headquarters this sweep, logged as one line.
		const movedIntoHeadquarters: string[] = [];

		for (const spec of GuildSetupManager.CHANNEL_SPECS) {
			// Honor per-channel user removal. If the admin removed this slot,
			// skip it regardless of autoHealEnabled. The slot returns when the
			// related toggle (eg /server leaderboard tracking enabled:True)
			// pulls the configField name back out of userRemovedChannels.
			if (userRemovedSlots.includes(spec.configField)) {
				console.log(
					`[auto-heal] skipped rebuild of ${spec.configField} in guild ${guild.id} because the admin removed it explicitly; re-enable the related feature to restore.`
				);
				continue;
			}

			const storedId = stored[spec.configField] as string | null | undefined;

			// What:  decide whether this spec needs a rebuild. Three states:
			//        ① stored id present AND channel exists → skip (happy
			//           path, most guilds most of the time);
			//        ② stored id present AND channel missing → rebuild the
			//           channel, persist the new id;
			//        ③ stored id null/undefined → rebuild the channel. This
			//           is the "legacy guild predating a new channel spec"
			//           case. Example: the nextDecreeChannelId field was
			//           added after some guilds had already run /setup, so
			//           those rows load with a null stored id and the
			//           channel has never existed in Discord. Before this
			//           branch, the sweep skipped them forever; the channel
			//           would only appear if the owner nuked and re-ran
			//           /setup from scratch, which is a terrible migration
			//           story. Treat null as "also missing, rebuild too."
			// Where: repairOneChannel is already idempotent, it builds the
			//        channel, posts the intro, persists the new id. The only
			//        extra concern is existing:null below: when storedId is
			//        null we have nothing to fetch, so skip the fetch and go
			//        straight to the rebuild path.
			if (storedId) {
				// resolve the channel. null (cache miss) and fetch throws both
				// mean rebuild. misconfigured-but-present channels are out of
				// scope for boot time self heal.
				const existing = await guild.channels.fetch(storedId).catch(() => null);
				// A live admin channel still under the notice board moves into 🏰 DERO
				// HEADQUARTERS (2026-10 item 257 Phase 2a, risk R1). Only a channel that is
				// not already there moves, so a second boot writes nothing.
				if (existing && spec.categoryField === "headquartersCategoryId") {
					const moved = await GuildSetupManager.moveExistingIntoHeadquarters(guild, existing, spec, stored, resolveCategory, logHeadquartersRefused);
					if (moved) movedIntoHeadquarters.push(spec.displayName);
				}
				if (existing) continue;
			}
			// fallthrough: either storedId was falsy, or the channel was
			// missing despite a stored id. Either way, build it.

			// ── resolve THIS spec's parent ──────────────────────────────
			// ⚠️ RISK R2 LIVES HERE. Before this block the sweep handed every spec
			// the ONE category it was given, so the moment the two arcade specs
			// joined CHANNEL_SPECS, every existing guild would have built
			// 📋arcade-rules and ⚔️challenges under 🪧 NOTICE BOARD on its next boot.
			// Nothing throws when that happens: the channels appear in the wrong
			// place, and the adopt-before-build scan inside repairOneChannel then
			// searches the wrong category's children forever after, so the next
			// sweep does not adopt them and builds duplicates instead.
			//
			// A legacy guild's row predates the arcade category entirely, so the
			// id is null and the category has to be created on demand. It is
			// persisted IMMEDIATELY rather than at the end of the sweep, which is
			// what makes the second arcade spec in this same loop fetch the one we
			// just made instead of creating a second one.
			let parent: CategoryChannel | null = category;
			if (spec.categoryField !== "categoryId") {
				// null means a 50013 already routed through handlePermissionFailure (or,
				// for Headquarters, no Manage Channels, already logged). Skip that
				// category's specs rather than abandoning the sweep: the homebase specs
				// may still be repairable.
				const secondary = await resolveCategory(spec.categoryField);
				if (!secondary) continue;
				parent = secondary;
			}
			// A notice board spec on a Headquarters only guild: nothing to build it under.
			if (!parent) continue;

			try {
				const result = await GuildSetupManager.repairOneChannel(guild, parent, spec, stored);
				// refresh local stored so the next spec + the notice post
				// step below see the new ids. Notably: if the admin channel
				// was the one repaired, stored.adminChannelId now points at
				// the new channel which is exactly where we want the notice.
				// repairOneChannel returns a PLAIN row for exactly this chain: a
				// spread hydrated row would leave every later spec reading its
				// stored id as missing (2026-10 item 274).
				stored = result.stored as typeof stored;
				// Audit notice uses the EFFECTIVE channel name (override if
				// set via /server channels rename, otherwise spec default). Without
				// this, "homebase-leaderboard rebuilt" would post in admin
				// after the rebuild even though the live channel is named
				// "stream-rankings" per the persisted override.
				const channelNamesRaw = (stored as unknown as { channelNames?: Map<string, string> | Record<string, string> }).channelNames;
				const overrideName =
					channelNamesRaw instanceof Map
						? channelNamesRaw.get(spec.configField)
						: (channelNamesRaw as Record<string, string> | undefined)?.[spec.configField];
				repaired.push(overrideName || GuildSetupManager.channelNameFor(spec, copyConfigOf(stored)));
			} catch (error) {
				console.error(LOG_MESSAGES.setup.channelRepairFailed(spec.displayName, guild.id), error);
				// continue to next spec. one failure should not block the
				// others from being repaired.
			}
		}

		if (movedIntoHeadquarters.length > 0) {
			console.log(`[headquarters] guild ${guild.id}: moved ${movedIntoHeadquarters.join(", ")} into 🏰 DERO HEADQUARTERS`);
		}
		if (repaired.length === 0) return [];

		// stored.adminChannelId points at the latest (possibly just rebuilt)
		// inner sanctum, so notices never land in a deleted channel.
		await GuildSetupManager.postRepairNotices(client, guild.id, stored.adminChannelId, repaired);
		return repaired;
	}

	// ── the boot sweep's secondary category ───────────────────────
	// Resolve (or build) the arcade or Headquarters category for repairMissingChannels,
	// persisting a newly found or built id at once so a guild that crashes mid sweep does
	// not create a second category next boot. Before BUILDING Headquarters, Manage
	// Channels is checked (2026-10 item 257 Phase 2a, owner decision 4): a server that
	// withheld it is left exactly as it is (onRefused logs the one line), never routed
	// toward the auto-leave countdown a 50013 on create would start, because the rest of
	// Dero works there today. A Headquarters that already exists is used either way, so
	// a deleted admin channel is still rebuilt where it belongs.
	private static async resolveSecondaryCategoryForSweep(
		guild: Guild,
		field: SecondaryCategoryField,
		stored: Record<string, unknown> & { adminRoleId?: string | null },
		onRefused: () => void
	): Promise<CategoryChannel | null> {
		const storedId = (stored[field] as string | null | undefined) ?? null;
		const existing = await GuildSetupManager.findExistingManagedCategory(guild, field, storedId, copyConfigOf(stored));
		if (existing === "unreachable") return null;
		if (!existing && field === "headquartersCategoryId" && !canManageChannels(guild)) {
			onRefused();
			return null;
		}
		const resolved = existing ?? (await GuildSetupManager.createManagedCategory(guild, field, guild.ownerId, stored.adminRoleId ?? null, copyConfigOf(stored)));
		if (resolved && resolved.id !== storedId) await guildConfigStore.update(guild.id, { [field]: resolved.id });
		return resolved;
	}

	// ── move a live admin channel into Headquarters ───────────────
	// One existing admin channel (🔒inner-sanctum, 🗒️admin-log) still
	// under the notice board is moved into 🏰 DERO HEADQUARTERS, keeping its messages and
	// pins, with its overwrites re-applied from its spec (risk R1). Resolves true when it
	// moved. Never throws back into the sweep: a refused move logs and leaves the channel.
	private static async moveExistingIntoHeadquarters(
		guild: Guild,
		existing: unknown,
		spec: (typeof GuildSetupManager.CHANNEL_SPECS)[number],
		stored: Record<string, unknown> & { adminRoleId?: string | null },
		resolveCategory: (field: SecondaryCategoryField) => Promise<CategoryChannel | null>,
		onRefused: () => void
	): Promise<boolean> {
		if (!(existing instanceof TextChannel)) return false;
		// Already home: no category lookup and no write, which is what makes a second boot a no op.
		if (typeof stored.headquartersCategoryId === "string" && existing.parentId === stored.headquartersCategoryId) return false;
		// A move is a channel edit, so it needs Manage Channels like a build does.
		if (!canManageChannels(guild)) {
			onRefused();
			return false;
		}
		const headquarters = await resolveCategory("headquartersCategoryId");
		if (!headquarters) return false;
		const memberRoleId = typeof stored.memberRoleId === "string" ? stored.memberRoleId : null;
		try {
			return await moveIntoCategory(guild, existing, headquarters, overwriteKindOf(spec), { memberRoleId, adminRoleId: stored.adminRoleId ?? null });
		} catch (error) {
			console.warn(`[headquarters] guild ${guild.id}: could not move ${spec.configField} into 🏰 DERO HEADQUARTERS; it stays where it is`, error);
			return false;
		}
	}

	// ── channel rename drift sync (2026-06) ──────────────────────────
	// What:  rename each existing homebase channel to its CURRENT expected name
	//        when it has drifted, e.g. a pack default changed (🛡️next-decree →
	//        🔜upcoming-events) or the bot's channel emoji changed. Removes the
	//        "delete the channel / re-run /setup" friction for guilds on defaults.
	// Who:   every setup-complete guild on every boot (main.ts ready loop).
	// When:  skipped for guilds that disabled auto-heal (autoHealEnabled === false
	//        means "do not manage my homebase", same opt-out as the rebuild sweep).
	//        A channel with a /server channels rename override keeps that override (expected
	//        = the override, normally already its live name); a channel with NO
	//        override is renamed to the current pack default. So the only way to
	//        keep an old custom name is to have set it via /server channels rename.
	// How:   expected = override || the guild pack's default; rename only when the live name
	//        differs, so steady state is one fetch per channel and zero API writes.
	//        Discord rate-limits renames (2 / 10 min / channel), but a drift rename
	//        fires at most once per name change, so this stays well clear.
	static async renameDriftedChannels(client: Client, guild: Guild): Promise<void> {
		const stored = (await guildConfigStore.findByGuildId(guild.id)) as
			| (Record<string, unknown> & { autoHealEnabled?: boolean | null; channelNames?: Map<string, string> | Record<string, string> })
			| null;
		if (!stored || stored.autoHealEnabled === false) return;

		const channelNamesRaw = stored.channelNames;
		const ids = stored as unknown as Record<string, string | null | undefined>;
		const adoptedIds = readAdoptedChannelIds(stored);

		for (const spec of GuildSetupManager.CHANNEL_SPECS) {
			const storedId = ids[spec.configField];
			if (!storedId) continue;
			// An adopted channel keeps the name its server gave it (2026-10 item 247
			// Phase 2): renaming the owner's #rules to 📘rules on every boot would be
			// Dero overwriting the owner's choice. /server channels rename still works on it.
			if (adoptedIds.includes(storedId)) continue;
			const channel = await client.channels.fetch(storedId).catch(() => null);
			// Both kinds rename the same way; the voice rooms are the only managed
			// channels that are not text channels.
			if (!(channel instanceof TextChannel || channel instanceof VoiceChannel)) continue;

			// Mongoose Map (hydrated doc) or plain object (.lean()'d), probe both,
			// same defensive read as repairOneChannel.
			const overrideName =
				channelNamesRaw instanceof Map
					? channelNamesRaw.get(spec.configField)
					: (channelNamesRaw as Record<string, string> | undefined)?.[spec.configField];
			const expected = overrideName || GuildSetupManager.channelNameFor(spec, copyConfigOf(stored));
			if (channel.name === expected) continue;

			try {
				const oldName = channel.name;
				await channel.setName(expected);
				console.log(`[setup] renamed ${spec.configField} "${oldName}" -> "${expected}" in guild ${guild.id}`);
			} catch (error) {
				console.warn(`[setup] failed to rename ${spec.configField} in guild ${guild.id}`, error);
			}
		}
	}

	// ── single channel builder ────────────────────────────────
	// What: recreate one channel under the given category with the shape
	//       createChannels gives its kind, for the guild's Community state as
	//       it is right now. Unlike createChannels, the stored admin role is
	//       layered on as well, so a repaired channel keeps the admin surface
	//       /setup granted.
	// Who:  repairOneChannel, so the boot sweep and ChannelDeleteWatcher both.
	// When: only from the repair path. autoSetup has its own bulk creation
	//       because it creates every channel in parallel with Promise.all.
	// How:  communityOverwritesFor resolves the shape; this only picks the
	//       Discord channel type and creates it.
	private static async buildSingleChannel(
		guild: Guild,
		category: CategoryChannel,
		name: string,
		kind: ManagedOverwriteKind,
		adminRoleId: string | null,
		// Read by a voice room (owner decision D3), and by a public text channel only
		// while the member role gates it on a Community guild.
		memberRoleId: string | null = null
	): Promise<TextChannel | VoiceChannel> {
		const permissionOverwrites = communityOverwritesFor(kind, guild, { ownerId: guild.ownerId }, { memberRoleId, adminRoleId });
		// guild.channels.create returns the class its type asks for, so both casts are
		// safe and save the caller a narrow.
		if (kind === "voice") {
			return (await guild.channels.create({ name, type: ChannelType.GuildVoice, parent: category.id, permissionOverwrites })) as VoiceChannel;
		}
		return (await guild.channels.create({ name, type: ChannelType.GuildText, parent: category.id, permissionOverwrites })) as TextChannel;
	}

	// ── audit notices ─────────────────────────────────────────
	// What: post one "channel restored" notice per repaired channel into
	//       the inner sanctum. If the admin channel itself was just
	//       repaired, adminChannelId refers to the NEW channel already
	//       because repairMissingChannels updated the stored state before
	//       calling here.
	// Who:  repairMissingChannels.
	// When: only when at least one channel was actually rebuilt.
	// Where: errors posting the notices are swallowed with a warn. the
	//        repair itself already succeeded and the bot is functional,
	//        a missing audit line is a visibility issue, not a correctness
	//        one.
	// How:  fetch the admin channel, verify it is a TextChannel, loop and
	//       send the embed. sequential sends keep Discord's rate limiter
	//       happy when several channels were repaired at once.
	// promoted from private so ChannelDeleteWatcher can reuse the same post
	// path for its single channel notice. the method already handles the
	// "admin channel was the one repaired" case because callers pass in the
	// freshest adminChannelId.
	static async postRepairNotices(
		client: Client,
		guildId: string,
		adminChannelId: string,
		repairedChannelNames: string[]
	): Promise<void> {
		try {
			const channel = await client.channels.fetch(adminChannelId).catch(() => null);
			if (!channel || !(channel instanceof TextChannel)) return;
			// Resolve the repair-notice copy in the guild's pack voice. Self-contained
			// load (mirrors postCastleRebuiltNotice) so both callers, the boot repair
			// sweep and ChannelDeleteWatcher, get neutral copy on a non-ROK guild
			// without threading config through every call site. Null → rok default.
			const config = await guildConfigStore.findByGuildId(guildId);
			// Single summary embed instead of one-per-channel. When the bot
			// rebuilds several channels in a single sweep (eg after a
			// toggle clears userRemovedChannels and auto-heal restores
			// multiple slots), one message in inner-sanctum carries the
			// audit signal without flooding the channel. Single-channel
			// repairs keep the same shape, the summary template handles
			// the count===1 case gracefully via singular/plural copy.
			await channel.send({ embeds: [ChannelContent.channelsRestoredSummary(repairedChannelNames, config)] });
		} catch (error) {
			console.warn(LOG_MESSAGES.setup.repairNoticePostFailed(guildId), error);
		}
	}

	// ── castle rebuilt announcement ───────────────────────────
	// What: after a full category rebuild via rebuildFromStaleConfig,
	//       post the "castle rebuilt" embed in the newly created inner
	//       sanctum so the admin understands why the category looks new.
	// Who:  ensureHomebase, in both the "category gone" and "foreign
	//       category" branches.
	// When: exactly once per rebuild.
	// Where: reads the freshly written GuildConfig to get the NEW
	//        adminChannelId. swallows post failures because the rebuild
	//        itself succeeded and the bot is functional.
	// How:  find the new admin channel via client.channels.fetch, verify
	//       it is a TextChannel, send the embed.
	private static async postCastleRebuiltNotice(client: Client, guildId: string): Promise<void> {
		try {
			const fresh = await guildConfigStore.findByGuildId(guildId);
			if (!fresh?.adminChannelId) return;
			const channel = await client.channels.fetch(fresh.adminChannelId).catch(() => null);
			if (!channel || !(channel instanceof TextChannel)) return;
			await channel.send({ embeds: [ChannelContent.castleRebuiltNotice(fresh)] });
		} catch (error) {
			console.warn(LOG_MESSAGES.setup.castleRebuiltNoticePostFailed(guildId), error);
		}
	}

	// ── ownership probe ───────────────────────────────────────
	// What: return true iff the stored scheduleMessageId resolves and is
	//       authored by the running bot account. Any other outcome (missing
	//       channel, missing message id, message deleted, author mismatch)
	//       means the stored homebase is not ours and must be rebuilt.
	// Who:  ensureHomebase on startup AND ChannelDeleteWatcher at runtime.
	//       Kept as its own method so both entry points use the same probe.
	// When: once per guild per boot, once per qualifying ChannelDelete event
	//       at runtime, or whenever any caller wants a cheap provenance
	//       check against Discord.
	// Where: intentionally does NOT call guildConfigStore.update, callers
	//        that act on the result own the follow up writes.
	// How:  bail early on any missing piece. Swallow 10008 / 10003 /
	//       cache misses as "not ours" so a single bad fetch does not crash
	//       the ready sweep for every other guild.
	// Tri-state ownership probe. "owned" = the schedule anchor exists and this bot
	// authored it. "foreign" = the anchor exists but a DIFFERENT bot authored it
	// (the only positive signal of someone else's homebase). "unknown" = we cannot
	// check (no anchor stored, the message was deleted, or a fetch failed).
	//
	// Callers MUST rebuild only on "foreign" and repair-in-place on "unknown".
	// Treating "unknown" as "rebuild" was the auto-heal duplicate-homebase bug: a
	// benign missing/deleted schedule message looked identical to a foreign one,
	// so a deleted pinned message triggered a full rebuild (new duplicate category
	// + fresh channels, losing /server channels rename overrides). A missing anchor is not
	// evidence the homebase is someone else's; ScheduleBoard reposts the message on
	// its next refresh.
	static async isHomebaseOwnedByThisBot(
		client: Client,
		guildId: string,
		stored: { scheduleChannelId?: string | null; scheduleMessageId?: string | null }
	): Promise<"owned" | "foreign" | "unknown"> {
		const selfId = client.user?.id;
		// No self id or no stored anchor → cannot disprove ownership. "unknown" so
		// the caller repairs in place instead of doing a destructive rebuild. A
		// Headquarters only guild has no 📅event-schedule yet, so it lands here too.
		if (!selfId) return "unknown";
		if (!stored.scheduleMessageId || !stored.scheduleChannelId) return "unknown";

		const channel = await client.channels.fetch(stored.scheduleChannelId).catch(() => null);
		if (!channel || !(channel instanceof TextChannel)) return "unknown";

		try {
			const message = await channel.messages.fetch(stored.scheduleMessageId);
			return message.author.id === selfId ? "owned" : "foreign";
		} catch (error) {
			// 10008 Unknown Message / 10003 Unknown Channel → the anchor is gone.
			// We cannot confirm OR disprove ownership, so "unknown" (repair in
			// place), NOT a rebuild. A deleted schedule message must never
			// duplicate the homebase.
			if (error instanceof DiscordAPIError) {
				console.warn(LOG_MESSAGES.setup.homebaseOwnershipProbeFailed(guildId, error.code));
			} else {
				console.warn(LOG_MESSAGES.setup.homebaseOwnershipProbeFailed(guildId, "unknown"));
			}
			return "unknown";
		}
	}

	// ── rebuild helper ────────────────────────────────────────
	// What: rerun autoSetup to build a fresh category + channels when the
	//       stored homebase is gone or foreign. Critically, this does NOT
	//       call deleteByGuildId. That would be destructive in the shared
	//       MongoDB cluster case (dev wiping prod's row and vice versa).
	//       A foreign row is never touched here.
	// Who:  ensureHomebase. Mirrors the private rebuildHomebase helper in
	//       ScheduleBoard.ts so runtime and boot time self heal take the
	//       same path.
	// When: only after ensureHomebase has positively determined the stored
	//       homebase is gone or foreign (either the category is missing in
	//       Discord, or the ownership probe came back negative).
	// Where: autoSetup is invoked with force:true so its own early return
	//        on "existing row" is bypassed. If the row in the DB is a
	//        foreign row (different bot's config), autoSetup's duplicate
	//        key handler will log loudly and bail on the persist step,
	//        leaving the fresh Discord channels built but unpersisted,
	//        the correct failure mode for the shared cluster misconfig.
	// How:   autoSetup(force:true) → if the DB slot is free, fresh row is
	//        written. If it is occupied by a foreign row, the unique index
	//        on guildId throws 11000 which autoSetup catches and logs.
	//        Either way the operator gets a signal and prod state is safe.
	//        foreignHomebase is passed through so a foreign rebuild keeps none of
	//        the reused categories' channels (2026-10 item 273, D1).
	private static async rebuildFromStaleConfig(guild: Guild, options: Pick<IAutoSetupOptions, "foreignHomebase"> = {}): Promise<void> {
		await GuildSetupManager.autoSetup(guild, { guildId: guild.id, ownerId: guild.ownerId }, { force: true, ...options });
	}

	// ── Phase 2: apply admin role to existing channels ────────
	static async applyAdminRole(guild: Guild, config: IAdminRoleConfig): Promise<void> {
		const stored = await guildConfigStore.findByGuildId(config.guildId);
		if (!stored) throw new Error("No guild config found, channels have not been constructed yet.");

		// ⚠️ DERIVED FROM CHANNEL_SPECS, NOT HAND LISTED, and that is a bug fix.
		// This used to fetch a hand written list of seven channels, which had
		// already rotted: nextDecreeChannelId was never in it, so the admin role
		// was NEVER granted on 🔜upcoming-events. Nothing errored, because every
		// grant is optional-chained; the channel simply stayed ungranted forever.
		// Adding the two ARCADE GAMES channels by hand would have made an
		// eleven-entry list of the same kind. Walking the specs means channel
		// eleven is granted the day it is declared.
		//
		// Every id is optional-chained and fetched defensively: a legacy row
		// carries nulls for any channel added after it was written, and the boot
		// sweep builds those later.
		const storedIds = stored as unknown as Record<string, string | null | undefined>;
		const fetchChannel = async (id: string | null | undefined): Promise<GuildChannel | null> =>
			id ? ((await guild.channels.fetch(id).catch(() => null)) as GuildChannel | null) : null;

		// Every managed category. The arcade and Headquarters ids are nullable on every
		// row written before each existed.
		for (const field of ["categoryId", "gamesCategoryId", "headquartersCategoryId"] as const) {
			const category = await fetchChannel(storedIds[field]);
			await category?.permissionOverwrites.create(config.adminRoleId, {
				ViewChannel: true,
				SendMessages: true,
				ReadMessageHistory: true,
			});
		}

		// Every managed channel, with the grant shaped by the spec's own kind:
		// admin channels also get ReadMessageHistory, which is what makes an
		// admin-only channel readable rather than merely visible.
		let adminChannel: GuildChannel | null = null;
		for (const spec of GuildSetupManager.CHANNEL_SPECS) {
			const channel = await fetchChannel(storedIds[spec.configField]);
			if (spec.configField === "adminChannelId") adminChannel = channel;
			// The MEMBER role is granted on the voice rooms on every guild (owner
			// decision D3), and on the public text channels too while it gates them on
			// a Community guild (2026-10 item 247); this is when an existing channel
			// first opens to members. The @everyone deny that makes the text grant
			// matter lands at the next boot's reconcile, which is also what posts the
			// one time gating announcement. Member role first, admin role last: create
			// REPLACES an overwrite, so an admin role that doubles as the member role
			// has to land second to keep the wider grant, and a member role that IS
			// @everyone replaces a room's Connect deny, opening it to all.
			const memberGrant = memberRoleGrant(guild, overwriteKindOf(spec), config.memberRoleId);
			if (memberGrant) await channel?.permissionOverwrites.create(config.memberRoleId, memberGrant);
			if (spec.kind === "voice") {
				await channel?.permissionOverwrites.create(config.adminRoleId, {
					ViewChannel: true,
					Connect: true,
					Speak: true,
					SendMessages: true,
				});
				continue;
			}
			// The audit trail is read only for admins too (communityOverwrites keeps the
			// array form of this grant), so nobody can pad or answer it in place.
			if (spec.kind === "adminLog") {
				await channel?.permissionOverwrites.create(config.adminRoleId, { ViewChannel: true, ReadMessageHistory: true, SendMessages: false });
				continue;
			}
			await channel?.permissionOverwrites.create(
				config.adminRoleId,
				spec.kind === "admin"
					? { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }
					: { ViewChannel: true, SendMessages: true }
			);
		}

		// post the real welcome message now that the role is known
		if (adminChannel?.isTextBased()) {
			await adminChannel.send({
				embeds: [ChannelContent.adminWelcome(config.ownerId, config.adminRoleId, stored)],
				components: GuildSetupManager.resolveIntroComponents("adminChannelId") ?? [],
			});
		}

		await guildConfigStore.update(config.guildId, {
			adminRoleId: config.adminRoleId,
			memberRoleId: config.memberRoleId,
			setupComplete: true,
		});
	}

	// ── channel creation ──────────────────────────────────────
	// ── resolve or create a secondary managed category ────────
	// What:  hand back the guild's 🎮 ARCADE GAMES or 🏰 DERO HEADQUARTERS category
	//        (SECONDARY_CATEGORIES says which by field), creating it when the stored
	//        id is null or points at something that no longer exists.
	// Who:   runAutoSetup and repairMissingChannels (a legacy guild whose row
	//        predates the category). ONE helper set for both categories and both
	//        callers, so no two paths can build one with different overwrites and drift.
	// ⚠️     BOTH callers must pass the STORED id. This comment used to claim
	//        runAutoSetup's stored id "is always null", which is only true of a
	//        fresh install; the forced rebuild paths reach it with a live category
	//        already recorded, and passing null there duplicated the category.
	//        See the call site in runAutoSetup for the full failure.
	// When:  once per autoSetup, and lazily on the boot sweep the first time a
	//        spec under that category needs a parent.
	// Where: the arcade's overwrites deliberately MIRROR the homebase category's,
	//        owner allow and nothing else. runAutoSetup's own comment explains why an
	//        @everyone deny on a category is actively harmful (it clobbers the
	//        bot's ViewChannel inheritance via @everyone-role membership and
	//        produces a 50013 on the very next child create). Headquarters is the
	//        one category that must hide from members, so it carries its own bot
	//        ViewChannel allow, which is what keeps that deny harmless.
	// How:   returns null on a 50013 after routing through handlePermissionFailure,
	//        matching runAutoSetup's posture: a guild that will not let the bot
	//        build is tracked toward the auto-leave grace period rather than
	//        throwing on every boot forever.
	//
	// ⚠️ NOTHING IS CREATED UNLESS DISCORD POSITIVELY SAID THERE IS NONE (the
	// post-launch plan's item 1, a second 🎮 ARCADE GAMES beside a live one). The
	// stored id is read first, but a failed fetch only means "gone" when Discord
	// answers Unknown Channel; a timeout, a rate limit or a 5xx used to read as gone
	// too, and built a duplicate. Then, before any create, a category already
	// carrying the category's name is adopted, which also heals a row that lost its id
	// (a self destruct release, a reset database). An unconfirmed stored id returns
	// null, which both callers already treat as "skip this category this pass".
	// runAutoSetup calls the two halves itself (see its call site for why), and so does
	// the boot sweep (resolveSecondaryCategoryForSweep), which checks Manage Channels
	// between them.
	// The lookup half: the stored category, else one already carrying the category's
	// name, else null (Discord confirmed there is none to reuse), or "unreachable"
	// when the stored id could not be confirmed either way.
	private static async findExistingManagedCategory(
		guild: Guild,
		field: SecondaryCategoryField,
		storedId: string | null | undefined,
		// The guild row the name is read through (null on a fresh install, the default pack).
		copyConfig: ICopyConfig | null
	): Promise<CategoryChannel | null | "unreachable"> {
		const { logTag } = SECONDARY_CATEGORIES[field];
		if (storedId) {
			const stored = await GuildSetupManager.fetchStoredCategory(guild, storedId);
			if (stored === "unreachable") {
				console.warn(`[${logTag}] guild ${guild.id}: could not confirm stored category ${storedId}; creating nothing this pass`);
				return "unreachable";
			}
			if (stored) return stored;
		}

		const adopted = GuildSetupManager.findManagedCategoryByName(guild, field, copyConfig);
		if (adopted) console.log(`[${logTag}] guild ${guild.id}: adopted existing category ${adopted.id} instead of building a second one`);
		return adopted;
	}

	// The create half, null on a 50013 after routing through handlePermissionFailure.
	private static async createManagedCategory(
		guild: Guild,
		field: SecondaryCategoryField,
		ownerId: string,
		adminRoleId: string | null,
		copyConfig: ICopyConfig | null
	): Promise<CategoryChannel | null> {
		const category = SECONDARY_CATEGORIES[field];
		try {
			return await guild.channels.create({
				name: resolveCategoryName(field, copyConfig),
				type: ChannelType.GuildCategory,
				permissionOverwrites: category.overwrites(guild, ownerId, adminRoleId),
			});
		} catch (error) {
			if (error instanceof DiscordAPIError && error.code === 50013) {
				await GuildSetupManager.handlePermissionFailure(guild);
				return null;
			}
			throw error;
		}
	}

	// The stored category, through fetchStoredChannel.
	private static async fetchStoredCategory(guild: Guild, categoryId: string): Promise<CategoryChannel | null | "unreachable"> {
		return GuildSetupManager.fetchStoredChannel(guild, categoryId, (channel): channel is CategoryChannel => (channel as { type?: unknown } | null)?.type === ChannelType.GuildCategory);
	}

	// A stored channel of the expected kind, null when Discord answered that it does not
	// exist (or the id now names a channel of another kind), and "unreachable" for any
	// other failure, which says nothing about whether it exists. Callers build nothing on
	// "unreachable": a timeout or a 5xx read as "gone" is how a second copy gets built.
	private static async fetchStoredChannel<TChannel>(
		guild: Guild,
		channelId: string,
		isExpectedKind: (channel: unknown) => channel is TChannel
	): Promise<TChannel | null | "unreachable"> {
		try {
			const channel = await guild.channels.fetch(channelId);
			return isExpectedKind(channel) ? channel : null;
		} catch (error) {
			if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownChannel) return null;
			return "unreachable";
		}
	}

	// A category already named as this environment's arcade or Headquarters. When a
	// guild already holds several (the duplicate this guards against), the one with the
	// most channels under it is the live one, so it wins and the empty spare is left for
	// an admin to delete rather than deleted by Dero. Reads the channel cache only, the
	// way adoption.ts scans for a welcome or rules channel: the Guilds intent fills it
	// at ready, so the scan costs no API call and has no failure of its own.
	private static findManagedCategoryByName(guild: Guild, field: SecondaryCategoryField, copyConfig: ICopyConfig | null): CategoryChannel | null {
		const name = resolveCategoryName(field, copyConfig);
		const matches = [...(guild.channels.cache?.values() ?? [])].filter(
			(channel): channel is CategoryChannel => channel?.type === ChannelType.GuildCategory && channel.name === name
		);
		if (matches.length === 0) return null;
		return matches.reduce((best, next) => (next.children.cache.size > best.children.cache.size ? next : best));
	}

	// ── a first build's channels, one group per managed category ───────
	// What:  build the channels of every category this pass builds, under the parents
	//        passed in; a group is built only when its parent is passed. A null parent is a
	//        category this forced rebuild settles slot by slot instead:
	//        settleReusedCategoryChildren keeps, moves or repairs each of its slots once the
	//        row is stored. Building its group here as well is what used to put a second
	//        set of every arcade and Headquarters channel beside the live one (2026-10 item
	//        273), and of every notice board channel beside its survivors (item 275).
	// Who:   runAutoSetup (fresh install, forced rebuild).
	// How:   one Promise.all per group, the groups in parallel. The parents are passed in
	//        rather than resolved here so the 50013 handling lives in one place above.
	private static async createChannels(
		guild: Guild,
		parents: { category: CategoryChannel | null; gamesCategory: CategoryChannel | null; headquartersCategory: CategoryChannel | null },
		config: ISetupConfig,
		// The roles each posture names, all null on a fresh install. `voice` is the
		// stored pair as is (owner decision D3); `text` carries the admin role only once
		// /setup has finished (runAutoSetup decides), and the member role while it gates
		// a Community guild. Every text posture and the welcome and rules adoption read
		// `text`, so a forced rebuild matches what buildSingleChannel builds on repair.
		roles: { voice: IOverwriteRoles; text: IOverwriteRoles },
		// The row a forced rebuild replaces (null on a fresh install), read by the welcome
		// and rules adoption scan and for the pack every channel is named from.
		storedRow: Record<string, unknown> | null = null
	): Promise<{
		homebase: IBuiltGroup<IHomebaseChannelIds, IHomebaseChannelObjects> | null;
		arcade: IBuiltGroup<IArcadeChannelIds, IArcadeChannelObjects> | null;
		headquarters: IBuiltGroup<IHeadquartersChannelIds, IHeadquartersChannelObjects> | null;
		adoptedChannelIds: string[];
		adoptions: Array<{ field: string; channelId: string }>;
	}> {
		const postures = GuildSetupManager.channelPostures(guild, config, roles);
		// A forced rebuild names its channels in the stored row's pack, so a streamer server
		// rebuilt keeps its template's names; a fresh install (no row) takes the default pack.
		const names = getPluginCopy(copyConfigOf(storedRow)).setup.channels;
		const [homebase, arcade, headquarters] = await Promise.all([
			parents.category ? GuildSetupManager.createHomebaseChannels(guild, parents.category, postures, roles.text, storedRow, names) : null,
			parents.gamesCategory ? GuildSetupManager.createArcadeChannels(guild, parents.gamesCategory, postures, names) : null,
			parents.headquartersCategory ? GuildSetupManager.createHeadquartersChannels(guild, parents.headquartersCategory, postures, names) : null,
		]);
		return { homebase: homebase?.group ?? null, arcade, headquarters, adoptedChannelIds: homebase?.adoptedChannelIds ?? [], adoptions: homebase?.adoptions ?? [] };
	}

	// Every overwrite shape a first build hands out, resolved once so the three group
	// builders cannot drift from each other or from the repair path's buildSingleChannel.
	private static channelPostures(guild: Guild, config: ISetupConfig, roles: { voice: IOverwriteRoles; text: IOverwriteRoles }): IChannelPostures {
		const owner = { ownerId: config.ownerId };
		return {
			// Members read, the owner and the bot write.
			public: communityOverwritesFor("public", guild, owner, roles.text),
			// Introductions is the one member-writable homebase channel: it doubles
			// as a greeter surface where new members answer the welcome icebreaker
			// (welcomeNewMember) and satisfies a Discord Onboarding gate that requires
			// posting in a channel before full access.
			intro: communityOverwritesFor("intro", guild, owner, roles.text),
			// Admin channels: the owner, plus the admin role once /setup has granted one.
			admin: communityOverwritesFor("admin", guild, owner, roles.text),
			// The audit trail: the owner and the admin role read, only the bot writes.
			adminLog: communityOverwritesFor("adminLog", guild, owner, roles.text),
			// 💬dero-commands: public, and members may send, because they run commands there.
			commandOutput: communityOverwritesFor("commandOutput", guild, owner, roles.text),
			// The voice rooms, the posture buildSingleChannel also uses on repair, so a
			// rebuilt room matches a fresh one.
			voice: communityOverwritesFor("voice", guild, owner, roles.voice),
		};
	}

	// 🪧 NOTICE BOARD's channels, built on a fresh install, a foreign rebuild, and a rebuild
	// where none of them survived the deleted category (2026-10 item 275).
	private static async createHomebaseChannels(
		guild: Guild,
		category: CategoryChannel,
		postures: IChannelPostures,
		textRoles: IOverwriteRoles,
		storedRow: Record<string, unknown> | null,
		channels: IPluginCopy["setup"]["channels"]
	): Promise<{ group: IBuiltGroup<IHomebaseChannelIds, IHomebaseChannelObjects>; adoptedChannelIds: string[]; adoptions: Array<{ field: string; channelId: string }> }> {
		// 👋welcome and 📘rules adopt the server's own channel when it has one
		// (2026-10 item 247 Phase 2). The scan runs BEFORE the create, which is the
		// whole guarantee against a duplicate: a match short circuits the build. The
		// two pattern lists share no name, so their scans cannot race for one channel.
		// The admin log line waits for the row (runAutoSetup), because adminLog reads
		// the log channel from it and this build has not stored it yet.
		const adoptOrCreate = async (field: "welcomeChannelId" | "rulesChannelId"): Promise<{ channel: TextChannel; adopted: boolean }> => {
			const spec = GuildSetupManager.CHANNEL_SPECS.find((entry) => entry.configField === field)!;
			const adopted = await GuildSetupManager.adoptExistingChannel(guild, category, spec, storedRow, textRoles, [], { deferAdminLog: true });
			if (adopted) return { channel: adopted, adopted: true };
			const channel = await guild.channels.create({ name: channels[spec.nameKey], type: ChannelType.GuildText, parent: category.id, permissionOverwrites: postures.public });
			return { channel, adopted: false };
		};

		const [
			introChannel,
			commandsChannel,
			leaderboardChannel,
			scheduleChannel,
			announcementsChannel,
			nextDecreeChannel,
			welcome,
			rules,
			meetingVoiceChannel,
			commandOutputChannel,
		] = await Promise.all([
			guild.channels.create({
				name: channels.intro,
				type: ChannelType.GuildText,
				parent: category.id,
				permissionOverwrites: postures.intro,
			}),
			guild.channels.create({
				name: channels.commands,
				type: ChannelType.GuildText,
				parent: category.id,
				// Commands channel uses publicOverwrites so members are
				// read-only here. The pinned command-center embed is the
				// channel's whole reason for existing; opening SendMessages
				// would let unrelated chatter bury it. Slash commands work
				// in any channel anyway, so the lockdown does not block use.
				permissionOverwrites: postures.public,
			}),
			guild.channels.create({
				name: channels.leaderboard,
				type: ChannelType.GuildText,
				parent: category.id,
				permissionOverwrites: postures.public,
			}),
			guild.channels.create({
				name: channels.schedule,
				type: ChannelType.GuildText,
				parent: category.id,
				permissionOverwrites: postures.public,
			}),
			guild.channels.create({
				name: channels.announcements,
				type: ChannelType.GuildText,
				parent: category.id,
				permissionOverwrites: postures.public,
			}),
			// seventh, 🛡️next-decree. public overwrites (mortals read,
			// bot writes). Mirror of announcements at the permission
			// level but its own channel so the audit trail does not
			// collide with the 15/30 minute reminder pings.
			guild.channels.create({
				name: channels.nextDecree,
				type: ChannelType.GuildText,
				parent: category.id,
				permissionOverwrites: postures.public,
			}),
			// 👋welcome and 📘rules: publicOverwrites, members read and the bot writes,
			// when built here; an adopted one keeps its own place and permissions until
			// an admin chooses to move it (adoptionChoice).
			adoptOrCreate("welcomeChannelId"),
			adoptOrCreate("rulesChannelId"),
			// The notice board's voice room (2026-10 item 235); the lounge is the arcade's.
			guild.channels.create({
				name: channels.meetingVoice,
				type: ChannelType.GuildVoice,
				parent: category.id,
				permissionOverwrites: postures.voice,
			}),
			// 💬dero-commands, under the notice board where members already look.
			guild.channels.create({
				name: channels.commandOutput,
				type: ChannelType.GuildText,
				parent: category.id,
				permissionOverwrites: postures.commandOutput,
			}),
		]);

		return {
			group: {
				ids: {
					categoryId: category.id,
					introChannelId: introChannel.id,
					commandsChannelId: commandsChannel.id,
					leaderboardChannelId: leaderboardChannel.id,
					scheduleChannelId: scheduleChannel.id,
					announcementsChannelId: announcementsChannel.id,
					nextDecreeChannelId: nextDecreeChannel.id,
					welcomeChannelId: welcome.channel.id,
					rulesChannelId: rules.channel.id,
					meetingVoiceChannelId: meetingVoiceChannel.id,
					commandOutputChannelId: commandOutputChannel.id,
				},
				objects: {
					introChannel,
					commandsChannel,
					leaderboardChannel,
					scheduleChannel,
					announcementsChannel,
					nextDecreeChannel,
					welcomeChannel: welcome.channel,
					rulesChannel: rules.channel,
					meetingVoiceChannel,
					commandOutputChannel,
				},
			},
			adoptedChannelIds: [welcome, rules].filter((entry) => entry.adopted).map((entry) => entry.channel.id),
			adoptions: [
				{ field: "welcomeChannelId", entry: welcome },
				{ field: "rulesChannelId", entry: rules },
			]
				.filter(({ entry }) => entry.adopted)
				.map(({ field, entry }) => ({ field, channelId: entry.channel.id })),
		};
	}

	// 🎮 ARCADE GAMES' channels, under the arcade category.
	// ⚠️ NOTE THE PARENT: category is the ARCADE here, not the homebase. Getting it wrong
	// is risk R2 in a form the compiler cannot catch (both are CategoryChannel), which is
	// why the specs carry categoryField for every OTHER consumer.
	//
	// Every text channel takes the public posture: members read, the bot writes. The rules
	// card is a pinned reference and the challenge boards are walls of bot posted cards with
	// buttons, so member SendMessages would only let chatter bury them. Challenges are
	// issued by command or button, not by typing here, so the lockdown costs nothing.
	private static async createArcadeChannels(
		guild: Guild,
		category: CategoryChannel,
		postures: IChannelPostures,
		channels: IPluginCopy["setup"]["channels"]
	): Promise<IBuiltGroup<IArcadeChannelIds, IArcadeChannelObjects>> {
		const [arcadeRulesChannel, arcadeChallengesChannel, arcadeGamesChannel, partyGamesChannel, arcadeRatedChallengesChannel, deroMarketChannel, arcadeVoiceChannel] =
			await Promise.all([
				guild.channels.create({
					name: channels.arcadeRules,
					type: ChannelType.GuildText,
					parent: category.id,
					permissionOverwrites: postures.public,
				}),
				guild.channels.create({
					name: channels.arcadeChallenges,
					type: ChannelType.GuildText,
					parent: category.id,
					permissionOverwrites: postures.public,
				}),
				// 🕹️games (2026-10 item 245 Phase 4a): members press its buttons and read
				// what Dero posts there, and nobody needs to type in it.
				guild.channels.create({
					name: channels.arcadeGames,
					type: ChannelType.GuildText,
					parent: category.id,
					permissionOverwrites: postures.public,
				}),
				// 🎉party-games (post-launch plan item 3).
				guild.channels.create({
					name: channels.partyGames,
					type: ChannelType.GuildText,
					parent: category.id,
					permissionOverwrites: postures.public,
				}),
				// 🏆rated-challenges (2026-10 item 254, Arcade 5), the posture of ⚔️challenges,
				// whose rated half it holds.
				guild.channels.create({
					name: channels.arcadeRatedChallenges,
					type: ChannelType.GuildText,
					parent: category.id,
					permissionOverwrites: postures.public,
				}),
				// 🏪dero-market (2026-10 item 267 Session 2a): members press its two buttons
				// and read the trades Dero posts.
				guild.channels.create({
					name: channels.deroMarket,
					type: ChannelType.GuildText,
					parent: category.id,
					permissionOverwrites: postures.public,
				}),
				// 🎮 Arcade Lounge (2026-10 item 235), the arcade's voice room.
				guild.channels.create({
					name: channels.arcadeVoice,
					type: ChannelType.GuildVoice,
					parent: category.id,
					permissionOverwrites: postures.voice,
				}),
			]);

		return {
			ids: {
				gamesCategoryId: category.id,
				arcadeRulesChannelId: arcadeRulesChannel.id,
				arcadeChallengesChannelId: arcadeChallengesChannel.id,
				arcadeGamesChannelId: arcadeGamesChannel.id,
				partyGamesChannelId: partyGamesChannel.id,
				arcadeRatedChallengesChannelId: arcadeRatedChallengesChannel.id,
				deroMarketChannelId: deroMarketChannel.id,
				arcadeVoiceChannelId: arcadeVoiceChannel.id,
			},
			objects: { arcadeRulesChannel, arcadeChallengesChannel, arcadeGamesChannel, partyGamesChannel, arcadeRatedChallengesChannel, deroMarketChannel, arcadeVoiceChannel },
		};
	}

	// 🏰 DERO HEADQUARTERS' channels (2026-10 item 257 Phase 2a), so admin controls sit
	// apart from the members'. ⚠️ NOTE THE PARENT, as with the arcade's: category is
	// Headquarters here. Admin only, except 🗒️admin-log, which only the bot writes.
	private static async createHeadquartersChannels(
		guild: Guild,
		category: CategoryChannel,
		postures: IChannelPostures,
		channels: IPluginCopy["setup"]["channels"]
	): Promise<IBuiltGroup<IHeadquartersChannelIds, IHeadquartersChannelObjects>> {
		const [adminChannel, adminLogChannel, deroConfigChannel, onboardingConfigChannel, arcadeControlChannel, serverConfigChannel] = await Promise.all([
			// 🔒inner-sanctum, or 🔒admin in the streamer pack.
			guild.channels.create({
				name: channels.admin,
				type: ChannelType.GuildText,
				parent: category.id,
				permissionOverwrites: postures.admin,
			}),
			// 🗒️admin-log (post-launch plan item 11), the bot write only audit trail.
			guild.channels.create({
				name: channels.adminLog,
				type: ChannelType.GuildText,
				parent: category.id,
				permissionOverwrites: postures.adminLog,
			}),
			guild.channels.create({
				name: channels.deroConfig,
				type: ChannelType.GuildText,
				parent: category.id,
				permissionOverwrites: postures.admin,
			}),
			guild.channels.create({
				name: channels.onboardingConfig,
				type: ChannelType.GuildText,
				parent: category.id,
				permissionOverwrites: postures.admin,
			}),
			guild.channels.create({
				name: channels.arcadeControl,
				type: ChannelType.GuildText,
				parent: category.id,
				permissionOverwrites: postures.admin,
			}),
			// 🛠️server-config, the fourth (2026-10 item 263 Phase 4a); a fresh server never gets 🎛️admin-controls.
			guild.channels.create({
				name: channels.serverConfig,
				type: ChannelType.GuildText,
				parent: category.id,
				permissionOverwrites: postures.admin,
			}),
		]);

		return {
			ids: {
				headquartersCategoryId: category.id,
				adminChannelId: adminChannel.id,
				adminLogChannelId: adminLogChannel.id,
				deroConfigChannelId: deroConfigChannel.id,
				onboardingConfigChannelId: onboardingConfigChannel.id,
				arcadeControlChannelId: arcadeControlChannel.id,
				serverConfigChannelId: serverConfigChannel.id,
			},
			objects: { adminChannel, adminLogChannel, deroConfigChannel, onboardingConfigChannel, arcadeControlChannel, serverConfigChannel },
		};
	}

	// ── populate channels with initial content ────────────────
	// What:  post the intro of every channel a first build made, one group per category,
	//        and return the message ids so runAutoSetup can persist them on the
	//        GuildConfig row. A group the build did not make (a reused category, null
	//        here) posts nothing: its kept channels already hold their intros.
	// Who:   runAutoSetup (fresh build, path A, and in place rebuild, path B).
	// When:  exactly once per build. Subsequent boots edit the stored ids in
	//        place via refreshIntroEmbeds rather than reposting.
	// Where: scheduleMessage keeps its special treatment, it is still the
	//        anchor the ScheduleBoard edits in place, and pinning is still
	//        best effort. Every other id lands on introMessageIds for boot time
	//        copy refreshes.
	// How:   each group's Promise.all returns its messages in the order they were sent,
	//        destructured by name so adding a channel later does not shift positions.
	private static async populateChannels(
		guild: Guild,
		built: { homebase: IHomebaseChannelObjects | null; arcade: IArcadeChannelObjects | null; headquarters: IHeadquartersChannelObjects | null },
		// Which of 👋welcome and 📘rules the server already had, and the row whose
		// saved rules the rules post shows (2026-10 item 247 Phase 2). An adopted
		// channel holding the owner's content gets no intro, and its anchor stays null.
		// adminRoleId is the role the rebuilt admin channels were granted (null on a
		// fresh install), which decides between the welcome and the pending card.
		// copyConfig is the pack every intro reads: the stored row on a forced rebuild, so a
		// streamer server rebuilt keeps its wording, and null on a fresh install.
		options: { adoptedChannelIds: readonly string[]; rulesConfig: IRulesConfig | null; adminRoleId: string | null; copyConfig: ICopyConfig | null }
	): Promise<{ scheduleMessageId: string | null; introMessageIds: Record<string, string | null> }> {
		const [homebase, arcade, headquarters] = await Promise.all([
			built.homebase ? GuildSetupManager.postHomebaseIntros(guild, built.homebase, options) : null,
			built.arcade ? GuildSetupManager.postArcadeIntros(built.arcade, options.copyConfig) : null,
			built.headquarters ? GuildSetupManager.postHeadquartersIntros(guild, built.headquarters, options.adminRoleId, options.copyConfig) : null,
		]);
		return { scheduleMessageId: homebase?.scheduleMessageId ?? null, introMessageIds: { ...homebase?.introMessageIds, ...arcade, ...headquarters } };
	}

	// 🪧 NOTICE BOARD's intros, the schedule anchor and the #command-center invite card.
	private static async postHomebaseIntros(
		guild: Guild,
		discordChannels: IHomebaseChannelObjects,
		options: { adoptedChannelIds: readonly string[]; rulesConfig: IRulesConfig | null; copyConfig: ICopyConfig | null }
	): Promise<{ scheduleMessageId: string; introMessageIds: Record<string, string | null> }> {
		const { copyConfig } = options;
		const {
			introChannel,
			commandsChannel,
			leaderboardChannel,
			scheduleChannel,
			announcementsChannel,
			nextDecreeChannel,
			welcomeChannel,
			rulesChannel,
			meetingVoiceChannel,
			commandOutputChannel,
		} = discordChannels;

		// The welcome and rules intros, through the adopted channel content gate.
		const postIntroUnlessOwnerContent = async (channel: TextChannel, field: "welcomeChannelId" | "rulesChannelId"): Promise<Message | null> => {
			const embed = GuildSetupManager.resolveIntroEmbed(field, guild, null, options.rulesConfig);
			if (!embed || !(await GuildSetupManager.adoptedChannelAcceptsIntro(guild, channel, embed, options.adoptedChannelIds))) return null;
			return channel.send({ embeds: [embed], components: GuildSetupManager.resolveIntroComponents(field, options.rulesConfig) ?? [] });
		};

		const [
			introMsg,
			commandsMsg,
			leaderboardMsg,
			scheduleMessage,
			announcementsMsg,
			nextDecreeMsg,
			// 👋welcome's intro and 📘rules' rules post, null where an adopted channel
			// already held the owner's content. Neither is pinned: both are read only.
			welcomeMsg,
			rulesMsg,
			// Second #command-center message: the standalone invite card (pitch +
			// Dero gif + Summon button), pinned separately from the command guide.
			inviteCardMsg,
			// The meeting room's card, /dero's Join, Leave and Status (2026-10 item 245).
			meetingVoiceMsg,
			commandOutputMsg,
		] = await Promise.all([
			// intro channel carries both the introduction embed AND the
			// "Summon me to your server, Mortal" link button. Components
			// travel alongside embeds on send; refreshIntroEmbeds must
			// also pass components on edit or Discord will drop the row.
			introChannel.send({
				embeds: [ChannelContent.introduction(copyConfig)],
				components: GuildSetupManager.resolveIntroComponents("introChannelId", copyConfig) ?? [],
				files: GuildSetupManager.resolveIntroFiles("introChannelId"),
			}),
			// Initial post includes the Suggestion Box button row so the
			// pin carries the member-clickable surface from minute one.
			// resolveIntroComponents returns the same row for refresh
			// reposts on subsequent boots; keep both call sites aligned.
			commandsChannel.send({ embeds: [ChannelContent.commandGuide(copyConfig)], components: GuildSetupManager.resolveIntroComponents("commandsChannelId", copyConfig) ?? [] }),
			leaderboardChannel.send({ embeds: [ChannelContent.leaderboardIntro(copyConfig)] }),
			scheduleChannel.send({ embeds: [ChannelContent.scheduleIntro(copyConfig)] }),
			announcementsChannel.send({ embeds: [ChannelContent.announcementsIntro(copyConfig)] }),
			// Pinned header above the NextUpBoard posts. Pinning is best
			// effort (see schedule channel block below). The message id
			// is persisted on introMessageIds.nextDecreeChannelId so
			// refreshIntroEmbeds edits it in place on every boot.
			nextDecreeChannel.send({ embeds: [ChannelContent.nextDecreeIntro(copyConfig)] }),
			postIntroUnlessOwnerContent(welcomeChannel, "welcomeChannelId"),
			postIntroUnlessOwnerContent(rulesChannel, "rulesChannelId"),
			// Standalone invite card in #command-center: short pitch + Dero gif + the
			// Summon button. Its own message so the wide button is not crammed into
			// the command guide's row. refreshIntroEmbeds maintains it on boot.
			commandsChannel.send({
				embeds: [ChannelContent.inviteCard(copyConfig)],
				components: GuildSetupManager.inviteCardComponents(copyConfig),
				files: [buildDeroGifAttachment()],
			}),
			meetingVoiceChannel.send({ embeds: [ChannelContent.voiceRoomIntro(copyConfig)], components: GuildSetupManager.resolveIntroComponents("meetingVoiceChannelId", copyConfig) ?? [] }),
			commandOutputChannel.send({ embeds: [ChannelContent.commandOutputIntro(copyConfig)] }),
		]);

		// Pinning policy (2026-06): pin ONLY member-writable channels. The
		// introductions channel lets members post, so without a pin the welcome
		// would get buried under chatter. Every other homebase channel is read-only,
		// so the bot's message stays put with nothing to bury it, a pin there is
		// just noise. So we deliberately do NOT pin the schedule board, command
		// guide, next-decree intro, admin command guide, or invite card.
		// refreshIntroEmbeds enforces the same rule on boot via shouldBePinned.
		try {
			await introMsg.pin();
		} catch (error) {
			console.warn(LOG_MESSAGES.setup.pinScheduleIntroFailed(introChannel.guildId), error);
		}
		// 💬dero-commands is the other member-writable channel, so its intro is pinned too.
		try {
			await commandOutputMsg.pin();
		} catch (error) {
			console.warn(LOG_MESSAGES.setup.pinScheduleIntroFailed(commandOutputChannel.guildId), error);
		}

		return {
			scheduleMessageId: scheduleMessage.id,
			// mirrors the GuildConfig.introMessageIds keys so runAutoSetup can hand the
			// merged map straight into the persist payload without reshaping.
			introMessageIds: {
				introChannelId: introMsg.id,
				commandsChannelId: commandsMsg.id,
				leaderboardChannelId: leaderboardMsg.id,
				scheduleChannelId: scheduleMessage.id,
				announcementsChannelId: announcementsMsg.id,
				nextDecreeChannelId: nextDecreeMsg.id,
				// Null when an adopted channel already held the owner's own content.
				welcomeChannelId: welcomeMsg?.id ?? null,
				rulesChannelId: rulesMsg?.id ?? null,
				// Second pinned message in #command-center: the standalone invite card.
				inviteCardId: inviteCardMsg.id,
				meetingVoiceChannelId: meetingVoiceMsg.id,
				commandOutputChannelId: commandOutputMsg.id,
			},
		};
	}

	// 🎮 ARCADE GAMES' intros. Neither the rules card nor the challenge boards are pinned,
	// per the pinning policy: both channels are read-only for members, so there is
	// nothing to bury the bot's message under. 🏪dero-market is the exception below.
	private static async postArcadeIntros(discordChannels: IArcadeChannelObjects, copyConfig: ICopyConfig | null): Promise<Record<string, string>> {
		const { arcadeRulesChannel, arcadeChallengesChannel, arcadeGamesChannel, partyGamesChannel, arcadeRatedChallengesChannel, deroMarketChannel, arcadeVoiceChannel } = discordChannels;
		const [arcadeRulesMsg, arcadeChallengesMsg, arcadeGamesMsgs, partyGamesMsg, arcadeRatedChallengesMsg, deroMarketMsg, arcadeVoiceMsg] = await Promise.all([
			arcadeRulesChannel.send({ embeds: [ChannelContent.arcadeRulesIntro(copyConfig)], components: GuildSetupManager.resolveIntroComponents("arcadeRulesChannelId", copyConfig) ?? [] }),
			arcadeChallengesChannel.send({ embeds: [ChannelContent.arcadeChallengesIntro(copyConfig)], components: GuildSetupManager.resolveIntroComponents("arcadeChallengesChannelId", copyConfig) ?? [] }),
			// 🕹️games' two messages, chained rather than two entries in this Promise.all: the
			// Challenge Board has to land BELOW the intro, and two parallel sends to one
			// channel arrive in either order.
			arcadeGamesChannel
				.send({ embeds: [ChannelContent.arcadeGamesIntro(copyConfig)], components: GuildSetupManager.resolveIntroComponents("arcadeGamesChannelId", copyConfig) ?? [] })
				.then(async (intro) => ({ intro, board: await arcadeGamesChannel.send(GuildSetupManager.gamesBoardContent(copyConfig)) })),
			// 🎉party-games' intro with the admin host and schedule buttons.
			partyGamesChannel.send({ embeds: [ChannelContent.partyGamesIntro(copyConfig)], components: GuildSetupManager.resolveIntroComponents("partyGamesChannelId", copyConfig) ?? [] }),
			// 🏆rated-challenges' intro, a one line card like ⚔️challenges'.
			arcadeRatedChallengesChannel.send({ embeds: [ChannelContent.arcadeRatedChallengesIntro(copyConfig)] }),
			// 🏪dero-market's intro with Buy coins and Sell coins, pinned below.
			deroMarketChannel.send({ embeds: [ChannelContent.deroMarketIntro(copyConfig)], components: GuildSetupManager.resolveIntroComponents("deroMarketChannelId", copyConfig) ?? [] }),
			// The lounge's card, /dero's Join, Leave and Status (2026-10 item 245).
			arcadeVoiceChannel.send({ embeds: [ChannelContent.voiceRoomIntro(copyConfig)], components: GuildSetupManager.resolveIntroComponents("arcadeVoiceChannelId", copyConfig) ?? [] }),
		]);

		// 🏪dero-market is read only, but every finished trade posts there and would bury
		// the panel, so its intro is pinned like the member-writable ones (refreshIntroEmbeds agrees).
		try {
			await deroMarketMsg.pin();
		} catch (error) {
			console.warn(LOG_MESSAGES.setup.pinScheduleIntroFailed(deroMarketChannel.guildId), error);
		}

		return {
			arcadeRulesChannelId: arcadeRulesMsg.id,
			arcadeChallengesChannelId: arcadeChallengesMsg.id,
			// 🕹️games' intro, and its second message, the Challenge Board.
			arcadeGamesChannelId: arcadeGamesMsgs.intro.id,
			arcadeGamesBoardId: arcadeGamesMsgs.board.id,
			partyGamesChannelId: partyGamesMsg.id,
			arcadeRatedChallengesChannelId: arcadeRatedChallengesMsg.id,
			deroMarketChannelId: deroMarketMsg.id,
			arcadeVoiceChannelId: arcadeVoiceMsg.id,
		};
	}

	// 🏰 DERO HEADQUARTERS' intros. None is pinned: only admins and Dero post there.
	private static async postHeadquartersIntros(
		guild: Guild,
		discordChannels: IHeadquartersChannelObjects,
		adminRoleId: string | null,
		copyConfig: ICopyConfig | null
	): Promise<Record<string, string>> {
		const { adminChannel, adminLogChannel, deroConfigChannel, onboardingConfigChannel, arcadeControlChannel, serverConfigChannel } = discordChannels;
		const [adminMsg, adminLogMsg, deroConfigMsg, onboardingConfigMsg, arcadeControlMsg, serverConfigMsg] = await Promise.all([
			// The welcome when a forced rebuild granted the stored admin role, the pending
			// card on a fresh install, through the one resolver refreshIntroEmbeds also reads,
			// so the boot refresh never replaces a welcome with a pending card or the reverse
			// (2026-10 item 272).
			adminChannel.send({
				embeds: [GuildSetupManager.resolveIntroEmbed("adminChannelId", guild, adminRoleId, copyConfig) ?? ChannelContent.adminPending(copyConfig)],
				components: GuildSetupManager.resolveIntroComponents("adminChannelId", copyConfig) ?? [],
			}),
			// 🗒️admin-log's header, edited in place on later boots like every intro.
			adminLogChannel.send({ embeds: [ChannelContent.adminLogIntro(copyConfig)] }),
			deroConfigChannel.send({ embeds: [ChannelContent.deroConfigIntro(copyConfig)] }),
			onboardingConfigChannel.send({ embeds: [ChannelContent.onboardingConfigIntro(copyConfig)] }),
			arcadeControlChannel.send({ embeds: [ChannelContent.arcadeControlIntro(copyConfig)] }),
			serverConfigChannel.send({ embeds: [ChannelContent.serverConfigIntro(copyConfig)] }),
		]);
		return {
			adminChannelId: adminMsg.id,
			adminLogChannelId: adminLogMsg.id,
			deroConfigChannelId: deroConfigMsg.id,
			onboardingConfigChannelId: onboardingConfigMsg.id,
			arcadeControlChannelId: arcadeControlMsg.id,
			serverConfigChannelId: serverConfigMsg.id,
		};
	}

	// ── intro embed refresh on boot ──────────────────────────────
	// What:  for each of the six homebase channels, edit the stored intro
	//        message in place so a restarted bot ships updated copy from
	//        the copy packs (@base/copy/packs) without forcing the operator to rebuild the
	//        homebase. If the stored message is missing, repost a fresh
	//        intro and persist the new id.
	// Who:   main.ts calls this inside the Events.ClientReady handler once
	//        per guild, AFTER ensureHomebase has run (so we never edit a
	//        channel that is about to be rebuilt).
	// When:  once per guild per process boot. Returns a summary so the
	//        caller can log aggregate numbers without knowing the per channel
	//        branches.
	// Where: paired with populateChannels. populateChannels writes the ids,
	//        refreshIntroEmbeds reads them and either edits or reposts.
	// How:   ① read fresh GuildConfig. bail if missing (ensureHomebase will
	//           have caught this already).
	//        ② for each spec, look up the stored message id under
	//           introMessageIds[spec.configField]. if null → no anchor yet
	//           (legacy row built before this field existed). treat like
	//           "stored message deleted" and repost a fresh intro.
	//        ③ fetch the channel and the message. on Discord 10008 (Unknown
	//           Message) or 10003 (Unknown Channel), repost + persist.
	//        ④ on 50005 (Cannot edit message authored by another user), we
	//           do NOT repost. That error means our stored id points at a
	//           foreign message, corruption case; leave it for the next
	//           ensureHomebase pass to sort out.
	//        ⑤ edit in place with the current embed. swallow transient
	//           errors (rate limit, outage) so one bad channel does not
	//           block the other five.
	static async refreshIntroEmbeds(client: Client, guild: Guild): Promise<{ edited: number; reposted: number }> {
		console.log(LOG_MESSAGES.setup.introRefreshStarted(guild.id));

		const stored = (await guildConfigStore.findByGuildId(guild.id)) as
			| (Record<string, unknown> & {
					adminRoleId?: string | null;
					introMessageIds?: Partial<Record<(typeof GuildSetupManager.CHANNEL_FIELDS)[number], string | null>> | null;
			  })
			| null;
		if (!stored) {
			// no config → ensureHomebase already owns this case. nothing to
			// refresh. zeroed summary keeps the caller's log tidy.
			console.log(LOG_MESSAGES.setup.introRefreshDone(guild.id, 0, 0));
			return { edited: 0, reposted: 0 };
		}

		let edited = 0;
		let reposted = 0;
		// mutate a local copy of introMessageIds as we go so reposts that
		// need a persist can be batched at the end. keeps DB writes to one
		// per guild in the common case.
		// Cast is necessary because the shared Partial<Record<CHANNEL_FIELDS,...>>
		// type on `stored.introMessageIds` does not include the flat
		// non-channel keys we have added (adminCommandGuideId). Accessing
		// it through `Record<string, string | null | undefined>` gives us
		// a runtime-safe read without widening the declared type.
		const storedIntroIds = (stored.introMessageIds ?? {}) as Record<string, string | null | undefined>;
		const nextIntroIds: Record<string, string | null> = {
			// ⚠️ DERIVED FROM CHANNEL_FIELDS, NOT HAND LISTED, and that change is a
			// bug fix rather than tidying. The loop below reads its anchor out of
			// THIS object (`nextIntroIds[spec.configField]`), so a channel missing
			// from here resolves to undefined on EVERY boot, is read as "nothing
			// posted yet", and gets its intro REPOSTED forever. Nothing errors and
			// the id even persists correctly; the initializer simply never reads it
			// back. That is the exact failure risk R1 describes, and it is not
			// hypothetical: both ARCADE GAMES cards did it the moment their specs
			// joined CHANNEL_SPECS, because this literal had not grown with them.
			// Deriving it means channel eleven cannot repeat the trick.
			//
			// Legacy rows load a null for any channel added after they were written.
			// That is correct and self healing: the loop treats a null anchor as
			// "post it once", then persists the new id.
			//
			// Derived from the specs, voice rooms included since they gained their
			// intro (2026-10 item 245 Phase 4b); introMessageIds declares a slot for
			// each, so the anchor persists like every other channel's.
			...Object.fromEntries(
				GuildSetupManager.CHANNEL_SPECS.map((spec) => [spec.configField, storedIntroIds[spec.configField] ?? null])
			),
			// The FLAT keys stay explicit, because they are not a channel's own
			// intro and so are deliberately absent from CHANNEL_FIELDS.
			// Flat key for the standalone invite card (second message in
			// #command-center). null on legacy rows; the invite-card block below
			// posts it the first time and persists the id.
			inviteCardId: storedIntroIds.inviteCardId ?? null,
			// Flat key for 🕹️games' second message, the Challenge Board. null on every
			// row until the board is first posted; the games board block below keeps it.
			arcadeGamesBoardId: storedIntroIds.arcadeGamesBoardId ?? null,
		};
		let needsPersist = false;
		// Set when this sweep posts a FRESH 🕹️games intro, so the board block below
		// posts a fresh board beneath it rather than keep the old one above it.
		let gamesIntroPosted = false;
		// The Headquarters config channels whose intro this pass posted fresh, so their
		// steps card and chart go fresh beneath it (2026-10 item 257 Phase 2b).
		const freshIntroFields = new Set<string>();
		const adoptedIds = readAdoptedChannelIds(stored);

		for (const spec of GuildSetupManager.CHANNEL_SPECS) {
			const channelId = stored[spec.configField] as string | null | undefined;
			if (!channelId) continue;

			// Resolved BEFORE the fetch so a channel with no intro is skipped quietly.
			const embed = GuildSetupManager.resolveIntroEmbed(spec.configField, guild, stored.adminRoleId ?? null, stored as unknown as ICopyConfig);
			if (!embed) continue;

			const channel = await client.channels.fetch(channelId).catch(() => null);
			if (!channel) {
				console.warn(LOG_MESSAGES.setup.introRefreshChannelMissing(spec.displayName, guild.id));
				continue;
			}
			// A voice room's built in text chat takes messages like a text channel, so
			// both kinds pass; anything else under a managed id is the wrong type.
			if (!(channel instanceof TextChannel || channel instanceof VoiceChannel)) {
				console.warn(LOG_MESSAGES.setup.introRefreshChannelWrongType(spec.displayName, guild.id));
				continue;
			}

			// Components (eg. the introductions channel's invite button)
			// must be passed explicitly on send, omitting them would
			// silently strip the invite button on every repost.
			// resolveIntroComponents returns null for the channels that
			// have no component surface; we pass `[]` in that case so
			// the send call is explicit about "no components."
			const componentRows = GuildSetupManager.resolveIntroComponents(spec.configField, stored as unknown as ICopyConfig);
			const storedMessageId = nextIntroIds[spec.configField];

			// ── schedule channel exception: edit-in-place ──────────
			// The pinned schedule board is the one place the owner
			// granted permission to keep editing (see 2026-04-24
			// "never edit, never delete" policy). ScheduleBoard.ts
			// owns the actual board content; refreshIntroEmbeds only
			// needs to make sure the intro/anchor message is pinned.
			// For schedule we do NOT apply the diff+post flow below.
			if (spec.configField === "scheduleChannelId") {
				if (storedMessageId) {
					try {
						const message = await channel.messages.fetch(storedMessageId);
						await message.edit({ embeds: [embed], components: componentRows ?? [] });
						// No pin: schedule channel is read-only (2026-06 pinning policy).
						edited += 1;
					} catch (error) {
						// Anchor missing or corrupted, let the schedule
						// board's own postOrEdit flow handle it on its
						// next refresh. We do NOT post a new intro here
						// because that would compete with ScheduleBoard's
						// own recovery path.
						const code = error instanceof DiscordAPIError ? error.code : null;
						if (code === 10008 || code === 10003) {
							console.warn(LOG_MESSAGES.setup.introRefreshReposting(spec.displayName, guild.id));
						} else {
							console.warn(LOG_MESSAGES.setup.introRefreshEditFailed(spec.displayName, guild.id), error);
						}
					}
				}
				continue;
			}

			// ── post-on-change policy for every OTHER spec ─────────
			// Owner's rule (2026-04-24): never edit, never delete
			// messages in intro channels. When copy changes, post a
			// NEW message below the old one, unpin the old, pin the
			// new. The old message remains in channel history so the
			// audit trail is preserved. Diff check prevents noise on
			// boots where nothing actually changed.
			//
			// Schedule channel is the only exception (handled above).
			// One narrow exception to "never edit" since 2026-10 item 245 Phase 4a, by the
			// owner's decision: a superseded intro in 📋arcade-rules or ⚔️challenges loses
			// the buttons that moved to 🕹️games (stripMovedArcadeControls). Its copy stays.

			// Which channels should have their intro pinned at all?
			// These are the channels where the intro is a permanent
			// reference a mortal or admin might scroll back to.
			// Pin ONLY member-writable channels, just introductions. Every other
			// homebase channel is read-only, so the bot's message stays put with
			// nothing to bury it and a pin is just noise (see populateChannels).
			// The two member-writable channels: introductions and 💬dero-commands.
			// 🏪dero-market is the third: members never type there, but every finished trade
			// posts there and would bury the panel its two buttons ride on.
			const shouldBePinned = spec.configField === "introChannelId" || spec.configField === "commandOutputChannelId" || spec.configField === "deroMarketChannelId";

			// Try to fetch the stored message. If present, compare its
			// embed to the fresh one; if equivalent, we are done for
			// this spec.
			let storedMessage: Message | null = null;
			if (storedMessageId) {
				storedMessage = await channel.messages.fetch(storedMessageId).catch(() => null);
				if (storedMessage && GuildSetupManager.embedsAreEquivalent(embed, storedMessage.embeds[0])) {
					// Embed copy is unchanged. Buttons might still have moved (the
					// 2026-06 controls fold-in relocated power-up buttons onto these
					// guides). A button relocation is not a copy change, so when the
					// components drift we refresh them IN PLACE (edit, not repost, no
					// audit-trail message to preserve). embedsAreEquivalent ignores
					// components, so this is the only path that migrates existing guilds
					// to the new button layout.
					if (!GuildSetupManager.componentsAreEquivalent(componentRows, storedMessage.components)) {
						try {
							await storedMessage.edit({ embeds: [embed], components: componentRows ?? [], ...GuildSetupManager.introEditFiles(spec.configField) });
							edited += 1;
						} catch (error) {
							console.warn(LOG_MESSAGES.setup.introRefreshEditFailed(spec.displayName, guild.id), error);
						}
					}
					// Backfill pin if the invariant says this channel should be pinned
					// but the stored message somehow lost its pin.
					if (shouldBePinned && !storedMessage.pinned) {
						try {
							await storedMessage.pin();
						} catch (pinError) {
							console.warn(LOG_MESSAGES.setup.pinScheduleIntroFailed(guild.id), pinError);
						}
					}
					continue;
				}
			}

			// An adopted channel with no Dero intro tracked in it holds the owner's own
			// content until shown otherwise (2026-10 item 247 Phase 2): leave it alone
			// rather than post Dero's intro over the owner's welcome or rules. A tracked
			// intro proves Dero already posts there, so that case flows on as usual.
			if (!storedMessage && !(await GuildSetupManager.adoptedChannelAcceptsIntro(guild, channel, embed, adoptedIds))) continue;

			// Copy differs (or stored message is gone). Before posting
			// a brand new message, scan the last 20 bot-authored
			// messages in this channel for one whose embed already
			// matches the fresh copy. If found, adopt it, someone
			// (this bot on an earlier boot, a racing tick, etc.) has
			// already posted the current copy and we should not
			// duplicate it. This is the answer to question 4 in the
			// 2026-04-24 policy thread.
			const selfId = guild.client.user?.id;
			const recent = await channel.messages.fetch({ limit: 20 }).catch(() => null);
			const existingMatch = recent?.find((msg) => {
				if (!selfId || msg.author.id !== selfId) return false;
				if (msg.embeds.length === 0) return false;
				return GuildSetupManager.embedsAreEquivalent(embed, msg.embeds[0]);
			});

			if (existingMatch) {
				// Adopt the existing matching message. Persist its id,
				// ensure it is pinned when the spec calls for it, and
				// unpin the previously tracked message if it was pinned
				// and is no longer the canonical one.
				if (shouldBePinned && !existingMatch.pinned) {
					try {
						await existingMatch.pin();
					} catch (pinError) {
						console.warn(LOG_MESSAGES.setup.pinScheduleIntroFailed(guild.id), pinError);
					}
				}
				if (storedMessage && storedMessage.id !== existingMatch.id && storedMessage.pinned) {
					try {
						await storedMessage.unpin();
					} catch (unpinError) {
						console.warn(LOG_MESSAGES.setup.introRefreshEditFailed(spec.displayName, guild.id), unpinError);
					}
				}
				nextIntroIds[spec.configField] = existingMatch.id;
				needsPersist = true;
				edited += 1;
				edited += await GuildSetupManager.stripMovedArcadeControls(spec.configField, [storedMessage, ...(recent?.values() ?? [])], {
					keepId: existingMatch.id,
					selfId,
					guildId: guild.id,
				});
				continue;
			}

			// Genuinely new content. Post a fresh message, unpin the
			// old (if pinned), pin the new, persist. If the post
			// fails, log and bail, we do NOT fall back to editing
			// because the owner's policy forbids it. Next boot will
			// retry cleanly.
			try {
				const message = await channel.send({ embeds: [embed], components: componentRows ?? [], files: GuildSetupManager.resolveIntroFiles(spec.configField) });
				if (shouldBePinned) {
					try {
						await message.pin();
					} catch (pinError) {
						console.warn(LOG_MESSAGES.setup.pinScheduleIntroFailed(guild.id), pinError);
					}
				}
				// Unpin the previous anchor (if one existed AND it was
				// pinned) so only the newest canonical message wears
				// the pin. We do NOT delete the old message, it stays
				// in channel history per the "nothing hidden" policy.
				if (storedMessage && storedMessage.pinned) {
					try {
						await storedMessage.unpin();
					} catch (unpinError) {
						console.warn(LOG_MESSAGES.setup.introRefreshEditFailed(spec.displayName, guild.id), unpinError);
					}
				}
				nextIntroIds[spec.configField] = message.id;
				needsPersist = true;
				reposted += 1;
				if (spec.configField === "arcadeGamesChannelId") gamesIntroPosted = true;
				freshIntroFields.add(spec.configField);
				edited += await GuildSetupManager.stripMovedArcadeControls(spec.configField, [storedMessage, ...(recent?.values() ?? [])], {
					keepId: message.id,
					selfId,
					guildId: guild.id,
				});
			} catch (error) {
				// Post failure is the one place we MUST skip and retry
				// next boot. Do not delete anything, do not fall back
				// to editing. The old message stays in place, still
				// pinned, still tracked.
				console.warn(LOG_MESSAGES.setup.introRefreshEditFailed(spec.displayName, guild.id), error);
			}
		}

		// ── invite card (second pinned message in #command-center) ──
		// What:  a standalone "summon Dero" card, short pitch + Dero gif + the
		//        Summon button, kept as its own pinned message so the wide invite
		//        button is not buried in the command guide's button row.
		// Who:   every setup-complete guild on every boot.
		// When:  after the spec loop, so the command guide (which no longer carries
		//        the invite) is already refreshed and the adopt scan below cannot
		//        mistake the guide for the card.
		// How:   edit in place (a static brand card, not an audit trail). Adopt by
		//        the invite Link button if the stored id is gone so a flaky round
		//        trip cannot duplicate it. Post fresh on legacy guilds that predate
		//        the card (null stored id, no match).
		const cardChannelId = stored.commandsChannelId as string | null | undefined;
		if (cardChannelId) {
			const channel = await client.channels.fetch(cardChannelId).catch(() => null);
			if (channel instanceof TextChannel) {
				const cardEmbed = ChannelContent.inviteCard(stored as unknown as ICopyConfig);
				const cardComponents = GuildSetupManager.inviteCardComponents(stored as unknown as ICopyConfig);

				let cardMessage = nextIntroIds.inviteCardId
					? await channel.messages.fetch(nextIntroIds.inviteCardId).catch(() => null)
					: null;

				if (!cardMessage) {
					// Adopt by EMBED identity, not just "has a Link button": on a legacy
					// guild the command guide transiently still carries the invite button
					// until the spec loop strips it above, and that strip edit is best
					// effort, if it failed, a button-only match would mis-adopt and then
					// clobber the command guide. The invite card's embed (distinct title +
					// image) is the safe, unambiguous key.
					const selfId = guild.client.user?.id;
					const recent = await channel.messages.fetch({ limit: 20 }).catch(() => null);
					cardMessage =
						recent?.find((msg) => (!selfId || msg.author.id === selfId) && GuildSetupManager.embedsAreEquivalent(cardEmbed, msg.embeds[0])) ?? null;
				}

				if (cardMessage) {
					// Refresh copy/components in place if drifted; backfill the pin.
					const drift =
						!GuildSetupManager.embedsAreEquivalent(cardEmbed, cardMessage.embeds[0]) ||
						!GuildSetupManager.componentsAreEquivalent(cardComponents, cardMessage.components);
					if (drift) {
						try {
							// attachments: [] drops the old upload so the re-attached file
							// (attachment://) resolves to the fresh one rather than duplicating.
							await cardMessage.edit({ embeds: [cardEmbed], components: cardComponents, files: [buildDeroGifAttachment()], attachments: [] });
							edited += 1;
						} catch (error) {
							console.warn(LOG_MESSAGES.setup.introRefreshEditFailed("invite card", guild.id), error);
						}
					}
					// No pin: command-center is read-only (2026-06 pinning policy).
					if (nextIntroIds.inviteCardId !== cardMessage.id) {
						nextIntroIds.inviteCardId = cardMessage.id;
						needsPersist = true;
					}
				} else {
					// No card yet (legacy guild migrating onto this feature), post
					// and track (no pin: command-center is read-only).
					try {
						const message = await channel.send({ embeds: [cardEmbed], components: cardComponents, files: [buildDeroGifAttachment()] });
						nextIntroIds.inviteCardId = message.id;
						needsPersist = true;
						reposted += 1;
					} catch (error) {
						console.warn(LOG_MESSAGES.setup.introRefreshEditFailed("invite card", guild.id), error);
					}
				}
			}
		}

		// ── 🕹️games' second message, the Challenge Board ──────────────
		// After the spec loop, like the invite card, so the intro above it is already
		// current. This block is also what MOVES the board for an existing guild: the
		// start buttons used to ride the ⚔️challenges intro, which the loop above
		// reposts without them (never deleting the old one), and they reappear here.
		const gamesChannelId = stored.arcadeGamesChannelId as string | null | undefined;
		if (gamesChannelId) {
			const gamesChannel = await client.channels.fetch(gamesChannelId).catch(() => null);
			if (gamesChannel instanceof TextChannel) {
				const board = await GuildSetupManager.maintainGamesBoard(gamesChannel, {
					storedId: nextIntroIds.arcadeGamesBoardId,
					selfId: guild.client.user?.id,
					guildConfig: stored as unknown as ICopyConfig,
					forcePost: gamesIntroPosted,
				});
				if (board.outcome === "edited") edited += 1;
				if (board.outcome === "posted") reposted += 1;
				if (board.id !== nextIntroIds.arcadeGamesBoardId) {
					nextIntroIds.arcadeGamesBoardId = board.id;
					needsPersist = true;
				}
			}
		}

		if (needsPersist) {
			// single write captures every repost. update covers both the new
			// intro ids and, for a reposted schedule intro, the
			// scheduleMessageId (kept in sync so ScheduleBoard does not see
			// a dangling pointer).
			const update: Record<string, unknown> = { introMessageIds: nextIntroIds };
			if (nextIntroIds.scheduleChannelId && stored.introMessageIds?.scheduleChannelId !== nextIntroIds.scheduleChannelId) {
				update.scheduleMessageId = nextIntroIds.scheduleChannelId;
			}
			await guildConfigStore.update(guild.id, update);
		}

		// After the intros are current and stored, so a steps card never sits above its
		// intro. Fire and forget: the cards keep their own ids and log their own failures.
		void syncAllHeadquarters(guild, freshIntroFields);

		console.log(LOG_MESSAGES.setup.introRefreshDone(guild.id, edited, reposted));
		return { edited, reposted };
	}
}
