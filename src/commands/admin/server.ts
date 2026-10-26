import { SlashCommandBuilder, type AutocompleteInteraction, type ChatInputCommandInteraction, type RepliableInteraction } from "discord.js";
import { addAutoHealOptions, configureAutoHeal } from "@features/setup/configureAutoHeal.js";
import { addChannelsSubcommands, channelsAutocomplete, channelsFormChoices, runChannelsSubcommand } from "@features/setup/channelVisibilitySubcommands.js";
import { addLeaderboardTrackingOptions, configureLeaderboardTracking } from "@features/leaderboard/configureLeaderboardTracking.js";
import { addWeekStartOptions, configureLeaderboardWeekStart } from "@features/leaderboard/configureLeaderboardWeekStart.js";
import type { CommandOptionReader, FormChoicesProvider } from "@handlers/commandOptions.js";

// ── /server ───────────────────────────────────────────────────────────
// What:  the server's homebase and its switches: `auto-heal` (whether deleted
//        homebase channels are rebuilt), the `channels` group (hide, show, list
//        and rename) and the `leaderboard` group (`tracking`, whether participation
//        is recorded, and `week-start`, which day the leaderboard's week begins).
// Who:   admins (BOT_CONSTANTS.ADMIN_COMMANDS), from the slash command or the
//        /server and /server channels buttons on the admin guide, which run this
//        same `run`. channels hide, show and list also keep their own server owner
//        check inside the channels module.
// Where: each handler lives with the feature it switches (features/setup and
//        features/leaderboard); this file only declares the tree and dispatches.

const CHANNELS_GROUP = "channels";

export const data = new SlashCommandBuilder()
	.setName("server")
	.setDescription("This server's homebase: channel auto heal, channel visibility and names, and the leaderboard")
	.addSubcommand((sub) =>
		addAutoHealOptions(sub.setName("auto-heal").setDescription("Toggle whether the bot rebuilds missing homebase channels automatically"))
	)
	.addSubcommandGroup((group) => addChannelsSubcommands(group.setName(CHANNELS_GROUP).setDescription("Hide, show, list or rename homebase channels")))
	.addSubcommandGroup((group) =>
		group
			.setName("leaderboard")
			.setDescription("The leaderboard's tracking switch and its week")
			.addSubcommand((sub) =>
				addLeaderboardTrackingOptions(sub.setName("tracking").setDescription("Toggle whether the bot records participation (reactions + voice joins)"))
			)
			.addSubcommand((sub) =>
				addWeekStartOptions(sub.setName("week-start").setDescription("Set which day the leaderboard's \"this week\" window starts on"))
			)
	);

/** The one handler the slash command and the admin guide's /server buttons share. */
export async function run(interaction: RepliableInteraction, options: CommandOptionReader): Promise<void> {
	const group = options.getSubcommandGroup(false);
	if (group === CHANNELS_GROUP) {
		await runChannelsSubcommand(interaction, options);
		return;
	}
	switch (options.getSubcommand(true)) {
		case "auto-heal":
			await configureAutoHeal(interaction, options);
			return;
		case "tracking":
			await configureLeaderboardTracking(interaction, options);
			return;
		default:
			await configureLeaderboardWeekStart(interaction, options);
	}
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
	await run(interaction, interaction.options);
}

// Only the channels group autocompletes (hide, show and rename's slot).
export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
	if (interaction.options.getSubcommandGroup(false) !== CHANNELS_GROUP) {
		await interaction.respond([]);
		return;
	}
	await channelsAutocomplete(interaction);
}

/** The admin form's pickers: the channels group's own, read by its leaf inside the group. */
export const formChoices: FormChoicesProvider = async (guild, leafPath, optionName) => {
	const [group, subcommand] = leafPath.split(" ");
	return group === CHANNELS_GROUP && subcommand ? channelsFormChoices(guild, subcommand, optionName) : null;
};
