import {
	SlashCommandBuilder,
	ChatInputCommandInteraction,
	AutocompleteInteraction,
	PermissionFlagsBits,
	TextChannel,
	EmbedBuilder,
} from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { COLORS } from "@base/copy/brand.js";
import { getPluginCopy } from "@base/copy/getCopy.js";
import { errorEmbed, infoEmbed } from "@utils/embedBuilder.js";
import { creatorId } from "@utils/config.js";

/* /channels, v1.5.1 visibility-toggle command.
   Three subcommands let admins hide or show the member-facing homebase
   channels without deleting them. Hiding applies @everyone deny
   ViewChannel; showing clears the deny. Channels always exist and
   the bot still posts to them; only member visibility changes.

   Autocomplete is dynamic per subcommand: /channels hide suggests only
   currently-VISIBLE channels (the ones the admin can actually hide);
   /channels show suggests only currently-HIDDEN channels. Avoids the
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

export const data = new SlashCommandBuilder()
	.setName("channels")
	.setDescription("Hide or show homebase channels for members")
	.setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
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
	.addSubcommand((sub) => sub.setName("list").setDescription("Show current visibility state of all hideable channels"));

/* Autocomplete handler. Dispatches on subcommand to return only the
   channel-kinds that make sense for the current operation: hide
   suggests visible channels, show suggests hidden channels. Empty list
   on degenerate cases (eg /channels show when nothing is hidden) so
   Discord shows "no options match" rather than misleading suggestions. */
export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
	if (!interaction.guildId) {
		await interaction.respond([]);
		return;
	}

	const subcommand = interaction.options.getSubcommand();
	if (subcommand !== "hide" && subcommand !== "show") {
		// list does not take a channel option, so autocomplete should
		// never fire for it. Defensive empty response just in case.
		await interaction.respond([]);
		return;
	}

	const config = await guildConfigStore.findByGuildId(interaction.guildId);
	if (!config) {
		await interaction.respond([]);
		return;
	}
	const hidden = new Set(config.hiddenChannels ?? []);

	const suggestions = HIDEABLE_CHANNELS.filter((c) => {
		// Skip channels that have not been provisioned in this guild yet
		// (resolveChannelId returns null for missing channel ids). Showing
		// them in the dropdown is misleading because /channels hide on an
		// unconfigured channel would fail anyway.
		const channelId = resolveChannelId(config, c.value);
		if (!channelId) return false;

		const isCurrentlyHidden = hidden.has(c.value);
		return subcommand === "hide" ? !isCurrentlyHidden : isCurrentlyHidden;
	});

	await interaction.respond(suggestions.map((c) => ({ name: c.name, value: c.value })));
}

export async function execute(interaction: ChatInputCommandInteraction) {
	// Load config first so the owner/setup responses below speak in the guild's
	// copy pack (ownerOnly + setupChannelsPending diverge between packs). A null
	// config resolves to the rok-commander default inside getPluginCopy.
	const config = await guildConfigStore.findByGuildId(interaction.guildId!);
	const { responses } = getPluginCopy(config);

	const isOwner = interaction.user.id === interaction.guild?.ownerId;
	const isCreator = interaction.user.id === creatorId;

	if (!isOwner && !isCreator) {
		await interaction.reply({ embeds: [errorEmbed(responses.ownerOnly)], ephemeral: true });
		return;
	}

	if (!config?.categoryId) {
		await interaction.reply({ embeds: [errorEmbed(responses.setupChannelsPending)], ephemeral: true });
		return;
	}

	const subcommand = interaction.options.getSubcommand();
	switch (subcommand) {
		case "hide":
			return handleHide(interaction, config);
		case "show":
			return handleShow(interaction, config);
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
		// never appears and /channels hide quietly does not support it. Adding to
		// HIDEABLE_CHANNELS without adding here looks like it works and does not.
		case "arcadeRulesChannelId":
			value = (config as unknown as Record<string, string | null | undefined>).arcadeRulesChannelId;
			break;
		case "arcadeChallengesChannelId":
			value = (config as unknown as Record<string, string | null | undefined>).arcadeChallengesChannelId;
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

async function handleHide(interaction: ChatInputCommandInteraction, config: GuildConfigDoc) {
	const fieldInput = interaction.options.getString("channel", true);
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
			embeds: [errorEmbed(`**${displayName}** is already hidden. Use /channels show ${field} to make it visible.`)],
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
		console.error(`[/channels hide] failed to apply overwrite`, error);
		await interaction.reply({ embeds: [errorEmbed("Failed to update channel permissions.")], ephemeral: true });
		return;
	}

	const hiddenChannels = Array.from(new Set([...(config.hiddenChannels ?? []), field]));
	await guildConfigStore.update(interaction.guildId!, { hiddenChannels });

	await interaction.reply({
		embeds: [
			infoEmbed(
				`Channel hidden`,
				`Hid <#${channelId}> (${displayName}) from members. The bot still posts there in the background. Run /channels show to make it visible again.`,
				COLORS.ARRIVAL
			),
		],
		ephemeral: true,
	});
}

async function handleShow(interaction: ChatInputCommandInteraction, config: GuildConfigDoc) {
	const fieldInput = interaction.options.getString("channel", true);
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
			embeds: [errorEmbed(`**${displayName}** is already visible. Use /channels hide ${field} to hide it.`)],
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
		console.error(`[/channels show] failed to clear overwrite`, error);
		await interaction.reply({ embeds: [errorEmbed("Failed to update channel permissions.")], ephemeral: true });
		return;
	}

	const hiddenChannels = (config.hiddenChannels ?? []).filter((f) => f !== field);
	await guildConfigStore.update(interaction.guildId!, { hiddenChannels });

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

async function handleList(interaction: ChatInputCommandInteraction, config: GuildConfigDoc) {
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
