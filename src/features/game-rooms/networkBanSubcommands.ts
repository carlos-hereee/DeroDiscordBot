import {
	escapeMarkdown,
	MessageFlags,
	type ChatInputCommandInteraction,
	type Client,
	type EmbedBuilder,
	type SlashCommandSubcommandBuilder,
	type SlashCommandSubcommandGroupBuilder,
} from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { COLORS } from "@base/copy/brand.js";
import { networkBanStore } from "@db/stores/networkBanStore.js";
import type { NetworkBanKind } from "@db/models/NetworkBan.js";
import { networkCopy } from "@features/game-rooms/networkCopy.js";
import { scheduleNetworkBoardRefresh } from "@features/game-rooms/networkBoard.js";
import { seatOutBannedMember, seatOutBannedServer } from "@features/game-rooms/satelliteSeats.js";
import { errorEmbed, infoEmbed } from "@utils/embedBuilder.js";
import { isPlatformOwner } from "@utils/permissions.js";

// ── /platform network ──────────────────────────────────────────────────────
// What:  the platform owner's network bans (2026-10 item 244 Phase 5b): `ban` and
//        `unban`, each naming a member or a server through its required `target`.
//        A banned member or server is left off every network board and refused every
//        new seat at a network table.
// Who:   commands/admin/platform.ts adds this group to /platform and runs it. The
//        platform owner ONLY (CREATOR_DISCORD_ID), through isPlatformOwner, the same
//        check /platform analytics uses, so the two cannot disagree about who the owner
//        is. An empty creatorId refuses everyone. /platform carries no Discord default
//        permission; the owner check here is the whole gate.
// Where: deliberately NOT in BOT_CONSTANTS.ADMIN_COMMANDS: that runtime gate requires a
//        /setup config in the guild, and the owner must reach the network from any server.
//        Writes NetworkBan through networkBanStore, asks the network board to redraw, and
//        (Phase 5c, owner decision 2026-10-24) seats out every seat the new ban names that
//        is already taken at a network table, through satelliteSeats.
// Does NOT: reach a banned member's seat in a room hosted in their own server (a ban
//        reaches the network only), or give anything back on unban. A server admin's
//        narrower tool is /arcade server block.

const copy = networkCopy;
const NETWORK = BOT_CONSTANTS.NETWORK;

const TARGET_OPTION = "target";
const USER_OPTION = "user";
const SERVER_OPTION = "server";
const REASON_OPTION = "reason";

type BanTargetKind = keyof typeof copy.command.targetChoices;
const TARGET_KINDS = Object.keys(copy.command.targetChoices) as BanTargetKind[];

// The target is required and first, because Discord lists required options before
// optional ones. The member and the server stay optional so one subcommand can name
// either, and the handler refuses the one the target needs when it is left empty.
function addTargetOptions(sub: SlashCommandSubcommandBuilder): SlashCommandSubcommandBuilder {
	return sub
		.addStringOption((option) =>
			option
				.setName(TARGET_OPTION)
				.setDescription(copy.command.targetOption)
				.setRequired(true)
				.addChoices(...TARGET_KINDS.map((kind) => ({ name: copy.command.targetChoices[kind], value: kind })))
		)
		.addUserOption((option) => option.setName(USER_OPTION).setDescription(copy.command.userOption).setRequired(false))
		.addStringOption((option) => option.setName(SERVER_OPTION).setDescription(copy.command.serverOption).setRequired(false));
}

/** The /platform network group: ban and unban, each with its target, member and server options. */
export function addNetworkBanSubcommands(group: SlashCommandSubcommandGroupBuilder): SlashCommandSubcommandGroupBuilder {
	return group
		.addSubcommand((sub) =>
			addTargetOptions(sub.setName("ban").setDescription(copy.command.ban)).addStringOption((option) =>
				option.setName(REASON_OPTION).setDescription(copy.command.reasonOption).setRequired(false).setMaxLength(NETWORK.BAN_REASON_MAX_LENGTH)
			)
		)
		.addSubcommand((sub) => addTargetOptions(sub.setName("unban").setDescription(copy.command.unban)));
}

/** Who a ban names, and how the owner's reply shows them. */
interface BanTarget {
	kind: NetworkBanKind;
	targetId: string;
	label: string;
}

type TargetRead = { ok: true; target: BanTarget } | { ok: false; problem: string };

/** Runs /platform network ban or unban for the platform owner, refusing everyone else first. */
export async function runNetworkBanSubcommand(interaction: ChatInputCommandInteraction): Promise<void> {
	if (!isPlatformOwner(interaction.user.id)) {
		await interaction.reply({ embeds: [errorEmbed(copy.notOwner)], flags: MessageFlags.Ephemeral });
		return;
	}

	const sub = interaction.options.getSubcommand(true);
	const targetKind = interaction.options.getString(TARGET_OPTION, true);
	if ((sub !== "ban" && sub !== "unban") || !isTargetKind(targetKind)) {
		await interaction.reply({ embeds: [errorEmbed(copy.unknownSubcommand(`${sub} ${targetKind}`))], flags: MessageFlags.Ephemeral });
		return;
	}

	const read = readTarget(interaction, targetKind);
	if (!read.ok) {
		await interaction.reply({ embeds: [errorEmbed(read.problem)], flags: MessageFlags.Ephemeral });
		return;
	}

	const target = read.target;
	try {
		const embed = sub === "ban" ? await ban(interaction.client, target, interaction.options.getString(REASON_OPTION) ?? "") : await unban(target);
		// No ping: the reply names a member only for the owner's eyes.
		await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
	}
	catch (error) {
		console.error(`[platform network] ${sub} failed for ${target.targetId}`, error);
		await interaction.reply({ embeds: [errorEmbed(copy.saveFailed)], flags: MessageFlags.Ephemeral }).catch(() => undefined);
	}
}

// A choice is the client's suggestion, so the submitted value is checked, not trusted.
function isTargetKind(value: string): value is BanTargetKind {
	return (TARGET_KINDS as string[]).includes(value);
}

// The member from the user option, or the server from its typed id, as the target says.
// The option the target needs, left empty, is refused rather than read from the other
// one. A typed id is user input, so it is checked for a snowflake's shape and refused
// otherwise, never stored.
function readTarget(interaction: ChatInputCommandInteraction, kind: BanTargetKind): TargetRead {
	if (kind === "member") {
		const user = interaction.options.getUser(USER_OPTION, false);
		if (!user) return { ok: false, problem: copy.missingTargetOption(kind) };
		return { ok: true, target: { kind: "user", targetId: user.id, label: `<@${user.id}>` } };
	}
	const serverId = interaction.options.getString(SERVER_OPTION, false)?.trim() ?? "";
	if (serverId === "") return { ok: false, problem: copy.missingTargetOption(kind) };
	if (!NETWORK.SERVER_ID_PATTERN.test(serverId)) return { ok: false, problem: copy.serverIdInvalid };
	const name = interaction.client.guilds.cache.get(serverId)?.name;
	return { ok: true, target: { kind: "guild", targetId: serverId, label: name ? `**${escapeMarkdown(name)}** (\`${serverId}\`)` : `\`${serverId}\`` } };
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
			if (seatedOut > 0) console.log(`[platform network] the ban on ${target.kind} ${target.targetId} seated out ${seatedOut} player(s) at network tables`);
		})
		.catch((error) => console.error(`[platform network] seating out the seats a ban on ${target.kind} ${target.targetId} names failed`, error));
}

async function unban(target: BanTarget): Promise<EmbedBuilder> {
	const lifted = await networkBanStore.unban(target.kind, target.targetId);
	if (!lifted) return infoEmbed(copy.title, copy.notBanned(target.kind, target.label), COLORS.ADMIN);
	scheduleNetworkBoardRefresh();
	return infoEmbed(copy.title, copy.unbanned(target.kind, target.label), COLORS.ADMIN);
}
