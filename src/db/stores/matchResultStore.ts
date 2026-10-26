// src/db/stores/matchResultStore.ts
import { MatchResult, type IMatchResult } from "@db/models/MatchResult.js";

// ── Match result store ──
// Every DB touch for MatchResult. Thin on purpose: features/ratings builds the row
// and decides what a board does with the players it reads. The store's one decision
// is reporting a duplicate roomId as "already recorded" rather than as a failure,
// because the unique roomId index IS the rating claim (see the model) and a second
// recording of one match is expected, not an error.

// Mongo's duplicate key error code.
const DUPLICATE_KEY_CODE = 11000;

/** A finishedAt window, `start` inclusive and `end` exclusive. */
export interface IFinishedBetween {
	start: Date;
	end: Date;
}

export const matchResultStore = {
	/** Insert the match's result. False when this room's result was already recorded. */
	async insertOnce(result: IMatchResult): Promise<boolean> {
		try {
			await MatchResult.create(result);
			return true;
		}
		catch (error) {
			if ((error as { code?: number })?.code === DUPLICATE_KEY_CODE) return false;
			throw error;
		}
	},

	/**
	 * Every player who has a result in one game in one guild, optionally only from
	 * matches that finished inside a window. Served by the { guildId, game, finishedAt }
	 * index; the answer holds each id once.
	 */
	async playerIdsInGuild(guildId: string, game: string, finishedBetween?: IFinishedBetween): Promise<string[]> {
		const filter = finishedBetween
			? { guildId, game, finishedAt: { $gte: finishedBetween.start, $lt: finishedBetween.end } }
			: { guildId, game };
		return MatchResult.distinct<"entries.userId", string>("entries.userId", filter);
	},

	/**
	 * Whether one guild finished at least one rated match inside a window, in any game.
	 * The monthly vault award's activity gate (2026-10 item 250 Phase 5). Served by the
	 * { guildId, game, finishedAt } index's guildId prefix.
	 */
	async hasRatedMatchInGuild(guildId: string, finishedBetween: IFinishedBetween): Promise<boolean> {
		const found = await MatchResult.exists({ guildId, rated: true, finishedAt: { $gte: finishedBetween.start, $lt: finishedBetween.end } });
		return found !== null;
	},
};
