import {
	Guild,
	PermissionFlagsBits,
	ChannelType,
	CategoryChannel,
	GuildChannel,
	Client,
	TextChannel,
	DiscordAPIError,
	ActionRowBuilder,
	ButtonBuilder,
	EmbedBuilder,
	Embed,
	Message,
} from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { ISetupConfig, IAdminRoleConfig, ICreatedChannels, IChannelObjects, IEnsureHomebaseResult } from "./setup.types.js";
import { ChannelContent } from "./ChannelContent.js";
import type { ICopyConfig } from "@base/copy/getCopy.js";
import { buildSuggestionBoxButton } from "@features/suggestion-box/SuggestionBox.js";
import { buildSelfDestructButton } from "@features/setup/selfDestruct.js";
import { buildArcadeHostRow } from "@features/games/arcadeHost.js";
import { buildMemberControlButtons, buildAdminControlButtons, buildIcebreakerButton, buildFortuneButton } from "@features/power-ups/PowerUps.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { buildDeroGifAttachment } from "@base/copy/brand.js";
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
	// ── bot self overwrite ────────────────────────────────────
	// What: build the channel permission overwrite that grants this bot
	//       the perms it needs on a private/restricted channel. Without
	//       this overwrite, an `@everyone deny ViewChannel` (or any
	//       channel-level deny on a guild-wide perm) propagates to the
	//       bot via @everyone-role membership and overrides the bot's
	//       integration-role allows. Symptom: DiscordAPIError 50013 on
	//       the very next operation against the channel, eg. creating
	//       a child under a private category, posting an intro embed,
	//       pinning the schedule board, etc.
	// Who:   autoSetup (category overwrites), createChannels (every
	//        public + admin child), buildSingleChannel (repair flow).
	// When:  every time we mint a category or channel for the homebase,
	//        regardless of public/admin kind. The cost is one extra
	//        overwrite entry per channel, cheap insurance against
	//        Discord's permission resolution model biting us.
	// Where: relies on `guild.client.user.id`. The client is logged in
	//        before guildCreate fires (login completes in main.ts step
	//        5), so `client.user` is always populated when we reach
	//        this code path. We avoid `guild.members.me` because the
	//        member cache may not be populated on the very first tick
	//        of guildCreate, but the User object on the Client is.
	// How:   member-level overwrite on the bot's user id. In Discord's
	//        channel permission resolution order, member overwrites
	//        apply LAST (after @everyone, then role overwrites), so a
	//        member allow beats any role-tier deny. We list every perm
	//        the bot uses against any homebase channel, view, send,
	//        embed, history, manage messages, manage channels, manage
	//        roles, add reactions, mention everyone, so a single
	//        overwrite shape works for category, public, and admin
	//        channels alike.
	private static botSelfOverwrite(guild: Guild) {
		// non-null assertion: guildCreate fires after the client is logged
		// in, so client.user is guaranteed populated.
		const botId = guild.client.user!.id;
		return {
			id: botId,
			allow: [
				PermissionFlagsBits.ViewChannel,
				PermissionFlagsBits.ManageChannels,
				PermissionFlagsBits.ManageRoles,
				PermissionFlagsBits.SendMessages,
				PermissionFlagsBits.EmbedLinks,
				PermissionFlagsBits.ReadMessageHistory,
				PermissionFlagsBits.ManageMessages,
				PermissionFlagsBits.AddReactions,
				PermissionFlagsBits.MentionEveryone,
			],
		};
	}

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

		// The SECOND category. Built here rather than left to the boot sweep so a
		// fresh install produces both categories and all ten channels in one pass,
		// which is what the completion criteria for this phase actually asks for.
		// A null return means a 50013 already routed through handlePermissionFailure,
		// so bail exactly as the homebase category create above does.
		const gamesCategory = await GuildSetupManager.resolveOrCreateArcadeCategory(guild, null, config.ownerId);
		if (!gamesCategory) return;

		const { ids, objects } = await GuildSetupManager.createChannels(guild, category, gamesCategory, config);
		const { scheduleMessageId, introMessageIds } = await GuildSetupManager.populateChannels(objects);

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
			// Persisted immediately (unlike nextDecreeChannelId, which relies on
			// boot-sweep adoption) so the admin power-up panel, which keys off
			// adminCommandsChannelId, can post as soon as ensurePowerUps runs
			// after /setup, without waiting for a reboot.
			adminCommandsChannelId: ids.adminCommandsChannelId,
			// ── 🎮 ARCADE GAMES ──
			// All three persisted in the SAME payload as the rest, deliberately.
			// nextDecreeChannelId's original omission (it relied on boot-sweep
			// adoption instead) meant the id was null until the next reboot, and
			// anything keying off it silently no-opped in between. Do not copy that.
			gamesCategoryId: ids.gamesCategoryId,
			arcadeRulesChannelId: ids.arcadeRulesChannelId,
			arcadeChallengesChannelId: ids.arcadeChallengesChannelId,
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
		// /rename-channel names (the rebuild path uses pack defaults). The schedule
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
		if (repairedChannels.length > 0) {
			console.log(LOG_MESSAGES.setup.ensureHomebaseDone(guild.id, "repaired"));
			return { action: "repaired", repairedChannels };
		}

		// ⑤ happy path: stored homebase exists, is owned by this bot, and
		//    all six channels are present.
		console.log(LOG_MESSAGES.setup.ensureHomebaseDone(guild.id, "skipped"));
		return { action: "skipped", repairedChannels: [] };
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
	] as const;

	// exported so ChannelDeleteWatcher can map a deleted channel id to its
	// spec without re declaring the list. Keep in sync with CHANNEL_FIELDS.
	static readonly CHANNEL_SPECS: Array<{
		configField: (typeof GuildSetupManager.CHANNEL_FIELDS)[number];
		displayName: string;
		kind: "public" | "admin";
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
	];

	// ── intro content resolver ────────────────────────────────
	// What: pick the right ChannelContent embed for a given spec, reading
	//       adminRoleId off the currently known stored config so post Phase 2
	//       guilds get the populated admin welcome instead of the placeholder.
	// Who:  repairOneChannel. Also usable by the realtime watcher.
	// How:   plain switch on configField so a future spec addition becomes
	//        a compile error here until the case is added.
	private static resolveIntroEmbed(
		field: (typeof GuildSetupManager.CHANNEL_FIELDS)[number],
		guild: Guild,
		adminRoleId: string | null,
		// Pack selector. Callers that have the loaded GuildConfig (repairOneChannel,
		// refreshIntroEmbeds) pass it so a non-ROK guild renders neutral intros;
		// undefined falls back to the rok-commander default (correct on first build).
		guildConfig?: ICopyConfig | null
	): EmbedBuilder {
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
			// ── 🎮 ARCADE GAMES ────────────────────────────────────────
			// Neither depends on adminRoleId: both channels are member facing, and
			// the rules card is the answer to "who can play what" for everyone
			// rather than an admin surface.
			case "arcadeRulesChannelId":
				return ChannelContent.arcadeRulesIntro(guildConfig);
			case "arcadeChallengesChannelId":
				return ChannelContent.arcadeChallengesIntro(guildConfig);
		}
	}

	// ── resolveIntroComponents ────────────────────────────────────
	// What:  returns the action row(s) that accompany a given channel's intro
	//        embed, or null if it has no buttons (the common case). Two channels
	//        carry a folded control row (2026-06): the #command-center guide and
	//        the admin-controls guide. The standalone "power-up" panels were
	//        retired, every button now rides on these pinned guides.
	// Who:   populateChannels on first build and refreshIntroEmbeds on every boot
	//        (both the edit-in-place and repost paths must pass components or
	//        Discord silently drops them).
	// When:  called per spec during the intro sweep.
	// Where: the powerup-prefixed buttons (toggle pings, say hello, refresh) keep
	//        their customIds so PowerUps.handlePowerUpButton still routes them;
	//        suggestion-box / invite / self-destruct each expose a bare button
	//        factory so all of a channel's buttons fit in ONE ActionRow.
	// How:   compose the ActionRow(s) per channel (command-center uses two rows so
	//        the wide invite button sits on its own line). null means "no buttons."
	private static resolveIntroComponents(
		field: (typeof GuildSetupManager.CHANNEL_FIELDS)[number]
	): ActionRowBuilder<ButtonBuilder>[] | null {
		switch (field) {
			case "commandsChannelId":
				// #command-center guide row: the member actions, Suggestion Box +
				// Toggle pings. The invite button and the Icebreaker button are NOT here:
				// they live on the standalone Summon Dero card (inviteCardComponents) so
				// they do not crowd this row.
				return [new ActionRowBuilder<ButtonBuilder>().addComponents(buildSuggestionBoxButton(), ...buildMemberControlButtons())];
			case "adminCommandsChannelId":
				// admin-controls guide row (2 buttons): owner-only Self destruct + the
				// admin controls (Refresh standings).
				return [new ActionRowBuilder<ButtonBuilder>().addComponents(buildSelfDestructButton(), ...buildAdminControlButtons())];
			case "arcadeRulesChannelId":
				// The arcade rules card carries the Host a game row, so a member can
				// start a game by pressing a button instead of learning /mini-game
				// first. The hosted game is posted into ⚔️challenges, never here: this
				// card is a pinned reference and a live board on top of it would bury
				// what the member came to read.
				return [buildArcadeHostRow()];
			default:
				// introductions + every other channel: intro embed only, no buttons.
				return null;
		}
	}

	// ── invite card button row ────────────────────────────────────
	// The Summon Dero card's buttons: the Summon (Link) button + the "Icebreaker"
	// button (moved off the command guide row 2026-06) + the "Fortune" button
	// (added 2026-07-02). Shared by the initial post (populateChannels) and boot
	// maintenance (refreshIntroEmbeds) so the two stay in lockstep, the
	// componentsAreEquivalent check on boot keys off this exact row, so adding a
	// button here re-edits the card on every existing guild's next boot.
	private static inviteCardComponents(): ActionRowBuilder<ButtonBuilder>[] {
		return [
			new ActionRowBuilder<ButtonBuilder>().addComponents(
				ChannelContent.buildInviteButton(),
				buildIcebreakerButton(),
				buildFortuneButton()
			),
		];
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
		// plain urls (e.g. the introductions Dero gif), compare literally so a real
		// image change still counts as drift worth reposting.
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
		resolved: ActionRowBuilder<ButtonBuilder>[] | null,
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
	// How:   ① buildSingleChannel with the spec's kind + the known adminRoleId.
	//        ② fire-and-forget the intro embed. failures are logged and
	//           swallowed because the channel is already functional.
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
	): Promise<{ newChannel: TextChannel; stored: typeof stored }> {
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
		// Read the per-slot custom-name override (set by /rename-channel)
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

		const existingByName = category.children.cache.find(
			(child): child is TextChannel => child instanceof TextChannel && child.name === effectiveName
		);
		const newChannel = existingByName
			? existingByName
			: await GuildSetupManager.buildSingleChannel(guild, category, effectiveName, spec.kind, stored.adminRoleId ?? null);
		if (existingByName) {
			console.warn(LOG_MESSAGES.setup.channelAdopted(effectiveName, guild.id));
		}

		// ── intro message resolution ────────────────────────────────
		// Two paths, merged:
		//   A. Fresh build (!existingByName): post an intro embed,
		//      capture the new message id. This is the historical
		//      behavior, a newly created channel has no intro yet.
		//   B. Adopted existing channel: scan the most recent messages
		//      for a bot-authored embed that matches the spec's intro.
		//      If found, reuse its id, DO NOT post a duplicate. If not
		//      found (eg. the existing channel was emptied by an admin),
		//      fall through to the same post-a-fresh-intro path as A so
		//      the adopted channel still ends up with the pinned intro.
		//
		// Why the scan only looks at the latest ~20 messages: a stray
		// intro embed further back in history is rare (bot is the only
		// author in its own homebase channels) and the scan is cheap.
		// If the adopted channel has 500 messages from a prior setup
		// cycle, we accept that a very old intro won't be adopted, the
		// fresh one we post beneath it is correct, and the historical
		// one is just harmless scrollback. Most guilds hitting this
		// branch have NO messages (the channel was just created but
		// never had its id persisted).
		let introMessageId: string | null = null;
		const introEmbed = GuildSetupManager.resolveIntroEmbed(spec.configField, guild, stored.adminRoleId ?? null, stored as unknown as ICopyConfig);
		const introComponents = GuildSetupManager.resolveIntroComponents(spec.configField);

		try {
			if (existingByName) {
				// Scan for an existing bot-authored intro embed with a
				// matching title. Embed titles are stable identifiers
				// for each intro (nextDecreeIntro → "🔜 Upcoming Events",
				// etc.) so title comparison is the cheapest way to
				// recognize our own prior post without storing a hash.
				const selfId = guild.client.user?.id;
				const targetTitle = introEmbed.data.title ?? null;

				const recent = await newChannel.messages.fetch({ limit: 20 }).catch(() => null);
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
						await existingIntro.edit({ embeds: [introEmbed], components: introComponents ?? [] });
					} catch (editError) {
						// edit failure is non fatal, the old embed stands.
						console.warn(LOG_MESSAGES.setup.channelRepairFailed(spec.displayName, guild.id), editError);
					}
				}
			}

			if (!introMessageId) {
				// Fresh post path: either a brand new channel (path A
				// above) or an adopted channel with no matching intro.
				const introMessage = await newChannel.send({
					embeds: [introEmbed],
					components: introComponents ?? [],
				});
				introMessageId = introMessage.id;
				// No pin: the schedule channel is read-only, so the board stays put
				// without one (2026-06 pinning policy, only introductions is pinned).
			}
		} catch (error) {
			console.warn(LOG_MESSAGES.setup.channelRepairFailed(spec.displayName, guild.id), error);
		}

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

		const update: Record<string, unknown> = {
			[spec.configField]: newChannel.id,
			introMessageIds: nextIntroIds,
		};
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
					`[auto-heal] skipped repair of ${wouldRepairCount} channel(s) in guild ${guild.id} because autoHealEnabled is false; run /configure-auto-heal enabled:True to resume.`
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
			// related toggle (eg /configure-leaderboard-tracking enabled:True)
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
				// set via /rename-channel, otherwise spec default). Without
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
	//        A channel with a /rename-channel override keeps that override (expected
	//        = the override, normally already its live name); a channel with NO
	//        override is renamed to the current pack default. So the only way to
	//        keep an old custom name is to have set it via /rename-channel.
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

		for (const spec of GuildSetupManager.CHANNEL_SPECS) {
			const storedId = ids[spec.configField];
			if (!storedId) continue;
			const channel = await client.channels.fetch(storedId).catch(() => null);
			if (!(channel instanceof TextChannel)) continue;

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
	// What: recreate one text channel under the given category with the
	//       same overwrites autoSetup.createChannels would have used for
	//       its kind. If the guild has already run Phase 2 and has an
	//       adminRoleId, that role's overwrite is layered on as well so
	//       repaired channels preserve the admin surface.
	// Who:  repairMissingChannels. Private because the overwrites are a
	//       mirror of createChannels and callers have no business tuning
	//       them ad hoc.
	// When: only from the repair path. autoSetup has its own bulk creation
	//       because it creates all six in parallel with Promise.all.
	// Where: keeps the posture identical to the original build, so a
	//        repaired channel is indistinguishable from one created during
	//        /setup except for the Discord creation timestamp.
	// How:  branch on kind for the base overwrites, append the admin role
	//       grant when applicable, then call guild.channels.create.
	private static async buildSingleChannel(
		guild: Guild,
		category: CategoryChannel,
		name: string,
		kind: "public" | "admin",
		adminRoleId: string | null
	): Promise<TextChannel> {
		// botSelfOverwrite must be in every shape, same reasoning as
		// createChannels (which mints the initial six). Without it, a
		// repaired public channel would silently fail to accept the bot's
		// intro repost; a repaired admin channel would not be visible to
		// the bot at all.
		const publicOverwrites = [
			{ id: guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] },
			GuildSetupManager.botSelfOverwrite(guild),
			{ id: guild.ownerId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
		];
		const adminOverwrites = [
			{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
			GuildSetupManager.botSelfOverwrite(guild),
			{
				id: guild.ownerId,
				allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
			},
		];

		// layer the admin role grant on top of the base overwrites when
		// the guild has already run Phase 2. public channels get send
		// permission for the admin role; admin channel gets full access.
		let overwrites;
		if (kind === "admin") {
			overwrites = [...adminOverwrites];
		} else {
			overwrites = [...publicOverwrites];
		}
		if (adminRoleId) {
			// admin kind gets full access (including history) so admins can
			// scroll back through past notices. public kind gets send
			// permission only; history is implied by ViewChannel.
			overwrites.push({
				id: adminRoleId,
				allow:
					kind === "admin"
						? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
						: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
			});
		}

		// guild.channels.create with ChannelType.GuildText always returns
		// a TextChannel; the cast is safe and saves a narrow in the caller.
		const created = (await guild.channels.create({
			name,
			type: ChannelType.GuildText,
			parent: category.id,
			permissionOverwrites: overwrites,
		})) as TextChannel;
		return created;
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
	// + fresh channels, losing /rename-channel overrides). A missing anchor is not
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

		const [category, introChannel, commandsChannel, leaderboardChannel, scheduleChannel, announcementsChannel, adminChannel, adminCommandsChannel] =
			(await Promise.all([
				guild.channels.fetch(stored.categoryId),
				guild.channels.fetch(stored.introChannelId),
				guild.channels.fetch(stored.commandsChannelId),
				guild.channels.fetch(stored.leaderboardChannelId),
				guild.channels.fetch(stored.scheduleChannelId),
				guild.channels.fetch(stored.announcementsChannelId),
				guild.channels.fetch(stored.adminChannelId),
				// admin command center: nullable on legacy rows that ran /setup
				// before this channel existed (the boot sweep creates it later),
				// so fetch defensively and skip the grant when not yet present.
				stored.adminCommandsChannelId ? guild.channels.fetch(stored.adminCommandsChannelId) : Promise.resolve(null),
			])) as (GuildChannel | null)[];

		// grant admin role access to category
		await category?.permissionOverwrites.create(config.adminRoleId, {
			ViewChannel: true,
			SendMessages: true,
			ReadMessageHistory: true,
		});

		// grant admin role send permissions on public channels
		for (const ch of [introChannel, commandsChannel, leaderboardChannel, scheduleChannel, announcementsChannel]) {
			await ch?.permissionOverwrites.create(config.adminRoleId, {
				ViewChannel: true,
				SendMessages: true,
			});
		}

		// grant admin role full access to admin channel
		await adminChannel?.permissionOverwrites.create(config.adminRoleId, {
			ViewChannel: true,
			SendMessages: true,
			ReadMessageHistory: true,
		});

		// grant admin role full access to the admin command center (same gating
		// as the admin channel). Optional-chained so a legacy row whose channel
		// the boot sweep has not built yet simply skips the grant.
		await adminCommandsChannel?.permissionOverwrites.create(config.adminRoleId, {
			ViewChannel: true,
			SendMessages: true,
			ReadMessageHistory: true,
		});

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
	// Who:   runAutoSetup (fresh install, stored id is always null) and
	//        repairMissingChannels (a legacy guild whose row predates the
	//        category). ONE helper for both, so the two paths cannot build it
	//        with different overwrites and drift.
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
	private static async resolveOrCreateArcadeCategory(
		guild: Guild,
		storedId: string | null | undefined,
		ownerId: string
	): Promise<CategoryChannel | null> {
		if (storedId) {
			const existing = await guild.channels.fetch(storedId).catch(() => null);
			if (existing && existing.type === ChannelType.GuildCategory) return existing as CategoryChannel;
		}

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

	private static async createChannels(
		guild: Guild,
		category: CategoryChannel,
		// The SECOND parent. Passed in rather than resolved here so createChannels
		// stays a pure "build these channels under these parents" step and the
		// 50013 handling lives in one place above.
		gamesCategory: CategoryChannel,
		config: ISetupConfig
	): Promise<{ ids: ICreatedChannels; objects: IChannelObjects }> {
		// public channels, owner can send, everyone else read-only.
		// botSelfOverwrite required: @everyone deny SendMessages otherwise
		// suppresses the bot's posts (intro embed, schedule board, reminders).
		const publicOverwrites = [
			{
				id: guild.roles.everyone.id,
				allow: [PermissionFlagsBits.ViewChannel],
				deny: [PermissionFlagsBits.SendMessages],
			},
			GuildSetupManager.botSelfOverwrite(guild),
			{
				id: config.ownerId,
				allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
			},
		];

		// Introductions is the one member-writable homebase channel: it doubles
		// as a greeter surface where new members answer the welcome icebreaker
		// (welcomeNewMember) and satisfies a Discord Onboarding gate that requires
		// posting in a channel before full access. Same as publicOverwrites but
		// WITHOUT the @everyone SendMessages deny.
		const introOverwrites = [
			{
				id: guild.roles.everyone.id,
				allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
			},
			GuildSetupManager.botSelfOverwrite(guild),
			{
				id: config.ownerId,
				allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
			},
		];

		// admin channel: owner only until Phase 2. botSelfOverwrite
		// required for the same reason as the category: @everyone deny
		// ViewChannel hides the channel from the bot otherwise.
		const adminOverwrites = [
			{
				id: guild.roles.everyone.id,
				deny: [PermissionFlagsBits.ViewChannel],
			},
			GuildSetupManager.botSelfOverwrite(guild),
			{
				id: config.ownerId,
				allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
			},
		];

		const [
			introChannel,
			commandsChannel,
			leaderboardChannel,
			scheduleChannel,
			announcementsChannel,
			adminChannel,
			nextDecreeChannel,
			adminCommandsChannel,
			arcadeRulesChannel,
			arcadeChallengesChannel,
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
				gamesCategoryId: gamesCategory.id,
				arcadeRulesChannelId: arcadeRulesChannel.id,
				arcadeChallengesChannelId: arcadeChallengesChannel.id,
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
				arcadeRulesChannel,
				arcadeChallengesChannel,
			},
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
	private static async populateChannels(discordChannels: IChannelObjects): Promise<{
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
			// ── 🎮 ARCADE GAMES intro anchors ──
			// Same one-key-per-channel slot every other intro gets, so
			// refreshIntroEmbeds edits both cards in place on later boots instead of
			// reposting them. GuildConfig declared these two keys in task 2.1.
			arcadeRulesChannelId: string;
			arcadeChallengesChannelId: string;
			// Second pinned message in #command-center: the standalone invite card.
			inviteCardId: string;
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
			arcadeRulesChannel,
			arcadeChallengesChannel,
		} = discordChannels;

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
			// ── 🎮 ARCADE GAMES ───────────────────────
			// The rules card and the challenge board intro. Neither is pinned, per
			// the pinning policy below: both channels are read-only for members, so
			// there is nothing to bury the bot's message under.
			arcadeRulesMsg,
			arcadeChallengesMsg,
			// Second #command-center message: the standalone invite card (pitch +
			// Dero gif + Summon button), pinned separately from the command guide.
			inviteCardMsg,
		] = await Promise.all([
			// intro channel carries both the introduction embed AND the
			// "Summon me to your server, Mortal" link button. Components
			// travel alongside embeds on send; refreshIntroEmbeds must
			// also pass components on edit or Discord will drop the row.
			introChannel.send({
				embeds: [ChannelContent.introduction()],
				components: GuildSetupManager.resolveIntroComponents("introChannelId") ?? [],
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
			adminCommandsChannel.send({ embeds: [ChannelContent.adminCommandGuide()], components: GuildSetupManager.resolveIntroComponents("adminCommandsChannelId") ?? [] }),
			// The arcade's two cards. Ordering inside this array is load bearing:
			// the destructure above is positional, which is exactly why every entry
			// is named rather than indexed.
			arcadeRulesChannel.send({ embeds: [ChannelContent.arcadeRulesIntro()] }),
			arcadeChallengesChannel.send({ embeds: [ChannelContent.arcadeChallengesIntro()] }),
			// Standalone invite card in #command-center: short pitch + Dero gif + the
			// Summon button. Its own message so the wide button is not crammed into
			// the command guide's row. refreshIntroEmbeds maintains it on boot.
			commandsChannel.send({
				embeds: [ChannelContent.inviteCard()],
				components: GuildSetupManager.inviteCardComponents(),
				files: [buildDeroGifAttachment()],
			}),
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
				arcadeRulesChannelId: arcadeRulesMsg.id,
				arcadeChallengesChannelId: arcadeChallengesMsg.id,
				inviteCardId: inviteCardMsg.id,
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
			...Object.fromEntries(GuildSetupManager.CHANNEL_FIELDS.map((field) => [field, storedIntroIds[field] ?? null])),
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
		};
		let needsPersist = false;

		for (const spec of GuildSetupManager.CHANNEL_SPECS) {
			const channelId = stored[spec.configField] as string | null | undefined;
			if (!channelId) continue;

			const channel = await client.channels.fetch(channelId).catch(() => null);
			if (!channel) {
				console.warn(LOG_MESSAGES.setup.introRefreshChannelMissing(spec.displayName, guild.id));
				continue;
			}
			if (!(channel instanceof TextChannel)) {
				console.warn(LOG_MESSAGES.setup.introRefreshChannelWrongType(spec.displayName, guild.id));
				continue;
			}

			const embed = GuildSetupManager.resolveIntroEmbed(spec.configField, guild, stored.adminRoleId ?? null, stored as unknown as ICopyConfig);
			// Components (eg. the introductions channel's invite button)
			// must be passed explicitly on send, omitting them would
			// silently strip the invite button on every repost.
			// resolveIntroComponents returns null for the channels that
			// have no component surface; we pass `[]` in that case so
			// the send call is explicit about "no components."
			const componentRows = GuildSetupManager.resolveIntroComponents(spec.configField);
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
							await storedMessage.edit({ embeds: [embed], components: componentRows ?? [] });
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
				continue;
			}

			// Genuinely new content. Post a fresh message, unpin the
			// old (if pinned), pin the new, persist. If the post
			// fails, log and bail, we do NOT fall back to editing
			// because the owner's policy forbids it. Next boot will
			// retry cleanly.
			try {
				const message = await channel.send({ embeds: [embed], components: componentRows ?? [] });
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
