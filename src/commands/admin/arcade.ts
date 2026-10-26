import { SlashCommandBuilder, type ChatInputCommandInteraction, type RepliableInteraction } from "discord.js";
import { ratingsCopy } from "@features/ratings/ratingsCopy.js";
import { economyCopy } from "@features/economy/economyCopy.js";
import { addChipSubcommands, runChipSubcommand } from "@features/economy/chipEconomySubcommands.js";
import { addArcadeSettingSubcommands, addServerBlockSubcommands, runArcadeSettingSubcommand } from "@features/setup/arcadeSettingsSubcommands.js";
import type { CommandOptionReader } from "@handlers/commandOptions.js";

// ── /arcade ───────────────────────────────────────────────────────────
// What:  the arcade in one command: `on` and `off`, `bots`, `reach` and
//        `monthly-post`, the `server` group (block and unblock a server on the
//        network) and the `chips` group (status, toggle and grant).
// Who:   admins, through BOT_CONSTANTS.ADMIN_COMMANDS (the guild owner or the bot's
//        admin role), from the slash command or the /arcade button on the admin
//        guide, whose settings panel runs `chips toggle`, `monthly-post` and `bots`
//        through this same `run`.
// Where: the settings live in features/setup/arcadeSettingsSubcommands.ts and the
//        chips in features/economy/chipEconomySubcommands.ts; this file only
//        declares the tree and dispatches.

const CHIPS_GROUP = "chips";

export const data = addArcadeSettingSubcommands(new SlashCommandBuilder().setName("arcade").setDescription(ratingsCopy.config.group))
	.addSubcommandGroup((group) => addServerBlockSubcommands(group.setName("server").setDescription(ratingsCopy.config.serverGroup)))
	.addSubcommandGroup((group) => addChipSubcommands(group.setName(CHIPS_GROUP).setDescription(economyCopy.admin.commandDescription)));

/** The one handler the slash command and the admin guide's /arcade button share. */
export async function run(interaction: RepliableInteraction, options: CommandOptionReader): Promise<void> {
	if (options.getSubcommandGroup(false) === CHIPS_GROUP) {
		await runChipSubcommand(interaction, options);
		return;
	}
	await runArcadeSettingSubcommand(interaction, options);
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
	await run(interaction, interaction.options);
}
