import {
	type Client,
	type EmbedBuilder,
	type Guild,
	type RepliableInteraction,
	type SlashCommandBuilder,
	type SlashCommandSubcommandGroupBuilder,
	type SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { errorEmbed, infoEmbed } from "@utils/embedBuilder.js";
import { COLORS } from "@base/copy/brand.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { voiceCopy } from "@features/voice/voiceCopy.js";
import { ratingsCopy } from "@features/ratings/ratingsCopy.js";
import { asChallengeReach, isChallengeReach } from "@features/game-rooms/challengeReach.js";
import { scheduleNetworkBoardRefresh } from "@features/game-rooms/networkBoard.js";
import { seatOutBlockedServers } from "@features/game-rooms/satelliteSeats.js";
import { CHALLENGE_REACHES, type ChallengeReach } from "@features/game-rooms/roomTypes.js";
import type { CommandOptionReader } from "@handlers/commandOptions.js";
import { adminLog, type AdminLogKind } from "@features/setup/adminLog.js";
import { setupCopy } from "@features/setup/setupCopy.js";
import { turnArcadeOff, turnArcadeOn } from "@features/setup/arcadeSwitch.js";
import { beginChannelAnswer } from "@utils/answerInChannel.js";
import { showEmbedNotice, showErrorNotice } from "@utils/textModal.js";

// ── /arcade settings ─────────────────────────────────────────────────────────
// What:  the arcade's own settings, stored on GuildConfig: `on` and `off` (the
//        category and its channels, through arcadeSwitch.ts), `bots` (whether a
//        challenge host may fill seats with Dero bots), `reach` (2026-10 item 244
//        Phase 4), `monthly-post`, and the `server` group's `block` and `unblock`
//        (the network block list, Phase 5b).
// Who:   commands/admin/arcade.ts adds these to /arcade and runs them, from the slash
//        command or the /arcade button on the admin guide. Admins only, through
//        /arcade in BOT_CONSTANTS.ADMIN_COMMANDS. The chips group beside them is
//        features/economy/chipEconomySubcommands.ts.
// Where: GuildConfig.arcadeMonthlyPost is read by features/ratings/monthlyArcadePost.ts,
//        GuildConfig.challengeReach by features/game-rooms/challengeReach.ts,
//        GuildConfig.botOpponentsEnabled by the challenge card's Play vs bots
//        (game-rooms/botSeat.ts, 2026-10 item 250 Phase 5), and
//        GuildConfig.blockedNetworkGuildIds by the network board and every remote join
//        (features/game-rooms/networkBoard.ts and networkJoin.ts); a new block also ends
//        the satellites already linking the two servers, both ways (satelliteSeats,
//        Phase 5c).
// How:   ① guild gate (rejects DM use); ② setup gate (a guild that never ran /setup
//        has no admin role for the runtime gate to check); ③ dispatch on the leaf;
//        ④ one ephemeral embed reply. Every write records one 🗒️admin-log line; an
//        "already X" reply wrote nothing and logs nothing.

const configCopy = voiceCopy.config;
const audited = setupCopy.adminLog;
const arcadeCopy = setupCopy.arcade;

/** Records one admin log line for a write that just landed. */
type Audit = (kind: AdminLogKind, subject: string, detail: string) => void;
const SERVER_OPTION = "server";

/** /arcade's own top level subcommands: on, off, bots, reach and monthly-post. Added first, before /arcade's groups. */
export function addArcadeSettingSubcommands(builder: SlashCommandBuilder): SlashCommandSubcommandsOnlyBuilder {
	return (
		builder
			// The arcade's on and off switch (post-launch plan item 14).
			.addSubcommand((sub) => sub.setName("on").setDescription(arcadeCopy.onDescription))
			.addSubcommand((sub) => sub.setName("off").setDescription(arcadeCopy.offDescription))
			// Whether a challenge host may fill seats with Dero bots (2026-10 item 250 Phase 5).
			.addSubcommand((sub) =>
				sub
					.setName("bots")
					.setDescription(ratingsCopy.config.bots)
					.addBooleanOption((option) => option.setName("enabled").setDescription(ratingsCopy.config.botsOption).setRequired(true))
			)
			.addSubcommand((sub) =>
				sub
					.setName("reach")
					.setDescription(ratingsCopy.config.reach)
					// Fixed choices, so Discord offers exactly the three reaches; the handler
					// still narrows the value, since a choice is the client's suggestion.
					.addStringOption((option) =>
						option
							.setName("mode")
							.setDescription(ratingsCopy.config.reachOption)
							.setRequired(true)
							.addChoices(...CHALLENGE_REACHES.map((reach) => ({ name: ratingsCopy.config.reachName(reach), value: reach })))
					)
			)
			.addSubcommand((sub) =>
				sub
					.setName("monthly-post")
					.setDescription(ratingsCopy.config.monthlyPost)
					// A boolean like `bots`, so the on and off switches of /arcade read the same.
					.addBooleanOption((option) => option.setName("enabled").setDescription(ratingsCopy.config.monthlyPostOption).setRequired(true))
			)
	);
}

// The network block list (2026-10 item 244 Phase 5b). A server id rather than a server
// picker, because the server to block is one Dero shares a network with, not one the
// admin is in, and Discord has no option type for that.
/** The /arcade server group: block and unblock. */
export function addServerBlockSubcommands(group: SlashCommandSubcommandGroupBuilder): SlashCommandSubcommandGroupBuilder {
	return group
		.addSubcommand((sub) =>
			sub
				.setName("block")
				.setDescription(ratingsCopy.config.blockServer)
				.addStringOption((option) => option.setName(SERVER_OPTION).setDescription(ratingsCopy.config.serverIdOption).setRequired(true))
		)
		.addSubcommand((sub) =>
			sub
				.setName("unblock")
				.setDescription(ratingsCopy.config.unblockServer)
				.addStringOption((option) => option.setName(SERVER_OPTION).setDescription(ratingsCopy.config.serverIdOption).setRequired(true))
		);
}

// ── handlers, one per subcommand ──

const info = (body: string, title: string = ratingsCopy.config.title): EmbedBuilder => infoEmbed(title, body, COLORS.ADMIN);

// Same idempotent shape as every switch in the bot: an unchanged value says so and writes
// nothing. A row that never stored the field reads as ON, the schema's default.
async function setMonthlyPost(guildId: string, storedValue: boolean | null | undefined, on: boolean, audit: Audit): Promise<EmbedBuilder> {
	if ((storedValue ?? true) === on) return info(ratingsCopy.config.monthlyPostUnchanged(on));
	await guildConfigStore.update(guildId, { arcadeMonthlyPost: on });
	audit("config.change", audited.subjects.arcadeMonthlyPost, on ? audited.on : audited.off);
	return info(ratingsCopy.config.monthlyPostSet(on));
}

// The bot opponents switch (2026-10 item 250 Phase 5), the same idempotent shape. Read
// by the challenge card's Play vs bots button, on the card and again on the press, so a
// match already playing keeps its bots.
async function setBotOpponents(guildId: string, storedValue: boolean | null | undefined, on: boolean, audit: Audit): Promise<EmbedBuilder> {
	if ((storedValue ?? true) === on) return info(ratingsCopy.config.botsUnchanged(on));
	await guildConfigStore.update(guildId, { botOpponentsEnabled: on });
	audit("config.change", audited.subjects.botOpponents, on ? audited.on : audited.off);
	return info(ratingsCopy.config.botsSet(on));
}

// The same idempotent shape for the challenge reach (2026-10 item 244 Phase 4). A row
// that never stored it reads as "server", the schema's default and today's behavior.
// Rooms already playing are untouched; the next open, choice or rematch reads the new value.
async function setChallengeReach(guildId: string, storedValue: unknown, reach: ChallengeReach, audit: Audit): Promise<EmbedBuilder> {
	if (asChallengeReach(storedValue) === reach) return info(ratingsCopy.config.reachUnchanged(reach));
	await guildConfigStore.update(guildId, { challengeReach: reach });
	audit("config.change", audited.subjects.arcadeReach, audited.set(ratingsCopy.config.reachName(reach)));
	// The server joined or left the network, or neither: the board refresh decides, and a
	// server that left loses its board message there (2026-10 item 244 Phase 5b).
	scheduleNetworkBoardRefresh();
	return info(ratingsCopy.config.reachSet(reach));
}

// The submitted mode is checked rather than trusted: Discord offers only the fixed
// choices, but an interaction's values are user input, and an unknown one is refused
// rather than read as a default that would quietly widen the reach.
async function setReachFromOption(guildId: string, storedValue: unknown, mode: string, audit: Audit): Promise<EmbedBuilder> {
	if (!isChallengeReach(mode)) return errorEmbed(ratingsCopy.config.reachUnknown);
	return setChallengeReach(guildId, storedValue, mode, audit);
}

// The network block list (2026-10 item 244 Phase 5b), the same idempotent shape: an
// unchanged list says so and writes nothing. The id is user input, so it is checked for a
// snowflake's shape, and this server's own id is refused, since a server cannot keep
// itself off its own tables. A change redraws the network boards, and a new block seats
// out the seats already taken between the two servers (Phase 5c, owner decision
// 2026-10-24), fire and forget after the write, since the sweep can outrun Discord's
// three second reply window and the block stands whatever it finds.
async function editNetworkBlock(
	client: Client,
	guildId: string,
	storedList: readonly string[] | null | undefined,
	sub: "block" | "unblock",
	rawId: string,
	audit: Audit
): Promise<EmbedBuilder> {
	const title = ratingsCopy.config.blockTitle;
	const serverId = rawId.trim();
	if (!BOT_CONSTANTS.NETWORK.SERVER_ID_PATTERN.test(serverId)) return errorEmbed(ratingsCopy.config.serverIdInvalid);
	if (serverId === guildId) return errorEmbed(ratingsCopy.config.blockSelf);

	const present = (storedList ?? []).includes(serverId);
	if (sub === "block") {
		if (present) return info(ratingsCopy.config.alreadyBlocked(serverId), title);
		await guildConfigStore.addBlockedNetworkGuild(guildId, serverId);
		audit("config.change", audited.subjects.networkBlock, audited.blocked(serverId));
		scheduleNetworkBoardRefresh();
		void seatOutBlockedServers(client, guildId, serverId).catch((error) =>
			console.error(`[arcade] seating out the seats between ${guildId} and blocked server ${serverId} failed`, error)
		);
		return info(ratingsCopy.config.blocked(serverId), title);
	}
	if (!present) return info(ratingsCopy.config.notBlocked(serverId), title);
	await guildConfigStore.removeBlockedNetworkGuild(guildId, serverId);
	audit("config.change", audited.subjects.networkBlock, audited.unblocked(serverId));
	scheduleNetworkBoardRefresh();
	return info(ratingsCopy.config.unblocked(serverId), title);
}

/** The slice of a GuildConfig row the arcade settings read. */
interface ArcadeSettings {
	challengeReach?: unknown;
	arcadeMonthlyPost?: boolean | null;
	blockedNetworkGuildIds?: readonly string[] | null;
	botOpponentsEnabled?: boolean | null;
}

/** The reply to one arcade setting, by its leaf. */
async function arcadeAnswer(
	client: Client,
	guildId: string,
	settings: ArcadeSettings,
	leaf: { group: string | null; sub: string },
	options: CommandOptionReader,
	audit: Audit
): Promise<EmbedBuilder> {
	if (leaf.group === "server" && (leaf.sub === "block" || leaf.sub === "unblock")) {
		return editNetworkBlock(client, guildId, settings.blockedNetworkGuildIds, leaf.sub, options.getString(SERVER_OPTION, true), audit);
	}
	if (leaf.sub === "reach") return setReachFromOption(guildId, settings.challengeReach, options.getString("mode", true), audit);
	if (leaf.sub === "bots") return setBotOpponents(guildId, settings.botOpponentsEnabled, options.getBoolean("enabled", true), audit);
	return setMonthlyPost(guildId, settings.arcadeMonthlyPost, options.getBoolean("enabled", true), audit);
}

// ── arcade off and on (post-launch plan item 14) ──
// Acknowledged first, because building or deleting a category and its channels can
// outrun Discord's three second reply window. Each outcome posts in 🎰arcade-control
// (2026-10 item 257 Phase 5), and only a real change is logged.
async function switchArcade(interaction: RepliableInteraction, guild: Guild, sub: "off" | "on", audit: Audit): Promise<void> {
	const answer = await beginChannelAnswer(interaction, "arcade");
	try {
		if (sub === "off") {
			const outcome = await turnArcadeOff(guild);
			if (outcome === "off") audit("config.change", audited.subjects.arcade, arcadeCopy.auditOff);
			const embed = outcome === "off" ? info(arcadeCopy.offBody, arcadeCopy.offTitle) : info(arcadeCopy.alreadyOff, arcadeCopy.offTitle);
			await answer.send({ embeds: [embed] });
			return;
		}
		const outcome = await turnArcadeOn(interaction.client, guild);
		if (outcome !== "already-on") audit("config.change", audited.subjects.arcade, arcadeCopy.auditOn);
		const body = { on: arcadeCopy.onBody, pending: arcadeCopy.onPending, "already-on": arcadeCopy.alreadyOn }[outcome];
		await answer.send({ embeds: [info(body, arcadeCopy.onTitle)] });
	} catch (error) {
		console.error(`[arcade] ${sub} failed guild=${guild.id}`, error);
		await answer.send({ embeds: [errorEmbed(sub === "off" ? arcadeCopy.offFailed : arcadeCopy.onFailed)] });
	}
}

/** Runs one /arcade setting (everything but the chips group), for the slash command and the admin guide alike. */
export async function runArcadeSettingSubcommand(interaction: RepliableInteraction, options: CommandOptionReader): Promise<void> {
	// ① guild gate
	const guildId = interaction.guildId;
	if (!guildId) {
		await showErrorNotice(interaction, configCopy.notInGuild);
		return;
	}

	// ② setup gate
	const guildConfig = await guildConfigStore.findByGuildId(guildId);
	if (!guildConfig) {
		await showErrorNotice(interaction, configCopy.setupRequired);
		return;
	}

	// Every write below records one admin log line, by the member who ran the command.
	const audit: Audit = (kind, subject, detail) =>
		adminLog.emit({ guild: { id: guildId, client: interaction.client }, kind, actor: { userId: interaction.user.id }, payload: { subject, detail } });

	try {
		// ③ dispatch. Every setting needs only the GuildConfig the setup gate already read.
		const group = options.getSubcommandGroup(false);
		const sub = options.getSubcommand(true);
		if (group === null && (sub === "off" || sub === "on")) {
			const guild = interaction.guild ?? (await interaction.client.guilds.fetch(guildId));
			await switchArcade(interaction, guild, sub, audit);
			return;
		}
		const embed = await arcadeAnswer(interaction.client, guildId, guildConfig, { group, sub }, options, audit);
		// ④
		await showEmbedNotice(interaction, embed);
	}
	catch (err) {
		console.error(`[arcade] failed guild=${guildId}`, err);
		await showErrorNotice(interaction, configCopy.saveFailed);
	}
}
