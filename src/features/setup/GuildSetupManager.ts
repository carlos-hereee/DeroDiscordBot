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
import { ISetupConfig, IAdminRoleConfig, ICreatedChannels, IChannelObjects, IEnsureHomebaseResult } from "./setup.types.js";
import { ChannelContent } from "./ChannelContent.js";
import { getPluginCopy, type ICopyConfig } from "@base/copy/getCopy.js";
import { buildSuggestionBoxButton } from "@features/suggestion-box/SuggestionBox.js";
import { buildSelfDestructButton } from "@features/setup/selfDestruct.js";
import { buildArcadeHostRow, buildHangmanCategoryStartRow } from "@features/games/arcadeHost.js";
import { buildPartyGamesRow } from "@features/game-rooms/partyGames.js";
import { buildSoloLuckRow } from "@features/games/soloLuck.js";
import { boardStartRows } from "@features/game-rooms/challengeBoardEmbeds.js";
import { buildGameRequestRow } from "@features/game-rooms/gameRequestHandlers.js";
import { buildMemberControlButtons, buildAdminControlButtons, buildIcebreakerButton, buildFortuneButton, buildClaimButton, buildProfileButtons } from "@features/power-ups/PowerUps.js";
import { buildAdminCommandRows } from "@features/command-buttons/adminGuideButtons.js";
import { buildCommunityControlButtons } from "@features/community/communityButtons.js";
import { isCommunityEnabled } from "@features/community/enableCommunity.js";
import { buildVoiceRoomControlRow } from "@features/voice/voiceRoomControls.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { buildDeroGifAttachment } from "@base/copy/brand.js";
import {
	communityOverwritesFor,
	dependsOnCommunityState,
	isMemberRoleGated,
	memberRoleGrant,
	overwriteKindOf,
	reconcileChannelOverwrite,
	type ManagedOverwriteKind,
} from "./communityOverwrites.js";
import { CommunityGatingAnnouncement } from "./CommunityGatingAnnouncement.js";
import { fetchAcceptsDeroContent, findWelcomeChannel, moveIntoNoticeBoard, readAdoptedChannelIds, scanAndClaim, type IWelcomeCandidate } from "./adoption.js";
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

const { channels } = rokCommanderCopy.setup;

// What: compose the home base category name, appending the dev suffix
//       when NODE_ENV === "development".
// Who:  autoSetup callers. ensures a dev instance sharing a guild with
//       prod creates a visually distinct category instead of colliding.
// When: once per autoSetup call. evaluated at runtime, not module load,
//       so env changes between runs are respected.
// Where: the copy packs (@base/copy/packs) own the base name and suffix
//        string. this helper owns the env branching so the pack stays free
//        of environment logic.
// How:   plain string concat. devSuffix is an empty string in prod or any
//        non-development value, so we could always concat, but the env
//        check keeps the production name pristine.
function resolveCategoryName(): string {
	return process.env.NODE_ENV === "development"
		? rokCommanderCopy.setup.categoryName + rokCommanderCopy.setup.devSuffix
		: rokCommanderCopy.setup.categoryName;
}

// The SECOND managed category, holding the game rules card and the challenge
// board. Deliberately a sibling of resolveCategoryName rather than a parameter
// on it: both read the same devSuffix and must branch on env identically, and a
// dev instance that suffixed one category but not the other would collide with
// prod on exactly one of them, which is the confusing half of that bug.
//
// Reads rokCommanderCopy directly, matching resolveCategoryName, because the
// category name is universal across packs by the 2026-05-22 decision. If it ever
// stops being universal, BOTH helpers become pack aware together.
function resolveGamesCategoryName(): string {
	return process.env.NODE_ENV === "development"
		? rokCommanderCopy.setup.gamesCategoryName + rokCommanderCopy.setup.devSuffix
		: rokCommanderCopy.setup.gamesCategoryName;
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

	static async autoSetup(guild: Guild, config: ISetupConfig, options: { force?: boolean } = {}): Promise<void> {
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

	private static async runAutoSetup(guild: Guild, config: ISetupConfig, options: { force?: boolean } = {}): Promise<void> {
		const existing = await guildConfigStore.findByGuildId(config.guildId);
		// default behavior: if a row exists, assume the homebase is already
		// constructed (by this bot) and skip. ensureHomebase is the only
		// caller that knows the row is stale or foreign and sets force to
		// bypass. A "stale" row means the category or channels were deleted
		// in Discord but the row in our DB still points at those dead ids,
		// we want to refresh the ids on THAT row, not insert a second one.
		if (existing?.categoryId && !options.force) return;

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
		const existingArcade = await GuildSetupManager.findExistingArcadeCategory(guild, storedArcadeId);
		if (existingArcade === "unreachable") return;

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
		let category;
		try {
			category = await guild.channels.create({
				name: resolveCategoryName(),
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

		// A null return means a 50013 already routed through handlePermissionFailure,
		// so bail exactly as the homebase category create above does.
		const gamesCategory = existingArcade ?? (await GuildSetupManager.createArcadeCategory(guild, config.ownerId));
		if (!gamesCategory) return;

		// The voice rooms are the one posture that names a role (owner decision D3,
		// member role only), so a forced rebuild of a guild that already ran /setup
		// threads its stored roles through and the rebuilt rooms open to members at
		// once instead of waiting for /setup to run again. Both null on a fresh install.
		const storedRoles = { memberRoleId: existing?.memberRoleId ?? null, adminRoleId: existing?.adminRoleId ?? null };
		// The stored row rides along twice: createChannels' adoption scan must not take
		// a channel that already fills another slot, and the rules post keeps the
		// owner's saved rules through a forced rebuild.
		const storedRow = existing as unknown as (Record<string, unknown> & IRulesConfig) | null;
		const { ids, objects, adoptedChannelIds } = await GuildSetupManager.createChannels(guild, category, gamesCategory, config, storedRoles, storedRow);
		const { scheduleMessageId, introMessageIds } = await GuildSetupManager.populateChannels(guild, objects, { adoptedChannelIds, rulesConfig: storedRow });

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
		//        the repaired homebase.
		// Where: path A's create is wrapped in a duplicate-key guard for the
		//        shared cluster misconfig case (dev bot running against the
		//        same MongoDB collection as prod). We REFUSE to overwrite a
		//        foreign row; the Discord side is already built so the least
		//        bad outcome is that the bot logs loudly and bails on persist.
		const persistPayload = {
			categoryId: category.id,
			introChannelId: ids.introChannelId,
			commandsChannelId: ids.commandsChannelId,
			leaderboardChannelId: ids.leaderboardChannelId,
			scheduleChannelId: ids.scheduleChannelId,
			announcementsChannelId: ids.announcementsChannelId,
			adminChannelId: ids.adminChannelId,
			// ⚠️ EVERY ID createChannels RETURNS IS STORED HERE, NO EXCEPTIONS, and
			// the exception this payload used to carry is why that is worth stating.
			// 🔜upcoming-events was built alongside the others but its id was left
			// out, so the row held null until the NEXT boot, when the repair sweep's
			// adopt-before-build scan found the orphan channel and persisted it. The
			// channel existed the whole time; only the pointer was missing, and
			// NextUpBoard reads that pointer, bails on null, and posts nothing. Every
			// guild therefore had a dead 🔜upcoming-events between /setup and its
			// first reboot. Closed 2026-08-12; the sweep still adopts for genuinely
			// legacy rows (case ③ in repairMissingChannels), it is just no longer
			// load bearing for a fresh install.
			nextDecreeChannelId: ids.nextDecreeChannelId,
			// Keys the admin power-up panel, so ensurePowerUps can post as soon as
			// /setup runs rather than waiting for a reboot.
			adminCommandsChannelId: ids.adminCommandsChannelId,
			// The audit trail, so the first admin action after /setup already has a home.
			adminLogChannelId: ids.adminLogChannelId,
			// 👋welcome and 📘rules, and which of the two (if either) the server already
			// had. Replaced, not merged: a build re-derives every adoption, and an id from
			// a prior build points at a channel this one either re-adopted or never saw.
			welcomeChannelId: ids.welcomeChannelId,
			rulesChannelId: ids.rulesChannelId,
			adoptedChannelIds,
			// ── 🎮 ARCADE GAMES ──
			gamesCategoryId: ids.gamesCategoryId,
			arcadeRulesChannelId: ids.arcadeRulesChannelId,
			arcadeChallengesChannelId: ids.arcadeChallengesChannelId,
			arcadeGamesChannelId: ids.arcadeGamesChannelId,
			partyGamesChannelId: ids.partyGamesChannelId,
			// ── the two voice rooms (2026-10 item 235) ──
			meetingVoiceChannelId: ids.meetingVoiceChannelId,
			arcadeVoiceChannelId: ids.arcadeVoiceChannelId,
			// v1.5.1 item 9: clear any previously-tracked permission failure
			// so a guild that recovered from missing-permissions state stops
			// being on the auto-leave countdown. Safe to set unconditionally
			// because Mongo treats setting null to an already-null field as
			// a no-op.
			firstPermissionFailureAt: null,
			// scheduleMessageId anchors the pinned schedule board that
			// ScheduleBoard.refreshSchedule keeps up to date. see
			// src/features/schedule/ScheduleBoard.ts for the lifecycle.
			scheduleMessageId,
			// introMessageIds anchors every other intro embed so
			// refreshIntroEmbeds can edit them in place on subsequent boots
			// when the copy packs (@base/copy/packs) change. This is the field that
			// makes "rebuild the bot copy without nuking the homebase"
			// possible.
			introMessageIds,
		};

		if (existing) {
			// path B, in place update of our existing row. Phase 2 state
			// (adminRoleId, memberRoleId, setupComplete) is intentionally
			// not overwritten so a repair preserves it.
			await guildConfigStore.update(config.guildId, persistPayload);
			return;
		}

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

		// ② category gone? null from fetch catch, or a Discord 10003 on the
		//    direct fetch path. Either way the stored homebase doesn't exist.
		const category = await guild.channels.fetch(stored.categoryId).catch(() => null);
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
			await GuildSetupManager.rebuildFromStaleConfig(guild);
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
		const desiredCategoryName = resolveCategoryName();
		if (category instanceof CategoryChannel && category.name !== desiredCategoryName) {
			const previousName = category.name;
			try {
				await category.edit({ name: desiredCategoryName });
				console.log(`[ensureHomebase] renamed category in guild ${guild.id} from "${previousName}" to "${desiredCategoryName}"`);
			} catch (error) {
				console.warn(`[ensureHomebase] failed to rename category in guild ${guild.id} to "${desiredCategoryName}"`, error);
			}
		}

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
		// eighth homebase channel. admin-only command + control surface:
		// the relocated admin command guide (out of inner-sanctum) plus the
		// admin power-up panel. kept separate so daily inner-sanctum notices
		// never bury the quick-action controls.
		"adminCommandsChannelId",
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
		// ── the two VOICE rooms, one under each category (2026-10 item 235) ──
		// They widen the resolveIntroEmbed switch like every other field; each
		// carries the small /dero card in its text chat (2026-10 item 245 Phase 4b).
		"meetingVoiceChannelId",
		"arcadeVoiceChannelId",
	] as const;

	// exported so ChannelDeleteWatcher can map a deleted channel id to its
	// spec without re declaring the list. Keep in sync with CHANNEL_FIELDS.
	static readonly CHANNEL_SPECS: Array<{
		configField: (typeof GuildSetupManager.CHANNEL_FIELDS)[number];
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
		categoryField: "categoryId" | "gamesCategoryId";
	}> = [
		{ configField: "introChannelId", displayName: channels.intro, kind: "public", categoryField: "categoryId" },
		// Commands channel is read-only for members on purpose. The pinned
		// command-center embed is the channel's reason for existing; opening
		// SendMessages here would let unrelated chatter bury that message.
		// Slash commands work in any channel anyway, so locking this one
		// down does not block functionality.
		{ configField: "commandsChannelId", displayName: channels.commands, kind: "public", categoryField: "categoryId" },
		{ configField: "leaderboardChannelId", displayName: channels.leaderboard, kind: "public", categoryField: "categoryId" },
		{ configField: "scheduleChannelId", displayName: channels.schedule, kind: "public", categoryField: "categoryId" },
		{ configField: "announcementsChannelId", displayName: channels.announcements, kind: "public", categoryField: "categoryId" },
		{ configField: "adminChannelId", displayName: channels.admin, kind: "admin", categoryField: "categoryId" },
		// 🛡️ seventh, next-decree. public so mortals see the board
		// posts, bot only writes (the category level overwrites already
		// gate SendMessages for "public" kind).
		{ configField: "nextDecreeChannelId", displayName: channels.nextDecree, kind: "public", categoryField: "categoryId" },
		// 🛡️ eighth, admin command center. admin-only (same gating as the
		// admin channel); hosts the command guide + admin power-up panel.
		{ configField: "adminCommandsChannelId", displayName: channels.adminCommands, kind: "admin", categoryField: "categoryId" },
		// 🗒️ the audit trail (post-launch plan item 11). ⚠️ THIS LINE ARMS THE BOOT
		// REPAIR SWEEP for every existing guild, the way the welcome and arcade specs
		// did: a legacy row loads adminLogChannelId as null, the sweep reads null as
		// case ③ "missing, build it", and the channel appears once on the next boot.
		// Its own kind, because it is the one channel nobody but the bot may post in.
		{ configField: "adminLogChannelId", displayName: channels.adminLog, kind: "adminLog", categoryField: "categoryId" },

		// ── 👋welcome and 📘rules (2026-10 item 247 Phase 2) ──
		// ⚠️ THESE TWO LINES ARM THE BOOT REPAIR SWEEP for every existing guild, the way
		// the arcade and voice specs did: a legacy row loads both ids as null, the sweep
		// reads null as case ③ "missing", and the next boot gives each guild its own.
		// Unlike every spec above, the missing channel may already EXIST under another
		// name: repairOneChannel and createChannels first look for the server's own
		// welcome or rules channel (ADOPTION_PATTERNS below) and adopt it into the
		// notice board, and only build when there is none. Members read both, the bot
		// writes: the join log is Dero's ledger and the rules post is a reference.
		{ configField: "welcomeChannelId", displayName: channels.welcome, kind: "public", categoryField: "categoryId" },
		{ configField: "rulesChannelId", displayName: channels.rules, kind: "public", categoryField: "categoryId" },

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
		{ configField: "arcadeRulesChannelId", displayName: channels.arcadeRules, kind: "public", categoryField: "gamesCategoryId" },
		{ configField: "arcadeChallengesChannelId", displayName: channels.arcadeChallenges, kind: "public", categoryField: "gamesCategoryId" },
		// 🕹️games (2026-10 item 245 Phase 4a). ⚠️ THIS LINE ARMS THE BOOT REPAIR SWEEP
		// for every existing guild, exactly as the two above once did: a legacy row
		// loads arcadeGamesChannelId as null, the sweep reads null as case ③ "missing,
		// build it", and the channel appears under 🎮 ARCADE GAMES on the next boot,
		// once, because the id is persisted the moment it is built. autoHealEnabled
		// false and userRemovedChannels both stop it, like every other spec. Public,
		// like its siblings: members press its buttons, the bot writes the messages.
		{ configField: "arcadeGamesChannelId", displayName: channels.arcadeGames, kind: "public", categoryField: "gamesCategoryId" },
		// 🎉party-games (post-launch plan item 3). ⚠️ THIS LINE ARMS THE BOOT REPAIR SWEEP
		// for every existing guild, like 🕹️games before it: a legacy row loads
		// partyGamesChannelId as null and the next boot builds it under 🎮 ARCADE GAMES,
		// once. "public" is the posture the plan asks for: members read and press its
		// buttons, the owner and the admin role may post, Dero writes the rounds.
		// arcadeSwitch reads the arcade's specs by category, so arcade off takes it too.
		{ configField: "partyGamesChannelId", displayName: channels.partyGames, kind: "public", categoryField: "gamesCategoryId" },

		// ── the two VOICE rooms (2026-10 item 235) ──
		// ⚠️ THESE ARM THE BOOT REPAIR SWEEP for every existing guild, by the owner's
		// decision D1: a legacy row loads both ids as null, the sweep reads null as
		// case ③ "missing, build it", and both rooms appear on the next boot, the
		// same way the arcade channels arrived. Each is filed under its own
		// category, which only categoryField and the spec test can enforce.
		// Plain voice channels, groundwork for meeting notes: nothing listens.
		{ configField: "meetingVoiceChannelId", displayName: channels.meetingVoice, kind: "voice", categoryField: "categoryId" },
		{ configField: "arcadeVoiceChannelId", displayName: channels.arcadeVoice, kind: "voice", categoryField: "gamesCategoryId" },
	];

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
			case "adminCommandsChannelId":
				// the relocated admin command guide is this channel's standard
				// pinned intro (was a second message in the admin channel before
				// the 2026-06-19 split). Self-destruct button rides along via
				// resolveIntroComponents.
				return ChannelContent.adminCommandGuide(guildConfig);
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
			// ── the voice rooms ──
			// One small card in each room's built in text chat, carrying /dero's
			// Join, Leave and Status (2026-10 item 245 Phase 4b, the owner's decision).
			// It is never pinned: a pin there would be the first thing every caller
			// scrolls past, and the card only has to be found by the people in the call.
			case "meetingVoiceChannelId":
			case "arcadeVoiceChannelId":
				return ChannelContent.voiceRoomIntro(guildConfig);
		}
	}

	// ── resolveIntroComponents ────────────────────────────────────
	// What:  returns the action row(s) that accompany a given channel's intro
	//        embed, or null if it has no buttons (the common case). The
	//        #command-center guide carries the member buttons, the admin-controls
	//        guide one button per admin command above its control row, and each
	//        voice room /dero's Join, Leave and Status (2026-10 item 245 Phase 4b).
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
	//        (the /account views, then the rest), the admin guide its command rows,
	//        then the community row, then the control row. null means "no buttons."
	private static resolveIntroComponents(
		field: (typeof GuildSetupManager.CHANNEL_FIELDS)[number],
		// Pack selector for the rows whose labels live in the copy packs (the rules
		// card's ballot button and 🕹️games' play now rows), read exactly the way
		// resolveIntroEmbed reads it: undefined is the rok-commander default, which is
		// correct on a first build.
		guildConfig?: ICopyConfig | null,
		// The live guild, read only for the admin guide's community row, which shows
		// Enable Community or Configure Onboarding by Discord's Community state. Absent
		// reads as Community off, which is every guild on its first build.
		guild?: Pick<Guild, "features"> | null
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
			case "adminCommandsChannelId":
				// admin-controls guide: two rows of admin command buttons (each opens its
				// command's own flow, gated at every step), the community row (Enable
				// Community or Configure Onboarding, whichever the live state calls for,
				// 2026-10 item 247 Phase 3 and post-launch plan item 8), then the
				// control row, the owner only Self destruct and the admin controls. Four
				// rows of Discord's five; the control row stays last, where the guide
				// test reads it.
				return [
					...buildAdminCommandRows(),
					// A partial guild (an unhydrated payload) carries no features, and reads as off.
					buildCommunityControlButtons(Boolean(guild?.features && isCommunityEnabled(guild))),
					new ActionRowBuilder<ButtonBuilder>().addComponents(buildSelfDestructButton(), ...buildAdminControlButtons()),
				];
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
	private static inviteCardComponents(): ActionRowBuilder<ButtonBuilder>[] {
		return [
			new ActionRowBuilder<ButtonBuilder>().addComponents(ChannelContent.buildInviteButton(), buildIcebreakerButton()),
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
	 * Adopt the server's own channel for one adoptable spec: find it, then move it
	 * into the notice board onto the public shape, or, for a welcome channel taken in
	 * place (findWelcomeChannel), leave it exactly where and as it is. Null when the
	 * spec is not adoptable, nothing matches, or the move failed, and the caller then
	 * builds Dero's own. `skipIds` are passed over too (the boot reconcile passes the
	 * slot's current channel, which is Dero's own).
	 */
	private static async adoptExistingChannel(
		guild: Guild,
		category: CategoryChannel,
		spec: (typeof GuildSetupManager.CHANNEL_SPECS)[number],
		stored: Record<string, unknown> | null,
		roles: { memberRoleId: string | null; adminRoleId: string | null },
		skipIds: readonly string[] = []
	): Promise<TextChannel | null> {
		const patterns = GuildSetupManager.ADOPTION_PATTERNS[spec.configField];
		if (!patterns) return null;
		const exclusions = {
			// A channel already filling another slot on this row is never taken for this one.
			ids: new Set([...GuildSetupManager.idsStoredOutside(stored, spec.configField), ...skipIds]),
			names: new Set([spec.displayName, GuildSetupManager.effectiveChannelName(stored, spec)]),
		};
		const candidate: IWelcomeCandidate | null =
			spec.configField === "welcomeChannelId"
				? findWelcomeChannel(guild, category, patterns, exclusions)
				: GuildSetupManager.asMovedCandidate(scanAndClaim(guild, category, patterns, exclusions));
		if (!candidate) return null;
		const match = candidate.channel;
		if (candidate.inPlace) {
			console.log(`[adoption] guild ${guild.id} adopted its system channel ${match.id} as ${spec.configField} in place`);
			GuildSetupManager.logAdoption(guild, spec.configField, match.id);
			return match;
		}
		try {
			const moved = await moveIntoNoticeBoard(match, category, communityOverwritesFor("public", guild, { ownerId: guild.ownerId }, roles));
			console.log(`[adoption] guild ${guild.id} adopted channel ${match.id} as ${spec.configField}${moved ? ", moved into the notice board" : ""}`);
			GuildSetupManager.logAdoption(guild, spec.configField, match.id);
			return match;
		} catch (error) {
			// A channel Dero cannot move (a 50013 on a channel the owner locked down) is
			// left where it is, and Dero builds its own: a working channel beside the
			// owner's beats a setup that throws on every boot.
			console.warn(`[adoption] guild ${guild.id} could not adopt channel ${match.id}; building ${spec.configField} instead`, error);
			return null;
		}
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

	private static asMovedCandidate(channel: TextChannel | null): IWelcomeCandidate | null {
		return channel ? { channel, inPlace: false } : null;
	}

	// The name a slot's channel carries: the /server channels rename override when one is set,
	// else the spec's default. Excluded from adoption alongside the default, so Dero
	// never adopts its own renamed channel as if the server had made it.
	private static effectiveChannelName(stored: Record<string, unknown> | null, spec: (typeof GuildSetupManager.CHANNEL_SPECS)[number]): string {
		const names = (stored as { channelNames?: Map<string, string> | Record<string, string> } | null)?.channelNames;
		const override = names instanceof Map ? names.get(spec.configField) : names?.[spec.configField];
		return override || spec.displayName;
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
	//        ③ adopt it (moved, or in place); ④ persist the slot, the adopted list and
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
	//           if the admin channel itself was the one repaired.
	static async repairOneChannel(
		guild: Guild,
		category: CategoryChannel,
		spec: (typeof GuildSetupManager.CHANNEL_SPECS)[number],
		stored: Record<string, unknown> & { adminRoleId?: string | null }
	): Promise<{ newChannel: TextChannel | VoiceChannel; stored: typeof stored }> {
		// ── adopt-before-build guard ───────────────────────────────
		// What:  before creating a brand new channel, scan the category
		//        for an existing text channel whose name matches this
		//        spec's displayName. If one exists, adopt it: persist
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
		// before falling back to spec.displayName. This is the rule the
		// streamer-feedback announcement promises: admin renames persist
		// across rebuilds. The Mongoose Map can be either a true Map (when
		// stored was hydrated as a document) or a plain object (when it was
		// .lean()'d upstream), so probe both shapes defensively.
		const channelNamesRaw = (stored as unknown as { channelNames?: Map<string, string> | Record<string, string> }).channelNames;
		const overrideName =
			channelNamesRaw instanceof Map
				? channelNamesRaw.get(spec.configField)
				: (channelNamesRaw as Record<string, string> | undefined)?.[spec.configField];
		const effectiveName = overrideName || spec.displayName;

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

		// merge so caller sees the fresh ids without a second round trip.
		return { newChannel, stored: { ...stored, ...update } };
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
		const introComponents = GuildSetupManager.resolveIntroComponents(spec.configField, guildConfig, guild);
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
	static async repairMissingChannels(client: Client, guild: Guild, category: CategoryChannel): Promise<string[]> {
		// re read the config here so we pick up the freshest admin role /
		// owner / channel ids. the caller only passed us the initial state.
		let stored = (await guildConfigStore.findByGuildId(guild.id)) as
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

		// ── the arcade category, resolved ONCE per sweep ────────────────
		// ⚠️ Cached in a local rather than read back off `stored`, and that is not
		// an optimization. The loop below reassigns `stored` from repairOneChannel's
		// return on every repair, which overwrites any gamesCategoryId written
		// here; the second arcade spec would then read null again and create a
		// SECOND category beside the first. A test caught exactly that.
		// `undefined` means not yet resolved, `null` means resolution failed
		// (50013, already reported) and the arcade specs are to be skipped.
		let arcadeCategory: CategoryChannel | null | undefined;

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
			let parent = category;
			if (spec.categoryField === "gamesCategoryId") {
				if (arcadeCategory === undefined) {
					const storedArcadeId = (stored as unknown as { gamesCategoryId?: string | null }).gamesCategoryId ?? null;
					arcadeCategory = await GuildSetupManager.resolveOrCreateArcadeCategory(guild, storedArcadeId, guild.ownerId);
					// Persist immediately when it was just built, so a guild that
					// crashes mid sweep does not create a second category next boot.
					if (arcadeCategory && arcadeCategory.id !== storedArcadeId) {
						await guildConfigStore.update(guild.id, { gamesCategoryId: arcadeCategory.id });
					}
				}
				// null means a 50013 already routed through handlePermissionFailure.
				// Skip the arcade specs rather than abandoning the sweep: the
				// homebase specs may still be repairable.
				if (!arcadeCategory) continue;
				parent = arcadeCategory;
			}

			try {
				const result = await GuildSetupManager.repairOneChannel(guild, parent, spec, stored);
				// refresh local stored so the next spec + the notice post
				// step below see the new ids. Notably: if the admin channel
				// was the one repaired, stored.adminChannelId now points at
				// the new channel which is exactly where we want the notice.
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
				repaired.push(overrideName || spec.displayName);
			} catch (error) {
				console.error(LOG_MESSAGES.setup.channelRepairFailed(spec.displayName, guild.id), error);
				// continue to next spec. one failure should not block the
				// others from being repaired.
			}
		}

		if (repaired.length === 0) return [];

		// stored.adminChannelId points at the latest (possibly just rebuilt)
		// inner sanctum, so notices never land in a deleted channel.
		await GuildSetupManager.postRepairNotices(client, guild.id, stored.adminChannelId, repaired);
		return repaired;
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
	// How:   expected = override || spec.displayName; rename only when the live name
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
			const expected = overrideName || spec.displayName;
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
		stored: { scheduleChannelId: string; scheduleMessageId?: string | null }
	): Promise<"owned" | "foreign" | "unknown"> {
		const selfId = client.user?.id;
		// No self id or no stored anchor → cannot disprove ownership. "unknown" so
		// the caller repairs in place instead of doing a destructive rebuild.
		if (!selfId) return "unknown";
		if (!stored.scheduleMessageId) return "unknown";

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
	private static async rebuildFromStaleConfig(guild: Guild): Promise<void> {
		await GuildSetupManager.autoSetup(guild, { guildId: guild.id, ownerId: guild.ownerId }, { force: true });
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

		// Both managed categories. The arcade one is nullable on every row written
		// before it existed.
		for (const field of ["categoryId", "gamesCategoryId"] as const) {
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
			await adminChannel.send({ embeds: [ChannelContent.adminWelcome(config.ownerId, config.adminRoleId, stored)] });
		}

		await guildConfigStore.update(config.guildId, {
			adminRoleId: config.adminRoleId,
			memberRoleId: config.memberRoleId,
			setupComplete: true,
		});
	}

	// ── channel creation ──────────────────────────────────────
	// ── resolve or create the 🎮 ARCADE GAMES category ────────
	// What:  hand back the guild's arcade category, creating it when the stored
	//        id is null or points at something that no longer exists.
	// Who:   runAutoSetup and repairMissingChannels (a legacy guild whose row
	//        predates the category). ONE helper for both, so the two paths cannot
	//        build it with different overwrites and drift.
	// ⚠️     BOTH callers must pass the STORED id. This comment used to claim
	//        runAutoSetup's stored id "is always null", which is only true of a
	//        fresh install; the forced rebuild paths reach it with a live category
	//        already recorded, and passing null there duplicated the category.
	//        See the call site in runAutoSetup for the full failure.
	// When:  once per autoSetup, and lazily on the boot sweep the first time a
	//        games spec needs a parent.
	// Where: the overwrites deliberately MIRROR the homebase category's, owner
	//        allow and nothing else. runAutoSetup's own comment explains why an
	//        @everyone deny on a category is actively harmful (it clobbers the
	//        bot's ViewChannel inheritance via @everyone-role membership and
	//        produces a 50013 on the very next child create), and that reasoning
	//        applies here identically. Privacy is enforced per child channel.
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
	// carrying the arcade's name is adopted, which also heals a row that lost its id
	// (a self destruct release, a reset database). An unconfirmed stored id returns
	// null, which both callers already treat as "skip the arcade this pass".
	// runAutoSetup calls the two halves itself (see its call site for why); the boot
	// sweep takes them together here.
	private static async resolveOrCreateArcadeCategory(
		guild: Guild,
		storedId: string | null | undefined,
		ownerId: string
	): Promise<CategoryChannel | null> {
		const existing = await GuildSetupManager.findExistingArcadeCategory(guild, storedId);
		if (existing === "unreachable") return null;
		return existing ?? GuildSetupManager.createArcadeCategory(guild, ownerId);
	}

	// The lookup half: the stored category, else one already carrying the arcade's
	// name, else null (Discord confirmed there is none to reuse), or "unreachable"
	// when the stored id could not be confirmed either way.
	private static async findExistingArcadeCategory(guild: Guild, storedId: string | null | undefined): Promise<CategoryChannel | null | "unreachable"> {
		if (storedId) {
			const stored = await GuildSetupManager.fetchStoredCategory(guild, storedId);
			if (stored === "unreachable") {
				console.warn(`[arcade-category] guild ${guild.id}: could not confirm stored category ${storedId}; creating nothing this pass`);
				return "unreachable";
			}
			if (stored) return stored;
		}

		const adopted = GuildSetupManager.findArcadeCategoryByName(guild);
		if (adopted) console.log(`[arcade-category] guild ${guild.id}: adopted existing category ${adopted.id} instead of building a second one`);
		return adopted;
	}

	// The create half, null on a 50013 after routing through handlePermissionFailure.
	private static async createArcadeCategory(guild: Guild, ownerId: string): Promise<CategoryChannel | null> {
		try {
			return await guild.channels.create({
				name: resolveGamesCategoryName(),
				type: ChannelType.GuildCategory,
				permissionOverwrites: [
					{
						id: ownerId,
						allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
					},
				],
			});
		} catch (error) {
			if (error instanceof DiscordAPIError && error.code === 50013) {
				await GuildSetupManager.handlePermissionFailure(guild);
				return null;
			}
			throw error;
		}
	}

	// The stored category, null when Discord answered that it does not exist (or the id
	// now names something that is not a category), and "unreachable" for any other
	// failure, which says nothing about whether it exists.
	private static async fetchStoredCategory(guild: Guild, categoryId: string): Promise<CategoryChannel | null | "unreachable"> {
		try {
			const channel = await guild.channels.fetch(categoryId);
			return channel?.type === ChannelType.GuildCategory ? (channel as CategoryChannel) : null;
		} catch (error) {
			if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownChannel) return null;
			return "unreachable";
		}
	}

	// A category already named as this environment's arcade. When a guild already
	// holds several (the duplicate this guards against), the one with the most
	// channels under it is the live one, so it wins and the empty spare is left for
	// an admin to delete rather than deleted by Dero. Reads the channel cache only, the
	// way adoption.ts scans for a welcome or rules channel: the Guilds intent fills it
	// at ready, so the scan costs no API call and has no failure of its own.
	private static findArcadeCategoryByName(guild: Guild): CategoryChannel | null {
		const name = resolveGamesCategoryName();
		const matches = [...(guild.channels.cache?.values() ?? [])].filter(
			(channel): channel is CategoryChannel => channel?.type === ChannelType.GuildCategory && channel.name === name
		);
		if (matches.length === 0) return null;
		return matches.reduce((best, next) => (next.children.cache.size > best.children.cache.size ? next : best));
	}

	private static async createChannels(
		guild: Guild,
		category: CategoryChannel,
		// The SECOND parent. Passed in rather than resolved here so createChannels
		// stays a pure "build these channels under these parents" step and the
		// 50013 handling lives in one place above.
		gamesCategory: CategoryChannel,
		config: ISetupConfig,
		// Read by the voice rooms' posture (see the call site in runAutoSetup), and the
		// member role by the public text channels while it gates a Community guild.
		storedRoles: { memberRoleId: string | null; adminRoleId: string | null },
		// The row a forced rebuild replaces (null on a fresh install), read only by the
		// welcome and rules adoption scan.
		storedRow: Record<string, unknown> | null = null
	): Promise<{ ids: ICreatedChannels; objects: IChannelObjects; adoptedChannelIds: string[] }> {
		const owner = { ownerId: config.ownerId };
		const voiceRoomOverwrites = communityOverwritesFor("voice", guild, owner, storedRoles);

		// The text channels never take the admin role here, as they never have: /setup
		// grants it (applyAdminRole) and the repair path layers it on (buildSingleChannel).
		// A forced rebuild of a gated Community guild therefore opens to members at once
		// and to an admin without the member role only after /setup runs again.
		const textRoles = { memberRoleId: storedRoles.memberRoleId, adminRoleId: null };

		// Members read, the owner and the bot write.
		const publicOverwrites = communityOverwritesFor("public", guild, owner, textRoles);

		// Introductions is the one member-writable homebase channel: it doubles
		// as a greeter surface where new members answer the welcome icebreaker
		// (welcomeNewMember) and satisfies a Discord Onboarding gate that requires
		// posting in a channel before full access.
		const introOverwrites = communityOverwritesFor("intro", guild, owner, textRoles);

		// Admin channels: owner only until /setup grants the admin role.
		const adminOverwrites = communityOverwritesFor("admin", guild, owner, textRoles);

		// The audit trail: the owner reads, only the bot writes (the admin role joins at /setup).
		const adminLogOverwrites = communityOverwritesFor("adminLog", guild, owner, textRoles);

		// 👋welcome and 📘rules adopt the server's own channel when it has one
		// (2026-10 item 247 Phase 2). The scan runs BEFORE the create, which is the
		// whole guarantee against a duplicate: a match short circuits the build. The
		// two pattern lists share no name, so their scans cannot race for one channel.
		const adoptOrCreate = async (field: "welcomeChannelId" | "rulesChannelId"): Promise<{ channel: TextChannel; adopted: boolean }> => {
			const spec = GuildSetupManager.CHANNEL_SPECS.find((entry) => entry.configField === field)!;
			const adopted = await GuildSetupManager.adoptExistingChannel(guild, category, spec, storedRow, textRoles);
			if (adopted) return { channel: adopted, adopted: true };
			const channel = await guild.channels.create({ name: spec.displayName, type: ChannelType.GuildText, parent: category.id, permissionOverwrites: publicOverwrites });
			return { channel, adopted: false };
		};

		const [
			introChannel,
			commandsChannel,
			leaderboardChannel,
			scheduleChannel,
			announcementsChannel,
			adminChannel,
			nextDecreeChannel,
			adminCommandsChannel,
			adminLogChannel,
			welcome,
			rules,
			arcadeRulesChannel,
			arcadeChallengesChannel,
			arcadeGamesChannel,
			partyGamesChannel,
			meetingVoiceChannel,
			arcadeVoiceChannel,
		] = await Promise.all([
			guild.channels.create({
				name: channels.intro,
				type: ChannelType.GuildText,
				parent: category.id,
				permissionOverwrites: introOverwrites,
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
				permissionOverwrites: publicOverwrites,
			}),
			guild.channels.create({
				name: channels.leaderboard,
				type: ChannelType.GuildText,
				parent: category.id,
				permissionOverwrites: publicOverwrites,
			}),
			guild.channels.create({
				name: channels.schedule,
				type: ChannelType.GuildText,
				parent: category.id,
				permissionOverwrites: publicOverwrites,
			}),
			guild.channels.create({
				name: channels.announcements,
				type: ChannelType.GuildText,
				parent: category.id,
				permissionOverwrites: publicOverwrites,
			}),
			guild.channels.create({
				name: channels.admin,
				type: ChannelType.GuildText,
				parent: category.id,
				permissionOverwrites: adminOverwrites,
			}),
			// seventh, 🛡️next-decree. public overwrites (mortals read,
			// bot writes). Mirror of announcements at the permission
			// level but its own channel so the audit trail does not
			// collide with the 15/30 minute reminder pings.
			guild.channels.create({
				name: channels.nextDecree,
				type: ChannelType.GuildText,
				parent: category.id,
				permissionOverwrites: publicOverwrites,
			}),
			// eighth, admin command center. adminOverwrites (admin-gated like
			// inner-sanctum); hosts the relocated command guide + the admin panel.
			guild.channels.create({
				name: channels.adminCommands,
				type: ChannelType.GuildText,
				parent: category.id,
				permissionOverwrites: adminOverwrites,
			}),
			// 🗒️admin-log (post-launch plan item 11), the bot write only audit trail.
			guild.channels.create({
				name: channels.adminLog,
				type: ChannelType.GuildText,
				parent: category.id,
				permissionOverwrites: adminLogOverwrites,
			}),
			// 👋welcome and 📘rules: publicOverwrites, members read and the bot writes,
			// whether built here or adopted and moved onto the same shape.
			adoptOrCreate("welcomeChannelId"),
			adoptOrCreate("rulesChannelId"),
			// ── ninth and tenth, under 🎮 ARCADE GAMES ────────────
			// ⚠️ NOTE THE PARENT: gamesCategory.id, not category.id. These two are
			// the only channels here that do not live in the homebase, and getting
			// this wrong is risk R2 in a form the compiler cannot catch (both are
			// CategoryChannel), which is why the specs carry categoryField for
			// every OTHER consumer.
			//
			// Both take publicOverwrites: members read, the bot writes. The rules
			// card is a pinned reference and the challenge board is a wall of bot
			// posted cards with buttons, so member SendMessages would only let
			// chatter bury them. Challenges are issued by command, not by typing
			// here, so the lockdown costs nothing.
			guild.channels.create({
				name: channels.arcadeRules,
				type: ChannelType.GuildText,
				parent: gamesCategory.id,
				permissionOverwrites: publicOverwrites,
			}),
			guild.channels.create({
				name: channels.arcadeChallenges,
				type: ChannelType.GuildText,
				parent: gamesCategory.id,
				permissionOverwrites: publicOverwrites,
			}),
			// 🕹️games, the third arcade channel (2026-10 item 245 Phase 4a). Same parent
			// and same posture as its two siblings: members press its buttons and read
			// what Dero posts there, and nobody needs to type in it.
			guild.channels.create({
				name: channels.arcadeGames,
				type: ChannelType.GuildText,
				parent: gamesCategory.id,
				permissionOverwrites: publicOverwrites,
			}),
			// 🎉party-games (post-launch plan item 3), the same parent and posture.
			guild.channels.create({
				name: channels.partyGames,
				type: ChannelType.GuildText,
				parent: gamesCategory.id,
				permissionOverwrites: publicOverwrites,
			}),
			// ── the two voice rooms, one per category (2026-10 item 235) ──
			// Same parent rule as above: the meeting room is homebase, the lounge is
			// arcade. Both take the voice shape, the posture buildSingleChannel also
			// uses on repair, so a rebuilt room matches a fresh one.
			guild.channels.create({
				name: channels.meetingVoice,
				type: ChannelType.GuildVoice,
				parent: category.id,
				permissionOverwrites: voiceRoomOverwrites,
			}),
			guild.channels.create({
				name: channels.arcadeVoice,
				type: ChannelType.GuildVoice,
				parent: gamesCategory.id,
				permissionOverwrites: voiceRoomOverwrites,
			}),
		]);

		return {
			ids: {
				categoryId: category.id,
				introChannelId: introChannel.id,
				commandsChannelId: commandsChannel.id,
				leaderboardChannelId: leaderboardChannel.id,
				scheduleChannelId: scheduleChannel.id,
				announcementsChannelId: announcementsChannel.id,
				adminChannelId: adminChannel.id,
				nextDecreeChannelId: nextDecreeChannel.id,
				adminCommandsChannelId: adminCommandsChannel.id,
				adminLogChannelId: adminLogChannel.id,
				welcomeChannelId: welcome.channel.id,
				rulesChannelId: rules.channel.id,
				gamesCategoryId: gamesCategory.id,
				arcadeRulesChannelId: arcadeRulesChannel.id,
				arcadeChallengesChannelId: arcadeChallengesChannel.id,
				arcadeGamesChannelId: arcadeGamesChannel.id,
				partyGamesChannelId: partyGamesChannel.id,
				meetingVoiceChannelId: meetingVoiceChannel.id,
				arcadeVoiceChannelId: arcadeVoiceChannel.id,
			},
			objects: {
				introChannel,
				commandsChannel,
				leaderboardChannel,
				scheduleChannel,
				announcementsChannel,
				adminChannel,
				nextDecreeChannel,
				adminCommandsChannel,
				adminLogChannel,
				welcomeChannel: welcome.channel,
				rulesChannel: rules.channel,
				arcadeRulesChannel,
				arcadeChallengesChannel,
				arcadeGamesChannel,
				partyGamesChannel,
				meetingVoiceChannel,
				arcadeVoiceChannel,
			},
			adoptedChannelIds: [welcome, rules].filter((entry) => entry.adopted).map((entry) => entry.channel.id),
		};
	}

	// ── populate channels with initial content ────────────────
	// What:  post the six intro embeds, one per homebase channel, and return
	//        the resulting message ids so autoSetup can persist them on the
	//        GuildConfig row.
	// Who:   autoSetup (fresh build, Path A) and autoSetup (in place rebuild,
	//        Path B via ensureHomebase → rebuildFromStaleConfig).
	// When:  exactly once per build. Subsequent boots edit the stored ids in
	//        place via refreshIntroEmbeds rather than reposting.
	// Where: scheduleMessage keeps its special treatment, it is still the
	//        anchor the ScheduleBoard edits in place, and pinning is still
	//        best effort. The other five ids are new surface, driven by the
	//        introMessageIds field added to GuildConfig for boot time copy
	//        refreshes.
	// How:   Promise.all returns the messages in the same order we send them.
	//        We destructure with names so adding a seventh channel later does
	//        not silently shift positional indexes.
	private static async populateChannels(
		guild: Guild,
		discordChannels: IChannelObjects,
		// Which of 👋welcome and 📘rules the server already had, and the row whose
		// saved rules the rules post shows (2026-10 item 247 Phase 2). An adopted
		// channel holding the owner's content gets no intro, and its anchor stays null.
		options: { adoptedChannelIds: readonly string[]; rulesConfig: IRulesConfig | null }
	): Promise<{
		scheduleMessageId: string;
		introMessageIds: {
			introChannelId: string;
			commandsChannelId: string;
			leaderboardChannelId: string;
			scheduleChannelId: string;
			announcementsChannelId: string;
			adminChannelId: string;
			nextDecreeChannelId: string;
			// Intro anchor for the admin command center (the relocated command
			// guide). Standard one-key-per-channel slot, the guide is this
			// channel's only tracked message after the 2026-06-19 split.
			adminCommandsChannelId: string;
			// 🗒️admin-log's header, edited in place on later boots like every intro.
			adminLogChannelId: string;
			// Null when an adopted channel already held the owner's own content.
			welcomeChannelId: string | null;
			rulesChannelId: string | null;
			// ── 🎮 ARCADE GAMES intro anchors ──
			// Same one-key-per-channel slot every other intro gets, so
			// refreshIntroEmbeds edits both cards in place on later boots instead of
			// reposting them. GuildConfig declared these two keys in task 2.1.
			arcadeRulesChannelId: string;
			arcadeChallengesChannelId: string;
			// 🕹️games' intro, and its second message, the Challenge Board.
			arcadeGamesChannelId: string;
			arcadeGamesBoardId: string;
			// 🎉party-games' intro, above its admin buttons (post-launch plan item 3).
			partyGamesChannelId: string;
			// Second pinned message in #command-center: the standalone invite card.
			inviteCardId: string;
			// The two voice rooms' cards, one anchor per room like every channel's.
			meetingVoiceChannelId: string;
			arcadeVoiceChannelId: string;
		};
	}> {
		const {
			introChannel,
			commandsChannel,
			leaderboardChannel,
			scheduleChannel,
			announcementsChannel,
			adminChannel,
			nextDecreeChannel,
			adminCommandsChannel,
			adminLogChannel,
			welcomeChannel,
			rulesChannel,
			arcadeRulesChannel,
			arcadeChallengesChannel,
			arcadeGamesChannel,
			partyGamesChannel,
			meetingVoiceChannel,
			arcadeVoiceChannel,
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
			adminMsg,
			nextDecreeMsg,
			// ── admin command center intro ───────────
			// The admin command guide is the dedicated admin command center's
			// pinned intro. Sent in the same Promise.all so posting happens in
			// one batch and ordering is deterministic. Persisted on
			// introMessageIds.adminCommandsChannelId like every other channel intro.
			adminCommandsMsg,
			// 🗒️admin-log's header. Not pinned: only Dero writes there, so nothing buries it.
			adminLogMsg,
			// 👋welcome's intro and 📘rules' rules post, null where an adopted channel
			// already held the owner's content. Neither is pinned: both are read only.
			welcomeMsg,
			rulesMsg,
			// ── 🎮 ARCADE GAMES ───────────────────────
			// The rules card and the challenge board intro. Neither is pinned, per
			// the pinning policy below: both channels are read-only for members, so
			// there is nothing to bury the bot's message under.
			arcadeRulesMsg,
			arcadeChallengesMsg,
			// 🕹️games' two messages, the intro and the Challenge Board beneath it.
			arcadeGamesMsgs,
			// 🎉party-games' intro with the admin host and schedule buttons.
			partyGamesMsg,
			// Second #command-center message: the standalone invite card (pitch +
			// Dero gif + Summon button), pinned separately from the command guide.
			inviteCardMsg,
			// The voice rooms' cards, /dero's Join, Leave and Status (2026-10 item 245).
			meetingVoiceMsg,
			arcadeVoiceMsg,
		] = await Promise.all([
			// intro channel carries both the introduction embed AND the
			// "Summon me to your server, Mortal" link button. Components
			// travel alongside embeds on send; refreshIntroEmbeds must
			// also pass components on edit or Discord will drop the row.
			introChannel.send({
				embeds: [ChannelContent.introduction()],
				components: GuildSetupManager.resolveIntroComponents("introChannelId") ?? [],
				files: GuildSetupManager.resolveIntroFiles("introChannelId"),
			}),
			// Initial post includes the Suggestion Box button row so the
			// pin carries the member-clickable surface from minute one.
			// resolveIntroComponents returns the same row for refresh
			// reposts on subsequent boots; keep both call sites aligned.
			commandsChannel.send({ embeds: [ChannelContent.commandGuide()], components: GuildSetupManager.resolveIntroComponents("commandsChannelId") ?? [] }),
			leaderboardChannel.send({ embeds: [ChannelContent.leaderboardIntro()] }),
			scheduleChannel.send({ embeds: [ChannelContent.scheduleIntro()] }),
			announcementsChannel.send({ embeds: [ChannelContent.announcementsIntro()] }),
			adminChannel.send({ embeds: [ChannelContent.adminPending()] }),
			// Pinned header above the NextUpBoard posts. Pinning is best
			// effort (see schedule channel block below). The message id
			// is persisted on introMessageIds.nextDecreeChannelId so
			// refreshIntroEmbeds edits it in place on every boot.
			nextDecreeChannel.send({ embeds: [ChannelContent.nextDecreeIntro()] }),
			// Admin command guide, the pinned intro of the dedicated admin
			// command center. Carries the owner-only Self destruct button row
			// (gated in the handler). Pinning handled below alongside the
			// schedule + next-decree pins.
			adminCommandsChannel.send({ embeds: [ChannelContent.adminCommandGuide()], components: GuildSetupManager.resolveIntroComponents("adminCommandsChannelId", null, guild) ?? [] }),
			adminLogChannel.send({ embeds: [ChannelContent.adminLogIntro()] }),
			postIntroUnlessOwnerContent(welcomeChannel, "welcomeChannelId"),
			postIntroUnlessOwnerContent(rulesChannel, "rulesChannelId"),
			// The arcade's two cards. Ordering inside this array is load bearing:
			// the destructure above is positional, which is exactly why every entry
			// is named rather than indexed.
			arcadeRulesChannel.send({ embeds: [ChannelContent.arcadeRulesIntro()], components: GuildSetupManager.resolveIntroComponents("arcadeRulesChannelId") ?? [] }),
			arcadeChallengesChannel.send({ embeds: [ChannelContent.arcadeChallengesIntro()], components: GuildSetupManager.resolveIntroComponents("arcadeChallengesChannelId") ?? [] }),
			// Chained rather than two entries in this Promise.all: the board has to land
			// BELOW the intro, and two parallel sends to one channel arrive in either order.
			arcadeGamesChannel
				.send({ embeds: [ChannelContent.arcadeGamesIntro()], components: GuildSetupManager.resolveIntroComponents("arcadeGamesChannelId") ?? [] })
				.then(async (intro) => ({ intro, board: await arcadeGamesChannel.send(GuildSetupManager.gamesBoardContent()) })),
			partyGamesChannel.send({ embeds: [ChannelContent.partyGamesIntro()], components: GuildSetupManager.resolveIntroComponents("partyGamesChannelId") ?? [] }),
			// Standalone invite card in #command-center: short pitch + Dero gif + the
			// Summon button. Its own message so the wide button is not crammed into
			// the command guide's row. refreshIntroEmbeds maintains it on boot.
			commandsChannel.send({
				embeds: [ChannelContent.inviteCard()],
				components: GuildSetupManager.inviteCardComponents(),
				files: [buildDeroGifAttachment()],
			}),
			meetingVoiceChannel.send({ embeds: [ChannelContent.voiceRoomIntro()], components: GuildSetupManager.resolveIntroComponents("meetingVoiceChannelId") ?? [] }),
			arcadeVoiceChannel.send({ embeds: [ChannelContent.voiceRoomIntro()], components: GuildSetupManager.resolveIntroComponents("arcadeVoiceChannelId") ?? [] }),
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
			console.warn(LOG_MESSAGES.setup.pinScheduleIntroFailed(discordChannels.introChannel.guildId), error);
		}

		return {
			scheduleMessageId: scheduleMessage.id,
			// mirrors the GuildConfig.introMessageIds shape so autoSetup can
			// hand this object straight into the persist payload without
			// reshaping.
			introMessageIds: {
				introChannelId: introMsg.id,
				commandsChannelId: commandsMsg.id,
				leaderboardChannelId: leaderboardMsg.id,
				scheduleChannelId: scheduleMessage.id,
				announcementsChannelId: announcementsMsg.id,
				adminChannelId: adminMsg.id,
				nextDecreeChannelId: nextDecreeMsg.id,
				adminCommandsChannelId: adminCommandsMsg.id,
				adminLogChannelId: adminLogMsg.id,
				welcomeChannelId: welcomeMsg?.id ?? null,
				rulesChannelId: rulesMsg?.id ?? null,
				arcadeRulesChannelId: arcadeRulesMsg.id,
				arcadeChallengesChannelId: arcadeChallengesMsg.id,
				arcadeGamesChannelId: arcadeGamesMsgs.intro.id,
				arcadeGamesBoardId: arcadeGamesMsgs.board.id,
				partyGamesChannelId: partyGamesMsg.id,
				inviteCardId: inviteCardMsg.id,
				meetingVoiceChannelId: meetingVoiceMsg.id,
				arcadeVoiceChannelId: arcadeVoiceMsg.id,
			},
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
			// The two FLAT keys stay explicit, because they are not a channel's own
			// intro and so are deliberately absent from CHANNEL_FIELDS.
			//
			// Legacy flat key for the OLD admin command guide that used to live
			// in #inner-sanctum. Retained only so the retirement block below can
			// unpin that stale message and null this key; new setups never set it.
			adminCommandGuideId: storedIntroIds.adminCommandGuideId ?? null,
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
			const componentRows = GuildSetupManager.resolveIntroComponents(spec.configField, stored as unknown as ICopyConfig, guild);
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
			const shouldBePinned = spec.configField === "introChannelId";

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

		// ── retire the legacy in-sanctum admin command guide ──────────────
		// What:  the admin command guide MOVED to its own channel
		//        (adminCommandsChannelId, maintained by the spec loop above) in
		//        the 2026-06-19 split. On guilds that still have the old guide
		//        pinned in #inner-sanctum, unpin it (left in history per the
		//        never-delete policy) and clear the legacy anchor so it stops
		//        being tracked. Once cleared, adminCommandGuideId is null and
		//        this block is a permanent no-op.
		// Who:   guilds set up before the split. Brand-new setups never populate
		//        adminCommandGuideId, so they skip this entirely.
		// When:  gated on the NEW channel's guide already being live
		//        (nextIntroIds.adminCommandsChannelId set) so an admin who
		//        disabled auto-heal, and therefore has no new channel yet,
		//        keeps the old guide pinned until the replacement actually exists.
		const legacyGuideId = nextIntroIds.adminCommandGuideId;
		const legacyAdminChannelId = stored.adminChannelId as string | null | undefined;
		if (legacyGuideId && nextIntroIds.adminCommandsChannelId && legacyAdminChannelId) {
			const adminChannel = await client.channels.fetch(legacyAdminChannelId).catch(() => null);
			if (adminChannel instanceof TextChannel) {
				const legacyGuide = await adminChannel.messages.fetch(legacyGuideId).catch(() => null);
				if (legacyGuide?.pinned) {
					try {
						await legacyGuide.unpin();
					} catch (unpinError) {
						console.warn(LOG_MESSAGES.setup.introRefreshEditFailed("admin command guide", guild.id), unpinError);
					}
				}
			}
			// Clear the anchor regardless of whether the fetch/unpin succeeded,
			// the message is no longer the tracked guide; the new channel owns
			// the live one now.
			nextIntroIds.adminCommandGuideId = null;
			needsPersist = true;
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
				const cardEmbed = ChannelContent.inviteCard();
				const cardComponents = GuildSetupManager.inviteCardComponents();

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

		console.log(LOG_MESSAGES.setup.introRefreshDone(guild.id, edited, reposted));
		return { edited, reposted };
	}
}
