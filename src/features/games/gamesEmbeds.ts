import { EmbedBuilder, type ColorResolvable } from "discord.js";
import { AUTHOR, COLORS } from "@base/copy/brand.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { gamesCopy } from "./gamesCopy.js";
import type { SoloLuckResult } from "./soloLuck.js";
import type { VersusResult } from "./versusResolve.js";
import type { RpsChoice, RpsOutcome } from "./rpsWinner.js";
import { handValue, type BlackjackTable, type Card, type HandOutcome, type SeatResult, type Suit } from "./blackjackState.js";

// ── /mini-game embeds ──────────────────────────────────────────────────────
// Self-contained game embeds. They do NOT reuse embedBuilder.base() on purpose:
// base() resolves branding through getPluginCopy(guildConfig), which couples a
// caller to the pluginId copy-pack system. The games are plain commands (not a
// plugin), so they pull the Dero author + colors straight from brand.ts, the
// same "non pack-aware call site" path brand.ts documents and fortuneEmbed.ts
// already takes.
//
// Phases 2 through 4 add their own builders here (duel result, rps reveal,
// hangman board and end state). Everything below is the shared challenge and
// accept surface those two challenge-based games have in common.

// Every embed in this feature carries the same Dero author and the same footer,
// so the shared spine lives in one place and a new builder cannot forget it.
function base(): EmbedBuilder {
	return new EmbedBuilder()
		.setTimestamp()
		.setAuthor({ name: AUTHOR.name, iconURL: AUTHOR.iconURL })
		.setFooter({ text: gamesCopy.footer });
}

// ── buildChallengeEmbed / buildChallengeClosedEmbed: RETIRED (Phase 4) ──
// Both existed for challengeFlow's public "X challenges Y" prompt and its
// declined/timed-out terminal card. The challenge board replaced that whole
// handshake with an opener card edited in place on ⚔️challenges, whose builders
// live in @features/game-rooms/challengeBoardEmbeds.ts. COLORS.GAME_CHALLENGE is
// still exported and is now unused here; it stays in the palette because the board
// card is the same concept wearing a different name.

// ── buildVersusResultEmbed ───────────────────────────────────────────────────
// The payoff embed for /mini-game duel. This one takes the full width image
// rather than a thumbnail: it is the moment the round exists for, and it is
// posted once, so it earns the visual weight the challenge prompt deliberately
// gave up.
//
// The result is a discriminated union, so the dice and coin branches each render
// only the fields their own mode actually has. That is the whole reason
// versusResolve returns a union instead of one shape with optional fields: an
// embed can never accidentally print a roll on a coin flip.
export function buildVersusResultEmbed(
	challengerId: string,
	opponentId: string,
	result: VersusResult,
	imageRef: string
): EmbedBuilder {
	// Shared by both head to head games. The `flip` on the result is what selects
	// the per game title, color and body line, so one builder serves both and they
	// cannot drift apart in layout.
	const shared = gamesCopy.versus;
	const dice = result.flip === "dice";

	const body = dice
		? gamesCopy.diceRoll.diceLine(challengerId, result.challengerRoll, opponentId, result.opponentRoll)
		: gamesCopy.coinFlip.coinLine(result.face);

	// A coin flip can never tie, which the union already encodes, so the tie line
	// is only reachable from the dice branch.
	const verdict =
		result.winner === "tie" ? shared.tieLine : shared.winnerLine(result.winner === "challenger" ? challengerId : opponentId);

	return base()
		.setTitle(dice ? gamesCopy.diceRoll.resultTitle : gamesCopy.coinFlip.resultTitle)
		.setColor(dice ? COLORS.GAME_DICEROLL : COLORS.GAME_COINFLIP)
		.setDescription(`${body}${verdict}`)
		.setImage(imageRef);
}

// ── buildRpsRevealEmbed ────────────────────────────────────────────────────
// The public payoff for /mini-game rps. Posted once, only after BOTH throws are
// recorded, so this function is the first place either choice becomes visible.
// Nothing upstream of the reveal may render a choice.
export function buildRpsRevealEmbed(
	challengerId: string,
	challengerChoice: RpsChoice,
	opponentId: string,
	opponentChoice: RpsChoice,
	outcome: RpsOutcome,
	imageRef: string
): EmbedBuilder {
	const c = gamesCopy.rps;
	const verdict =
		outcome === "tie" ? c.tieLine : c.winnerLine(outcome === "challenger" ? challengerId : opponentId);

	return base()
		.setTitle(c.revealTitle)
		.setColor(COLORS.GAME_RPS)
		.setDescription(`${c.revealLine(challengerId, challengerChoice, opponentId, opponentChoice)}${verdict}`)
		.setImage(imageRef);
}

// ── buildSoloLuckEmbed ─────────────────────────────────────────────────────
// The one public message a solo round against Dero posts (the 1.7.0 test fixes,
// item 14). No image: the luck games' art is not on disk yet and the stand in is
// Dero's portrait, which the author line already shows, so attaching it on every
// flip would upload the same picture twice per press. The footer states the XP
// rule, never a payout, because the daily cap may have spent it already.
export function buildSoloLuckEmbed(memberId: string, result: SoloLuckResult): EmbedBuilder {
	const c = gamesCopy.soloLuck;
	const verdicts: Record<SoloLuckResult["outcome"], string> = { won: c.memberWins(memberId), lost: c.deroWins, tie: c.tie };
	const verdict = verdicts[result.outcome];
	const { SOLO_LUCK_WIN_XP, SOLO_LUCK_OTHER_XP, DAILY_XP_CAP } = BOT_CONSTANTS.LEVELING;

	return base()
		.setTitle(SOLO_LUCK_TITLES[result.game])
		.setColor(SOLO_LUCK_COLORS[result.game])
		.setDescription(`${soloLuckBody(memberId, result)}${verdict}`)
		.setFooter({ text: `${c.xpRule(SOLO_LUCK_WIN_XP, SOLO_LUCK_OTHER_XP, DAILY_XP_CAP)} ${gamesCopy.footer}` });
}

const SOLO_LUCK_TITLES: Record<SoloLuckResult["game"], string> = {
	coinflip: gamesCopy.soloLuck.coinTitle,
	diceroll: gamesCopy.soloLuck.diceTitle,
	rps: gamesCopy.soloLuck.rpsTitle,
};

const SOLO_LUCK_COLORS: Record<SoloLuckResult["game"], ColorResolvable> = {
	coinflip: COLORS.GAME_COINFLIP,
	diceroll: COLORS.GAME_DICEROLL,
	rps: COLORS.GAME_RPS,
};

function soloLuckBody(memberId: string, result: SoloLuckResult): string {
	const c = gamesCopy.soloLuck;
	if (result.game === "coinflip") return c.coinLine(memberId, result.face);
	if (result.game === "diceroll") return c.diceLine(memberId, result.memberRoll, result.deroRoll);
	return c.rpsLine(memberId, result.memberThrow, result.deroThrow);
}

// ── buildHangmanBoardEmbed ─────────────────────────────────────────────────
// The public board, edited IN PLACE after every real guess so the whole channel
// watches one message evolve rather than scrolling a wall of updates. The image
// is the gallows frame for the current miss count, which is why the art manifest
// declares seven of them.
//
// The masked word arrives already escaped by hangmanState.maskedWord: a bare
// underscore is markdown for italics in Discord, so an unescaped mask renders as
// slanted nothing instead of blanks. `description` is the caller's line under the
// title, because a channel round (anyone guesses) and a game room (everyone but
// the word's author guesses) say different things about who plays.
export function buildHangmanBoardEmbed(
	masked: string,
	misses: string[],
	attemptsLeft: number,
	description: string,
	imageRef: string
): EmbedBuilder {
	const c = gamesCopy.hangman;
	return base()
		.setTitle(c.boardTitle)
		.setColor(COLORS.GAME_HANGMAN)
		.setDescription(description)
		.addFields(
			{ name: c.wordLabel, value: masked, inline: false },
			{ name: c.missesLabel, value: misses.length ? misses.map((l) => l.toUpperCase()).join(" ") : c.noMisses, inline: true },
			{ name: c.attemptsLabel, value: String(attemptsLeft), inline: true }
		)
		.setImage(imageRef);
}

// ── buildHangmanEndEmbed ───────────────────────────────────────────────────
// Replaces the board on a win, a loss, or an expiry. Always names the word: a
// round that ends without revealing it is the one outcome players actually
// resent, and there is nothing left to protect once the round is over.
export function buildHangmanEndEmbed(title: string, description: string, imageRef: string): EmbedBuilder {
	return base().setTitle(title).setColor(COLORS.GAME_HANGMAN).setDescription(description).setImage(imageRef);
}

// ── buildRpsTimeoutEmbed ───────────────────────────────────────────────────
// The round was accepted and then stalled. Deliberately does NOT reveal the
// throw of whoever did commit: the round is void, so publishing one player's
// choice would hand their opponent free information for the rematch.
export function buildRpsTimeoutEmbed(description: string): EmbedBuilder {
	return base().setTitle(gamesCopy.rps.timeoutTitle).setColor(COLORS.GAME_CHALLENGE).setDescription(description);
}

// ── blackjack ───────────────────────────────────────────────────────────────
// Cards render as TEXT, not as application emojis, and that is a deliberate v1
// choice rather than the plan's. The plan calls for a 52 card application emoji
// set, which is genuinely better looking and works in every guild without admin
// setup, but it needs 52 uploaded image assets that do not exist yet. Text cards
// need nothing, read fine at a glance, and cost no upload on every redraw. The
// emoji set is a drop in upgrade later: only these two helpers change.

const SUIT_SYMBOLS: Record<Suit, string> = { S: "♠", H: "♥", D: "♦", C: "♣" };

export function renderCard(card: Card): string {
	return `${card.rank}${SUIT_SYMBOLS[card.suit]}`;
}

export function renderHand(cards: Card[]): string {
	return cards.map(renderCard).join("  ");
}

// "18" or "soft 17". The soft marker is not decoration: it is the difference
// between a hand that can take a card safely and one that cannot, and a player
// who cannot see it is being asked to do the ace arithmetic in their head.
// Exported for the blackjack result card, so the card and this embed print one total.
export function renderTotal(cards: Card[]): string {
	const { total, soft } = handValue(cards);
	return soft ? gamesCopy.blackjack.softTotal(total) : String(total);
}

// ── buildBlackjackSeatingEmbed ─────────────────────────────────────────────
// Table mode only. A solo game never posts this: it deals immediately, because
// a join window for one player is a countdown to nothing.
export function buildBlackjackSeatingEmbed(hostId: string, seated: string[], secondsLeft: number): EmbedBuilder {
	const c = gamesCopy.blackjack;
	return base()
		.setTitle(c.seatingTitle)
		.setColor(COLORS.GAME_BLACKJACK)
		.setDescription(`${c.seatingDescription(hostId)}\n\n${c.seatingClosesIn(secondsLeft)}`)
		.addFields({
			name: c.seatsLabel,
			value: seated.length ? seated.map((id) => `<@${id}>`).join("\n") : c.noSeats,
			inline: false,
		});
}

// ── buildBlackjackTableEmbed ───────────────────────────────────────────────
// The live board, edited in place for the whole hand. `revealDealer` is false
// for every render before the dealer plays, which is what keeps the hole card
// secret from EVERYONE, players and spectators alike. That single fact is why
// blackjack needs no per player private view and therefore never runs into the
// 15 minute interaction token limit.
export function buildBlackjackTableEmbed(table: BlackjackTable, revealDealer: boolean): EmbedBuilder {
	const c = gamesCopy.blackjack;
	const dealerValue = revealDealer
		? `${renderHand(table.dealer.cards)}  •  ${renderTotal(table.dealer.cards)}`
		: `${renderCard(table.dealer.cards[0])}  ${c.holeCard}`;

	const title = table.buyIn > 0 ? c.handTitle(table.handNumber) : c.tableTitle;
	const embed = base().setTitle(title).setColor(COLORS.GAME_BLACKJACK).addFields({ name: c.dealerLabel, value: dealerValue, inline: false });

	// A seat that is out was dealt nothing this hand, so it has no field (and an empty field
	// is one Discord refuses).
	for (const seat of table.seats.filter((candidate) => candidate.hands.length > 0)) {
		// One field per HAND, not per seat, so a split shows as two lines a player
		// can actually tell apart. The active hand is marked, because after a split
		// "which of these am I playing" is otherwise guesswork.
		const lines = seat.hands.map((hand, index) => {
			const active = table.phase === "playing" && table.seats[table.turn]?.userId === seat.userId && seat.activeHand === index;
			const notes = [hand.status === "bust" ? c.bustNote : null, hand.status === "left" ? c.leftNote : null, hand.doubled ? c.doubledNote : null].filter(Boolean).join(", ");
			const label = c.handLabel(index, seat.hands.length);
			return `${active ? "▶ " : ""}${label}: ${renderHand(hand.cards)}  •  ${renderTotal(hand.cards)}${notes ? `  (${notes})` : ""}`;
		});
		// A bankroll table says what is riding on the hands and what is left behind them.
		if (table.buyIn > 0) lines.push(c.seatStack(seat.stack, seat.hands.reduce((sum, hand) => sum + hand.bet, 0)));
		embed.addFields({ name: seat.username, value: lines.join("\n"), inline: false });
	}

	if (table.phase === "playing") {
		const acting = table.seats[table.turn];
		if (acting) embed.setDescription(c.turnLine(acting.userId));
	}

	return embed;
}

// ── buildBlackjackResultEmbed ──────────────────────────────────────────────
// Replaces the board once the dealer has settled. Always reveals everything:
// the hand is over, so there is nothing left to protect, and a result card that
// hides the dealer's cards is the one thing players will not accept.
export function buildBlackjackResultEmbed(table: BlackjackTable, results: SeatResult[], anyDoubledLoss: boolean): EmbedBuilder {
	const c = gamesCopy.blackjack;
	const OUTCOME_LABELS: Record<HandOutcome, string> = {
		blackjack: c.outcomeBlackjack,
		win: c.outcomeWin,
		push: c.outcomePush,
		lose: c.outcomeLose,
	};

	const embed = base()
		.setTitle(c.resultTitle)
		.setColor(COLORS.GAME_BLACKJACK)
		.addFields({
			name: c.dealerLabel,
			value: `${renderHand(table.dealer.cards)}  •  ${renderTotal(table.dealer.cards)}`,
			inline: false,
		});

	for (const result of results) {
		const seat = table.seats.find((s) => s.userId === result.userId);
		const lines = result.hands.map((outcome, index) => {
			const cards = seat ? renderHand(seat.hands[index].cards) : "";
			const doubled = result.doubled[index] ? `  (${c.doubledNote})` : "";
			// What the hand paid, at a table that plays for a stack (2026-10 item 267).
			const paid = table.buyIn > 0 ? `  ${c.payoutNote(result.bets[index] ?? 0, result.payouts[index] ?? 0)}` : "";
			return `**${OUTCOME_LABELS[outcome]}** ${cards}${doubled}${paid}`;
		});
		embed.addFields({ name: result.username, value: lines.join("\n"), inline: false });
	}

	// Every seat's stack after the hand paid, out seats included, so the table reads its standings.
	if (table.buyIn > 0) embed.addFields({ name: c.stacksAfterHand, value: table.seats.map(seatStanding).join("\n"), inline: false });

	if (anyDoubledLoss) embed.setDescription(c.doubledLostAll);
	return embed;
}

// One seat's line in a bankroll table's standings: its stack, or why it is out.
function seatStanding(seat: BlackjackTable["seats"][number]): string {
	const c = gamesCopy.blackjack;
	if (seat.out === "left") return `${seat.username}: ${c.seatLeft}`;
	if (seat.out === "broke") return `${seat.username}: ${c.seatBroke}`;
	return `${seat.username}: ${c.seatStack(seat.stack, 0)}`;
}

// ── buildBlackjackBettingEmbed (2026-10 item 267) ────────────────────────────
// A bankroll table's board while it takes the hand's bets: no cards yet, so no dealer and no
// hands, only each seat's stack and its bet or that it is still choosing, with the seat on the
// betting turn named. A free table says once that its stacks are pretend.
export function buildBlackjackBettingEmbed(table: BlackjackTable, freeTable: boolean): EmbedBuilder {
	const c = gamesCopy.blackjack;
	const betting = table.phase === "betting" ? table.seats[table.turn] : undefined;
	const lines = table.seats.map((seat) => {
		if (seat.out) return seatStanding(seat);
		const status = seat.bet > 0 ? c.seatStack(seat.stack, seat.bet) : `${c.seatStack(seat.stack, 0)}, ${c.seatWaitingToBet}`;
		return `${betting?.userId === seat.userId ? "▶ " : ""}${seat.username}: ${status}`;
	});
	const description = [betting ? c.bettingLine(betting.userId) : null, freeTable ? c.freeTableNote : null].filter(Boolean).join("\n\n");
	const embed = base().setTitle(c.bettingTitle(table.handNumber)).setColor(COLORS.GAME_BLACKJACK).addFields({ name: c.stacksAfterHand, value: lines.join("\n"), inline: false });
	return description ? embed.setDescription(description) : embed;
}
