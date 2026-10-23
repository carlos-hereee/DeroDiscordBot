import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { luckStatStore, type ILuckIncrements } from "@db/stores/luckStatStore.js";
import { utcMonthKey } from "@utils/utcMonthKey.js";
import { isLuckGame } from "./ratingEngine.js";

// ── luckStats ────────────────────────────────────────────────────────
// Records coin flip, dice roll and rock paper scissors results for the luck board
// (2026-10 item 244): per guild, per player, per game, per UTC month, how many
// decided games and how many wins. Called fire and forget by roomGames.ts, only by
// the press that won roomLifecycle.finish's claim, so one match counts once. It
// never rates anything: these games are pure chance.
//
// A tie is not a decided game and records nothing, because counting it would drag
// every tied player's score toward zero for an outcome nobody won. The score the
// board ranks by is wins above expected, `wins - decided / 2`, shown only from 20
// decided games.

const LIMITS = BOT_CONSTANTS.RATINGS;

// A fair two player game is won half the time, so expected wins are half of decided.
const EXPECTED_WIN_SHARE = 0.5;

/** One player's luck numbers for a month. */
export interface LuckTally {
	decided: number;
	wins: number;
}

export interface LuckResult {
	guildId: string;
	game: string;
	playerIds: readonly string[];
	/** Null for a tie, which records nothing. */
	winnerId: string | null;
	now?: Date;
}

/**
 * Wins above expected, `wins - decided / 2`: positive for a player luckier than a
 * fair coin, negative for one less lucky. Null below 20 decided games, where the
 * number says more about the sample than about the player.
 */
export function luckScore(tally: LuckTally): number | null {
	if (tally.decided < LIMITS.LUCK_MIN_DECIDED) return null;
	return tally.wins - tally.decided * EXPECTED_WIN_SHARE;
}

/** What one result adds to each player's month row. Empty for a tie. */
export function luckIncrementsFor(playerIds: readonly string[], winnerId: string | null): { userId: string; increments: ILuckIncrements }[] {
	if (winnerId === null) return [];
	return [...new Set(playerIds)].map((userId) => ({ userId, increments: { decided: 1, wins: userId === winnerId ? 1 : 0 } }));
}

/** Record one luck game result. Resolves when written or failed; never rejects, so callers use `void`. */
export async function recordLuckResult(result: LuckResult): Promise<void> {
	if (!isLuckGame(result.game)) return;

	try {
		const month = utcMonthKey(result.now ?? new Date());
		await Promise.all(
			luckIncrementsFor(result.playerIds, result.winnerId).map(({ userId, increments }) =>
				luckStatStore.increment({ guildId: result.guildId, userId, game: result.game, month }, increments)
			)
		);
	}
	catch (error) {
		console.error(`[ratings] recording a ${result.game} luck result in guild ${result.guildId} failed`, error);
	}
}
