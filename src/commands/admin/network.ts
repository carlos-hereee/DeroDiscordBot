import { escapeMarkdown, MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction, type Client, type EmbedBuilder } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { COLORS } from "@base/copy/brand.js";
import { networkBanStore } from "@db/stores/networkBanStore.js";
import type { NetworkBanKind } from "@db/models/NetworkBan.js";
import { networkCopy } from "@features/game-rooms/networkCopy.js";
import { scheduleNetworkBoardRefresh } from "@features/game-rooms/networkBoard.js";
import { seatOutBannedMember, seatOutBannedServer } from "@features/game-rooms/satelliteSeats.js";
import { errorEmbed, infoEmbed } from "@utils/embedBuilder.js";
import { isPlatformOwner } from "./render-analytics.js";

// ── /network ───────────────────────────────────────────────────────────────
// What:  the platform owner's network bans (2026-10 item 244 Phase 5b): `ban user`,
//        `ban server`, `unban user`, `unban server`. A banned member or server is left
//        off every network board and refused every new seat at a network table.
// Who:   the platform owner ONLY (CREATOR_DISCORD_ID), through the same isPlatformOwner
//        check /render-analytics uses, so the two owner commands cannot disagree about
//        who the owner is. An empty creatorId refuses everyone. It carries no Discord
//        default permission, like /render-analytics; the owner check is the whole gate.
// Where: deliberately NOT in BOT_CONSTANTS.ADMIN_COMMANDS: that runtime gate requires a
//        /setup config in the guild, and the owner must reach the network from any server.
//        Writes NetworkBan through networkBanStore, asks the network board to redraw, and
//        (Phase 5c, owner decision 2026-10-24) seats out every seat the new ban names that
//        is already taken at a network table, through satelliteSeats.
// Does NOT: reach a banned member's seat in a room hosted in their own server (a ban
//        reaches the network only), or give anything back on unban. A server admin's
//        narrower tool is /dero-config arcade block-server.
//
// ⚠️ `data` IS DELIBERATELY UNANNOTATED, for the same reason as xp.ts:
// .addSubcommandGroup() narrows the builder away from SlashCommandBuilder.

const copy = networkCopy;
const NETWORK = BOT_CONSTANTS.NETWORK;

const USER_OPTION = "user";
const SERVER_OPTION = "server";
const REASON_OPTION = "reason";

export const data = new SlashCommandBuilder()
	.setName("network")
	.setDescription(copy.command.description)
	.addSubcommandGroup((group) =>
		group
			.setName("ban")
			.setDescription(copy.command.banGroup)
			.addSubcommand((sub) =>
				sub
					.setName("user")
					.setDescription(copy.command.user)
					.addUserOption((option) => option.setName(USER_OPTION).setDescription(copy.command.userOption).setRequired(true))
					.addStringOption((option) =>
						option.setName(REASON_OPTION).setDescription(copy.command.reasonOption).setRequired(false).setMaxLength(NETWORK.BAN_REASON_MAX_LENGTH)
					)
			)
			.addSubcommand((sub) =>
				sub
					.setName("server")
					.setDescription(copy.command.server)
					.addStringOption((option) => option.setName(SERVER_OPTION).setDescription(copy.command.serverOption).setRequired(true))
					.addStringOption((option) =>
						option.setName(REASON_OPTION).setDescription(copy.command.reasonOption).setRequired(false).setMaxLength(NETWORK.BAN_REASON_MAX_LENGTH)
					)
			)
	)
	.addSubcommandGroup((group) =>
		group
			.setName("unban")
			.setDescription(copy.command.unbanGroup)
			.addSubcommand((sub) =>
				sub
					.setName("user")
					.setDescription(copy.command.user)
					.addUserOption((option) => option.setName(USER_OPTION).setDescription(copy.command.userOption).setRequired(true))
			)
			.addSubcommand((sub) =>
				sub
					.setName("server")
					.setDescription(copy.command.server)
					.addStringOption((option) => option.setName(SERVER_OPTION).setDescription(copy.command.serverOption).setRequired(true))
			)
	);

/** Who a ban names, and how the owner's reply shows them. */
interface BanTarget {
	kind: NetworkBanKind;
	targetId: string;
	label: string;
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
	if (!isPlatformOwner(interaction.user.id)) {
		await interaction.reply({ embeds: [errorEmbed(copy.notOwner)], flags: MessageFlags.Ephemeral });
		return;
	}

	const group = interaction.options.getSubcommandGroup(true);
	const sub = interaction.options.getSubcommand(true);
	if ((group !== "ban" && group !== "unban") || (sub !== "user" && sub !== "server")) {
		await interaction.reply({ embeds: [errorEmbed(copy.unknownSubcommand(`${group} ${sub}`))], flags: MessageFlags.Ephemeral });
		return;
	}

	const target = readTarget(interaction, sub);
	if (!target) {
		await interaction.reply({ embeds: [errorEmbed(copy.serverIdInvalid)], flags: MessageFlags.Ephemeral });
		return;
	}

	try {
		const embed = group === "ban" ? await ban(interaction.client, target, interaction.options.getString(REASON_OPTION) ?? "") : await unban(target);
		// No ping: the reply names a member only for the owner's eyes.
		await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
	}
	catch (error) {
		console.error(`[network] ${group} ${sub} failed for ${target.targetId}`, error);
		await interaction.reply({ embeds: [errorEmbed(copy.saveFailed)], flags: MessageFlags.Ephemeral }).catch(() => undefined);
	}
}

// The member from the user option, or the server from its typed id. A typed id is user
// input, so it is checked for a snowflake's shape and refused otherwise, never stored.
function readTarget(interaction: ChatInputCommandInteraction, sub: "user" | "server"): BanTarget | null {
	if (sub === "user") {
		const user = interaction.options.getUser(USER_OPTION, true);
		return { kind: "user", targetId: user.id, label: `<@${user.id}>` };
	}
	const serverId = interaction.options.getString(SERVER_OPTION, true).trim();
	if (!NETWORK.SERVER_ID_PATTERN.test(serverId)) return null;
	const name = interaction.client.guilds.cache.get(serverId)?.name;
	return { kind: "guild", targetId: serverId, label: name ? `**${escapeMarkdown(name)}** (\`${serverId}\`)` : `\`${serverId}\`` };
}

// Each write is idempotent with an honest "already" reply, and a change redraws the boards
// so a banned table or server leaves them within the board's debounce.
async function ban(client: Client, target: BanTarget, reason: string): Promise<EmbedBuilder> {
	const added = await networkBanStore.ban(target.kind, target.targetId, reason.trim(), new Date());
	if (!added) return infoEmbed(copy.title, copy.alreadyBanned(target.kind, target.label), COLORS.ADMIN);
	scheduleNetworkBoardRefresh();
	seatOutTakenSeats(client, target);
	return infoEmbed(copy.title, copy.banned(target.kind, target.label), COLORS.ADMIN);
}

// Fire and forget after the ban landed (the bot's rule 7): a sweep across several servers
// can outrun Discord's three second reply window, and the ban stands whatever it finds. A
// ban that already stood sweeps nothing, since its seats were swept when it was placed.
function seatOutTakenSeats(client: Client, target: BanTarget): void {
	const sweep = target.kind === "user" ? seatOutBannedMember(client, target.targetId) : seatOutBannedServer(client, target.targetId);
	void sweep
		.then((seatedOut) => {
			if (seatedOut > 0) console.log(`[network] the ban on ${target.kind} ${target.targetId} seated out ${seatedOut} player(s) at network tables`);
		})
		.catch((error) => console.error(`[network] seating out the seats a ban on ${target.kind} ${target.targetId} names failed`, error));
}

async function unban(target: BanTarget): Promise<EmbedBuilder> {
	const lifted = await networkBanStore.unban(target.kind, target.targetId);
	if (!lifted) return infoEmbed(copy.title, copy.notBanned(target.kind, target.label), COLORS.ADMIN);
	scheduleNetworkBoardRefresh();
	return infoEmbed(copy.title, copy.unbanned(target.kind, target.label), COLORS.ADMIN);
}
