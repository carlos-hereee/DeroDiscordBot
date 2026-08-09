import { EmbedBuilder } from "discord.js";
import { AUTHOR, COLORS } from "@base/copy/brand.js";
import { gamesCopy } from "./gamesCopy.js";
import type { DuelResult } from "./duelResolve.js";
import type { RpsChoice, RpsOutcome } from "./rpsWinner.js";

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
		.setFooter({ text: gamesCopy.challenge.footer });
}

// ── buildChallengeEmbed ────────────────────────────────────────────────────
// The public "X challenges Y" prompt that carries the Accept and Decline row.
// gameLabel comes from the calling game's own copy block (gamesCopy.duel.label,
// gamesCopy.rps.label) so one embed serves both challenge-based games and a
// third game only needs a label, not a new builder.
//
// The mentions in the description do NOT ping: mentions inside an embed never
// notify. challengeFlow puts the notifying mention in the message content with
// allowedMentions pinned to the opponent, so the ping is deliberate and bounded.
// thumbnailRef comes from resolveGameAsset("challenge"), which hands back the
// bundled Dero avatar until real challenge art lands under assets/games/. A
// small corner thumbnail rather than a full width image, matching reminderEmbed's
// rule that the big banner is reserved for the payoff moment; here the payoff is
// the result embed the game posts next.
export function buildChallengeEmbed(challengerId: string, opponentId: string, gameLabel: string, thumbnailRef: string): EmbedBuilder {
	return base()
		.setTitle(gamesCopy.challenge.title)
		.setColor(COLORS.GAME_CHALLENGE)
		.setDescription(gamesCopy.challenge.description(challengerId, opponentId, gameLabel))
		.setThumbnail(thumbnailRef);
}

// ── buildChallengeClosedEmbed ──────────────────────────────────────────────
// The terminal state for a challenge that ended WITHOUT a game starting, either
// declined or timed out. Reuses the challenge color rather than the error color
// on purpose: a declined challenge is a normal outcome, not a failure, and
// painting it red would read as "something broke."
export function buildChallengeClosedEmbed(description: string): EmbedBuilder {
	return base().setTitle(gamesCopy.challenge.closedTitle).setColor(COLORS.GAME_CHALLENGE).setDescription(description);
}

// ── buildDuelResultEmbed ───────────────────────────────────────────────────
// The payoff embed for /mini-game duel. This one takes the full width image
// rather than a thumbnail: it is the moment the round exists for, and it is
// posted once, so it earns the visual weight the challenge prompt deliberately
// gave up.
//
// The result is a discriminated union, so the dice and coin branches each render
// only the fields their own mode actually has. That is the whole reason
// duelResolve returns a union instead of one shape with optional fields: an
// embed can never accidentally print a roll on a coin flip.
export function buildDuelResultEmbed(
	challengerId: string,
	opponentId: string,
	result: DuelResult,
	imageRef: string
): EmbedBuilder {
	const c = gamesCopy.duel;

	const body =
		result.flip === "dice"
			? c.diceLine(challengerId, result.challengerRoll, opponentId, result.opponentRoll)
			: c.coinLine(result.face);

	// A coin duel can never tie, which the union already encodes, so the tie line
	// is only reachable from the dice branch.
	const verdict =
		result.winner === "tie" ? c.tieLine : c.winnerLine(result.winner === "challenger" ? challengerId : opponentId);

	return base()
		.setTitle(c.resultTitle)
		.setColor(COLORS.GAME_DUEL)
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

// ── buildHangmanBoardEmbed ─────────────────────────────────────────────────
// The public board, edited IN PLACE after every real guess so the whole channel
// watches one message evolve rather than scrolling a wall of updates. The image
// is the gallows frame for the current miss count, which is why the art manifest
// declares seven of them.
//
// The masked word arrives already escaped by hangmanState.maskedWord: a bare
// underscore is markdown for italics in Discord, so an unescaped mask renders as
// slanted nothing instead of blanks.
export function buildHangmanBoardEmbed(
	masked: string,
	misses: string[],
	attemptsLeft: number,
	starterId: string,
	imageRef: string
): EmbedBuilder {
	const c = gamesCopy.hangman;
	return base()
		.setTitle(c.boardTitle)
		.setColor(COLORS.GAME_HANGMAN)
		.setDescription(c.startedBy(starterId))
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
