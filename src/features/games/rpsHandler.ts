import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { gamesCopy } from "./gamesCopy.js";

// ── /mini-game rps ─────────────────────────────────────────────────────────
// PHASE 1 STUB. Same contract as duelHandler: Phase 3 replaces the body, keeps
// the export name, creates no file under src/commands/, and does not modify
// challengeFlow.ts' public contract, it only consumes it.
//
// Phase 3 fills in the one genuinely new problem in this plan: after both
// players accept, each makes a SECRET choice. Reply ephemerally to the
// opponent's Accept ButtonInteraction (challengeFlow hands it back deliberately
// unacknowledged for exactly this) and followUp the challenger's original slash
// interaction with their own separate ephemeral prompt. Never one shared
// ephemeral message: discord.js 14.25 silently drops input when a select and a
// button share one, a bug this codebase has already hit.
export async function runRps(interaction: ChatInputCommandInteraction): Promise<void> {
	await interaction.reply({ content: gamesCopy.comingSoon(gamesCopy.rps.label), flags: MessageFlags.Ephemeral });
}
