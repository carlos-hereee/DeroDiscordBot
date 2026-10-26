import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { economyCopy } from "@features/economy/economyCopy.js";
import { runChipClaim } from "@features/economy/chipClaim.js";

// ── /claim ────────────────────────────────────────────────────────────
// What:  a member claims their chips (2026-10 item 250 Phase 5): 25,000 the first time
//        in a server, then 1,000 every 24 hours.
// Who:   every member. Not in ADMIN_COMMANDS and no default member permission.
// Where: the whole reply is features/economy/chipClaim.ts; this file only registers it.

export const data = new SlashCommandBuilder().setName("claim").setDescription(economyCopy.claim.commandDescription);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
	await runChipClaim(interaction);
}
