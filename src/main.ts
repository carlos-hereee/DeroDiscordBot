import { GatewayIntentBits, Collection, Events, Client, Partials } from "discord.js";
import { arcadeMonthlyPostRunOnBoot, deroVoiceSamplerEnabled, discordToken, weeklyDigestRunOnBoot } from "@utils/config.js";
import clientReady from "@handlers/clientReady.js";
import { registerClientErrorListeners } from "@handlers/clientErrorListeners.js";
import { answerInteractionFailure } from "@handlers/interactionFailure.js";
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
import { arrivalEmbed, pairingCodeEmbed } from "@utils/embedBuilder.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { GuildSetupManager } from "@features/setup/GuildSetupManager.js";
import { registerChannelDeleteWatcher } from "@features/setup/ChannelDeleteWatcher.js";
import { checkOnboardingAndNotifyOwner } from "@features/setup/OnboardingCheck.js";
import { backfillSetupInvitations, sendSetupInvitation } from "@features/setup/setupInvitation.js";
import { migrateArcadeChannelFields } from "@features/setup/migrateArcadeChannelFields.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { pendingPairingStore } from "@db/stores/pendingPairingStore.js";
import { BOT_LOG_EVENTS } from "@base/constants/BOT_LOG_EVENTS.js";
import { refreshAllSchedules } from "@features/schedule/ScheduleBoard.js";
import { postFeatureAnnouncements } from "@features/announcements/postFeatureAnnouncement.js";
import { registerOutageWatcher } from "@features/observability/outageWatcher.js";
import { LOG_MESSAGES } from "@base/constants/log-messages.js";
import { dispatchButton, dispatchModal, dispatchSelectMenu } from "@handlers/interactionRegistry.js";
import { registerDecreeEditHandlers } from "@features/schedule/decreeEditHandlers.js";
import { registerLeaderboardChannelHandlers } from "@features/leaderboard/leaderboardChannelHandlers.js";
import { refreshAllNextUp } from "@features/schedule/NextUpBoard.js";
import { refreshAllLeaderboards } from "@features/leaderboard/LeaderboardBoard.js";
import { registerScheduleControlHandlers } from "@features/schedule/ScheduleControls.js";
import { registerSuggestionBoxHandlers } from "@features/suggestion-box/SuggestionBox.js";
import { registerArcadeHostHandlers } from "@features/games/arcadeHost.js";
import { registerSoloLuckHandlers } from "@features/games/soloLuck.js";
import { registerClaimRoundHandlers } from "@features/economy/chipClaim.js";
import { registerCoinMarketHandlers } from "@features/economy/coinMarketPanel.js";
import { migrateGlobalChipWallets } from "@features/economy/migrateGlobalChipWallets.js";
import { registerPartyGameHandlers } from "@features/game-rooms/partyGames.js";
import { registerGameRequestHandlers } from "@features/game-rooms/gameRequestHandlers.js";
import { registerGameRoomHandlers } from "@features/game-rooms/gameRoomHandlers.js";
import { registerGameRoomMemberRemoveWatcher } from "@features/game-rooms/guildMemberRemoveWatcher.js";
import { recoverGameRoomsOnBoot } from "@features/game-rooms/roomBootRecovery.js";
import { reconcileSatellitesOnBoot, registerSatelliteWatchers } from "@features/game-rooms/satelliteSeats.js";
import { startNetworkBoards } from "@features/game-rooms/networkBoard.js";
import { registerTagNotice } from "@features/ratings/tagNotice.js";
import { sweepHoldemClocks } from "@features/game-rooms/roomHoldemHandlers.js";
import { sweepBotTurns } from "@features/game-rooms/botTurns.js";
import { logMonopolyRendererStatus } from "@features/games/monopolyRenderer.js";
import { logCanvasRendererStatus, logDeroArtStatus } from "@features/renderer/index.js";
import { sweepMonopolyAuctions } from "@features/game-rooms/roomMonopolyAuction.js";
import { registerPollHandlers, dispatchPolls, logPollTallies } from "@features/polls/PollDispatcher.js";
import { registerSelfDestructHandlers } from "@features/setup/selfDestruct.js";
import { registerRulesEditHandlers } from "@features/setup/rulesEdit.js";
import { registerAdoptionChoiceHandlers } from "@features/setup/adoptionChoice.js";
import { registerHeadquartersStepHandlers } from "@features/setup/headquartersSteps.js";
import { registerCommunityStateSync, registerCommunityHandlers } from "@features/community/communityButtons.js";
import { registerWelcomeLog } from "@features/setup/welcomeLog.js";
import { registerPowerUpHandlers, removeAllPowerUpPanels } from "@features/power-ups/PowerUps.js";
import { registerAdminCommandLauncher } from "@features/command-buttons/adminCommandLauncher.js";
import { registerVoiceRoomControlHandlers } from "@features/voice/voiceRoomControlHandlers.js";
import { registerListenHandlers } from "@features/voice/listenHandler.js";
import { registerHoldemRulesCardHandlers } from "@features/dero-brain/holdemRulesCard.js";
import { voiceSessions } from "@features/voice/voiceSessions.js";
import { voiceQueue } from "@features/voice/voiceQueue.js";
import { afterQueueChange as logQueueChange, registerVoiceQueueLogHandlers } from "@features/voice/voiceQueueLog.js";
import { afterQueueChange as redrawQueuedCards } from "@features/game-rooms/cardVoice.js";
import { runQueuedJoin } from "@commands/utility/dero.js";
import { registerVoiceSessionWatchers } from "@features/voice/voiceSessionWatchers.js";
import { startVoiceListener } from "@features/voice/voiceListener.js";
import { startSoakSampler } from "@features/voice/soakSampler.js";
import { registerGreeter, ensureIntroChannelsWritable } from "@features/greeter/welcomeNewMember.js";
import { runWeeklyDigest, startWeeklyDigest } from "@features/leveling/weeklyDigest.js";
import { runMonthlyArcadePost } from "@features/ratings/monthlyArcadePost.js";
import { checkEarlyAccess, earlyAccessEmbed } from "@features/early-access/earlyAccess.js";
import { isAdminCommand } from "@utils/permissions.js";
import { registerNoticeModal, showEmbedNotice, showNotice } from "@utils/textModal.js";
import { flushNow, startXpWriter } from "@features/leveling/xpWriter.js";
import { registerMessageXp } from "@features/leveling/messageXp.js";
import { registerReactionXp } from "@features/leveling/reactionXp.js";
import { startVoiceSweep } from "@features/leveling/voiceXp.js";
import { refreshAllLevelsBoards } from "@features/leveling/LevelsBoard.js";
import { getPluginCopy } from "@base/copy/getCopy.js";

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
registerClientErrorListeners(client);

// ── process lifecycle: graceful shutdown + global error nets ──────────
// Railway sends SIGTERM on every deploy. Without a handler the cron keeps
// firing while the client and Mongo connection are torn down, which can cut a
// reminder fire between its Discord post and its dedup-row write (→ a duplicate
// on the next boot). The shutdown sequence stops new work first, then tears
// down in dependency order so an in-flight write has a chance to flush.
let apiServer: Server | undefined;
// The Dero voice soak sampler, or null when DERO_VOICE_SAMPLER is not 1.
let soakSampler: { stop(): void } | null = null;
// The weekly digest cron, or null before ClientReady has started it.
let weeklyDigest: { stop(): void } | null = null;
let isShuttingDown = false;

async function gracefulShutdown(signal: string, exitCode = 0): Promise<void> {
	if (isShuttingDown) return; // a second signal during teardown is a no-op
	isShuttingDown = true;
	console.log(`[shutdown] received ${signal}, shutting down gracefully`);
	// A hard deadline for the whole sequence below: a flush, a gateway destroy or a Mongo close
	// that hangs (Atlas down is the likely one) would otherwise leave a process that has already
	// stopped its crons sitting there forever, never restarted. unref so it never holds a clean
	// exit open.
	setTimeout(() => {
		console.error(`[shutdown] still running after ${BOT_CONSTANTS.SHUTDOWN_DEADLINE_MS}ms, exiting`);
		process.exit(exitCode);
	}, BOT_CONSTANTS.SHUTDOWN_DEADLINE_MS).unref();
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
	// Still step ⓪: end every voice call while the gateway is up. Destroying a voice
	// connection sends its "leave the channel" update through the gateway
	// adapter, so after ③ it could only time out and leave Dero sitting in the
	// channel until Discord noticed the process was gone. Synchronous: it only
	// queues the leave and clears each session's timers.
	try {
		soakSampler?.stop();
		voiceSessions.leaveAll();
	} catch (err) {
		console.error("[shutdown] voice leaveAll failed", err);
	}
	// ① stop cron so no new reminder tick begins mid-teardown.
	try {
		weeklyDigest?.stop();
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

	// step 2b: sum the per server chip wallets into each member's global wallet (2026-10
	// item 267 Session 1a) before any handler registers, so no claim or buy in reads a
	// global row the migration has not filled yet. Idempotent, so it runs every boot; a
	// failure is logged and boot continues, because unmigrated rows are retried next boot.
	try {
		await migrateGlobalChipWallets();
	} catch (error) {
		console.error("[economy] the global chip wallet migration failed; it runs again next boot", error);
	}

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
				// The clickable /setup invitation (2026-11 item 285 Phase 1), after the
				// pairing code. Once per guild ever, so a re-invite of a guild already
				// invited sends nothing; never throws, so nothing here awaits it.
				void sendSetupInvitation(guild, client);
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
			// The clickable /setup invitation (2026-11 item 285 Phase 1), right after the
			// pairing code. Fire and forget: it never throws and logs its own outcome.
			void sendSetupInvitation(guild, client);
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
	// The Host a game buttons and the hangman category start on the 🕹️games intro.
	// Registered by customId PREFIX at the client level, like every other handler
	// here, so the buttons keep working on a card posted by an earlier deploy,
	// including the old 📋arcade-rules card that still carries the host row.
	registerArcadeHostHandlers();
	// The solo luck row against Dero on the 🕹️games intro (2026-10 item 245 Phase 4a).
	registerSoloLuckHandlers();
	// 🎉party-games' Host hangman and Schedule buttons, the schedule modal and the RSVP
	// buttons in 🔜upcoming-events (post-launch plan item 3).
	registerPartyGameHandlers();
	// The game request ballot behind the 📋arcade-rules card's button (same phase).
	registerGameRequestHandlers();
	// The in-room controls (Archive now, Forfeit). Registered at the client level
	// like the rest, so a result card posted by an earlier deploy keeps working:
	// a room's buttons outlive the room, and its customIds outlive the deploy.
	registerGameRoomHandlers();
	// The voice queue's 🗒️admin-log entries: Move up, Move down and Remove (2026-10 item 267).
	registerVoiceQueueLogHandlers();
	registerPollHandlers();
	registerSelfDestructHandlers();
	// The Edit rules button on the 📘rules post (2026-10 item 247 Phase 2).
	registerRulesEditHandlers();
	// The Choose button on the card listing the server's own welcome and rules
	// channels, and its modal (2026-10 item 257 Phase 1a).
	registerAdoptionChoiceHandlers();
	// The 🏰 DERO HEADQUARTERS step buttons and the voice priority modal (2026-10 item
	// 257 Phase 2b), on the one "hqstep" prefix.
	registerHeadquartersStepHandlers();
	// Enable Community, its Confirm, and Configure Onboarding on the admin guide
	// (2026-10 item 247 Phase 3), all on the one "community" prefix.
	registerCommunityHandlers();
	// The close of every notice modal an admin control answers with instead of a
	// message left to dismiss (post-launch plan item 9), on the one "notice" prefix.
	registerNoticeModal();
	registerPowerUpHandlers();
	registerClaimRoundHandlers();
	registerCoinMarketHandlers();
	// Every admin command's button on the admin guide, with the pick, the optional
	// field pick and the form each one opens (2026-10 item 245 Phase 4b).
	registerAdminCommandLauncher();
	// Join, Leave and Status on the two voice rooms' intros, the /dero handlers.
	registerVoiceRoomControlHandlers();
	// The Listen button on fortunes and welcomes. Registered here like the rest so
	// a Listen row posted by an earlier deploy keeps answering.
	registerListenHandlers();
	// Dero's hold em rules card (Open public, Open invite only, Change rules,
	// Cancel, the invite picker and the rules modal). A request lives in memory,
	// so a card from before a restart answers "expired".
	registerHoldemRulesCardHandlers();

	// then register the interaction  listerner
	client.on(Events.InteractionCreate, async (interaction) => {
		// handle autocomplete interactions first, before command checks
		if (interaction.isAutocomplete()) {
			const command = client.commands.get(interaction.commandName);
			// An autocomplete cannot be answered with an error, so a failure is only logged.
			if (command?.autocomplete) await command.autocomplete(interaction).catch((error: unknown) => console.error(`[interactions] autocomplete for /${interaction.commandName} threw`, error));
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
				await answerInteractionFailure(interaction, `button handler for customId='${interaction.customId}'`, error);
			}
			return;
		}

		// ── persistent string select dispatch ──
		// Same dispatch model as buttons, added for the game rooms invite picker.
		// A select driven by an inline collector (configure-rok-reminders' timezone
		// picker) flows through here too; dispatchSelectMenu returns false and the
		// collector handles it, exactly as with buttons and modals.
		//
		// isStringSelectMenu specifically, NOT isAnySelectMenu: the other select
		// types (User, Role, Channel, Mentionable) are populated by DISCORD, and
		// game rooms deliberately uses a bot-populated StringSelect so a bot can
		// never appear as an opponent. Nothing here should quietly start routing a
		// component type that reintroduces that.
		if (interaction.isStringSelectMenu()) {
			try {
				await dispatchSelectMenu(interaction);
			} catch (error) {
				await answerInteractionFailure(interaction, `select handler for customId='${interaction.customId}'`, error);
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
				await answerInteractionFailure(interaction, `modal handler for customId='${interaction.customId}'`, error);
			}
			return;
		}

		if (!interaction.isChatInputCommand()) return;

		const command = client.commands.get(interaction.commandName);
		if (!command) {
			console.error(LOG_MESSAGES.main.noCommandMatch(interaction.commandName));
			return;
		}

		// One try around the guards AND the command: the admin guard reads the config and may
		// fetch the member, and the early access gate may call the platform, so a Mongo or
		// network failure there used to escape as an unhandled rejection and leave the member
		// with "The application did not respond".
		try {
			// ── admin role guard ───────────────────────────────────────────
			// skip for /setup, it has its own owner-only check
			if (interaction.commandName !== "setup") {
				const config = await guildConfigStore.findByGuildId(interaction.guildId!);

				// A command in BOT_CONSTANTS.ADMIN_COMMANDS, unless the leaf is a member one
				// (MEMBER_SUBCOMMANDS): /events list is a member view, the rest of /events is
				// not. The group is passed too, so a leaf inside a group is matched whole.
				const subcommand = interaction.options.getSubcommand(false);
				const group = interaction.options.getSubcommandGroup(false);
				if (isAdminCommand(interaction.commandName, subcommand, group)) {
					// guild hasn't run /setup yet, no config means no admin role is defined
					if (!config) {
						await showNotice(interaction, { title: getPluginCopy(null).notice.commands, sections: [rokCommanderCopy.responses.setupRequired] });
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
						await showNotice(interaction, { title: getPluginCopy(null).notice.commands, sections: [rokCommanderCopy.responses.noWizardPowers] });
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
					await showEmbedNotice(interaction, earlyAccessEmbed(access.generalReleaseAt));
					return;
				}
			}

			await command.execute(interaction);
		} catch (error) {
			// A real failure, so it keeps the error title, but it is still the member's alone: a
			// notice, or its private error embed once the command already acknowledged, never a
			// post pinging them in 💬dero-commands (owner rule 1 of the Round 3 list, 2026-10 item 263).
			await answerInteractionFailure(interaction, `/${interaction.commandName}`, error);
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
		// The weekly digest DM (2026-10 item 243 Phase 4): Monday 9 am Central, the
		// most active members of each guild get their own week as a card. Its own
		// cron rather than a passenger on ReminderScheduler's, since it paces its
		// DMs over minutes and the reminder tick has a 60 second budget. With
		// WEEKLY_DIGEST_RUN_ON_BOOT=1 one pass also runs now, the owner's hand
		// trigger for the test guild; the per week claim keeps it from repeating.
		weeklyDigest = startWeeklyDigest(client);
		if (weeklyDigestRunOnBoot) void runWeeklyDigest(client);
		// The monthly arcade post's own cron lives in startScheduler. With
		// ARCADE_MONTHLY_POST_RUN_ON_BOOT=1 one PREVIEW of the current month also
		// posts now, the owner's hand trigger for the test guild (2026-10 item 244).
		// It claims nothing, so it repeats on every boot while the flag is set; the
		// warning makes a flag left on Railway visible in the first log lines.
		if (arcadeMonthlyPostRunOnBoot) {
			console.warn("[arcade-monthly] ARCADE_MONTHLY_POST_RUN_ON_BOOT is on: posting a preview of this month now, and again on every boot until it is unset.");
			void runMonthlyArcadePost(client, new Date(), { preview: true });
		}

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

		// ── game room departures ──────────────────────────────────
		// A member leaving the guild ends every live room they were
		// playing in (forfeit semantics; solo and unstarted rooms close
		// as abandoned), with a system line in the room saying why. Rides
		// the same GuildMembers intent the greeter needs.
		registerGameRoomMemberRemoveWatcher(client);
		// A network table's satellites in other servers (2026-10 item 244 Phase 5a): a
		// member leaving THEIR server, their server removing Dero, or the satellite
		// channel being deleted seats them out of the table, which plays on. Second
		// listeners on GuildMemberRemove and ChannelDelete on purpose; see satelliteSeats.ts.
		registerSatelliteWatchers(client);
		// After a rated win, one line inviting a winner whose worn server tag belongs to a
		// server off the network to bring Dero there, at most once in 30 days (2026-10 item
		// 244 Phase 5b). A listener on the rating writer; see features/ratings/tagNotice.ts.
		registerTagNotice(client);
		// One line saying whether cards render as pictures on this host, with which
		// fonts, and whether the S3 card cache is on. Registers the bundled fonts.
		logCanvasRendererStatus();
		// One line naming each Dero v2 pose in assets/dero/v2 as present, missing or
		// opaque; the cards draw the bundled avatar for any pose that is not present.
		void logDeroArtStatus();
		// One line saying whether Monopoly boards render as pictures on this host
		// and which of the owner's art files are still missing from assets/games.
		logMonopolyRendererStatus();

		// ── Dero voice call watchers ──────────────────────────────
		// Ends a call two minutes after the last member allowed to give Dero
		// tasks left it, and at once when Dero is moved, kicked or its channel is
		// deleted. A VoiceStateUpdate listener beside ActivityTracker's on
		// purpose; see the header of voiceSessionWatchers.ts.
		registerVoiceSessionWatchers(client);
		// Dero's ears: every call that reaches Ready starts a listener that hears
		// ONLY members on the task list (the operator gate in voiceListener.ts).
		// Handed over here rather than imported by voiceSessions, which would
		// close an import cycle through the executor.
		voiceSessions.useListener(startVoiceListener);
		// The voice queue (2026-10 item 257, owner item 22): when a call ends, the request
		// at the head runs through the /dero join flow. Wired here because the flow lives
		// in the command and a feature must not import a command.
		voiceQueue.useRunner(runQueuedJoin);
		voiceSessions.onEnd(voiceQueue.afterCallEnded);
		// Every queue change redraws its 🗒️admin-log entry and any challenge card waiting in line
		// (2026-10 item 267), handed over here for the same reason as the runner.
		voiceQueue.onChange(logQueueChange);
		voiceQueue.onChange(redrawQueuedCards);
		// The soak test's numbers: one audit row a minute while a call is open,
		// and only when DERO_VOICE_SAMPLER is 1. Off, it arms no timer at all.
		soakSampler = startSoakSampler(deroVoiceSamplerEnabled);

		// ── new-member greeter ────────────────────────────────────
		// Attach the guildMemberAdd listener so new joins get welcomed (ping +
		// random icebreaker) in the introductions channel. Needs the GuildMembers
		// intent, already enabled above. ensureIntroChannelsWritable (after the
		// homebase sweep) makes existing guilds' intro channels member-writable
		// so newcomers can actually answer.
		registerGreeter(client);
		// The 👋welcome channel's join and leave log (2026-10 item 247 Phase 2). A
		// second GuildMemberAdd listener beside the greeter's on purpose: the greeter
		// welcomes in introductions, this logs in 👋welcome, each throttled apart.
		registerWelcomeLog(client);
		// Redraws 🧭onboarding when Discord's Community state changes, so its step 1 mark
		// follows at once (2026-10 item 263 Phase 4a, R3-14).
		registerCommunityStateSync(client);

		// ── legacy arcade field rename ─────────────────────────────
		// What: renames gamesRulesChannelId / gamesChallengesChannelId (and their
		//       introMessageIds copies) to their arcade* names on any row still
		//       carrying the pre-2026-08-12 spelling.
		// When: BEFORE the ensureHomebase sweep below, and the order is the point:
		//       repairMissingChannels is what reads those fields, and a legacy row
		//       reads them as null, which makes it build a SECOND rules channel
		//       beside the live one. See the module header for why the category
		//       still resolving is what hides this.
		// Where: idempotent and DB-only, so it costs one filtered updateMany per
		//        field on a boot where nothing is stale.
		await migrateArcadeChannelFields();

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
				// admin set a custom name via /server channels rename. Removes the "delete +
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

		// ── setup invitation backfill (2026-11 item 285 Phase 1) ──
		// Invites the owner of every guild still missing SETUP_INVITATION_SENT: guilds
		// joined while Dero was offline, and on the first boot after this ships, every
		// guild (risk R8). After the homebase sweep so a guild built this boot has its
		// row and pack. Fire and forget, paced inside, so the boards below never wait on
		// a sweep of DMs; removing this one call disables the backfill.
		void backfillSetupInvitations(client);

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

		// ── startup rehydration of the levels board ──
		// What: refresh every guild's SECOND board in the leaderboard channel, the
		//       xp standings, so a bot that was offline while members played comes
		//       back showing the truth rather than yesterday's order.
		// Where: mirrors refreshAllLeaderboards immediately above, and runs after
		//        it so the two boards in one channel settle in a stable order on a
		//        first boot. Per-guild errors are logged and swallowed inside
		//        refreshLevelsBoard, so one bad guild cannot stall the rest.
		await refreshAllLevelsBoards(client);

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

		// ── game room boot recovery ────────────────────────────────
		// What: reconcile what the GameRoom rows claim with what Discord has, then
		//       catch up on any archiving missed while the process was down.
		// When: every boot, which on Railway means every deploy.
		// Why:  a row that says "playing" is a CLAIM. While the bot was down an admin
		//       can delete a room's channel, and nothing was listening; the row would
		//       then hold that host's one room slot forever (the partial unique index
		//       counts non-terminal statuses) and no error would ever be raised.
		// Where: errors are isolated per room inside the helper, so one unreachable
		//        guild cannot fail the boot.
		await recoverGameRoomsOnBoot(client);
		// The satellite half of the same catch up: departures from a network table's
		// satellites that happened while the bot was down. Never throws.
		await reconcileSatellitesOnBoot(client);
		// Every network server's network board, drawn once and then kept current by the
		// changes that move it (2026-10 item 244 Phase 5b). After the reconcile, so a table
		// a departure closed is not listed. Never throws.
		await startNetworkBoards(client);

		// ── hold em turn clock ─────────────────────────────────────
		// What: force-folds a player who has run out of time at a poker table, and
		//       deals the next hand once the last one has sat on the board long enough.
		// When: every HOLDEM_CLOCK_TICK_MS (10s), because the turn budget is 3 minutes
		//       and the 5 minute room cron would let a 3 minute clock fire
		//       anywhere inside five minutes.
		// Why an interval rather than a cron: node-cron's finest granularity is a
		//       minute, which is twice the budget it is meant to enforce.
		// Where: errors are isolated per table inside the sweep, and the sweep is
		//       a no-op when no hold em table is live, which is almost always.
		setInterval(() => {
			void sweepHoldemClocks(client).catch((error) => console.error("[game-rooms] hold em clock tick failed", error));
		}, BOT_CONSTANTS.HOLDEM_CLOCK_TICK_MS).unref();

		// ── monopoly auction clock ─────────────────────────────────
		// Closes each sealed bid round once its 3 minutes are up. Its own interval
		// for the hold em clock's reason: the 5 minute room cron would close a 3
		// minute round anywhere inside five minutes. A no-op when no auction is open.
		setInterval(() => {
			void sweepMonopolyAuctions(client).catch((error) => console.error("[game-rooms] monopoly auction tick failed", error));
		}, BOT_CONSTANTS.MONOPOLY_AUCTION_TICK_MS).unref();

		// ── Dero bot opponents (2026-10 item 250 Phase 5) ──────────
		// Moves every bot seat one step per tick, through the same paths a member's press
		// takes, and ends a match no member is left in. A no-op read when no room has a bot.
		setInterval(() => {
			void sweepBotTurns(client).catch((error) => console.error("[game-rooms] bot turn tick failed", error));
		}, BOT_CONSTANTS.BOT_TURNS.TICK_MS).unref();

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
})().catch((error: unknown) => {
	// A boot that fails (Mongo unreachable, a bad token) must END the process with a failure code,
	// so Railway restarts it. Left to the unhandledRejection net it was only logged, leaving a
	// process that never logged in and that nothing restarts.
	console.error("[boot] the bot could not start", error);
	process.exit(1);
});
