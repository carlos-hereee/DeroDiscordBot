import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { gamesCopy } from "./gamesCopy.js";

// ── /mini-game hangman ─────────────────────────────────────────────────────
// PHASE 1 STUB. Same contract as the other two: Phase 4 replaces the body, keeps
// the export name, and creates no file under src/commands/.
//
// Hangman is the one game that does NOT use challengeFlow.ts, there is no
// opponent. Phase 4 fills in: post a PUBLIC board embed that updates in place, a
// "Guess a letter" button whose handler calls showModal as its FIRST response (a
// modal cannot be deferred), and a Map keyed by channel id so the whole channel
// can play one round together. Clean the map entry the instant a round ends.
export async function runHangman(interaction: ChatInputCommandInteraction): Promise<void> {
	await interaction.reply({ content: gamesCopy.comingSoon(gamesCopy.hangman.label), flags: MessageFlags.Ephemeral });
}
