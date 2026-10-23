import { MessageFlags, type RepliableInteraction } from "discord.js";
import { errorEmbed } from "@utils/embedBuilder.js";
import { memberLevelStore } from "@db/stores/memberLevelStore.js";
import { xpPeriodStore } from "@db/stores/xpPeriodStore.js";
import { levelFromTotalXp } from "@features/leveling/levelCurve.js";
import { periodKeysFor } from "@features/leveling/levelPeriod.js";
import { getLevelingConfig } from "@features/leveling/levelingConfig.js";
import { levelingCopy } from "@features/leveling/levelingCopy.js";
import { buildLevelsBoardEmbed, type LevelsBoardEntry } from "@features/leveling/levelingEmbeds.js";
import { deferProfileReply } from "@features/leveling/accountProfile.js";

// ── /account view:levels ───────────────────────────────────────────────────
// What:  the guild's xp standings for this week, this month, or all time.
// Who:   every member. /account view:levels is PUBLIC, like the profile and
//        /leaderboard; the #command-center guide's Levels button answers
//        privately. Both call showLevelsStandings (2026-10 item 245 Phase 4b
//        folded the old /levels command into /account).
// When:  on demand. The pinned LevelsBoard covers all time passively; this
//        view is the only way to see the two period windows.
// Where: ⚠️ THIS IS NOT /leaderboard. That command ranks participation SCORE
//        for ROK events, aggregated from PlayerActivity and keyed by event and
//        occurrence. This one ranks XP. Both are legitimate standings and both
//        live in the same guild, which is why every embed either one renders
//        carries a subtitle naming the question it answers.
// How:   all time reads MemberLevel directly. The two period windows read
//        XpPeriod for the top ten, then resolve those ten to display names in
//        ONE follow-up query, because XpPeriod deliberately stores no username:
//        the period rows are disposable aggregates and denormalizing a name
//        into them would mean two places to fix a nickname change.

/** The stretch of time the standings rank, the /account window option's values. */
export type LevelsWindow = "week" | "month" | "alltime";

/** Which window to rank, and whether only the asker sees it. */
export interface LevelsStandingsRequest {
	window: LevelsWindow;
	isPrivate: boolean;
}

/** The window choices, in the order the slash command offers them. */
export const LEVELS_WINDOW_CHOICES: ReadonlyArray<{ name: string; value: LevelsWindow }> = [
	{ name: levelingCopy.board.allTime, value: "alltime" },
	{ name: levelingCopy.board.thisWeek, value: "week" },
	{ name: levelingCopy.board.thisMonth, value: "month" },
];

/** A stored or typed window, narrowed; anything else reads as all time, the old default. */
export function toLevelsWindow(value: string | null): LevelsWindow {
	return value === "week" || value === "month" ? value : "alltime";
}

/** Reply with the standings for one window. */
export async function showLevelsStandings(interaction: RepliableInteraction, { window, isPrivate }: LevelsStandingsRequest): Promise<void> {
	const guildId = interaction.guildId;
	if (!guildId) {
		await interaction.reply({
			embeds: [errorEmbed(levelingCopy.errors.outsideGuild)],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	await deferProfileReply(interaction, isPrivate);

	const context = await getLevelingConfig(guildId);
	if (!context) {
		await interaction.editReply({ embeds: [errorEmbed(levelingCopy.errors.noData)] });
		return;
	}

	const { entries, label } = await resolveWindow(guildId, window, context);

	await interaction.editReply({ embeds: [buildLevelsBoardEmbed(label, entries)] });
}

async function resolveWindow(
	guildId: string,
	window: LevelsWindow,
	context: NonNullable<Awaited<ReturnType<typeof getLevelingConfig>>>
): Promise<{ entries: LevelsBoardEntry[]; label: string }> {
	const settings = context.settings;
	const levelOf = (totalXp: number): number =>
		levelFromTotalXp(totalXp, settings.curve, settings.curveMultiplier, settings.maxLevel);

	if (window === "alltime") {
		const rows = await memberLevelStore.topByTotalXp(guildId, 10);
		return {
			label: levelingCopy.board.allTime,
			entries: rows.map((row) => ({
				userId: row.userId,
				username: row.username,
				level: levelOf(row.totalXp),
				xp: row.totalXp,
			})),
		};
	}

	const keys = periodKeysFor(new Date(), context.weekStart);
	const period = window === "week" ? keys.week : keys.month;
	const label = window === "week" ? levelingCopy.board.thisWeek : levelingCopy.board.thisMonth;

	const rows = await xpPeriodStore.topInPeriod(guildId, period, 10);
	if (rows.length === 0) return { entries: [], label };

	// ONE query for all ten names and lifetime levels rather than ten. The period
	// row holds the xp earned INSIDE the window, which is the number being ranked;
	// the level shown beside it is the member's lifetime level, because a "level"
	// that only counted this week would be a different and meaningless number.
	const members = await memberLevelStore.findManyInGuild(
		guildId,
		rows.map((row) => row.userId)
	);
	const byUserId = new Map(members.map((member) => [member.userId, member]));

	return {
		label,
		entries: rows.map((row) => {
			const member = byUserId.get(row.userId);
			return {
				userId: row.userId,
				// A member whose lifetime row was reset by /xp but whose period row
				// survives falls back to their id rather than rendering "undefined".
				username: member?.username ?? row.userId,
				level: levelOf(member?.totalXp ?? 0),
				xp: row.xp,
			};
		}),
	};
}
