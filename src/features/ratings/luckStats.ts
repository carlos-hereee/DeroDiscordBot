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
//
// Magic 8 ball readings join the score (2026-10 item 250 Phase 5, the owner's choice of
// "above expected"): each reading adds its luck minus the average reading's, recorded by
// recordFortuneReading on the month's "fortune" row. Readings never count toward the 20
// decided games, so the 8 ball alone can never put a player on the board.

const LIMITS = BOT_CONSTANTS.RATINGS;

// A fair two player game is won half the time, so expected wins are half of decided.
const EXPECTED_WIN_SHARE = 0.5;

/** One player's luck numbers for a month. The two 8 ball fields are present only for a player who read it. */
export interface LuckTally {
	decided: number;
	wins: number;
	readings?: number;
	// The sum of each reading's luck above the average reading.
	fortunePoints?: number;
}

/** The game key a month's magic 8 ball row is stored under. Not a luck game: it decides nothing. */
export const FORTUNE_LUCK_GAME = "fortune";

export interface LuckResult {
	guildId: string;
	game: string;
	playerIds: readonly string[];
	/** Null for a tie, which records nothing. */
	winnerId: string | null;
	now?: Date;
}

/**
 * Wins above expected, `wins - decided / 2`, plus the 8 ball readings' luck above the
 * average reading: positive for a player luckier than a fair coin and an average 8
 * ball, negative for one less lucky. Null below 20 decided games, where the number
 * says more about the sample than about the player; readings never count toward them.
 */
export function luckScore(tally: LuckTally): number | null {
	if (tally.decided < LIMITS.LUCK_MIN_DECIDED) return null;
	return tally.wins - tally.decided * EXPECTED_WIN_SHARE + (tally.fortunePoints ?? 0);
}

/** What one result adds to each player's month row. Empty for a tie. */
export function luckIncrementsFor(playerIds: readonly string[], winnerId: string | null): { userId: string; increments: ILuckIncrements }[] {
	if (winnerId === null) return [];
	return [...new Set(playerIds)].map((userId) => ({ userId, increments: { decided: 1, wins: userId === winnerId ? 1 : 0 } }));
}

export interface FortuneReading {
	guildId: string;
	userId: string;
	/** The reading's luck minus the average reading's (fortune/rollFortune.EXPECTED_FORTUNE_LUCK). */
	luckAboveAverage: number;
	now?: Date;
}

/** Record one magic 8 ball reading on the month's fortune row. Resolves when written or failed; never rejects, so callers use `void`. */
export async function recordFortuneReading(reading: FortuneReading): Promise<void> {
	try {
		const month = utcMonthKey(reading.now ?? new Date());
		await luckStatStore.addReading({ guildId: reading.guildId, userId: reading.userId, game: FORTUNE_LUCK_GAME, month }, reading.luckAboveAverage);
	}
	catch (error) {
		console.error(`[ratings] recording a magic 8 ball reading for ${reading.userId} in guild ${reading.guildId} failed`, error);
	}
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
