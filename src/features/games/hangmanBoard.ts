import type { AttachmentBuilder, EmbedBuilder } from "discord.js";
import { isRenderPayload, withRenderFallback } from "@features/renderer/index.js";
import { resolveGameAsset, hangmanStageKey, type ResolvedGameAsset } from "./gamesAssets.js";
import { buildHangmanBoardEmbed } from "./gamesEmbeds.js";
import { hangmanCardView, renderHangmanCard, type HangmanCardView } from "./hangmanRenderer.js";
import { maskedWord, wrongLetters, remainingAttempts, type HangmanState } from "./hangmanState.js";

// ── hangmanBoard ───────────────────────────────────────────────────────────
// What:  the one way a hangman board becomes a Discord picture: the drawn card in
//        the embed's image slot when it renders, the gallows art (or its Dero stand
//        in) when it does not, under the same embed either way.
// Who:   both forms of the game. hangmanHandler (the casual channel round) edits
//        one board in place; roomHangman (a game room) posts a card per guess.
// Where: it builds a payload and sends nothing, so each caller keeps its own
//        delivery (an edit or a new message) and its own components.
//
// ⚠️ THE WORD NEVER REACHES THIS MODULE'S OUTPUT. The card view carries the
// revealed letters and the embed carries the mask, so a board drawn mid round
// cannot spoil it (the room's risk R12).

export interface HangmanBoardPicture {
	embeds: EmbedBuilder[];
	files: AttachmentBuilder[];
}

/**
 * The card for `view` with `embedFor` wrapped around it. The attachment and the
 * embed's image reference always come from the same branch, so no message can
 * attach one picture and point its embed at the other.
 */
export async function boardPicture(
	view: HangmanCardView,
	art: ResolvedGameAsset,
	embedFor: (imageRef: string) => EmbedBuilder
): Promise<HangmanBoardPicture> {
	const card = await withRenderFallback(
		() => renderHangmanCard(view),
		() => embedFor(art.ref)
	);
	if (isRenderPayload(card)) return { embeds: [embedFor(card.ref)], files: [card.attachment] };
	return { embeds: [card], files: [art.attachment] };
}

/**
 * The board for a round still in play: the mask, the misses and the attempts
 * left, over the gallows frame for the current miss count. `description` is the
 * line under the title, which differs between a channel round and a room.
 */
export function playingBoardPicture(state: HangmanState, description: string): Promise<HangmanBoardPicture> {
	return boardPicture(hangmanCardView(state), resolveGameAsset(hangmanStageKey(state.wrong)), (imageRef) =>
		buildHangmanBoardEmbed(maskedWord(state), wrongLetters(state), remainingAttempts(state), description, imageRef)
	);
}
