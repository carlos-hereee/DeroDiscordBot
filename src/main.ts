import { GatewayIntentBits, Collection, Events, MessageFlags, Client, Partials } from "discord.js";
import { discordToken } from "@utils/config.js";
import clientReady from "@commands/utility/ready.js";
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import type { Server } from "http";
import dns from "dns";
import { startScheduler, stopScheduler } from "@features/reminders/ReminderScheduler.js";
import { connectMongoose, disconnectMongoose } from "@db/db.js";
import { registerActivityListeners } from "@features/activity-tracking/ActivityTracker.js";
import { startApiServer } from "@api/server.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { arrivalEmbed, errorEmbed, pairingCodeEmbed } from "@utils/embedBuilder.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { GuildSetupManager } from "@features/setup/GuildSetupManager.js";
import { registerChannelDeleteWatcher } from "@features/setup/ChannelDeleteWatcher.js";
import { checkOnboardingAndNotifyOwner } from "@features/setup/OnboardingCheck.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { pendingPairingStore } from "@db/stores/pendingPairingStore.js";
import { BOT_LOG_EVENTS } from "@base/constants/BOT_LOG_EVENTS.js";
import { refreshAllSchedules } from "@features/schedule/ScheduleBoard.js";
import { postFeatureAnnouncements } from "@features/announcements/postFeatureAnnouncement.js";
import { registerOutageWatcher } from "@features/observability/outageWatcher.js";
import { LOG_MESSAGES } from "@base/constants/log-messages.js";
import { dispatchButton, dispatchModal } from "@handlers/interactionRegistry.js";
import { registerDecreeEditHandlers } from "@features/schedule/decreeEditHandlers.js";
import { registerLeaderboardChannelHandlers } from "@features/leaderboard/leaderboardChannelHandlers.js";
import { refreshAllNextUp } from "@features/schedule/NextUpBoard.js";
import { refreshAllLeaderboards } from "@features/leaderboard/LeaderboardBoard.js";
import { registerScheduleControlHandlers } from "@features/schedule/ScheduleControls.js";
import { registerSuggestionBoxHandlers } from "@features/suggestion-box/SuggestionBox.js";
import { registerPollHandlers, dispatchPolls, logPollTallies } from "@features/polls/PollDispatcher.js";
import { registerSelfDestructHandlers } from "@features/setup/selfDestruct.js";
import { registerPowerUpHandlers, removeAllPowerUpPanels } from "@features/power-ups/PowerUps.js";
import { registerGreeter, ensureIntroChannelsWritable } from "@features/greeter/welcomeNewMember.js";
import { checkEarlyAccess, earlyAccessEmbed } from "@features/early-access/earlyAccess.js";
import { flushNow, startXpWriter } from "@features/leveling/xpWriter.js";
import { registerMessageXp } from "@features/leveling/messageXp.js";
import { registerReactionXp } from "@features/leveling/reactionXp.js";
import { startVoiceSweep } from "@features/leveling/voiceXp.js";

// ── DNS resolver guard ─────────────────────────────────────────────────────
// Some dev machines leave node's DNS library (c-ares) unable to read the system
// resolver config, so it falls back to its hard-coded 127.0.0.1 default where
// nothing is listening, and EVERY lookup fails with ECONNREFUSED, including the
// Atlas SRV record mongoose needs at startup. Detect that loopback-only fallback
// and point node at public resolvers instead. Runs at module load, before
// connectMongoose (the first DNS consumer) is called below. No-op in production:
// Heroku / Railway report real resolvers, so the condition is false there.
const dnsResolvers = dns.getServers();
if (dnsResolvers.length === 0 || dnsResolvers.every((server) => server === "127.0.0.1" || server === "::1")) {
	console.warn(
		`[dns] system resolver was loopback-only (${dnsResolvers.join(", ") || "none"}); falling back to public DNS so SRV lookups work`
	);
	dns.setServers(["1.1.1.1", "1.0.0.1", "8.8.8.8"]);
}

// paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMembers, // ← needed for member data
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.GuildVoiceStates, // ← needed for VoiceStateUpdate
		GatewayIntentBits.GuildPresences, // ← needed for PresenceUpdate
		// MessageContent intent intentionally NOT requested: the bot reads no
		// message text (every message.content reference is commented-out legacy
		// code, and the one messageCreate listener, leveling's messageXp, reads
		// only WHO posted and WHERE, never the body). MessageContent is a
		// privileged intent gated by Discord verification at 100+ guilds, so
		// requesting it while unused is pure verification risk. Re-add only if a
		// feature genuinely needs to read message bodies.
		//
		// ⚠️ The pressure to re-add it will come from leveling: per word or per
		// character xp is the obvious "improvement" and it is the one thing here
		// that would need this intent. It is also the most gameable mode in that
		// category, which is why xpRules.rollXp takes no message text parameter at
		// all. Adding length based xp would mean deliberately changing a signature,
		// not just flipping this line.
		GatewayIntentBits.GuildMessageReactions, // ← needed for MessageReactionAdd
	],
	// Discord only sends full data for recent messages.
	// For older messages it sends a "partial", an incomplete object with just the ID.
	//  Without declaring `Partials.Message`, `Partials.Reaction`, and `Partials.User`,
	// reactions on reminder messages that are more than a few minutes old will be silently ignored,
	//  and `reaction.fetch()` in the listener won't work correctly.
	partials: [
		Partials.Message, // ← needed to catch reactions on older messages
		Partials.Reaction, // ← needed to catch reactions on older messages
		Partials.User,
	],
});

clientReady(client);

// ── process lifecycle: graceful shutdown + global error nets ──────────
// Railway sends SIGTERM on every deploy. Without a handler the cron keeps
// firing while the client and Mongo connection are torn down, which can cut a
// reminder fire between its Discord post and its dedup-row write (→ a duplicate
// on the next boot). The shutdown sequence stops new work first, then tears
// down in dependency order so an in-flight write has a chance to flush.
let apiServer: Server | undefined;
let isShuttingDown = false;

async function gracefulShutdown(signal: string, exitCode = 0): Promise<void> {
	if (isShuttingDown) return; // a second signal during teardown is a no-op
	isShuttingDown = true;
	console.log(`[shutdown] received ${signal}, shutting down gracefully`);
	// ⓪ flush buffered leveling xp FIRST, while the Mongo connection is still up.
	// Message xp is staged in memory and written on an interval, so a redeploy
	// lands somewhere inside a flush window and would otherwise drop it.
	//
	// ⚠️ This lives INSIDE gracefulShutdown rather than in a second
	// process.on("SIGTERM") in xpWriter, deliberately. A sibling signal listener
	// would race this sequence: the flush could be cut off mid bulkWrite, or fire
	// after ④ below had already closed the socket it needs. One shutdown path,
	// ordered explicitly.
	try {
		await flushNow();
	} catch (err) {
		console.error(LOG_MESSAGES.leveling.shutdownFlushFailed, err);
	}
	// ① stop cron so no new reminder tick begins mid-teardown.
	try {
		stopScheduler();
	} catch (err) {
		console.error("[shutdown] stopScheduler failed", err);
	}
	// ② stop accepting new HTTP requests.
	try {
		apiServer?.close();
	} catch (err) {
		console.error("[shutdown] api server close failed", err);
	}
	// ③ disconnect the gateway (halts interaction + event handling).
	try {
		await client.destroy();
	} catch (err) {
		console.error("[shutdown] client.destroy failed", err);
	}
	// ④ close Mongo last so any in-flight write lands before the socket drops.
	try {
		await disconnectMongoose();
	} catch (err) {
		console.error("[shutdown] mongoose disconnect failed", err);
	}
	console.log("[shutdown] complete");
	process.exit(exitCode);
}

process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));

// The bot has many fire-and-forget side effects; an unhandled rejection should
// be logged, not crash the process. An uncaught exception leaves an undefined
// state, so we tear down cleanly and let Railway restart us with a non-zero
// code rather than limp along corrupted.
process.on("unhandledRejection", (reason) => {
	console.error("[process] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
	console.error("[process] uncaughtException:", err);
	void gracefulShutdown("uncaughtException", 1);
});

// load commands first
(async () => {
	// step 1 - load commands
	client.commands = new Collection();
	const ADMIN_COMMANDS = new Set<string>(BOT_CONSTANTS.ADMIN_COMMANDS);

	const foldersPath = path.join(__dirname, "commands");
	const commandFolders = fs.readdirSync(foldersPath);

	// command loader loop
	for (const folder of commandFolders) {
		const commandsPath = path.join(foldersPath, folder);
		const commandFiles = fs.readdirSync(commandsPath).filter((file) => file.endsWith(".js") || file.endsWith(".cjs"));
		for (const file of commandFiles) {
			const filePath = path.join(commandsPath, file);
			const commandModule = await import(pathToFileURL(filePath).href);
			const command = commandModule.default ?? commandModule; // handles both cases

			if ("data" in command && "execute" in command) {
				client.commands.set(command.data.name, command);
			} else console.warn(LOG_MESSAGES.main.commandLoadWarning(filePath));
		}
	}

	// step 2 - connect to db before starting the bot to ensure it's ready when commands are executed
	await connectMongoose();

	// step 3 - set up event listeners before logging in, to avoid missing any events that fire on startup (like guildCreate)
	//
	// guildCreate handles three distinct re-entries:
	//   ① brand new install: no GuildConfig row at all → autoSetup
	//      builds the homebase from scratch + DM the owner.
	//   ② re-install after a wipe: GuildConfig row exists with
	//      setupComplete=true, but the user kicked the bot, deleted
	//      the category/channels, and re-invited. The DB still says
	//      "all good" but Discord side is empty. We need to rebuild.
	//      Without this branch, the bot would silently no-op on
	//      re-invite and the owner would think self-heal was broken.
	//   ③ partial re-install: row exists but setupComplete=false
	//      (rare; usually means an earlier autoSetup crashed mid-way).
	//      Treat the same as ① and run autoSetup.
	//
	// ensureHomebase is the right tool for ②: it checks the stored
	// category id against Discord, falls through to rebuildFromStaleConfig
	// when the category is gone, and posts a "castle rebuilt" notice in
	// the new inner sanctum. It's idempotent, so calling it on every
	// guildCreate is safe even when the homebase is already healthy.
	client.on(Events.GuildCreate, async (guild) => {
		try {
			const alreadyBuilt = await guildConfigStore.findByGuildId(guild.id);

			// ② re-install after a wipe. Hand off to ensureHomebase
			// instead of short-circuiting. ensureHomebase will detect
			// the missing category, run rebuildFromStaleConfig, and
			// post the recovery notice. We do NOT re-DM the owner here
			// because the INTRO_DM_SENT log is still set from the
			// original install, re-DMing on every re-invite would be
			// noise.
			if (alreadyBuilt?.setupComplete) {
				await GuildSetupManager.ensureHomebase(client, guild);
				// Onboarding check on re-install too. A guild paired before this
				// feature shipped may have Onboarding enabled and would not have
				// been DM'd yet; the idempotency log gates duplicates.
				await checkOnboardingAndNotifyOwner(client, guild);
				// ── pairing code DM (FUTURE_PLANS item 63, Phase 1) ──
				// On a re-invite the owner may be following the dashboard panel's
				// instruction to claim this guild, so the pairing code is the ONLY
				// DM here: INTRO_DM_SENT is already set from the original install,
				// so no arrival DM fires. Self-contained try/catch because some
				// owners block DMs and a failed pairing DM must not abort
				// guildCreate. PAIRING_CODE_SENT is logged only after the DM
				// actually leaves so the funnel counts delivered codes.
				try {
					const owner = await guild.fetchOwner();
					const pairingCode = await pendingPairingStore.issue(guild.id, guild.ownerId);
					await owner.send({ embeds: [pairingCodeEmbed(pairingCode)] });
					await botLogStore.log(guild.id, BOT_LOG_EVENTS.PAIRING_CODE_SENT, { ownerId: guild.ownerId });
				} catch (pairingError) {
					console.warn(`[main] pairing code DM failed for guild ${guild.id}`, pairingError);
				}
				return;
			}

			// ① + ③ first-time or partial install.
			const owner = await guild.fetchOwner();
			await GuildSetupManager.autoSetup(guild, { guildId: guild.id, ownerId: guild.ownerId });
			await owner.send({ embeds: [arrivalEmbed(guild.name, owner.id)] });
			await botLogStore.log(guild.id, BOT_LOG_EVENTS.INTRO_DM_SENT, { ownerId: guild.ownerId });
			// ── pairing code DM (FUTURE_PLANS item 63, Phase 1) ──
			// A second DM right after the arrival embed so a brand-new owner can
			// claim this guild from the plugin dashboard with no slash command.
			// Self-contained try/catch so a blocked-DM owner does not abort the
			// rest of guildCreate, and PAIRING_CODE_SENT is logged only when the
			// DM actually leaves so the funnel counts delivered codes.
			try {
				const pairingCode = await pendingPairingStore.issue(guild.id, guild.ownerId);
				await owner.send({ embeds: [pairingCodeEmbed(pairingCode)] });
				await botLogStore.log(guild.id, BOT_LOG_EVENTS.PAIRING_CODE_SENT, { ownerId: guild.ownerId });
			} catch (pairingError) {
				console.warn(`[main] pairing code DM failed for guild ${guild.id}`, pairingError);
			}
			// Onboarding compat heads-up. Fires AFTER the arrival DM so the
			// owner gets the welcome before the operational notice. The
			// helper bails silently when Onboarding is off or our category
			// is already in the default channel list, which is the common
			// case for non-community-enabled guilds.
			await checkOnboardingAndNotifyOwner(client, guild);
		} catch (error) {
			// Do NOT leave the guild on autoSetup failure. The bot stays in the
			// guild so ensureHomebase can self-heal on the next boot via the
			// rebuild paths. Leaving was the old behavior, it forced owners to
			// re-invite manually after any transient failure (Discord 5xx, rate
			// limit, mid-build disconnect), which is harsher than the partial
			// install state ensureHomebase already knows how to recover from.
			console.error(LOG_MESSAGES.main.autoSetupFailed(guild.id), error);
		}
	});
	// register persistent button + modal handlers BEFORE the listener
	// installs. Each register* call is idempotent at module level, the
	// registry throws if the same prefix gets registered twice, which
	// surfaces a duplicate-bootstrap bug at boot rather than at the first
	// click. Add new handler registrations here as new persistent UIs ship.
	registerDecreeEditHandlers();
	registerLeaderboardChannelHandlers();
	registerScheduleControlHandlers();
	registerSuggestionBoxHandlers();
	registerPollHandlers();
	registerSelfDestructHandlers();
	registerPowerUpHandlers();

	// then register the interaction  listerner
	client.on(Events.InteractionCreate, async (interaction) => {
		// handle autocomplete interactions first, before command checks
		if (interaction.isAutocomplete()) {
			const command = client.commands.get(interaction.commandName);
			if (command?.autocomplete) await command.autocomplete(interaction);
			return;
		}

		// ── persistent button dispatch ──
		// What:  routes button clicks (Edit on a NextUpBoard post, etc) to
		//        the registered handler in interactionRegistry.
		// When:  every Discord ButtonInteraction. A `false` return from
		//        dispatchButton means no global handler matched, that's
		//        the expected case for buttons consumed by an inline
		//        awaitMessageComponent collector inside a slash command
		//        (configure-rok-reminders, the apply-scope flow inside
		//        decreeEditHandlers, etc). Both listeners receive the
		//        same InteractionCreate event; whichever has a matching
		//        handler acks the interaction.
		// Where: handlers register their prefix at boot (registerDecreeEdit
		//        Handlers above). Per-handler permission gates live inside
		//        the handler, the dispatcher does not authorize.
		if (interaction.isButton()) {
			try {
				await dispatchButton(interaction);
			} catch (error) {
				console.error(`[interactions] button handler threw for customId='${interaction.customId}'`, error);
				if (!interaction.replied && !interaction.deferred) {
					await interaction
						.reply({
							embeds: [errorEmbed(rokCommanderCopy.responses.commandExecuteFailure)],
							flags: MessageFlags.Ephemeral,
						})
						.catch(() => undefined);
				}
			}
			return;
		}

		// ── persistent modal dispatch ──
		// Same dispatch model as buttons. Modals submitted by an inline
		// awaitModalSubmit collector (configure-rok-reminders' checklist
		// modal) flow through here too; dispatchModal returns false and
		// the inline collector handles the submit.
		if (interaction.isModalSubmit()) {
			try {
				await dispatchModal(interaction);
			} catch (error) {
				console.error(`[interactions] modal handler threw for customId='${interaction.customId}'`, error);
				if (!interaction.replied && !interaction.deferred) {
					await interaction
						.reply({
							embeds: [errorEmbed(rokCommanderCopy.responses.commandExecuteFailure)],
							flags: MessageFlags.Ephemeral,
						})
						.catch(() => undefined);
				}
			}
			return;
		}

		if (!interaction.isChatInputCommand()) return;

		const command = client.commands.get(interaction.commandName);
		if (!command) {
			console.error(LOG_MESSAGES.main.noCommandMatch(interaction.commandName));
			return;
		}

		// ── admin role guard ───────────────────────────────────────────
		// skip for /setup, it has its own owner-only check
		if (interaction.commandName !== "setup") {
			const config = await guildConfigStore.findByGuildId(interaction.guildId!);

			if (ADMIN_COMMANDS.has(interaction.commandName)) {
				// guild hasn't run /setup yet, no config means no admin role is defined
				if (!config) {
					await interaction.reply({
						embeds: [errorEmbed(rokCommanderCopy.responses.setupRequired)],
						flags: MessageFlags.Ephemeral,
					});
					return;
				}

				const isOwner = interaction.user.id === interaction.guild?.ownerId;
				// Resolve the invoking member cache-first, then fall back to a fetch.
				// The members cache can be cold (large guild, fresh restart, gateway
				// gap), and a cache miss previously denied a legitimate admin with
				// "no wizard powers." Only pay the fetch when there is an adminRoleId
				// to check and the actor is not already the owner, so the hot paths
				// (owner, or guild with no admin role) stay cache-only.
				let member = interaction.guild?.members.cache.get(interaction.user.id) ?? null;
				if (!member && !isOwner && config.adminRoleId) {
					member = (await interaction.guild?.members.fetch(interaction.user.id).catch(() => null)) ?? null;
				}
				const hasAdminRole = (config.adminRoleId && member?.roles.cache.has(config.adminRoleId)) ?? false;

				if (!isOwner && !hasAdminRole) {
					await interaction.reply({
						embeds: [errorEmbed(rokCommanderCopy.responses.noWizardPowers)],
						flags: MessageFlags.Ephemeral,
					});
					return;
				}
			}
		}

		// ── Studio early-access gate ("Dero's new powers first") ──
		// A command listed in EARLY_ACCESS_FEATURES stays exclusive to Studio-owned guilds
		// until its release date, then opens to all. Runs AFTER the admin guard so a
		// permission failure takes precedence over the upsell. Skips DMs (no guildId), and
		// for the un-listed common case returns instantly with no network call.
		if (interaction.guildId) {
			const access = await checkEarlyAccess(interaction.commandName, interaction.guildId);
			if (!access.allowed && access.generalReleaseAt) {
				await interaction.reply({
					embeds: [earlyAccessEmbed(access.generalReleaseAt)],
					flags: MessageFlags.Ephemeral,
				});
				return;
			}
		}

		try {
			await command.execute(interaction);
		} catch (error) {
			console.error(LOG_MESSAGES.main.commandExecuteError(interaction.commandName), error);

			// interaction might already be replied to
			if (interaction.replied || interaction.deferred) {
				await interaction.followUp({
					embeds: [errorEmbed(rokCommanderCopy.responses.commandExecuteFailure)],
					flags: MessageFlags.Ephemeral,
				});
			} else {
				await interaction.reply({
					embeds: [errorEmbed(rokCommanderCopy.responses.commandExecuteFailure)],
					flags: MessageFlags.Ephemeral,
				});
			}
		}
	}); // start the scheduler after commands are loaded
	// && after client is ready (since it relies on the client to send messages)
	client.once(Events.ClientReady, async () => {
		// set bot presence. Activity name is the bot's status line under
		// its username in the member list. Default activity type is
		// Watching, so this renders as "Watching 🎙️ Tuning the realm".
		client.user?.setPresence({ activities: [{ name: "🎙️ Tuning the realm" }], status: "online" });

		// start scheduler and activity tracker, and API server
		startScheduler(client);
		registerActivityListeners(client);
		apiServer = startApiServer(client);

		// ── leveling ──────────────────────────────────────────────
		// What: the bot's first messageCreate listener, a SECOND
		//       MessageReactionAdd listener beside ActivityTracker's, an
		//       interval sweep over cached voice states, and the buffered
		//       writer they all stage into.
		// Who:  src/features/leveling/. Registered here, right after
		//       registerActivityListeners, because the reaction listener is
		//       deliberately a sibling of that one and the two are easiest to
		//       reason about when they are declared together.
		// When: once per boot. Leveling is ON in every guild by default (the
		//       owner's locked decision), so these are live everywhere
		//       immediately; per guild it is switched by
		//       GuildConfig.leveling.enabled, which needs no deploy.
		// Where: the writer must start BEFORE the listeners, or a message
		//       arriving in the same tick would stage into a buffer with no
		//       flush timer behind it. Its shutdown flush is step ⓪ of
		//       gracefulShutdown above, not a second signal listener.
		startXpWriter(client);
		registerMessageXp(client);
		registerReactionXp(client);
		startVoiceSweep(client);

		// ── outage watcher ────────────────────────────────────────
		// Polls serverApi reachability state every 60s. DMs the platform
		// owner once if the server is unreachable for >= 5 minutes, and
		// once again when it recovers. No-op when CREATOR_DISCORD_ID is
		// unset (logs a warn so operators notice on first boot). Fully
		// decoupled from the request path, outageWatcher only reads
		// state, never participates in the actual server calls.
		registerOutageWatcher(client);

		// ── realtime homebase self heal ───────────────────────────
		// Registered BEFORE the ensureHomebase boot sweep below so the
		// gateway listener is live the moment the bot is ready. Pairs
		// with the boot sweep: realtime handles single channel deletions
		// as they happen; boot sweep catches anything that was deleted
		// while the bot was offline. See ChannelDeleteWatcher.ts for the
		// cooldown + ownership probe contract.
		registerChannelDeleteWatcher(client);

		// ── new-member greeter ────────────────────────────────────
		// Attach the guildMemberAdd listener so new joins get welcomed (ping +
		// random icebreaker) in the introductions channel. Needs the GuildMembers
		// intent, already enabled above. ensureIntroChannelsWritable (after the
		// homebase sweep) makes existing guilds' intro channels member-writable
		// so newcomers can actually answer.
		registerGreeter(client);

		// ── homebase self heal on wake up ──────────────────────────
		// What: every guild the bot is cached in gets an ensureHomebase pass.
		//       That method checks category presence + ownership, scans each
		//       of the six child channels, and rebuilds any that were deleted
		//       while the bot was offline. Missing single channels get a per
		//       channel audit notice posted to the inner sanctum; a fully
		//       missing category triggers a reconstruction plus a "castle
		//       rebuilt" embed in the new inner sanctum.
		// Who:  ensureHomebase lives on GuildSetupManager and centralizes the
		//       detect + rebuild logic so the runtime self heal in
		//       ScheduleBoard.postOrEdit and this boot time sweep follow the
		//       same provenance rules.
		// When: exactly once per process boot, right after the scheduler /
		//       activity / api server are up so anything ensureHomebase posts
		//       into the new schedule channel can be refreshed immediately by
		//       refreshAllSchedules below.
		// Where: the arrival DM only fires on "built" (first time construct).
		//        "rebuilt" and "repaired" are self narrating inside the inner
		//        sanctum, so re DMing the owner would be noise.
		// How:  ensureHomebase returns { action, repairedChannels }.
		//       "built" is the only branch that warrants the arrival DM, and
		//       even then we respect the INTRO_DM_SENT log so re running a
		//       build in edge cases (DB wipe but owner already greeted) does
		//       not double DM.
		for (const guild of client.guilds.cache.values()) {
			try {
				const result = await GuildSetupManager.ensureHomebase(client, guild);

				if (result.action === "built") {
					// first time build for this guild. preserve the original
					// arrival DM behavior, guarded by the existing bot log so
					// we never spam an owner we've already greeted.
					const alreadyIntroduced = await botLogStore.has(guild.id, BOT_LOG_EVENTS.INTRO_DM_SENT);
					if (!alreadyIntroduced) {
						const owner = await guild.fetchOwner();
						await owner.send({ embeds: [arrivalEmbed(guild.name, owner.id)] });
						await botLogStore.log(guild.id, BOT_LOG_EVENTS.INTRO_DM_SENT, { ownerId: guild.ownerId });
					}
				}
				// "rebuilt", "repaired", and "skipped" paths are handled
				// entirely inside ensureHomebase (which posts the castle /
				// per channel notices into the inner sanctum for the first
				// two). nothing else to do here.

				// ── Discord Onboarding compat heads-up ───────────────
				// Restart-coverage for guilds paired before FUTURE_PLANS
				// item 35 shipped. The helper is idempotent via the
				// ONBOARDING_HEADSUP_SENT log key so once-per-guild DM
				// behavior holds across boots. Failure to check is
				// non-fatal, the bot still runs, just without the
				// proactive heads-up for that one guild.
				try {
					await checkOnboardingAndNotifyOwner(client, guild);
				} catch (onboardingError) {
					console.warn(`[main] onboarding compat check failed for guild ${guild.id}`, onboardingError);
				}

				// Schedule board control row (Go Live + phase-gated Pause/Resume
				// toggle) is rebuilt by refreshAllSchedules below on every boot, so
				// no separate boot-time attach step is needed anymore.

				// ── intro embed refresh ───────────────────────────────
				// What: after ensureHomebase has confirmed (or rebuilt) the
				//       homebase for this guild, sweep the six stored intro
				//       messages and edit them in place so copy changes in
				//       the copy packs (@base/copy/packs) land on the next
				//       boot without forcing an admin to rebuild.
				// When: only after ensureHomebase finishes so we never edit
				//       a channel that was just deleted. A fresh "built"
				//       already wrote the latest copy so this call is a no
				//       op for that branch, but running it uniformly keeps
				//       the code path simple and the logs symmetric.
				// Where: failures here must not cancel the rest of the boot
				//        loop, swallow with a log so one guild cannot stall
				//        the others.
				try {
					await GuildSetupManager.refreshIntroEmbeds(client, guild);
				} catch (refreshError) {
					console.error(LOG_MESSAGES.main.autoSetupFailedSkipping(guild.id), refreshError);
				}

				// Rename any homebase channel still on an old default name to the
				// current default (e.g. 🛡️next-decree → 🔜upcoming-events), unless an
				// admin set a custom name via /rename-channel. Removes the "delete +
				// re-run /setup" friction for guilds on default channel names.
				try {
					await GuildSetupManager.renameDriftedChannels(client, guild);
				} catch (renameError) {
					console.error(LOG_MESSAGES.main.autoSetupFailedSkipping(guild.id), renameError);
				}
			} catch (error) {
				console.error(LOG_MESSAGES.main.autoSetupFailedSkipping(guild.id), error);

				// ── auto-leave on Missing Permissions (2026-05-11) ──
				// When ensureHomebase / autoSetup fails with Discord error
				// 50013 (Missing Permissions), the bot is in this guild but
				// cannot construct its homebase. It will fail the same way
				// every boot until either (a) the admin grants Administrator
				// permission or (b) we leave. Real example: guild
				// 745227275196170320 sat in this state for over a month with
				// no recovery. Leaving frees the slot toward Discord's 100-
				// guild verification threshold and surfaces the issue to the
				// admin (who has to re-invite if they want the bot back).
				// We attempt a brief owner DM first so the admin understands
				// why; swallow DM failures because some owners disable DMs
				// from non-friends and the leave should still proceed.
				const errCode = (error as { code?: number } | undefined)?.code;
				if (errCode === 50013) {
					try {
						const owner = await guild.fetchOwner().catch(() => null);
						if (owner) {
							await owner
								.send({
									content:
										`Hi! I tried to set up shop in **${guild.name}** but Discord blocked me from creating my channels (Missing Permissions). ` +
										`I've left the server to keep things tidy. If you want me back, re-invite me with the Administrator scope and I'll set up cleanly. ` +
										`Questions: silent6804 on Discord.`,
								})
								.catch(() => null);
						}
					} catch {
						// owner DM failure is non-fatal; leave still proceeds
					}
					try {
						await guild.leave();
						console.warn(
							`[auto-leave] left guild ${guild.id} (${guild.name}) due to 50013 Missing Permissions during autoSetup. Re-invite with Administrator scope to recover.`
						);
					} catch (leaveError) {
						console.error(`[auto-leave] failed to leave guild ${guild.id}`, leaveError);
					}
				}
			}
		}

		// ── startup rehydration of the schedule board ──
		// What: refresh every guild's pinned schedule message so it reflects
		//       current state after any downtime.
		// Who:  every guild the bot is in, regardless of setup state. Guilds
		//       still mid autoSetup are no-ops inside refreshSchedule.
		// When: once per process lifecycle, right after auto setup sweeps and
		//       before we hand control over to the schedulers.
		// Where: pairs with the hourly safety tick inside startScheduler and
		//        the on-change triggers scattered across events.routes,
		//        ReminderJob, and GuildEventManager.
		// How:  iterates client.guilds.cache sequentially (alphabetical by
		//       guild id) so errors on one guild cannot stall the rest.
		await refreshAllSchedules(client);

		// ── startup rehydration of the leaderboard board ──
		// What: refresh every guild's pinned leaderboard message so this week's
		//       standings are current after any downtime, and so the weekly
		//       window reflects the right week on boot (a bot that was offline
		//       across a week rollover would otherwise show last week until the
		//       next activity or reminder fire).
		// Where: mirrors refreshAllSchedules above. Per-guild errors are logged
		//        and swallowed inside refreshLeaderboard so one bad guild cannot
		//        stall the rest.
		await refreshAllLeaderboards(client);

		// ── startup sweep of next-decree boards ──
		// What: posts every upcoming decree in the next 24h horizon to each
		//       guild's nextDecreeChannelId. Pairs with refreshAllSchedules:
		//       schedules are edited in place, next-decree posts are NEW.
		// When: once per boot. The dedup Set inside NextUpBoard guarantees
		//       a re-boot within 24h does not duplicate posts already made
		//       by a prior process, except across a restart, where some
		//       overlap is the accepted trade-off (channel is append-only).
		// Where: failures per-guild are logged and swallowed inside
		//        refreshAllNextUp; one bad guild does not stall the others.
		await refreshAllNextUp(client);

		// ── retire the old standalone control panels (2026-06 fold-in) ──
		// What: the channel controls (toggle pings, say hello, refresh) moved
		//       off standalone "power-up" panels onto the pinned intro guides.
		//       This one-time sweep deletes any leftover panel + clears its id.
		// When: after the homebase sweep so the channels still exist to clean.
		//       Idempotent; per-guild failures are logged and swallowed inside
		//       the sweep so one bad guild cannot stall the rest.
		await removeAllPowerUpPanels(client);

		// ── make existing guilds' introductions channels member-writable ──
		// New guilds get this from createChannels' introOverwrites; this
		// idempotent sweep brings guilds set up before the greeter shipped into
		// line so newcomers can post their answer to the welcome icebreaker.
		await ensureIntroChannelsWritable(client);

		// ── feature announcement sweep ─────────────────────────────
		// What: once-per-version broadcast to every setup-complete guild.
		//       Public post lands in #announcements, admin post in
		//       #inner-sanctum. Idempotent via botLogStore, most boots
		//       are no-ops, only the first boot after a deploy posts.
		// Who:  postFeatureAnnouncements in features/announcements/.
		//       Reads package.json version synchronously at module load.
		// When: runs LAST in the boot sequence so ensureHomebase +
		//       refreshIntroEmbeds + refreshAllSchedules have finished
		//       and channel ids in GuildConfig are freshest.
		// Where: fire-and-forget? NO, we await it, but internally each
		//        guild is isolated so one failure cannot stall others.
		//        Errors are logged and swallowed inside the helper.
		await postFeatureAnnouncements(client);

		// ── audience poll broadcast ──────────────────────────────
		// What: broadcast each active poll to eligible guilds once (idempotent
		//       per poll via the poll_sent botLog key), then log the cross-guild
		//       tally so the platform owner can read accumulating results from
		//       Railway logs.
		// When: boot tail, after postFeatureAnnouncements, so channel ids in
		//       GuildConfig are freshest. Same per-guild isolation, one guild's
		//       failure cannot stall the rest (handled inside dispatchPolls).
		await dispatchPolls(client);
		await logPollTallies();

		console.log(LOG_MESSAGES.main.readyBanner(client.user?.tag ?? "unknown"));
	});

	// login the bot after everything is set up
	await client.login(discordToken);
})();
