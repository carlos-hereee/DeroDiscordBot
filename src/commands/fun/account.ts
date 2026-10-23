import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { levelingCopy } from "@features/leveling/levelingCopy.js";
import { showAccountProfile } from "@features/leveling/accountProfile.js";
import { LEVELS_WINDOW_CHOICES, showLevelsStandings, toLevelsWindow } from "@features/leveling/levelsStandings.js";
import { showAchievements } from "@features/leveling/achievementsView.js";

// ── /account ───────────────────────────────────────────────────────────────
// What:  a member's leveling surfaces behind one command: `view` picks the
//        profile (the default), the server's levels standings, or a member's
//        achievements. `member` names whose profile or achievements to show and
//        `window` names which stretch the levels view ranks.
// Who:   every member. PUBLIC replies, exactly as /levels and /achievements gave
//        before 2026-10 item 245 Phase 4b folded them in here.
// Where: the three views live in features/leveling, shared with the Account,
//        Levels and Achievements buttons on the #command-center guide, which
//        answer privately instead (PowerUps).
//
// ⚠️ PUBLIC, so it is deliberately in NEITHER admin mechanism. It is not in
// BOT_CONSTANTS.ADMIN_COMMANDS and it carries no setDefaultMemberPermissions,
// exactly like /leaderboard and /events list. Members seeing their own standing
// is the entire point of the feature.

const VIEW_CHOICES = [
	{ name: levelingCopy.accountViews.profile, value: "profile" },
	{ name: levelingCopy.accountViews.levels, value: "levels" },
	{ name: levelingCopy.accountViews.achievements, value: "achievements" },
] as const;

export const data = new SlashCommandBuilder()
	.setName("account")
	.setDescription("See your level, rank, game record and achievements, or the server's standings")
	.addStringOption((option) =>
		option
			.setName("view")
			.setDescription("What to show. Defaults to the profile.")
			.setRequired(false)
			.addChoices(...VIEW_CHOICES)
	)
	.addUserOption((option) =>
		option.setName("member").setDescription("Whose profile or achievements to show. Defaults to you.").setRequired(false)
	)
	.addStringOption((option) =>
		option
			.setName("window")
			.setDescription("Which stretch of time the levels view ranks")
			.setRequired(false)
			.addChoices(...LEVELS_WINDOW_CHOICES)
	);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
	const view = interaction.options.getString("view");
	if (view === "levels") {
		await showLevelsStandings(interaction, { window: toLevelsWindow(interaction.options.getString("window")), isPrivate: false });
		return;
	}
	const target = interaction.options.getUser("member") ?? interaction.user;
	if (view === "achievements") {
		await showAchievements(interaction, { target, isPrivate: false });
		return;
	}
	await showAccountProfile(interaction, { target, isPrivate: false });
}
