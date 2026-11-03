import { escapeMarkdown, TextChannel, type Client, type EmbedBuilder, type Guild } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { arcadeMonthlyPostEvent } from "@base/constants/BOT_LOG_EVENTS.js";
import { COLORS } from "@base/copy/brand.js";
import { getPluginCopy, type ICopyConfig, type IPluginCopy } from "@base/copy/index.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { gameRoomsCopy } from "@features/game-rooms/gameRoomsCopy.js";
import { isRenderPayload, withRenderFallback } from "@features/renderer/index.js";
import { infoEmbed } from "@utils/embedBuilder.js";
import { currentUtcMonth, previousUtcMonth, type UtcMonth } from "@utils/utcMonthKey.js";
import { renderArcadeMonthlyCard, type ArcadeMonthlySection, type ArcadeMonthlyView } from "./arcadeMonthlyRenderer.js";
import { memberNameResolver } from "./memberNames.js";
import { formatLuckScore, formatRating, luckBoardInGuild, topRatedInGuild, topWinningHands, type NameResolver, type RatedPlayer } from "./ratingBoards.js";
import { RATED_GAMES, type RatedGame } from "./ratingEngine.js";

// ── monthlyArcadePost ────────────────────────────────────────────────
// Each server's arcade month (2026-10 item 244 Phase 3b): on the 1st, last month's
// top three winning Hold'em hands, the top rated player of each rated game among
// that server's players, and its luckiest player, posted in its leaderboard
// channel as a rendered card with a text embed fallback.
//
// Who:   ReminderScheduler.startScheduler fires runMonthlyArcadePost on
//        BOT_CONSTANTS.RATINGS.MONTHLY_POST_CRON in America/Chicago. main.ts runs
//        one PREVIEW pass at boot when ARCADE_MONTHLY_POST_RUN_ON_BOOT is 1, the
//        owner's hand trigger for a test guild (see MonthlyPostOptions).
// When:  a guild is skipped when /arcade monthly-post is off, when it
//        has no config or its homebase is gone, when its leaderboard channel cannot
//        be reached, and when the month left nothing to show (no showdown, no rated
//        match, nobody past the luck minimum), since an empty card every month is noise.
// Where: "last month" is the UTC month before the run, the month every ratings
//        collection keys on. The 1st at 9:05 am Central is already the 1st in UTC,
//        so it is always the calendar month that just ended.
// How:   ① read the guild's config and switch; ② skip a month already claimed in
//        BotLog; ③ build the view through ratingBoards, the same reads /rating
//        makes; ④ resolve the channel; ⑤ CLAIM, then ⑥ render and send.
//
// ⚠️ NOTHING NETWORK WIDE: every player on the post played in this server, and
// the post goes to this server only (risk R9). It never throws: every failure is
// logged per guild and the run moves on, since nothing waits on the post.

const LIMITS = BOT_CONSTANTS.RATINGS;
// Month names in English, the bot's one language, from the month's own UTC start.
const MONTH_LABEL = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

export type MonthlyPostStatus = "posted" | "off" | "no-config" | "no-channel" | "nothing-to-show" | "already-posted" | "failed";

/** How one guild's pass went, for the run's log line and the tests. */
export interface MonthlyPostOutcome {
	guildId: string;
	status: MonthlyPostStatus;
	/** True when the card rendered, false when the text embed posted. Set only when posted. */
	usedCard?: boolean;
}

export interface MonthlyViewQuery {
	guildId: string;
	guildName: string;
	month: UtcMonth;
	copy: IPluginCopy;
	resolveNames: NameResolver;
	/** True for a month still under way, which the title says, so a preview never reads as the month's final word. */
	soFar?: boolean;
}

export interface MonthlyPostOptions {
	/**
	 * The owner's hand trigger (ARCADE_MONTHLY_POST_RUN_ON_BOOT): post the CURRENT
	 * UTC month so far, titled as such, and neither read nor write the month's
	 * BotLog claim, so a test guild can see the post today and the real post on the
	 * 1st still goes out. Every other skip (the admin's off switch, no channel,
	 * nothing to show) still applies.
	 */
	preview?: boolean;
}

/** One pass over every guild the bot is in, posting the month before `now` (or, as a preview, the month `now` falls in). Never throws. */
export async function runMonthlyArcadePost(client: Client, now: Date = new Date(), options: MonthlyPostOptions = {}): Promise<MonthlyPostOutcome[]> {
	const preview = options.preview ?? false;
	const month = preview ? currentUtcMonth(now) : previousUtcMonth(now);
	const outcomes: MonthlyPostOutcome[] = [];
	for (const guild of client.guilds.cache.values()) {
		const outcome = await postGuildMonth(client, guild, month, preview);
		outcomes.push(outcome);
		if (outcome.status === "posted") {
			console.log(`[arcade-monthly] guild=${guild.id} month=${month.key} card=${outcome.usedCard} preview=${preview}`);
		}
	}
	return outcomes;
}

async function postGuildMonth(client: Client, guild: Guild, month: UtcMonth, preview: boolean): Promise<MonthlyPostOutcome> {
	const outcome = (status: MonthlyPostStatus, usedCard?: boolean): MonthlyPostOutcome => ({ guildId: guild.id, status, usedCard });
	try {
		// ①
		const config = await guildConfigStore.findByGuildId(guild.id);
		if (!config || config.homebaseDestroyed) return outcome("no-config");
		if (config.arcadeMonthlyPost === false) return outcome("off");
		if (!config.leaderboardChannelId) return outcome("no-channel");

		// ② A preview never looks at the claim: it is not the month's post.
		const event = arcadeMonthlyPostEvent(month.key);
		if (!preview && (await botLogStore.has(guild.id, event))) return outcome("already-posted");

		// ③
		const view = await buildArcadeMonthlyView({
			guildId: guild.id,
			guildName: guild.name,
			month,
			copy: getPluginCopy(config),
			resolveNames: memberNameResolver(guild),
			soFar: preview,
		});
		if (!view) return outcome("nothing-to-show");

		// ④
		const channel = await client.channels.fetch(config.leaderboardChannelId).catch(() => null);
		if (!(channel instanceof TextChannel)) {
			console.warn(`[arcade-monthly] guild ${guild.id} has no reachable leaderboard channel ${config.leaderboardChannelId}, so ${month.key} was not posted`);
			return outcome("no-channel");
		}

		// ⑤ Claimed BEFORE the send, the weekly digest's rule: a crash after this costs
		// the server its post, and nothing can ever post the same month twice. A
		// preview claims nothing, or the real post on the 1st would find its month
		// taken and stay silent.
		if (!preview) await botLogStore.log(guild.id, event, { month: month.key });

		// ⑥
		const card = await withRenderFallback(
			() => renderArcadeMonthlyCard(view),
			() => buildArcadeMonthlyEmbed(view, config)
		);
		if (isRenderPayload(card)) {
			await channel.send({ embeds: [buildArcadeMonthlyCardEmbed(view, card.ref, config)], files: [card.attachment] });
			return outcome("posted", true);
		}
		await channel.send({ embeds: [card] });
		return outcome("posted", false);
	}
	catch (error) {
		console.error(`[arcade-monthly] posting ${month.key} in guild ${guild.id} failed`, error);
		return outcome("failed");
	}
}

/**
 * The post for one guild's month, in its pack's words, or null when the month left
 * nothing to show. Reads through ratingBoards, so every number matches /rating.
 */
export async function buildArcadeMonthlyView(query: MonthlyViewQuery): Promise<ArcadeMonthlyView | null> {
	const words = query.copy.arcadeRatings;
	const post = words.monthlyPost;
	const [hands, topRated, luckBoard] = await Promise.all([
		topWinningHands({ guildId: query.guildId, month: query.month.key, limit: LIMITS.MONTHLY_TOP_HANDS, words: query.copy.holdemHands }),
		topRatedPerGame(query),
		luckBoardInGuild({ guildId: query.guildId, month: query.month.key, limit: 1, resolveNames: query.resolveNames }),
	]);
	const luckiest = luckBoard[0];
	if (hands.length === 0 && topRated.length === 0 && !luckiest) return null;

	const sections: ArcadeMonthlySection[] = [
		{
			heading: post.handsHeading,
			rows: hands.map((hand) => ({ lead: hand.phrase, detail: post.handsDetail(hand.count) })),
			emptyLine: post.handsEmpty,
		},
		{
			heading: post.ratedHeading,
			rows: topRated.map(({ game, player }) => ({
				lead: player.displayName,
				detail: post.ratedDetail(gameRoomsCopy.gameLabel(game), formatRating(player, words.provisionalMark)),
			})),
			emptyLine: post.ratedEmpty,
		},
		{
			heading: post.luckHeading,
			rows: luckiest ? [{ lead: luckiest.displayName, detail: post.luckDetail(formatLuckScore(luckiest.score), luckiest.wins, luckiest.decided) }] : [],
			emptyLine: post.luckEmpty(LIMITS.LUCK_MIN_DECIDED),
		},
	];

	const monthLabel = MONTH_LABEL.format(query.month.start);
	return {
		title: query.soFar ? post.titleSoFar(monthLabel) : post.title(monthLabel),
		guildName: query.guildName,
		sections,
		note: topRated.some(({ player }) => player.provisional) ? words.provisionalNote : "",
		footer: post.footer,
	};
}

// The top player of each rated game among those who finished a match of it in this
// server during the month, ranked by their rating now. Ratings keep no history, and
// at 9:05 on the 1st "now" is the month's end in all but minutes.
async function topRatedPerGame(query: MonthlyViewQuery): Promise<Array<{ game: RatedGame; player: RatedPlayer }>> {
	const perGame = await Promise.all(
		RATED_GAMES.map(async (game) => {
			const [player] = await topRatedInGuild({
				guildId: query.guildId,
				game,
				limit: 1,
				resolveNames: query.resolveNames,
				finishedBetween: { start: query.month.start, end: query.month.end },
			});
			return player ? { game, player } : null;
		})
	);
	return perGame.filter((entry): entry is { game: RatedGame; player: RatedPlayer } => entry !== null);
}

// ── the embeds ──
// One spine (title, color, the /rating invitation) for the card post and the text
// post, so the two can never answer differently; the levels board's pattern.

function monthlySpine(view: ArcadeMonthlyView, guildConfig?: ICopyConfig | null): EmbedBuilder {
	return infoEmbed(view.title, view.footer, COLORS.ARCADE, guildConfig);
}

/** The post when its card rendered: the spine, with everything else drawn on the card. */
export function buildArcadeMonthlyCardEmbed(view: ArcadeMonthlyView, imageRef: string, guildConfig?: ICopyConfig | null): EmbedBuilder {
	return monthlySpine(view, guildConfig).setImage(imageRef);
}

/** The post as text, when the card does not draw: one field per section, and the provisional note when a rating carries the mark. */
export function buildArcadeMonthlyEmbed(view: ArcadeMonthlyView, guildConfig?: ICopyConfig | null): EmbedBuilder {
	const description = view.note ? `${view.footer}\n\n*${view.note}*` : view.footer;
	return monthlySpine(view, guildConfig)
		.setDescription(description)
		.addFields(
			view.sections.map((section) => ({
				name: section.heading,
				value: section.rows.length > 0 ? section.rows.map((row) => `**${escapeMarkdown(row.lead)}**, ${row.detail}`).join("\n") : section.emptyLine,
			}))
		);
}
