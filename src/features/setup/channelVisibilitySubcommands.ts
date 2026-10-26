import {
	TextChannel,
	EmbedBuilder,
	type AutocompleteInteraction,
	type Guild,
	type RepliableInteraction,
	type SlashCommandSubcommandGroupBuilder,
} from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { COLORS } from "@base/copy/brand.js";
import { getPluginCopy } from "@base/copy/getCopy.js";
import { errorEmbed, infoEmbed } from "@utils/embedBuilder.js";
import { creatorId } from "@utils/config.js";
import { addRenameChannelOptions, renameChannel, renameSlotChoices } from "@features/setup/renameChannel.js";
import { adminLog } from "@features/setup/adminLog.js";
import { setupCopy } from "@features/setup/setupCopy.js";
import type { CommandOptionReader, OptionChoice } from "@handlers/commandOptions.js";

/* /server channels: the homebase visibility toggles and rename, as one
   subcommand group that commands/admin/server.ts adds to /server and
   dispatches here. This module exports no `data` or `execute`, so neither
   command loader registers it.
   Three subcommands let admins hide or show the member-facing homebase
   channels without deleting them. Hiding applies @everyone deny
   ViewChannel; showing clears the deny. Channels always exist and
   the bot still posts to them; only member visibility changes. The
   fourth, rename, renames a managed channel and persists the name; its
   handler lives in features/setup/renameChannel.ts.

   ⚠️ TWO GATES, ON PURPOSE. hide, show and list are server owner only
   (the inline check in runChannelsSubcommand). rename lets the admin role
   pass, through /server in BOT_CONSTANTS.ADMIN_COMMANDS alone, so it is
   dispatched BEFORE the owner check.

   Autocomplete is dynamic per subcommand: /server channels hide suggests
   only currently-VISIBLE channels (the ones the admin can actually hide);
   /server channels show suggests only currently-HIDDEN channels. Avoids the
   UX trap where a static dropdown lets the admin pick a channel that
   is already in the desired state and the command silently no-ops. */

export const HIDEABLE_CHANNELS = [
	{ name: "Command center", value: "commandsChannelId" },
	{ name: "Leaderboard", value: "leaderboardChannelId" },
	{ name: "Event schedule", value: "scheduleChannelId" },
	{ name: "Announcements", value: "announcementsChannelId" },
	{ name: "Upcoming events", value: "nextDecreeChannelId" },
	// ── 🎮 ARCADE GAMES ──
	// Both belong here because both are MEMBER FACING and public, which is the
	// only criterion this list applies. An admin who does not want games in their
	// server should be able to hide the arcade without deleting it, exactly as
	// they can with the leaderboard.
	{ name: "Arcade rules", value: "arcadeRulesChannelId" },
	{ name: "Challenge board", value: "arcadeChallengesChannelId" },
	// 🏆rated-challenges (2026-10 item 254, Arcade 5), member facing like the board.
	{ name: "Rated challenges", value: "arcadeRatedChallengesChannelId" },
] as const;

// ⚠️ THIS LIST IS A DELIBERATE SUBSET OF CHANNEL_SPECS, NOT A MIRROR OF IT, and
// that is the one thing to understand before extending it. Introductions is
// excluded because hiding the channel new members are pointed at defeats the
// greeter, and both admin channels are excluded because they are already
// invisible to members, so "hide" would be a no-op with a confusing label.
// Do NOT "fix" this by deriving it from CHANNEL_SPECS the way the intro anchor
// map and the admin-role grant now are; those two had to cover everything, this
// one has to cover a choice.

type HideableField = (typeof HIDEABLE_CHANNELS)[number]["value"];
type GuildConfigDoc = NonNullable<Awaited<ReturnType<typeof guildConfigStore.findByGuildId>>>;

/** The /server channels group's four subcommands. */
export function addChannelsSubcommands(group: SlashCommandSubcommandGroupBuilder): SlashCommandSubcommandGroupBuilder {
	return group
		.addSubcommand((sub) =>
			sub
				.setName("hide")
				.setDescription("Hide a channel from members (bot still posts in the background)")
				.addStringOption((opt) =>
					opt.setName("channel").setDescription("Which channel to hide").setRequired(true).setAutocomplete(true)
				)
		)
		.addSubcommand((sub) =>
			sub
				.setName("show")
				.setDescription("Make a hidden channel visible to members again")
				.addStringOption((opt) =>
					opt.setName("channel").setDescription("Which channel to show").setRequired(true).setAutocomplete(true)
				)
		)
		.addSubcommand((sub) => sub.setName("list").setDescription("Show current visibility state of all hideable channels"))
		.addSubcommand((sub) =>
			addRenameChannelOptions(sub.setName("rename").setDescription("Rename a bot-managed channel so the new name persists across rebuilds"))
		);
}

/* Visibility choices. Return only the channel-kinds that make sense for
   the operation: hide suggests visible channels, show suggests hidden
   channels. Empty list on degenerate cases (eg /server channels show when
   nothing is hidden) so Discord shows "no options match" rather than
   misleading suggestions. */
async function visibilityChoices(guildId: string, subcommand: "hide" | "show"): Promise<OptionChoice[]> {
	const config = await guildConfigStore.findByGuildId(guildId);
	if (!config) return [];
	return hideableChannelStates(config)
		.filter((channel) => (subcommand === "hide" ? !channel.hidden : channel.hidden))
		.map((channel) => ({ name: channel.name, value: channel.value }));
}

/** One hideable channel this guild has, and whether members are kept from seeing it. */
export interface HideableChannelState {
	name: string;
	value: HideableField;
	hidden: boolean;
}

/**
 * The hideable channels provisioned in this guild, with their visibility. Read by the
 * hide and show picks above and by the /server channels settings panel (post-launch plan
 * item 9). A channel not provisioned yet is left out: hiding it would fail anyway.
 */
export function hideableChannelStates(config: GuildConfigDoc): HideableChannelState[] {
	const hidden = new Set(config.hiddenChannels ?? []);
	return HIDEABLE_CHANNELS.filter((c) => resolveChannelId(config, c.value) !== null).map((c) => ({ name: c.name, value: c.value, hidden: hidden.has(c.value) }));
}

/** Whether a member passes hide, show and list's gate: the server owner, or the bot's creator. */
export function canChangeVisibility(userId: string, guildOwnerId: string | undefined): boolean {
	return userId === guildOwnerId || userId === creatorId;
}

/* The choices one subcommand's option offers, for the autocomplete and the
   admin form alike: rename's slot lists the configured channel slots, hide
   and show's channel lists the hideable channels in the right state. list
   takes no option, so it answers nothing. */
async function choicesFor(guild: Guild | null, subcommand: string): Promise<OptionChoice[]> {
	if (!guild) return [];
	if (subcommand === "rename") return renameSlotChoices(guild);
	if (subcommand === "hide" || subcommand === "show") return visibilityChoices(guild.id, subcommand);
	return [];
}

/** The /server channels autocomplete: the leaf's own picks. */
export async function channelsAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
	await interaction.respond(await choicesFor(interaction.guild, interaction.options.getSubcommand()));
}

/** Runs one /server channels subcommand, for the slash command and the admin guide alike. */
export async function runChannelsSubcommand(interaction: RepliableInteraction, options: CommandOptionReader): Promise<void> {
	// rename keeps /rename-channel's admin gate, so it leaves before the owner
	// check below (see the TWO GATES note at the top of this file).
	const subcommand = options.getSubcommand();
	if (subcommand === "rename") {
		await renameChannel(interaction, options);
		return;
	}

	// Load config first so the owner/setup responses below speak in the guild's
	// copy pack (ownerOnly + setupChannelsPending diverge between packs). A null
	// config resolves to the rok-commander default inside getPluginCopy.
	const config = await guildConfigStore.findByGuildId(interaction.guildId!);
	const { responses } = getPluginCopy(config);

	if (!canChangeVisibility(interaction.user.id, interaction.guild?.ownerId)) {
		await interaction.reply({ embeds: [errorEmbed(responses.ownerOnly)], ephemeral: true });
		return;
	}

	if (!config?.categoryId) {
		await interaction.reply({ embeds: [errorEmbed(responses.setupChannelsPending)], ephemeral: true });
		return;
	}

	switch (subcommand) {
		case "hide":
			return handleHide(interaction, options, config);
		case "show":
			return handleShow(interaction, options, config);
		case "list":
			return handleList(interaction, config);
		default:
			await interaction.reply({ embeds: [errorEmbed("Unknown subcommand")], ephemeral: true });
	}
}

/* Resolve a HideableField to the actual Discord channel id stored in
   GuildConfig. Switch statement instead of dynamic indexing because
   Mongoose Document types do not expose a string index signature. */
function resolveChannelId(config: GuildConfigDoc, field: HideableField): string | null {
	let value: string | null | undefined;
	switch (field) {
		case "commandsChannelId":
			value = config.commandsChannelId;
			break;
		case "leaderboardChannelId":
			value = config.leaderboardChannelId;
			break;
		case "scheduleChannelId":
			value = config.scheduleChannelId;
			break;
		case "announcementsChannelId":
			value = config.announcementsChannelId;
			break;
		case "nextDecreeChannelId":
			value = config.nextDecreeChannelId;
			break;
		// ⚠️ A CASE MISSING HERE IS SILENT. The switch has no default, so an
		// unhandled field leaves `value` undefined, this returns null, and the
		// autocomplete filter above drops the channel entirely: the option simply
		// never appears and /server channels hide quietly does not support it. Adding to
		// HIDEABLE_CHANNELS without adding here looks like it works and does not.
		case "arcadeRulesChannelId":
			value = (config as unknown as Record<string, string | null | undefined>).arcadeRulesChannelId;
			break;
		case "arcadeChallengesChannelId":
			value = (config as unknown as Record<string, string | null | undefined>).arcadeChallengesChannelId;
			break;
		case "arcadeRatedChallengesChannelId":
			value = (config as unknown as Record<string, string | null | undefined>).arcadeRatedChallengesChannelId;
			break;
	}
	return typeof value === "string" && value.length > 0 ? value : null;
}

/* Validate that the user picked a HideableField. The autocomplete
   handler returns valid values, but a determined user could type a
   raw value and get past the dropdown. Returning a helpful error here
   keeps the bot resilient to manual entry. */
function isHideableField(value: string): value is HideableField {
	return HIDEABLE_CHANNELS.some((c) => c.value === value);
}

async function handleHide(interaction: RepliableInteraction, options: CommandOptionReader, config: GuildConfigDoc) {
	const fieldInput = options.getString("channel", true);
	if (!isHideableField(fieldInput)) {
		await interaction.reply({
			embeds: [errorEmbed(`Pick one of the channels from the dropdown.`)],
			ephemeral: true,
		});
		return;
	}
	const field = fieldInput;
	const displayName = HIDEABLE_CHANNELS.find((c) => c.value === field)?.name ?? field;

	// State guard: if the channel is already hidden, reject early so the
	// admin gets clear feedback instead of a silent no-op.
	const hidden = new Set(config.hiddenChannels ?? []);
	if (hidden.has(field)) {
		await interaction.reply({
			embeds: [errorEmbed(`**${displayName}** is already hidden. Use /server channels show ${field} to make it visible.`)],
			ephemeral: true,
		});
		return;
	}

	const channelId = resolveChannelId(config, field);
	if (!channelId) {
		await interaction.reply({
			embeds: [errorEmbed(`That channel is not configured on this guild yet.`)],
			ephemeral: true,
		});
		return;
	}

	const channel = await interaction.guild!.channels.fetch(channelId).catch(() => null);
	if (!channel || !(channel instanceof TextChannel)) {
		await interaction.reply({
			embeds: [errorEmbed(`Channel not found in Discord. It may have been deleted; let auto-heal rebuild it first.`)],
			ephemeral: true,
		});
		return;
	}

	try {
		await channel.permissionOverwrites.edit(interaction.guild!.roles.everyone.id, { ViewChannel: false });
	} catch (error) {
		console.error(`[/server channels hide] failed to apply overwrite`, error);
		await interaction.reply({ embeds: [errorEmbed("Failed to update channel permissions.")], ephemeral: true });
		return;
	}

	const hiddenChannels = Array.from(new Set([...(config.hiddenChannels ?? []), field]));
	await guildConfigStore.update(interaction.guildId!, { hiddenChannels });
	adminLog.emitFor(interaction, interaction.guildId!, "config.change", { subject: setupCopy.adminLog.subjects.channelVisibility(displayName), detail: setupCopy.adminLog.hidden });

	await interaction.reply({
		embeds: [
			infoEmbed(
				`Channel hidden`,
				`Hid <#${channelId}> (${displayName}) from members. The bot still posts there in the background. Run /server channels show to make it visible again.`,
				COLORS.ARRIVAL
			),
		],
		ephemeral: true,
	});
}

async function handleShow(interaction: RepliableInteraction, options: CommandOptionReader, config: GuildConfigDoc) {
	const fieldInput = options.getString("channel", true);
	if (!isHideableField(fieldInput)) {
		await interaction.reply({
			embeds: [errorEmbed(`Pick one of the channels from the dropdown.`)],
			ephemeral: true,
		});
		return;
	}
	const field = fieldInput;
	const displayName = HIDEABLE_CHANNELS.find((c) => c.value === field)?.name ?? field;

	// State guard: if the channel is NOT currently hidden, reject early
	// so the admin understands why nothing visibly changes.
	const hidden = new Set(config.hiddenChannels ?? []);
	if (!hidden.has(field)) {
		await interaction.reply({
			embeds: [errorEmbed(`**${displayName}** is already visible. Use /server channels hide ${field} to hide it.`)],
			ephemeral: true,
		});
		return;
	}

	const channelId = resolveChannelId(config, field);
	if (!channelId) {
		await interaction.reply({
			embeds: [errorEmbed(`That channel is not configured on this guild yet.`)],
			ephemeral: true,
		});
		return;
	}

	const channel = await interaction.guild!.channels.fetch(channelId).catch(() => null);
	if (!channel || !(channel instanceof TextChannel)) {
		await interaction.reply({
			embeds: [errorEmbed(`Channel not found in Discord.`)],
			ephemeral: true,
		});
		return;
	}

	// Restore @everyone ViewChannel to allow (not null), which matches the
	// original publicOverwrites shape from createChannels. Setting null
	// would clear the explicit allow and rely on server defaults; setting
	// true explicitly grants it back so the channel definitively becomes
	// visible regardless of server-wide overrides.
	try {
		await channel.permissionOverwrites.edit(interaction.guild!.roles.everyone.id, { ViewChannel: true });
	} catch (error) {
		console.error(`[/server channels show] failed to clear overwrite`, error);
		await interaction.reply({ embeds: [errorEmbed("Failed to update channel permissions.")], ephemeral: true });
		return;
	}

	const hiddenChannels = (config.hiddenChannels ?? []).filter((f) => f !== field);
	await guildConfigStore.update(interaction.guildId!, { hiddenChannels });
	adminLog.emitFor(interaction, interaction.guildId!, "config.change", { subject: setupCopy.adminLog.subjects.channelVisibility(displayName), detail: setupCopy.adminLog.shown });

	await interaction.reply({
		embeds: [
			infoEmbed(
				`Channel visible`,
				`Made <#${channelId}> (${displayName}) visible to members again.`,
				COLORS.ARRIVAL
			),
		],
		ephemeral: true,
	});
}

async function handleList(interaction: RepliableInteraction, config: GuildConfigDoc) {
	const hidden = new Set(config.hiddenChannels ?? []);
	const lines = HIDEABLE_CHANNELS.map((c) => {
		const id = resolveChannelId(config, c.value);
		const channelMention = id ? `<#${id}>` : `(not configured)`;
		const state = hidden.has(c.value) ? "🔒 hidden" : "🔓 visible";
		return `**${c.name}** ${state}  •  ${channelMention}`;
	}).join("\n");

	const embed = new EmbedBuilder()
		.setTitle("Channel visibility")
		.setDescription(lines)
		.setColor(COLORS.ARRIVAL)
		.setFooter({ text: "Hidden channels still receive bot posts; only member visibility is suppressed." });

	await interaction.reply({ embeds: [embed], ephemeral: true });
}

/**
 * The admin form's pickers, which read the same lists the autocomplete answers with.
 * `subcommand` is the leaf inside the channels group ("hide", "rename").
 */
export async function channelsFormChoices(guild: Guild, subcommand: string, optionName: string): Promise<OptionChoice[] | null> {
	if (subcommand === "rename") return optionName === "slot" ? renameSlotChoices(guild) : null;
	return optionName === "channel" ? choicesFor(guild, subcommand) : null;
}
