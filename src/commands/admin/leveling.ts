import { SlashCommandBuilder, type ChatInputCommandInteraction, type RepliableInteraction } from "discord.js";
import { addLevelSettingsSubcommands, runLevelSettings } from "@features/leveling/levelSettingsSubcommands.js";
import { addXpSubcommands, runXpSubcommand } from "@features/leveling/xpSubcommands.js";
import { refreshHeadquartersCards } from "@features/setup/headquartersCards.js";
import type { CommandOptionReader } from "@handlers/commandOptions.js";

// ── /leveling ─────────────────────────────────────────────────────────
// What:  the leveling system in one command: the `settings` group (every per
//        server knob, from the master switch to role rewards) and the `xp` group
//        (correct, reset or export members' XP).
// Who:   admins only, through BOT_CONSTANTS.ADMIN_COMMANDS and nothing else: no
//        Discord default permission, which would hide it from the /setup admin role.
//        From the slash command or the /leveling button on the admin guide, whose
//        settings panel runs the settings group's leaves through this same `run`.
// Where: the handlers live in features/leveling (levelSettingsSubcommands.ts and
//        xpSubcommands.ts); this file only declares the tree and dispatches.

const XP_GROUP = "xp";

export const data = new SlashCommandBuilder()
	.setName("leveling")
	.setDescription("XP and levels: the settings, and corrections, resets and exports of members' XP")
	// The settings group says it creates nothing, because /setup builds channels and
	// roles and an admin who reads "set up" can expect the same of this.
	.addSubcommandGroup((group) =>
		addLevelSettingsSubcommands(
			group.setName("settings").setDescription("Configure XP and levels for this server. Writes settings only, creates no channels or roles.")
		)
	)
	.addSubcommandGroup((group) => addXpSubcommands(group.setName(XP_GROUP).setDescription("Correct, reset or export this server's XP data")));

/** The one handler the slash command and the admin guide's /leveling button share. */
export async function run(interaction: RepliableInteraction, options: CommandOptionReader): Promise<void> {
	await dispatch(interaction, options);
	// 🛠️server-config's steps card, switches and chart follow every leveling and XP change, fire
	// and forget (2026-10 item 263 Phase 4a); the steps and settings panels run this handler.
	refreshHeadquartersCards(interaction.guild, "serverConfig");
}

async function dispatch(interaction: RepliableInteraction, options: CommandOptionReader): Promise<void> {
	if (options.getSubcommandGroup(false) === XP_GROUP) {
		await runXpSubcommand(interaction, options);
		return;
	}
	await runLevelSettings(interaction, options);
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
	await run(interaction, interaction.options);
}
