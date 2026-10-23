import { SlashCommandBuilder, type ChatInputCommandInteraction, type RepliableInteraction } from "discord.js";
import { addAutoHealOptions, configureAutoHeal } from "@features/setup/configureAutoHeal.js";
import { addLeaderboardTrackingOptions, configureLeaderboardTracking } from "@features/leaderboard/configureLeaderboardTracking.js";
import { addWeekStartOptions, configureLeaderboardWeekStart } from "@features/leaderboard/configureLeaderboardWeekStart.js";
import type { CommandOptionReader } from "@handlers/commandOptions.js";

// ── /configure ────────────────────────────────────────────────────────
// What:  the server switches an admin flips rarely: `auto-heal` (whether
//        deleted homebase channels are rebuilt), `leaderboard-tracking`
//        (whether participation is recorded) and `week-start` (which day the
//        leaderboard's week begins).
// Who:   admins (BOT_CONSTANTS.ADMIN_COMMANDS), from the slash command or the
//        /configure button on the admin guide, which runs this same `run`.
// Where: each handler lives with the feature it switches (setup and
//        leaderboard); 2026-10 item 245 Phase 4b merged configure-auto-heal,
//        configure-leaderboard-tracking and configure-leaderboard-week-start
//        into this one command.

export const data = new SlashCommandBuilder()
	.setName("configure")
	.setDescription("Server switches: channel auto-heal, leaderboard tracking and the leaderboard week")
	.addSubcommand((sub) =>
		addAutoHealOptions(sub.setName("auto-heal").setDescription("Toggle whether the bot rebuilds missing homebase channels automatically"))
	)
	.addSubcommand((sub) =>
		addLeaderboardTrackingOptions(
			sub.setName("leaderboard-tracking").setDescription("Toggle whether the bot records participation (reactions + voice joins)")
		)
	)
	.addSubcommand((sub) =>
		addWeekStartOptions(sub.setName("week-start").setDescription("Set which day the leaderboard's \"this week\" window starts on"))
	);

/** The one handler the slash command and the admin guide's /configure button share. */
export async function run(interaction: RepliableInteraction, options: CommandOptionReader): Promise<void> {
	switch (options.getSubcommand(true)) {
		case "auto-heal":
			await configureAutoHeal(interaction, options);
			return;
		case "leaderboard-tracking":
			await configureLeaderboardTracking(interaction, options);
			return;
		default:
			await configureLeaderboardWeekStart(interaction, options);
	}
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
	await run(interaction, interaction.options);
}
