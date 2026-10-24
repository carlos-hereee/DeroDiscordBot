import { ModalBuilder, TextDisplayBuilder, type ButtonInteraction, type InteractionReplyOptions, type ModalSubmitInteraction } from "discord.js";
import { GAME_ROOM_MODAL_PREFIX } from "./gameRoomActions.js";

// ── privateView ──────────────────────────────────────────────────────
// What:  shows a player their own private state (a battleship fleet, a hold em hand)
//        in a modal that pops over the room, instead of an ephemeral message that
//        sits in the channel until the player dismisses it (post-launch plan item 16).
// Who:   roomBattleshipHandlers (View my board, Randomize) and roomHoldemHandlers
//        (View my hand). gameRoomHandlers routes the modal's close to closePrivateView.
// When:  on the player's own press, never pushed: the same pull rule the ephemeral
//        replies followed, so nothing private is sent to anyone who did not ask.
// How:   the modal is text only (TextDisplay sections). Discord documents TextDisplay
//        as a modal component but says nothing on a modal that holds no input at all,
//        so a refusal is caught and answered with the old ephemeral reply instead. A
//        failed showModal leaves the interaction unanswered, which is what lets the
//        fallback still reply inside the three second window.
//
// ⚠️ PRIVATE BY CONSTRUCTION, not by care: a modal is only ever shown to the member
// whose press opened it, exactly like an ephemeral reply.

/** The modal's customId action. gameRoomHandlers routes it to closePrivateView. */
export const PRIVATE_VIEW_ACTION = "view";

// Discord caps one TextDisplay at 4000 characters and a modal at five components.
const MAX_SECTIONS = 5;
const MAX_SECTION_LENGTH = 4000;

/** What the modal shows: a title (45 characters at most) and up to five blocks of text. */
export interface PrivateViewContent {
	title: string;
	sections: string[];
}

/** The modal for one private view. Exported for the tests, which read it back with toJSON. */
export function buildPrivateViewModal(roomId: string, content: PrivateViewContent): ModalBuilder {
	return new ModalBuilder()
		.setCustomId(`${GAME_ROOM_MODAL_PREFIX}:${PRIVATE_VIEW_ACTION}:${roomId}`)
		.setTitle(content.title)
		.addTextDisplayComponents(
			...content.sections
				.filter((section) => section.trim().length > 0)
				.slice(0, MAX_SECTIONS)
				.map((section) => new TextDisplayBuilder().setContent(section.slice(0, MAX_SECTION_LENGTH)))
		);
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
	try {
		await interaction.showModal(buildPrivateViewModal(roomId, content));
		return;
	} catch (error) {
		console.warn("[game-rooms] the private view modal was refused; answering privately instead", { roomId, error });
	}
	await interaction.reply(await fallback()).catch((error) => console.error("[game-rooms] the private view fallback failed", { roomId, error }));
}

/**
 * The modal's Submit or close. There is nothing to submit, so it is acknowledged
 * without a reply; deferUpdate is legal because the modal opened from a message button.
 */
export async function closePrivateView(interaction: ModalSubmitInteraction): Promise<void> {
	// Swallowed on purpose: the modal is already gone from the member's screen, and a
	// failed acknowledgement costs at most Discord's own "interaction failed" note.
	await interaction.deferUpdate().catch(() => undefined);
}
