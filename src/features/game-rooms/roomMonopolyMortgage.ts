import type { StringSelectMenuInteraction } from "discord.js";
import { answerInChannel } from "@utils/answerInChannel.js";
import { errorEmbed } from "@utils/embedBuilder.js";
import { applyMortgage, applySellBuilding, applyUnmortgage, type MonopolyResult, type MonopolyState } from "@features/games/monopolyState.js";
import { monopolyInventoryReply } from "./roomMonopoly.js";
import { commitMonopolyMove, loadSeatedRoom } from "./roomMonopolyHandlers.js";

// ── roomMonopolyMortgage ─────────────────────────────────────────────
// What:  the selects in the private Inventory peek: mortgage a lot for cash, lift a
//        mortgage, and sell a building back to the bank. They are also how a seat
//        raises cash for a debt the match is holding for it.
// Who:   gameRoomHandlers routes the `mmortgage`, `munmortgage` and `msell`
//        selects here; the peek itself is roomMonopoly.monopolyInventoryReply.
// When:  any time in a live match, by any seat still in it, on or off its turn
//        (the standard rule), so none requires the turn.
// Where: the engine's applyMortgage, applyUnmortgage and applySellBuilding
//        decide every rule; the move commits through the same compare and swap
//        as any other, so a mortgage or sale can never be lost under a
//        concurrent roll.
// How:   acknowledge the press on the peek, commit, then redraw the peek in place
//        from the state just written, so the new balance and the refreshed
//        options are what the player sees next.

type HoldingsAction = (state: MonopolyState, ownerId: string, tileId: string) => MonopolyResult;

/** A pick from the peek's "Mortgage a lot" select. */
export const handleMortgageSelect = (interaction: StringSelectMenuInteraction): Promise<void> => runHoldingsSelect(interaction, applyMortgage);

/** A pick from the peek's "Lift a mortgage" select. */
export const handleUnmortgageSelect = (interaction: StringSelectMenuInteraction): Promise<void> => runHoldingsSelect(interaction, applyUnmortgage);

/** A pick from the peek's "Sell a building" select: one house, or the hotel, back to the bank. */
export const handleSellSelect = (interaction: StringSelectMenuInteraction): Promise<void> => runHoldingsSelect(interaction, applySellBuilding);

async function runHoldingsSelect(interaction: StringSelectMenuInteraction, action: HoldingsAction): Promise<void> {
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
		await answerInChannel(interaction, "member", { embeds: [errorEmbed(outcome.reason)] });
		return;
	}
	await interaction.editReply(monopolyInventoryReply(outcome.state, interaction.user.id, room.roomId));
}

export const roomMonopolyMortgage = { handleMortgageSelect, handleUnmortgageSelect, handleSellSelect };
