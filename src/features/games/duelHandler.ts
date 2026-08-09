import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { gamesCopy } from "./gamesCopy.js";

// ── /mini-game duel ────────────────────────────────────────────────────────
// PHASE 1 STUB. The command shell and the shared challenge engine ship first so
// every later game registers into an existing dispatch table instead of adding a
// slash command of its own. Phase 2 replaces the body below; it does NOT create
// a new file under src/commands/ and it does NOT change this file's export name,
// so the MINI_GAME_HANDLERS entry pointing here needs no edit.
//
// Phase 2 fills in: read the opponent and flip options, check this game's OWN
// module scope CooldownManager (never a shared /mini-game cooldown, that would
// let a duel block a fortune reading), call issueChallenge from challengeFlow.ts,
// and on "accepted" resolve through the pure duelResolve module and render the
// result with a new gamesEmbeds builder.
export async function runDuel(interaction: ChatInputCommandInteraction): Promise<void> {
	await interaction.reply({ content: gamesCopy.comingSoon(gamesCopy.duel.label), flags: MessageFlags.Ephemeral });
}
