import type { IPluginCopy, IRankName } from "@base/copy/types.js";
import { isBotSeatId } from "@utils/botSeatId.js";
import { gameResultCountStore } from "@db/stores/gameResultCountStore.js";
import { compareHands, evaluateHand, HAND_CATEGORIES, RANK_LABELS, type Card, type HandCategory, type HandValue } from "@features/games/holdemHand.js";
import { utcMonthKey } from "@utils/utcMonthKey.js";

// ── gameResultCounts ─────────────────────────────────────────────────
// Counts game results per guild per UTC month for the Phase 3b monthly post
// (2026-10 item 244). Hold'em is the first and only writer: at every contested
// showdown, the winning hand. Called fire and forget from roomHoldemHandlers'
// settle path, which only the action that won the table's compare and swap
// reaches, so a showdown counts once. Popularity comes from these game results,
// never from render cache keys (owner decision 2026-10-23).
//
// The stored label is a stable KEY, `<category>:<top rank label>` ("pair:A",
// "full house:K"), built from HAND_CATEGORIES and RANK_LABELS. The member facing
// words live in the copy pack and are applied on read by phraseHoldemHandLabel, so
// rewording a hand never splits one month's count across two spellings.

const HOLDEM_GAME = "holdem";
const LABEL_SEPARATOR = ":";
// The one category with a name of its own at one rank: the ace high straight flush.
const ROYAL_FLUSH_CATEGORY: HandCategory = "straight flush";
const ROYAL_FLUSH_RANK_LABEL = "A";

/** The table fields a showdown count reads: everyone's hole cards and the board. */
export interface ShowdownTable {
	holeCards: Record<string, Card[]>;
	board: Card[];
}

export interface ShowdownCount {
	guildId: string;
	table: ShowdownTable;
	/** The players whose hands were shown, from the settle outcome. */
	shownUserIds: readonly string[];
	now?: Date;
}

/** The stable count key for a hand: its category and its most significant rank. */
export function holdemHandLabel(hand: HandValue): string {
	const topRank = hand.ranks[0];
	return `${hand.category}${LABEL_SEPARATOR}${RANK_LABELS[topRank] ?? topRank}`;
}

/** The category and rank label a count key was built from, or null for a key this module did not build. */
export function parseHoldemHandLabel(label: string): { category: HandCategory; rankLabel: string } | null {
	const at = label.lastIndexOf(LABEL_SEPARATOR);
	if (at < 0) return null;
	const category = HAND_CATEGORIES.find((candidate) => candidate === label.slice(0, at));
	const rankLabel = label.slice(at + 1);
	return category && rankLabel ? { category, rankLabel } : null;
}

/**
 * A count key in members' words ("pair of aces", "aces full", "royal flush") from
 * the given pack's `holdemHands`. Null for a key that does not parse or names a rank
 * the pack has no word for, so a caller can skip it rather than print a raw key.
 */
export function phraseHoldemHandLabel(label: string, words: IPluginCopy["holdemHands"]): string | null {
	const parsed = parseHoldemHandLabel(label);
	if (!parsed) return null;
	if (parsed.category === ROYAL_FLUSH_CATEGORY && parsed.rankLabel === ROYAL_FLUSH_RANK_LABEL) return words.royalFlush;

	// Typed against the full category list, so a pack missing a category is a compile error.
	const phrases: Record<HandCategory, (rank: IRankName) => string> = words.byCategory;
	const rankNames: Record<string, IRankName | undefined> = words.rankNames;
	const rank = rankNames[parsed.rankLabel];
	return rank ? phrases[parsed.category](rank) : null;
}

/**
 * The best hand among the shown players, or null when nobody's cards can be read.
 * At a showdown the board holds five cards and each player two, which is what
 * evaluateHand needs; a seat missing its hole cards is skipped rather than guessed.
 */
export function winningShowdownHand(table: ShowdownTable, shownUserIds: readonly string[]): HandValue | null {
	let best: HandValue | null = null;
	for (const userId of shownUserIds) {
		const holeCards = table.holeCards[userId];
		if (!holeCards?.length) continue;
		const hand = evaluateHand([...holeCards, ...table.board]);
		if (!best || compareHands(hand, best) > 0) best = hand;
	}
	return best;
}

/** Count the winning hand of one Hold'em showdown. Resolves when written or failed; never rejects, so callers use `void`. */
export async function recordShowdownHand(showdown: ShowdownCount): Promise<void> {
	try {
		// A showdown a Dero bot was in (2026-10 item 250 Phase 5) is practice, not one of
		// the server's hands, so the monthly post's top hands never count it.
		if (showdown.shownUserIds.some(isBotSeatId)) return;
		const winning = winningShowdownHand(showdown.table, showdown.shownUserIds);
		if (!winning) return;
		await gameResultCountStore.increment({
			guildId: showdown.guildId,
			game: HOLDEM_GAME,
			month: utcMonthKey(showdown.now ?? new Date()),
			label: holdemHandLabel(winning),
		});
	}
	catch (error) {
		console.error(`[ratings] counting a Hold'em showdown hand in guild ${showdown.guildId} failed`, error);
	}
}
