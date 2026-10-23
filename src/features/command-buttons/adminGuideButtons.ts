import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

// ── the admin guide's command buttons ────────────────────────────────────────
// What:  one button per admin command on the admin command guide (the pinned intro
//        in adminCommandsChannelId), grouped two rows by concern.
// Who:   GuildSetupManager.resolveIntroComponents composes these rows above the
//        guide's control row; adminCommandLauncher answers every press.
// Why a separate module: this one imports no command. The launcher imports every
//        admin command module, and GuildSetupManager sits under several of them, so
//        building the rows here keeps the setup manager out of that import cycle.
// How:   each button's label is the command's own name, so it can never advertise a
//        command that does not exist. adminCommandLauncher.test.ts pins that every
//        name here is a command it can open, and that every admin command is here.

/** The customId prefix every admin guide command button carries: `admincmd:<command>`. */
export const ADMIN_COMMAND_BUTTON_PREFIX = "admincmd";

/** The admin commands the guide offers, row by row: events and schedules, then the server. */
export const ADMIN_GUIDE_COMMAND_ROWS: ReadonlyArray<readonly string[]> = [
	["events", "schedule", "stream", "configure-kvk-season"],
	["channels", "configure", "setup-level-system", "xp", "dero-config"],
];

/** The button that opens one admin command's flow. */
export function buildAdminCommandButton(commandName: string): ButtonBuilder {
	return new ButtonBuilder()
		.setCustomId(`${ADMIN_COMMAND_BUTTON_PREFIX}:${commandName}`)
		.setLabel(`/${commandName}`)
		.setStyle(ButtonStyle.Secondary);
}

/** The guide's command rows, in ADMIN_GUIDE_COMMAND_ROWS order. */
export function buildAdminCommandRows(): ActionRowBuilder<ButtonBuilder>[] {
	return ADMIN_GUIDE_COMMAND_ROWS.map((names) => new ActionRowBuilder<ButtonBuilder>().addComponents(names.map(buildAdminCommandButton)));
}
