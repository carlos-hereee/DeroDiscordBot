import { deroCoinStore } from "@db/stores/deroCoinStore.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { memberLevelStore } from "@db/stores/memberLevelStore.js";
import { xpPeriodStore } from "@db/stores/xpPeriodStore.js";
import { currentUtcMonth } from "@utils/utcMonthKey.js";

// ── verseProgress ────────────────────────────────────────────────────
// What:  the four counts of the Verse, the platform owner's read of how far Dero has
//        spread (2026-10 item 257 Phase 3b, owner decision 3): players, monthly active
//        players, servers, games completed and Dero coins collected.
// Who:   features/platform/verseSubcommand.ts, which answers /platform verse to the
//        platform owner ONLY.
// Does NOT: post anywhere or reach a member surface. The Verse has no public metric
//        (decision 2), so no caller may put these numbers in a channel, an announcement
//        or a card. It reads only; it never writes.
// How:   every figure is a count or a sum computed by the database (the stores hold the
//        aggregations and their indexes), so no row and no id list is ever loaded here.

/** The window "monthly active" looks back over. */
export const ACTIVE_WINDOW_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** One game's completed matches across every server. */
export interface GameCompletedCount {
	game: string;
	count: number;
}

/** The Verse, in counts. */
export interface VerseProgress {
	/** Distinct members with a level row in any server. */
	players: number;
	/** Distinct members who earned xp or Dero coins in the last ACTIVE_WINDOW_DAYS days. */
	monthlyActivePlayers: number;
	servers: {
		/** Servers that finished setup. */
		setUp: number;
		/** Of those, servers whose challenge reach is the network. */
		onNetwork: number;
	};
	gamesCompleted: {
		total: number;
		/** Biggest first, ties by game name so the order never shuffles between reads. */
		byGame: GameCompletedCount[];
	};
	coins: {
		/** Every Dero coin ever paid. */
		total: number;
		/** Paid inside the current UTC month. */
		thisMonth: number;
	};
}

/** Read the Verse as of `now`. Rejects when any read fails, so the caller answers an error rather than a partial count. */
export async function buildVerseProgress(now: Date = new Date()): Promise<VerseProgress> {
	const activeSince = new Date(now.getTime() - ACTIVE_WINDOW_DAYS * MS_PER_DAY);
	const monthStart = currentUtcMonth(now).start;

	const [players, monthlyActivePlayers, setUp, onNetwork, completed, coinsTotal, coinsThisMonth] = await Promise.all([
		memberLevelStore.countDistinctMembers(),
		xpPeriodStore.countMembersActiveSince(activeSince, deroCoinStore.coinAwardCollectionName()),
		guildConfigStore.countSetUp(),
		guildConfigStore.countSetUpOnNetwork(),
		gameRoomStore.countCompletedByGame(),
		deroCoinStore.sumAllAwards(),
		deroCoinStore.sumAllAwards(monthStart),
	]);

	const byGame = [...completed].sort((a, b) => b.count - a.count || a.game.localeCompare(b.game));
	return {
		players,
		monthlyActivePlayers,
		servers: { setUp, onNetwork },
		gamesCompleted: { total: byGame.reduce((sum, row) => sum + row.count, 0), byGame },
		coins: { total: coinsTotal, thisMonth: coinsThisMonth },
	};
}
