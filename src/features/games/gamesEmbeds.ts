import { EmbedBuilder } from "discord.js";
import { AUTHOR, COLORS } from "@base/copy/brand.js";
import { gamesCopy } from "./gamesCopy.js";
import type { DuelResult } from "./duelResolve.js";

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
