import type { ButtonInteraction, InteractionReplyOptions, ModalBuilder, ModalSubmitInteraction } from "discord.js";
import { acknowledgeTextModal, buildTextModal, showTextModal, type TextModalContent } from "@utils/textModal.js";
import { GAME_ROOM_MODAL_PREFIX } from "./gameRoomActions.js";

// ── privateView ──────────────────────────────────────────────────────
// What:  shows a player their own private state (a battleship fleet, a hold em hand)
//        in a modal that pops over the room, instead of an ephemeral message that
//        sits in the channel until the player dismisses it (post-launch plan item 16).
// Who:   roomBattleshipHandlers (View my board, Randomize) and roomHoldemHandlers
//        (View my hand). gameRoomHandlers routes the modal's close to closePrivateView.
// When:  on the player's own press, never pushed: the same pull rule the ephemeral
//        replies followed, so nothing private is sent to anyone who did not ask.
// How:   the room's modal customId over the shared text modal in utils/textModal,
//        which holds the modal limits, the refusal fallback and the close.

/** The modal's customId action. gameRoomHandlers routes it to closePrivateView. */
export const PRIVATE_VIEW_ACTION = "view";

/** What the modal shows: a title (45 characters at most) and up to five blocks of text. */
export type PrivateViewContent = TextModalContent;

/** The modal for one private view. Exported for the tests, which read it back with toJSON. */
export function buildPrivateViewModal(roomId: string, content: PrivateViewContent): ModalBuilder {
	return buildTextModal(privateViewCustomId(roomId), content);
}

/**
 * Open the private view as a modal, or, when Discord refuses the modal, answer with
 * the ephemeral reply `fallback` builds. Never throws past a failed fallback.
 */
export async function showPrivateView(
	interaction: ButtonInteraction,
	roomId: string,
	content: PrivateViewContent,
	fallback: () => Promise<InteractionReplyOptions>
): Promise<void> {
	await showTextModal(interaction, privateViewCustomId(roomId), content, fallback);
}

/** The modal's Submit or close: acknowledged without a reply. */
export async function closePrivateView(interaction: ModalSubmitInteraction): Promise<void> {
	await acknowledgeTextModal(interaction);
}

function privateViewCustomId(roomId: string): string {
	return `${GAME_ROOM_MODAL_PREFIX}:${PRIVATE_VIEW_ACTION}:${roomId}`;
}
