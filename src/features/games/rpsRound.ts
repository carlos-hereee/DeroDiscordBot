import type { RpsChoice } from "./rpsWinner.js";

// ── rpsRound ───────────────────────────────────────────────────────────────
// The round's state machine, kept PURE and separate from rpsHandler's Discord
// work for one specific reason: the hardest bug in this game is a race, two
// players clicking their choice in the same tick and the reveal firing twice.
// Racing logic buried inside an async Discord handler is close to untestable.
// Pulled out here it is a synchronous function with an exhaustive test.
//
// The invariant this file exists to hold: applyPick can return reveal: true AT
// MOST ONCE per round, no matter how many callers race into it.

export type RpsSide = "challenger" | "opponent";

export interface RpsRoundState {
	challengeId: string;
	picks: Partial<Record<RpsSide, RpsChoice>>;
	resolved: boolean;
}

export type RpsPickResult =
	// The pick landed. reveal is true for EXACTLY the caller that completed the
	// round, and that caller owns posting the result.
	| { status: "recorded"; reveal: boolean }
	// This side already picked. Their first choice stands; a second click must
	// never overwrite it, or a player could watch their opponent's ephemeral
	// appear and then change their mind.
	| { status: "duplicate" }
	// The round already revealed or timed out. A late click gets told so rather
	// than silently doing nothing.
	| { status: "closed" };

export function createRpsRound(challengeId: string): RpsRoundState {
	return { challengeId, picks: {}, resolved: false };
}

// ⚠️ SYNCHRONOUS BY CONTRACT. Every read and write below happens in one
// uninterrupted run of the event loop, so two clicks in the same tick are
// serialized by Node itself and only one can observe an incomplete round and
// then complete it. Introducing an `await` anywhere in this function would open
// exactly the race the whole design is built to close. Do not make it async.
export function applyPick(round: RpsRoundState, side: RpsSide, choice: RpsChoice): RpsPickResult {
	if (round.resolved) return { status: "closed" };
	if (round.picks[side]) return { status: "duplicate" };

	round.picks[side] = choice;

	// Claim the reveal in the SAME tick the round completes. Setting resolved
	// here, rather than after the caller finishes posting, is what makes the
	// claim exclusive: the second clicker's call already returned before any
	// awaiting happens in the handler.
	if (round.picks.challenger && round.picks.opponent) {
		round.resolved = true;
		return { status: "recorded", reveal: true };
	}

	return { status: "recorded", reveal: false };
}

// Close a round that nobody completed. Returns true only for the caller that
// actually closed it, so a timeout firing alongside a just-in-time reveal cannot
// post a second, contradictory message.
export function closeRound(round: RpsRoundState): boolean {
	if (round.resolved) return false;
	round.resolved = true;
	return true;
}
