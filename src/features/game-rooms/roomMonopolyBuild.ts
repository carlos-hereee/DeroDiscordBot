import { ActionRowBuilder, StringSelectMenuBuilder, type ButtonInteraction, type StringSelectMenuInteraction } from "discord.js";
import { answerInChannel } from "@utils/answerInChannel.js";
import {
	applyBuild,
	listBuildOptions,
	nextBuildingKind,
	type BuildingKind,
	type BuildOption,
	type MonopolyState,
} from "@features/games/monopolyState.js";
import { GAME_ROOM_SELECT_PREFIX } from "./gameRoomActions.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { commitMonopolyMove, loadSeatedRoom, monopolyStateOf } from "./roomMonopolyHandlers.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { showNotice } from "@utils/textModal.js";

// ── roomMonopolyBuild ────────────────────────────────────────────────
// What:  the Build button: a private picker of every lot the seat on the clock can
//        build on right now, and the pick that builds one house (or the hotel on a
//        lot that already has four).
// Who:   routed from gameRoomHandlers: the `mbuild` button and the `mbuild` select.
// When:  the seat on the clock, before its roll. The board only shows Build then,
//        and the engine refuses it at any other time anyway.
// Where: the build itself is the engine's applyBuild, committed through the same
//        compare and swap as every other move; this file only offers and routes.
// How:   a select rather than the plan's two field modal (lot and kind), because
//        the kind is not a choice: the even building rule and the four house ladder
//        decide it, so asking would only add a way to be refused. The picker lists
//        listBuildOptions, the engine's own rule check, so it never offers a lot the
//        build would then refuse; after each build it refreshes in place so a player
//        can build round a whole group without reopening it.


// Discord's ceiling on options in one select. The board has 22 color lots, so the
// slice never bites today; it is here so a future board cannot make the select throw.
const MAX_SELECT_OPTIONS = 25;

/**
 * The Build button: answers with the picker, or says why there is nothing to build. The
 * picker rebuilds itself after each build, which a modal cannot, so it posts
 * where it was pressed (2026-10 item 257 Phase 5); every pick builds only for its presser's own
 * seat, re-checked by loadSeatedRoom and the engine.
 */
export async function handleMbuild(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	const state = monopolyStateOf(room);
	if (!state) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.monopoly, sections: [gameRoomsCopy.monopoly.noBoard] });
		return;
	}
	const options = listBuildOptions(state, interaction.user.id);
	if (options.length === 0) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.monopoly, sections: [gameRoomsCopy.monopoly.nothingToBuild] });
		return;
	}
	await answerInChannel(interaction, "here", { content: gameRoomsCopy.monopoly.buildPickerPrompt, components: [buildPickerRow(room.roomId, options)] });
}

/** A pick from the picker: build on that lot, then refresh the picker with what is left. */
export async function handleBuildSelect(interaction: StringSelectMenuInteraction): Promise<void> {
	const [, , roomId] = interaction.customId.split(":");
	const room = await loadSeatedRoom(interaction, roomId);
	if (!room) return;

	// The value is user input like the customId, so it reaches the engine only as a
	// tile id the engine validates; an unknown id is refused there with its reason.
	const tileId = interaction.values[0] ?? "";
	await interaction.deferUpdate();
	const outcome = await commitMonopolyMove(
		interaction.client,
		room,
		interaction.user.id,
		(state, actorId) => applyBuild(state, actorId, tileId, buildingKindFor(state, tileId)),
		{ onTurnOnly: true }
	);
	if (!outcome.ok) {
		// The engine's refusal (not your turn, cannot afford, the board busy) is a state, so a
		// private notice after the deferUpdate, never a ping in 💬dero-commands (owner rule 1 of
		// the Round 3 list, 2026-10 item 263).
		await showNotice(interaction, { title: gameRoomsCopy.notices.monopoly, sections: [outcome.reason] });
		return;
	}

	const remaining = listBuildOptions(outcome.state, interaction.user.id);
	await interaction.editReply(
		remaining.length > 0
			? { content: gameRoomsCopy.monopoly.buildPickerAgain, components: [buildPickerRow(room.roomId, remaining)] }
			: { content: gameRoomsCopy.monopoly.buildPickerDone, components: [] }
	);
}

// What the lot takes next, read off the state the build runs against rather than
// the picker's snapshot, so a lot that gained a house since the picker opened gets
// the right kind. A tile id the board does not have falls to "house" and the engine
// refuses it by name.
function buildingKindFor(state: MonopolyState, tileId: string): BuildingKind {
	const lot = state.properties[tileId];
	return lot ? nextBuildingKind(lot) : "house";
}

function buildPickerRow(roomId: string, options: BuildOption[]): ActionRowBuilder<StringSelectMenuBuilder> {
	const select = new StringSelectMenuBuilder()
		.setCustomId(`${GAME_ROOM_SELECT_PREFIX}:mbuild:${roomId}`)
		.setPlaceholder(gameRoomsCopy.monopoly.buildPickerPlaceholder)
		.addOptions(
			options.slice(0, MAX_SELECT_OPTIONS).map((option) => ({
				label: gameRoomsCopy.monopoly.buildOptionLabel(option.name, option.kind, option.cost),
				value: option.tileId,
			}))
		);
	return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

export const roomMonopolyBuild = { handleMbuild, handleBuildSelect };
