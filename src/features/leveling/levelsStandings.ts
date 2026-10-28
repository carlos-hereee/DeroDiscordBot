import { type RepliableInteraction } from "discord.js";
import { errorEmbed } from "@utils/embedBuilder.js";
import { memberLevelStore } from "@db/stores/memberLevelStore.js";
import { xpPeriodStore } from "@db/stores/xpPeriodStore.js";
import { levelFromTotalXp } from "@features/leveling/levelCurve.js";
import { periodKeysFor } from "@features/leveling/levelPeriod.js";
import { getLevelingConfig } from "@features/leveling/levelingConfig.js";
import { levelingCopy } from "@features/leveling/levelingCopy.js";
import { buildLevelsBoardCardEmbed, buildLevelsBoardEmbed, type LevelsBoardEntry } from "@features/leveling/levelingEmbeds.js";
import { LEVELS_BOARD_AVATAR_SIZE, renderLevelsBoardCard } from "@features/leveling/levelsBoardRenderer.js";
import { avatarRequestFor, isRenderPayload, withRenderFallback } from "@features/renderer/index.js";
import { beginProfileAnswer } from "@features/leveling/accountProfile.js";
import { showNotice } from "@utils/textModal.js";
import { getPluginCopy } from "@base/copy/getCopy.js";

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
//        into them would mean two places to fix a nickname change. The answer
//        is the pinned board's own card (levelsBoardRenderer, 2026-10 item 254),
//        with the text board as the fallback when the canvas cannot draw.

/** The stretch of time the standings rank, the /account window option's values. */
export type LevelsWindow = "week" | "month" | "alltime";

/** Which window to rank. */
export interface LevelsStandingsRequest {
	window: LevelsWindow;
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
export async function showLevelsStandings(interaction: RepliableInteraction, { window }: LevelsStandingsRequest): Promise<void> {
	const guildId = interaction.guildId;
	if (!guildId) {
		await showNotice(interaction, { title: getPluginCopy(null).notice.leveling, sections: [levelingCopy.errors.outsideGuild] });
		return;
	}

	const answer = await beginProfileAnswer(interaction);

	const context = await getLevelingConfig(guildId);
	if (!context) {
		await answer.send({ embeds: [errorEmbed(levelingCopy.errors.noData)] });
		return;
	}

	const { entries, label } = await resolveWindow(guildId, window, context);
	const withFaces = entries.map((entry) => ({ ...entry, avatar: cachedAvatar(interaction, entry.userId) }));

	// The card when it renders, the text board when it does not. Either way one reply.
	const board = await withRenderFallback(
		() => renderLevelsBoardCard(label, withFaces),
		() => buildLevelsBoardEmbed(label, entries)
	);
	if (isRenderPayload(board)) {
		await answer.send({ embeds: [buildLevelsBoardCardEmbed(label, board.ref)], files: [board.attachment] });
		return;
	}
	await answer.send({ embeds: [board] });
}

// The faces of members already in the guild's cache. Unlike the pinned board's
// sweep, a view answering a press does not fetch missing members: a member it
// cannot see draws the placeholder rather than slowing the reply.
function cachedAvatar(interaction: RepliableInteraction, userId: string): LevelsBoardEntry["avatar"] {
	const member = interaction.guild?.members.cache.get(userId);
	return member ? avatarRequestFor(member.user, LEVELS_BOARD_AVATAR_SIZE) : null;
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
				// A member whose lifetime row was reset by /leveling xp but whose period row
				// survives falls back to their id rather than rendering "undefined".
				username: member?.username ?? row.userId,
				level: levelOf(member?.totalXp ?? 0),
				xp: row.xp,
			};
		}),
	};
}
