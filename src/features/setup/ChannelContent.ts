import { EmbedBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { getPluginCopy, type ICopyConfig } from "@base/copy/getCopy.js";
import { infoEmbed } from "@utils/embedBuilder.js";
import { DERO_GIF_URL, COLORS, DERO_GIF_REF } from "@base/copy/brand.js";
// botInviteLink is composed in @utils/config from the env-driven
// clientId, so a dev process serves the dev install URL and a prod
// process serves the prod install URL automatically. We deliberately
// do NOT import BOT_CONSTANTS.INVITE_URL anymore, that string is
// pinned to the prod client id and was the source of dev/prod mix-up
// risk.
import { botInviteLink } from "@utils/config.js";

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
		// setImage shows the large animated Dero below the welcome so new members
		// see the mascot in action (gifs animate in the image slot, unlike the
		// static author icon). Renders once the asset is deployed (see DERO_GIF_URL).
		return infoEmbed(cc.introduction.title, cc.introduction.description, copy.COLORS.INTRODUCTION).setImage(DERO_GIF_URL);
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

	// ── 🎮 ARCADE GAMES intros ──────────────────────────────────
	// The rules card, one FIELD per game rather than one embed per game.
	// The plan asked for an embed each; the intro pipeline (resolveIntroEmbed,
	// populateChannels, refreshIntroEmbeds, repairOneChannel, the delete watcher)
	// is built around ONE embed per channel, and widening all of it to an array
	// would be real surgery for a difference a reader cannot see: a field renders
	// as its own titled block either way. Discord allows 25 fields and the roster
	// is five games, seven once battleship and holdem land, so the ceiling is not
	// close. If the roster ever outgrows that, THAT is the moment to widen the
	// pipeline rather than to truncate the list.
	arcadeRulesIntro(guildConfig?: ICopyConfig | null): EmbedBuilder {
		const copy = getPluginCopy(guildConfig);
		const c = copy.channelContent.arcadeRules;
		const embed = infoEmbed(c.title, c.description, copy.COLORS.ARCADE);

		// Order is the reading order a newcomer needs: what this place is, how to
		// start something, how to join something somebody else started, why any of
		// it is worth doing, and only THEN the roster. Leading with the roster is
		// what made the old card read as a wall.
		// `roomBody` explains what a head to head match actually IS now that Phase 4
		// made rooms real, and it sits between joining and leveling because that is
		// where a reader's question arrives: they have just been told they can join a
		// match, and the next thing they do not know is where it happens.
		embed.addFields(
			{ name: c.hostTitle, value: c.hostBody, inline: false },
			{ name: c.joinTitle, value: c.joinBody, inline: false },
			{ name: c.roomTitle, value: c.roomBody, inline: false },
			{ name: c.levelingTitle, value: c.levelingBody, inline: false }
		);

		// The three rosters, grouped by how many humans a game needs. A group with
		// no games is omitted rather than rendered empty, so a future pack that
		// ships fewer games does not leave a bare heading behind.
		const groups: Array<{ title: string; games: ReadonlyArray<{ name: string; how: string }> }> = [
			{ title: c.soloTitle, games: c.solo },
			{ title: c.versusTitle, games: c.versus },
			{ title: c.partyTitle, games: c.party },
		];
		for (const group of groups) {
			if (!group.games.length) continue;
			embed.addFields({
				name: group.title,
				value: group.games.map((game) => `**${game.name}** ${game.how}`).join("\n"),
				inline: false,
			});
		}

		return embed;
	},

	arcadeChallengesIntro(guildConfig?: ICopyConfig | null): EmbedBuilder {
		const copy = getPluginCopy(guildConfig);
		const cc = copy.channelContent;
		return infoEmbed(cc.arcadeChallenges.title, cc.arcadeChallenges.description, copy.COLORS.ARCADE);
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
