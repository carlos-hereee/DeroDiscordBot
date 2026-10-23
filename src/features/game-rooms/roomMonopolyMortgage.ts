import { MessageFlags, type StringSelectMenuInteraction } from "discord.js";
import { errorEmbed } from "@utils/embedBuilder.js";
import { applyMortgage, applyUnmortgage, type MonopolyResult, type MonopolyState } from "@features/games/monopolyState.js";
import { monopolyInventoryReply } from "./roomMonopoly.js";
import { commitMonopolyMove, loadSeatedRoom } from "./roomMonopolyHandlers.js";

// ── roomMonopolyMortgage ─────────────────────────────────────────────
// What:  the two selects in the private Inventory peek: mortgage a lot for cash,
//        and lift a mortgage.
// Who:   gameRoomHandlers routes the `mmortgage` and `munmortgage` selects here;
//        the peek itself is roomMonopoly.monopolyInventoryReply.
// When:  any time in a live match, by any seat still in it, on or off its turn
//        (the standard rule), so neither requires the turn.
// Where: the engine's applyMortgage and applyUnmortgage decide every rule; the
//        move commits through the same compare and swap as any other, so a
//        mortgage can never be lost under a concurrent roll.
// How:   acknowledge the press on the peek, commit, then redraw the peek in place
//        from the state just written, so the new balance and the refreshed
//        options are what the player sees next.

const PRIVATE = { flags: MessageFlags.Ephemeral } as const;

type MortgageAction = (state: MonopolyState, ownerId: string, tileId: string) => MonopolyResult;

/** A pick from the peek's "Mortgage a lot" select. */
export const handleMortgageSelect = (interaction: StringSelectMenuInteraction): Promise<void> => runMortgageSelect(interaction, applyMortgage);

/** A pick from the peek's "Lift a mortgage" select. */
export const handleUnmortgageSelect = (interaction: StringSelectMenuInteraction): Promise<void> => runMortgageSelect(interaction, applyUnmortgage);

async function runMortgageSelect(interaction: StringSelectMenuInteraction, action: MortgageAction): Promise<void> {
	const [, , roomId] = interaction.customId.split(":");
	const room = await loadSeatedRoom(interaction, roomId);
	if (!room) return;

	// The value is user input like the customId; the engine validates the tile id and
	// refuses an unknown one, or one this seat does not own, with its reason.
	const tileId = interaction.values[0] ?? "";
	await interaction.deferUpdate();
	const outcome = await commitMonopolyMove(interaction.client, room, interaction.user.id, (state, ownerId) => action(state, ownerId, tileId), {
		onTurnOnly: false,
	});
	if (!outcome.ok) {
		await interaction.followUp({ embeds: [errorEmbed(outcome.reason)], ...PRIVATE });
		return;
	}
	await interaction.editReply(monopolyInventoryReply(outcome.state, interaction.user.id, room.roomId));
}

export const roomMonopolyMortgage = { handleMortgageSelect, handleUnmortgageSelect };
