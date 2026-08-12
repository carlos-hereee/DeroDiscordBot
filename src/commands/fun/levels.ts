import { SlashCommandBuilder, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { errorEmbed } from "@utils/embedBuilder.js";
import { memberLevelStore } from "@db/stores/memberLevelStore.js";
import { xpPeriodStore } from "@db/stores/xpPeriodStore.js";
import { levelFromTotalXp } from "@features/leveling/levelCurve.js";
import { periodKeysFor } from "@features/leveling/levelPeriod.js";
import { getLevelingConfig } from "@features/leveling/levelingConfig.js";
import { levelingCopy } from "@features/leveling/levelingCopy.js";
import { buildLevelsBoardEmbed, type LevelsBoardEntry } from "@features/leveling/levelingEmbeds.js";

// ── /levels ────────────────────────────────────────────────────────────────
// What:  the guild's xp standings for this week, this month, or all time.
// Who:   every member. PUBLIC, like /account and /leaderboard.
// When:  on demand. The pinned LevelsBoard covers all time passively; this
//        command is the only way to see the two period windows.
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

type Window = "week" | "month" | "alltime";

export const data = new SlashCommandBuilder()
	.setName("levels")
	.setDescription("See who is most present in this server")
	.addStringOption((option) =>
		option
			.setName("window")
			.setDescription("Which stretch of time to rank")
			.setRequired(false)
			// Choices rather than free text, so Discord rejects anything else before
			// the interaction reaches the bot and the handler never hand validates it.
			.addChoices(
				{ name: levelingCopy.board.allTime, value: "alltime" },
				{ name: levelingCopy.board.thisWeek, value: "week" },
				{ name: levelingCopy.board.thisMonth, value: "month" }
			)
	);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
	const guildId = interaction.guildId;
	if (!guildId) {
		await interaction.reply({
			embeds: [errorEmbed(levelingCopy.errors.outsideGuild)],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	await interaction.deferReply();

	const context = await getLevelingConfig(guildId);
	if (!context) {
		await interaction.editReply({ embeds: [errorEmbed(levelingCopy.errors.noData)] });
		return;
	}

	const window = (interaction.options.getString("window") ?? "alltime") as Window;
	const { entries, label } = await resolveWindow(guildId, window, context);

	await interaction.editReply({ embeds: [buildLevelsBoardEmbed(label, entries)] });
}

async function resolveWindow(
	guildId: string,
	window: Window,
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
