import {
	MessageFlags,
	TextChannel,
	VoiceChannel,
	type Guild,
	type RepliableInteraction,
	type SlashCommandSubcommandBuilder,
} from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { errorEmbed, infoEmbed } from "@utils/embedBuilder.js";
import { COLORS } from "@base/copy/brand.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { CommandOptionReader, OptionChoice } from "@handlers/commandOptions.js";

// ── /channels rename ──────────────────────────────────────────────────
// What:  rename one of the bot-managed channels AND persist the new name
//        so it survives the rebuild path. Without this command, admins
//        could rename channels via Discord's UI but the rebuilds run by
//        repairMissingChannels and ChannelDeleteWatcher would restore
//        the pack default (eg "homebase-leaderboard") whenever a
//        channel got deleted and re-created.
// Who:   server admins: gated by BOT_CONSTANTS.ADMIN_COMMANDS in main.ts (the
//        server owner or the /setup admin role), like the rest of /configure.
//        /channels rename and the admin guide's /channels button both run it.
// When:  on demand. Idempotent, running with the same name twice is a
//        no-op write (we still emit a "no change made" reply rather
//        than a silent success so the admin gets clear feedback).
// Where: writes both (a) the live Discord channel via channel.setName,
//        and (b) GuildConfig.channelNames map keyed by configField.
//        The rebuild path reads channelNames before falling back to
//        spec.displayName.
// How:   ① slot choices: pack-neutral labels mapping to the
//           trackable configField names so the command reads the
//           same in rok-commander and general-events;
//        ② resolve the channel id from GuildConfig and fetch the live
//           channel; bail if the channel slot has never been set up;
//        ③ rename the live channel via Discord API, then persist the
//           override into the channelNames map;
//        ④ explicit "this persists across rebuilds; direct Discord
//           renames do not" reminder in the reply embed so the admin
//           internalizes the rule the first time they use the command.

// ── slot label table ──
// Stable pack-neutral labels for the autocomplete dropdown. The label is
// what the admin sees ("Leaderboard"); the value is the configField name
// the handler operates on. Adding a future channel slot requires a one-
// liner here plus the schema/spec wiring in GuildSetupManager.
export const SLOT_LABELS: ReadonlyArray<{ label: string; configField: string }> = [
	{ label: "Introduction channel", configField: "introChannelId" },
	{ label: "Commands channel", configField: "commandsChannelId" },
	{ label: "Leaderboard", configField: "leaderboardChannelId" },
	{ label: "Schedule board", configField: "scheduleChannelId" },
	{ label: "Announcements", configField: "announcementsChannelId" },
	{ label: "Admin / inner sanctum", configField: "adminChannelId" },
	{ label: "Upcoming events", configField: "nextDecreeChannelId" },
	// Admin command center. MISSING until 2026-08-12, so the one channel an admin
	// is most likely to want renamed was the one slot they could not pick. Not a
	// deliberate exclusion, just a list nobody extended when the channel shipped.
	{ label: "Admin controls", configField: "adminCommandsChannelId" },
	// 👋welcome and 📘rules (2026-10 item 247 Phase 2). An autocomplete row each, so
	// no command redeploy. The drift sweep leaves an ADOPTED one's name alone, but an
	// admin renaming it here is the owner's own choice and goes through.
	{ label: "Welcome log", configField: "welcomeChannelId" },
	{ label: "Rules", configField: "rulesChannelId" },
	// ── 🎮 ARCADE GAMES ──
	// Both member facing and both renameable: a guild that calls its arcade
	// something else should be able to say so, and repairOneChannel already
	// honors a stored override across rebuilds.
	{ label: "Arcade rules", configField: "arcadeRulesChannelId" },
	{ label: "Challenge board", configField: "arcadeChallengesChannelId" },
	// 🕹️games (2026-10 item 245 Phase 4a). An autocomplete row, not a change to the
	// command's registered shape, so no command redeploy is needed for it.
	{ label: "Games", configField: "arcadeGamesChannelId" },
	// ── the two voice rooms (2026-10 item 235) ──
	// Renameable like every other managed channel; the drift sweep and the
	// repair path both honor the stored override for a voice room too.
	{ label: "Meeting Hall voice room", configField: "meetingVoiceChannelId" },
	{ label: "Arcade Lounge voice room", configField: "arcadeVoiceChannelId" },
];
const VALID_SLOTS = new Set(SLOT_LABELS.map((s) => s.configField));

/** The options this handler reads, added to the merged command's subcommand. */
export function addRenameChannelOptions(sub: SlashCommandSubcommandBuilder): SlashCommandSubcommandBuilder {
	return sub
		.addStringOption((option) =>
			option.setName("slot").setDescription("Which channel slot to rename").setRequired(true).setAutocomplete(true)
		)
		.addStringOption((option) =>
			option
				.setName("name")
				.setDescription("New channel name (1-100 chars; Discord auto-converts spaces to dashes)")
				.setRequired(true)
				.setMinLength(1)
				.setMaxLength(100)
		);
}

/**
 * The channel slots /channels rename can name in this guild, each shown by its LIVE
 * name. Read by the command's autocomplete and by the admin form's slot picker.
 */
export async function renameSlotChoices(guild: Guild): Promise<OptionChoice[]> {
	// Filter to channels actually configured in this guild. v1.5.1 fix:
	// previously the dropdown listed all 7 slots unconditionally, which
	// made admins think they could rename channels that did not exist
	// in their guild. The handler rejected those cases at runtime, but
	// surfacing only configured slots in the dropdown gives clearer UX.
	const config = await guildConfigStore.findByGuildId(guild.id);
	if (!config) return [];
	const configRecord = config as unknown as Record<string, string | null | undefined>;

	// Display the LIVE channel name so the dropdown reflects prior renames.
	// Without this, an admin who renamed "leaderboard" to "top-warriors"
	// last week still saw "Leaderboard" in the dropdown the next time and
	// had to remember which slot they were renaming. Slot label is appended
	// in parens for context (useful when channel names are generic and the
	// admin needs to confirm which logical slot they are targeting).
	// Cache lookup (not fetch) keeps autocomplete responsive; the
	// GUILD_CHANNELS gateway intent keeps the cache warm. Cache miss falls
	// back to the static label so the slot stays selectable.
	const suggestions: OptionChoice[] = [];
	for (const slot of SLOT_LABELS) {
		const id = configRecord[slot.configField];
		if (typeof id !== "string" || id.length === 0) continue;

		const channel = guild.channels.cache.get(id);
		const liveName = channel?.name;
		// Discord caps an autocomplete name and a select label at 100 chars;
		// channel names cap at 100 already, so the parenthetical can push us
		// over. Slice defensively.
		const displayName =
			liveName && liveName.length > 0
				? `${liveName} (${slot.label})`.slice(0, BOT_CONSTANTS.DISCORD_LIMITS.MAX_SELECT_LABEL_LENGTH)
				: slot.label;
		suggestions.push({ name: displayName, value: slot.configField });
	}
	return suggestions;
}

export async function renameChannel(interaction: RepliableInteraction, options: CommandOptionReader): Promise<void> {
	const guildId = interaction.guildId;
	if (!guildId) {
		await interaction.reply({
			embeds: [errorEmbed("Run this in a server, not a DM.")],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const slot = options.getString("slot", true);
	const newName = options.getString("name", true).trim();

	// Validate the slot against the known set. Without this, a user typing
	// a free-form value into the field could write to an arbitrary key on
	// the channelNames map.
	if (!VALID_SLOTS.has(slot)) {
		await interaction.reply({
			embeds: [errorEmbed("Pick a slot from the dropdown, that value is not a known channel slot.")],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const config = await guildConfigStore.findByGuildId(guildId);
	if (!config) {
		await interaction.reply({
			embeds: [errorEmbed("This server has not been set up yet. Run /setup first.")],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	// Resolve the channel id from GuildConfig. If the slot has never been
	// set up (eg legacy guild predating a newer channel spec), surface
	// the missing channel rather than silently rejecting.
	const channelId = (config as unknown as Record<string, string | null | undefined>)[slot];
	if (!channelId) {
		await interaction.reply({
			embeds: [
				errorEmbed(
					"That channel slot is not currently set up in this server. Run /setup or enable the related feature first."
				),
			],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const channel = await interaction.guild?.channels.fetch(channelId).catch(() => null);
	// The two voice rooms are the only managed slots that are not text channels.
	if (!channel || !(channel instanceof TextChannel || channel instanceof VoiceChannel)) {
		await interaction.reply({
			embeds: [
				errorEmbed("Could not find the live channel. It may have been deleted; let auto-heal rebuild it, then try again."),
			],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	// Idempotency. If the live channel already has this name AND the
	// override matches, surface "no change made" rather than silently
	// re-writing. Two equality checks because the override and the live
	// name can theoretically drift (admin renamed via Discord directly
	// since the last slash-command write).
	const existingOverride = (config.channelNames as Map<string, string> | undefined)?.get(slot);
	if (channel.name === newName && existingOverride === newName) {
		await interaction.reply({
			embeds: [
				infoEmbed(
					"Already that name",
					`The channel is already named **${newName}** and that name is already persisted. No change made.`,
					COLORS.SCHEDULE
				),
			],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	try {
		// Rename the live channel first. If the API call fails (rate limit,
		// permission missing, etc.) we bail before writing the override,
		// otherwise the GuildConfig would claim a name that does not exist
		// in Discord and rebuilds would propagate the false name forward.
		await channel.setName(newName, "Renamed via /channels rename");

		// Persist the override in the channelNames map. Mongoose Maps need
		// to be cloned + written back; guildConfigStore.update wraps in
		// $set so passing a plain object with dotted notation is cleanest.
		const updatedMap = new Map((config.channelNames as Map<string, string> | undefined) ?? []);
		updatedMap.set(slot, newName);
		// Mongoose accepts a plain object for a Map field on $set; convert
		// to a record so the wire format matches what the store expects.
		const channelNamesRecord: Record<string, string> = {};
		for (const [key, val] of updatedMap.entries()) {
			channelNamesRecord[key] = val;
		}
		await guildConfigStore.update(guildId, { channelNames: channelNamesRecord });

		await interaction.reply({
			embeds: [
				infoEmbed(
					"✏️ Channel renamed",
					`The channel is now named **${newName}** and the rename is persisted, so it will survive any future auto-heal rebuild.\n\nHeads up: renaming the channel directly in Discord works for the live channel but does NOT update the persisted override. Use /channels rename again any time you want the new name to stick across rebuilds.`,
					COLORS.SCHEDULE
				),
			],
			flags: MessageFlags.Ephemeral,
		});
	} catch (err) {
		console.error(`[channels rename] failed for guild ${guildId}, slot ${slot}`, err);
		await interaction.reply({
			embeds: [
				errorEmbed(
					"Could not rename the channel. Check the bot's Manage Channels permission, or try again, Discord enforces a rate limit of 2 renames per 10 minutes per channel."
				),
			],
			flags: MessageFlags.Ephemeral,
		});
	}
}
