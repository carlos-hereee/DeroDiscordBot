import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

// ── the admin guide's command buttons ────────────────────────────────────────
// What:  one button per admin job on the admin command guide (the pinned intro in
//        adminCommandsChannelId), two rows: events, the server, its channels,
//        leveling and Dero, then the arcade.
// Who:   GuildSetupManager.resolveIntroComponents composes these rows above the
//        guide's control row; adminCommandLauncher answers every press.
// Why a separate module: this one imports no command. The launcher imports every
//        admin command module, and GuildSetupManager sits under several of them, so
//        building the rows here keeps the setup manager out of that import cycle.
// How:   a button's customId carries a launch id: a settings panel id (server,
//        server-channels, leveling, dero-config, arcade) or, for /events, the command
//        name. Its label is the command path that id opens, so it can never advertise
//        a command that does not exist: adminCommandLauncher.test.ts pins that every
//        id here opens the command its label names, and that every admin command is here.

/** The customId prefix every admin guide command button carries: `admincmd:<launch id>`. */
export const ADMIN_COMMAND_BUTTON_PREFIX = "admincmd";

/** One guide button: the launch id its customId carries and the command path its label shows. */
export interface AdminGuideButton {
	id: string;
	path: string;
}

/**
 * The guide's buttons, row by row: events, the server, its channels, leveling and
 * Dero's voice, then the arcade. Five a row is Discord's ceiling.
 */
export const ADMIN_GUIDE_COMMAND_ROWS: ReadonlyArray<readonly AdminGuideButton[]> = [
	[
		{ id: "events", path: "events" },
		{ id: "server", path: "server" },
		{ id: "server-channels", path: "server channels" },
		{ id: "leveling", path: "leveling" },
		{ id: "dero-config", path: "dero-config" },
	],
	[{ id: "arcade", path: "arcade" }],
];

/** The button that opens one admin job's flow. */
export function buildAdminCommandButton(button: AdminGuideButton): ButtonBuilder {
	return new ButtonBuilder()
		.setCustomId(`${ADMIN_COMMAND_BUTTON_PREFIX}:${button.id}`)
		.setLabel(`/${button.path}`)
		.setStyle(ButtonStyle.Secondary);
}

/** The guide's command rows, in ADMIN_GUIDE_COMMAND_ROWS order. */
export function buildAdminCommandRows(): ActionRowBuilder<ButtonBuilder>[] {
	return ADMIN_GUIDE_COMMAND_ROWS.map((buttons) => new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.map(buildAdminCommandButton)));
}
