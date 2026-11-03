// ── board refresh result ─────────────────────────────────────────────────
// What one refresh of a self refreshing board did, shared by the two boards of the
// leaderboard channel (LeaderboardBoard and LevelsBoard), which never import each
// other. The refreshers still never throw: they log, and say what happened here, so
// Refresh standings can name each board in its reply (2026-10 item 254). Every other
// caller (boot sweep, hourly tick, coalesced refreshes) ignores it.

/** Why a board was not posted or edited. The reply's copy maps each one to words. */
export type BoardRefreshProblem =
	| "homebase-destroyed"
	| "not-set-up"
	| "channel-missing"
	| "foreign-message"
	| "edit-failed"
	| "post-failed"
	| "unexpected-error";

/** posted is true when the board's message was edited in place or posted fresh. */
export interface BoardRefreshResult {
	posted: boolean;
	problem?: BoardRefreshProblem;
}

export const BOARD_POSTED: BoardRefreshResult = { posted: true };

/** A refresh that did not post, and why. */
export function boardNotPosted(problem: BoardRefreshProblem): BoardRefreshResult {
	return { posted: false, problem };
}
