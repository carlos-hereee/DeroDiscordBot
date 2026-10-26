import { EmbedBuilder, ButtonBuilder, ButtonStyle, type AttachmentBuilder } from "discord.js";
import { getPluginCopy, type ICopyConfig } from "@base/copy/getCopy.js";
import { infoEmbed } from "@utils/embedBuilder.js";
import { DERO_GIF_URL, COLORS, DERO_GIF_REF } from "@base/copy/brand.js";
import { deroArtAttachment } from "@features/renderer/deroArt.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { rulesContent, type IRulesConfig } from "./rulesContent.js";
// botInviteLink is composed in @utils/config from the env-driven
// clientId, so a dev process serves the dev install URL and a prod
// process serves the prod install URL automatically. We deliberately
// do NOT import BOT_CONSTANTS.INVITE_URL anymore, that string is
// pinned to the prod client id and was the source of dev/prod mix-up
// risk.
import { botInviteLink } from "@utils/config.js";

// The rules card states its clocks in minutes and hours; BOT_CONSTANTS keeps them
// in milliseconds, the unit the sweeps run on.
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

// ── ChannelContent ───────────────────────────────────────────────────────
// What:  builders for the pinned intro embeds + self-heal notices the bot
//        posts in each homebase channel. Every method that renders pack copy
//        takes an optional `guildConfig` so the words track the guild's
//        plugin pack (kingdom voice for rok-commander, neutral for
//        general-events).
// Who:   GuildSetupManager. populateChannels passes nothing on first build;
//        repairOneChannel / refreshIntroEmbeds / applyAdminRole and the
//        notice posters pass the loaded GuildConfig so a non-ROK guild
//        renders neutral copy.
// When:  a null/undefined config resolves to the rok-commander default via
//        getPluginCopy. That preserves the historical behavior of every
//        existing guild AND is the correct voice for a brand-new guild whose
//        pluginId is not yet known (set later via pairing/install).
// Where: copy resolves through getPluginCopy(guildConfig) from @base/copy.
//        Each method resolves the pack once and reads its title/description,
//        responses, and COLORS off that single source. COLORS are byte
//        identical across packs but read from the resolved pack too so a
//        method never mixes copy sources.
export const ChannelContent = {
	introduction(guildConfig?: ICopyConfig | null): EmbedBuilder {
		const copy = getPluginCopy(guildConfig);
		const cc = copy.channelContent;
		// The large Dero below the welcome is his v2 welcome pose from the bot's own
		// assets (2026-10 item 245 Phase 3b), so it no longer waits on companyuno.com
		// serving the gif. GuildSetupManager.resolveIntroFiles sends the file with
		// every post and edit of this message.
		return infoEmbed(cc.introduction.title, cc.introduction.description, copy.COLORS.INTRODUCTION).setImage(ChannelContent.introductionImage().ref);
	},

	/**
	 * The welcome's image and the file it needs: the v2 welcome pose, or the hosted
	 * gif with no file while the pose is not on disk, so a missing file can never
	 * make the welcome's send fail. The embed's ref and the file sent with it both
	 * come from here, so the two cannot name different images.
	 */
	introductionImage(): { ref: string; attachment: AttachmentBuilder | null } {
		return deroArtAttachment("welcome") ?? { ref: DERO_GIF_URL, attachment: null };
	},

	// ── invite card ──────────────────────────────────────────────────
	// What:  a standalone "summon Dero" growth card, pinned in #command-center as
	//        its OWN message so the wide invite button gets its own embed instead
	//        of crowding the command guide's button row. Short pitch + the bundled
	//        animated Dero gif (setImage attachment://) + the Summon button. The
	//        caller must also upload the gif file (buildDeroGifAttachment).
	// Who:   populateChannels (initial post) + refreshIntroEmbeds (maintains it).
	// How:   brand-indigo (COLORS.DERO) so it reads as a Dero card, not a channel
	//        intro. NOTE: like buildInviteButton, the pitch is hardcoded kingdom
	//        voice and is NOT pack-aware, a general-events guild sees ROK wording.
	//        Same pre-existing debt as the button it pairs with; tracked separately.
	inviteCard(): EmbedBuilder {
		return infoEmbed(
			"🔱 Summon Dero to Your Realm",
			"Command a kingdom of your own? Dero answers the call. Bring him to your server and let the events, reminders, and rankings run themselves.",
			COLORS.DERO
		).setImage(DERO_GIF_REF);
	},

	// ── invite button ────────────────────────────────────────────────
	// What:  the "Summon me to your server" Link button. Opens Discord's OAuth
	//        consent screen for inviting the bot into another server. Link buttons
	//        need no interaction handler, Discord opens the URL directly.
	// Who:   attached to the standalone invite card (ChannelContent.inviteCard), its
	//        own pinned message in #command-center. MOVED off the introductions
	//        intro (2026-06) because that channel is now member-writable and the
	//        welcome would bury a pinned button there.
	// When:  attached on first build (populateChannels) and re-attached on every
	//        boot (refreshIntroEmbeds) so URL/permission revisions land without a
	//        manual rebuild. Returned as a bare ButtonBuilder so it can share one
	//        ActionRow with the other command-center buttons.
	// How:   ButtonStyle.Link, URL from @utils/config.botInviteLink so the client
	//        id + permissions track the running environment automatically.
	// NOTE:  the label + emoji are hardcoded kingdom voice and are NOT pack-aware
	//        (no pack field exists for them). A general-events guild would see this
	//        ROK-voiced label until a pack field is added. Pre-existing limitation,
	//        just relocated; tracked outside this pass.
	buildInviteButton(): ButtonBuilder {
		return new ButtonBuilder()
			.setLabel("Summon me to your server, Mortal")
			.setStyle(ButtonStyle.Link)
			.setURL(botInviteLink)
			.setEmoji("🔱");
	},

	commandGuide(guildConfig?: ICopyConfig | null): EmbedBuilder {
		const copy = getPluginCopy(guildConfig);
		const cc = copy.channelContent;
		return infoEmbed(cc.commandGuide.title, cc.commandGuide.description, copy.COLORS.COMMANDS).addFields(
			...cc.commandGuide.fields
		);
	},

	// ── admin command guide ──────────────────────────────────────
	// The pinned intro of the dedicated admin command center (its own
	// homebase channel as of the 2026-06-19 split; previously a second
	// pinned message inside #inner-sanctum next to adminWelcome). Tracked on
	// GuildConfig.introMessageIds.adminCommandsChannelId so refreshIntroEmbeds
	// edits/reposts it in place on boot when copy or the command list evolves.
	// ADMIN color keeps it visually consistent with the rest of the admin surface.
	adminCommandGuide(guildConfig?: ICopyConfig | null): EmbedBuilder {
		const copy = getPluginCopy(guildConfig);
		const cc = copy.channelContent;
		return infoEmbed(cc.adminCommandGuide.title, cc.adminCommandGuide.description, copy.COLORS.ADMIN).addFields(
			...cc.adminCommandGuide.fields
		);
	},
	adminPending(guildConfig?: ICopyConfig | null): EmbedBuilder {
		const copy = getPluginCopy(guildConfig);
		return infoEmbed(copy.channelContent.adminWelcome.title, copy.responses.adminRolePending, copy.COLORS.ADMIN);
	},
	scheduleIntro(guildConfig?: ICopyConfig | null): EmbedBuilder {
		const copy = getPluginCopy(guildConfig);
		const cc = copy.channelContent;
		return infoEmbed(cc.schedule.title, cc.schedule.description, copy.COLORS.SCHEDULE);
	},

	leaderboardIntro(guildConfig?: ICopyConfig | null): EmbedBuilder {
		const copy = getPluginCopy(guildConfig);
		const cc = copy.channelContent;
		return infoEmbed(cc.leaderboard.title, cc.leaderboard.description, copy.COLORS.LEADERBOARD);
	},

	announcementsIntro(guildConfig?: ICopyConfig | null): EmbedBuilder {
		const copy = getPluginCopy(guildConfig);
		const cc = copy.channelContent;
		return infoEmbed(cc.announcements.title, cc.announcements.description, copy.COLORS.ANNOUNCEMENTS);
	},

	// Pinned intro above the NextUpBoard posts. Tells mortals that this
	// channel grows over time on purpose (each upcoming event creates a
	// permanent post) so they stop asking why it is not being "cleaned up".
	nextDecreeIntro(guildConfig?: ICopyConfig | null): EmbedBuilder {
		const copy = getPluginCopy(guildConfig);
		const cc = copy.channelContent;
		return infoEmbed(cc.nextDecree.title, cc.nextDecree.description, copy.COLORS.NEXT_DECREE);
	},

	// 🗒️admin-log's header (post-launch plan item 11), above the one line per admin
	// action that features/setup/adminLog.ts posts beneath it.
	adminLogIntro(guildConfig?: ICopyConfig | null): EmbedBuilder {
		const copy = getPluginCopy(guildConfig);
		const cc = copy.channelContent;
		return infoEmbed(cc.adminLog.title, cc.adminLog.description, copy.COLORS.ADMIN);
	},

	// ── 🎮 ARCADE GAMES intros ──────────────────────────────────
	// The rules card: rules ONLY since 2026-10 item 245 Phase 4a. The roster and the
	// host buttons moved to 🕹️games (arcadeGamesIntro below), so this card is one
	// field per rule, in the order a newcomer meets them, ratings last. The clocks,
	// amounts and rating thresholds come from BOT_CONSTANTS rather than from the copy,
	// so the card can never promise a number the sweep, awardXp or the ratings code
	// does not run.
	arcadeRulesIntro(guildConfig?: ICopyConfig | null): EmbedBuilder {
		const copy = getPluginCopy(guildConfig);
		const c = copy.channelContent.arcadeRules;
		const { LEVELING, RATINGS } = BOT_CONSTANTS;
		return infoEmbed(c.title, c.description, copy.COLORS.ARCADE).addFields(
			{ name: c.roomTitle, value: c.roomBody, inline: false },
			{ name: c.slotTitle, value: c.slotBody, inline: false },
			{
				name: c.idleTitle,
				value: c.idleBody(BOT_CONSTANTS.GAME_ROOM_IDLE_ABANDON_MS / MS_PER_MINUTE, BOT_CONSTANTS.GAME_ROOM_MONOPOLY_IDLE_MS / MS_PER_HOUR),
				inline: false,
			},
			{ name: c.rematchTitle, value: c.rematchBody, inline: false },
			{
				name: c.xpTitle,
				value: c.xpBody(LEVELING.MESSAGE_XP, LEVELING.REACTION_XP, LEVELING.SOLO_LUCK_WIN_XP, LEVELING.SOLO_LUCK_OTHER_XP, LEVELING.DAILY_XP_CAP),
				inline: false,
			},
			{
				name: c.ratingsTitle,
				value: c.ratingsBody(RATINGS.PROVISIONAL_GAMES, RATINGS.HOLDEM_MIN_RATED_HANDS, RATINGS.LUCK_MIN_DECIDED),
				inline: false,
			}
		);
	},

	// ── 🕹️games, the first of its two messages ──────────────────────
	// Every game once, one line each, as ONE field: a field per game would spend a
	// field per roster entry against Discord's 25, and one line reads as a list,
	// which is what this is. The play now field explains the three control rows
	// beneath it (resolveIntroComponents). The Challenge Board is the second message
	// (arcadeGamesBoard), because all six rows of controls do not fit in one.
	arcadeGamesIntro(guildConfig?: ICopyConfig | null): EmbedBuilder {
		const copy = getPluginCopy(guildConfig);
		const c = copy.channelContent.arcadeGames;
		return infoEmbed(c.title, c.description, copy.COLORS.ARCADE).addFields(
			{ name: c.rosterTitle, value: c.roster.map((game) => `**${game.name}** ${game.how}`).join("\n"), inline: false },
			{ name: c.playTitle, value: c.playBody, inline: false }
		);
	},

	// 🕹️games' second message: the heading above the Challenge Board's start buttons.
	// Tracked on introMessageIds.arcadeGamesBoardId and kept by GuildSetupManager.
	arcadeGamesBoard(guildConfig?: ICopyConfig | null): EmbedBuilder {
		const copy = getPluginCopy(guildConfig);
		const c = copy.channelContent.arcadeGames;
		return infoEmbed(c.boardTitle, c.boardDescription, copy.COLORS.ARCADE);
	},

	// The card in each voice room's text chat, above /dero's Join, Leave and Status
	// (2026-10 item 245 Phase 4b). Tracked on introMessageIds under the room's own field.
	voiceRoomIntro(guildConfig?: ICopyConfig | null): EmbedBuilder {
		const c = getPluginCopy(guildConfig).channelContent.voiceRoom;
		return infoEmbed(c.title, c.description, COLORS.DERO);
	},

	arcadeChallengesIntro(guildConfig?: ICopyConfig | null): EmbedBuilder {
		const copy = getPluginCopy(guildConfig);
		const cc = copy.channelContent;
		return infoEmbed(cc.arcadeChallenges.title, cc.arcadeChallenges.description, copy.COLORS.ARCADE);
	},

	// 🏆rated-challenges' intro (2026-10 item 254, Arcade 5): one line, like
	// ⚔️challenges', above the rated games' cards and the network board.
	arcadeRatedChallengesIntro(guildConfig?: ICopyConfig | null): EmbedBuilder {
		const copy = getPluginCopy(guildConfig);
		const cc = copy.channelContent;
		return infoEmbed(cc.arcadeRatedChallenges.title, cc.arcadeRatedChallenges.description, copy.COLORS.ARCADE);
	},

	// 🎉party-games' intro (post-launch plan item 3), above the admin host and
	// schedule buttons (features/game-rooms/partyGames).
	partyGamesIntro(guildConfig?: ICopyConfig | null): EmbedBuilder {
		const copy = getPluginCopy(guildConfig);
		const cc = copy.channelContent;
		return infoEmbed(cc.partyGames.title, cc.partyGames.description, copy.COLORS.ARCADE);
	},

	// ── 👋welcome and 📘rules (2026-10 item 247 Phase 2) ──────────────
	// The join log's intro, above the join and leave lines welcomeLog posts.
	welcomeIntro(guildConfig?: ICopyConfig | null): EmbedBuilder {
		const copy = getPluginCopy(guildConfig);
		const c = copy.channelContent.welcome;
		return infoEmbed(c.title, c.description, copy.COLORS.ARRIVAL);
	},

	// The rules post's embed. Takes the stored row rather than only a pack selector,
	// because the owner's saved rules live on it; rulesContent owns the build so the
	// intro sweep and the Edit rules re-render cannot render the rules two ways.
	rulesIntro(guildConfig?: IRulesConfig | null): EmbedBuilder {
		return rulesContent.build(guildConfig).embed;
	},

	adminWelcome(ownerId: string, adminRoleId: string, guildConfig?: ICopyConfig | null): EmbedBuilder {
		const copy = getPluginCopy(guildConfig);
		const cc = copy.channelContent;
		return infoEmbed(cc.adminWelcome.title, cc.adminWelcome.description(ownerId, adminRoleId), copy.COLORS.ADMIN);
	},

	// ── self heal notices ─────────────────────────────────────
	// posted to the inner sanctum from GuildSetupManager.ensureHomebase when
	// a wake up scan finds missing pieces of the homebase. per channel
	// notices fire for single channel restores; the castle rebuilt notice
	// fires once after a full category reconstruction. both use the ADMIN
	// color so they visually match the rest of the inner sanctum surface.
	channelRepairNotice(channelName: string, guildConfig?: ICopyConfig | null): EmbedBuilder {
		const copy = getPluginCopy(guildConfig);
		const cc = copy.channelContent;
		return infoEmbed(cc.channelRepairNotice.title, cc.channelRepairNotice.description(channelName), copy.COLORS.ADMIN);
	},
	// Single summary embed when multiple channels are restored in one
	// sweep. Replaces the "one embed per channel" spam previously emitted
	// by postRepairNotices when the bot rebuilt several missing channels
	// at once (eg after toggling leaderboard back on triggered a sweep
	// that rebuilt every removed homebase channel). One message in
	// inner-sanctum is enough, the admin only needs to know which
	// channels were touched, not see N copies of the same warning
	// paragraph. Reuses the existing repair-notice copy template via
	// the locale's summaryTitle / summaryBody keys.
	channelsRestoredSummary(channelNames: string[], guildConfig?: ICopyConfig | null): EmbedBuilder {
		const copy = getPluginCopy(guildConfig);
		const cc = copy.channelContent;
		const list = channelNames.map((n) => `• ${n}`).join("\n");
		const description = `${cc.channelRepairNotice.summaryBody(channelNames.length)}\n\n${list}`;
		return infoEmbed(cc.channelRepairNotice.summaryTitle, description, copy.COLORS.ADMIN);
	},
	castleRebuiltNotice(guildConfig?: ICopyConfig | null): EmbedBuilder {
		const copy = getPluginCopy(guildConfig);
		const cc = copy.channelContent;
		return infoEmbed(cc.castleRebuiltNotice.title, cc.castleRebuiltNotice.description, copy.COLORS.ADMIN);
	},
};
