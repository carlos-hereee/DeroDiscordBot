import type { Client, User } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { awardXp } from "@features/leveling/awardXp.js";
import type { GameOutcome, LevelingGameSlug } from "@features/leveling/levelingTypes.js";
import type { HandOutcome, SeatResult } from "./blackjackState.js";

// ── gameXp ─────────────────────────────────────────────────────────────────
// The games feature's one seam into the leveling system.
//
// What:  turns a finished round into xp and a win/loss record for everyone who
//        took part.
// Who:   versusHandler and rpsHandler (both two player, both the same three way
//        shape), hangmanHandler (many players, its own shape), and the three
//        games arriving in phases 6 to 8.
// When:  AFTER the player facing result has already been posted. Never before,
//        and never between a result being computed and the message that shows it.
// Where: this file may import awardXp and NOTHING else from leveling. A game
//        handler must never reach a store, the curve, or the announcer directly;
//        that single rule is what makes adding a game later nearly free.
// How:   every call is FIRE AND FORGET. awardXp never throws by contract, and
//        these helpers return void rather than a promise so a caller physically
//        cannot await one into a collector callback where nothing is left to
//        catch it. Convention 7 in CLAUDE.md.
//
// ⚠️ NO AMOUNT IS INLINED HERE OR IN ANY HANDLER. They all live in
// BOT_CONSTANTS.LEVELING so an operator can retune the economy in one place and
// a game cannot quietly pay differently from its siblings.

export type TwoPlayerWinner = "challenger" | "opponent" | "tie";

interface TwoPlayerResult {
	client: Client;
	guildId: string | null;
	channelId?: string | null;
	game: LevelingGameSlug;
	challenger: User;
	opponent: User;
	winner: TwoPlayerWinner;
}

// The shared duel and rps payout. The winner takes play xp PLUS the win bonus,
// the loser keeps the play xp for showing up, and a tie pays both the tie amount,
// which sits deliberately between the two so a draw is worth more than losing and
// less than winning.
export function awardTwoPlayerResult(result: TwoPlayerResult): void {
	// A game played in a DM has no guild to be ranked in. Nothing to award.
	if (!result.guildId) return;

	const { GAME_PLAY_XP, GAME_WIN_XP, GAME_TIE_XP } = BOT_CONSTANTS.LEVELING;

	const players: Array<{ user: User; won: boolean }> = [
		{ user: result.challenger, won: result.winner === "challenger" },
		{ user: result.opponent, won: result.winner === "opponent" },
	];

	for (const player of players) {
		const drawn = result.winner === "tie";
		void awardXp({
			client: result.client,
			guildId: result.guildId,
			userId: player.user.id,
			username: player.user.globalName ?? player.user.username,
			amount: drawn ? GAME_TIE_XP : GAME_PLAY_XP + (player.won ? GAME_WIN_XP : 0),
			source: "game",
			game: result.game,
			outcome: drawn ? "drawn" : player.won ? "won" : "lost",
			channelId: result.channelId ?? null,
		});
	}
}

interface SoloLuckPayout {
	client: Client;
	guildId: string | null;
	channelId?: string | null;
	user: User;
	won: boolean;
}

// The solo luck payout (the 1.7.0 test fixes, item 14): a coin flip, dice roll or
// rps against Dero. A win pays SOLO_LUCK_WIN_XP and a loss or a tie pays
// SOLO_LUCK_OTHER_XP, as source "soloLuck", which puts it inside the daily cap.
//
// ⚠️ NO `game` AND NO `outcome`, deliberately. A per game record would move
// games.coinflip.won and its siblings, which feed the Coin Caller, Dice Roller,
// Strategist, Contender and Champion achievements, and their tier XP is NOT capped.
// A member flipping against Dero a few hundred times would then walk straight past
// the daily cap on achievement bonuses. The record stays a record of matches
// against members.
export function awardSoloLuckResult(result: SoloLuckPayout): void {
	if (!result.guildId) return;

	const { SOLO_LUCK_WIN_XP, SOLO_LUCK_OTHER_XP } = BOT_CONSTANTS.LEVELING;
	void awardXp({
		client: result.client,
		guildId: result.guildId,
		userId: result.user.id,
		username: result.user.globalName ?? result.user.username,
		amount: result.won ? SOLO_LUCK_WIN_XP : SOLO_LUCK_OTHER_XP,
		source: "soloLuck",
		channelId: result.channelId ?? null,
	});
}

interface MultiPlayerResult {
	client: Client;
	guildId: string | null;
	channelId?: string | null;
	game: LevelingGameSlug;
	// Everyone who took part, resolved to an id and a display name by the caller,
	// which is the only place that knows how to look them up. A name the caller
	// could not resolve is left undefined rather than filled with the snowflake:
	// awardXp then records the result and skips the name write, where a raw id
	// would overwrite the member's real name on /account and /account view:levels.
	participants: Array<{ userId: string; username?: string }>;
	// The member who finished it, when somebody did. Null on a loss or an expiry.
	winnerId: string | null;
	// What everyone but the winner records when there IS a winner. "assist" is the
	// hangman reading (the room solved it together) and stays the default; Monopoly
	// passes "lost", because a seat that went bankrupt did not help the last one
	// standing win.
	nonWinnerOutcome?: Extract<GameOutcome, "assist" | "lost">;
}

// The hangman shape, and the reason the ASSIST outcome exists at all: a public
// round is solved by one member on top of letters several others revealed. The
// solver takes the win, everyone else who guessed takes an assist rather than a
// loss, because they materially advanced a round somebody else won.
//
// On a loss or an expiry nobody assisted anybody, so every participant takes the
// play xp and a "lost". Showing up is the behavior being rewarded either way.
// A game whose other players genuinely lost (Monopoly) says so with
// nonWinnerOutcome; the xp is the same either way, only the record differs.
export function awardMultiPlayerResult(result: MultiPlayerResult): void {
	if (!result.guildId) return;

	const { GAME_PLAY_XP, GAME_WIN_XP } = BOT_CONSTANTS.LEVELING;
	const nonWinnerOutcome = result.nonWinnerOutcome ?? "assist";

	for (const participant of result.participants) {
		const isWinner = result.winnerId !== null && participant.userId === result.winnerId;
		const beatenByWinner = result.winnerId !== null && !isWinner;

		void awardXp({
			client: result.client,
			guildId: result.guildId,
			userId: participant.userId,
			username: participant.username,
			amount: GAME_PLAY_XP + (isWinner ? GAME_WIN_XP : 0),
			source: "game",
			game: result.game,
			outcome: isWinner ? "won" : beatenByWinner ? nonWinnerOutcome : "lost",
			channelId: result.channelId ?? null,
		});
	}
}

// ── blackjack ───────────────────────────────────────────────────────────────
// The third shape, and it needs to exist because neither helper above fits.
// awardTwoPlayerResult is two sided. awardMultiPlayerResult assumes ONE winner
// the whole table is measured against. A blackjack table has neither: every
// hand is an independent bet against the DEALER, who is not a member and earns
// nothing, so six seats can all win, all lose, or any mixture, at once.

// What one hand is worth. Split out so the arithmetic is readable in isolation
// and so the doubling asymmetry is stated exactly once. Exported because the
// blackjack result card prints this figure, and it must be the one paid.
export function blackjackHandXp(outcome: HandOutcome, doubled: boolean): number {
	const { GAME_PLAY_XP, GAME_WIN_XP, GAME_TIE_XP, BLACKJACK_NATURAL_XP, BLACKJACK_DOUBLE_WIN_MULTIPLIER } = BOT_CONSTANTS.LEVELING;

	// Doubling raises the WIN BONUS and nothing else. See the constant's own note:
	// multiplying the whole award would make a doubled loss pay more than an
	// ordinary one, and the correct play would be to double every hand.
	const winBonus = doubled ? GAME_WIN_XP * BLACKJACK_DOUBLE_WIN_MULTIPLIER : GAME_WIN_XP;

	switch (outcome) {
		// A natural cannot actually be doubled (it is final the moment it is dealt,
		// so no action is ever offered on it), but the bonus is written to compose
		// rather than to assume that, because a future rule change should not
		// silently produce a wrong number here.
		case "blackjack":
			return GAME_PLAY_XP + winBonus + BLACKJACK_NATURAL_XP;
		case "win":
			return GAME_PLAY_XP + winBonus;
		// A push returns the stake, so doubling neither helps nor hurts.
		case "push":
			return GAME_TIE_XP;
		// The staked half of doubling: a doubled loss forfeits even the play xp.
		case "lose":
			return doubled ? 0 : GAME_PLAY_XP;
	}
}

const BLACKJACK_RECORD: Record<HandOutcome, GameOutcome> = {
	blackjack: "won",
	win: "won",
	push: "drawn",
	lose: "lost",
};

interface BlackjackPayout {
	client: Client;
	guildId: string | null;
	channelId?: string | null;
	// Straight from blackjackState.settle(), one entry per seat, each carrying one
	// outcome per hand in hand order.
	seats: SeatResult[];
}

// ONE AWARD PER HAND, not per seat, which is the honest reading: a seat that
// split is playing two bets and may win one and lose the other, so collapsing
// them into a single outcome would have to invent a winner. Two awards means
// /account reads "played 2, won 1, lost 1", which is what actually happened.
//
// A zero amount still awards, and deliberately: awardXp only short circuits on
// zero when there is no `game` attached, so a doubled loss records the hand
// (played +1, lost +1) while paying nothing.
export function awardBlackjackResult(result: BlackjackPayout): void {
	if (!result.guildId) return;

	for (const seat of result.seats) {
		seat.hands.forEach((outcome, index) => {
			void awardXp({
				client: result.client,
				guildId: result.guildId as string,
				userId: seat.userId,
				username: seat.username,
				amount: blackjackHandXp(outcome, seat.doubled[index] ?? false),
				source: "game",
				game: "blackjack",
				outcome: BLACKJACK_RECORD[outcome],
				channelId: result.channelId ?? null,
			});
		});
	}
}
