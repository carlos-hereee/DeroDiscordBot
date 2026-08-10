import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { buildSuggestionModal } from "@features/suggestion-box/SuggestionBox.js";

// ── /suggestion-box ─────────────────────────────────────────────────
// Open to every guild member. Shows the suggestion modal; submission
// flows through the persistent modal handler registered in
// SuggestionBox.ts (same handler the #command-center button uses).
// Permission gate: NONE, friction defeats the purpose of feedback.
//
// The command guide pinned in #command-center lists this under
// member commands. Submission lands in the Company Uno platform
// owner's in-app inbox.

export const data = new SlashCommandBuilder()
	.setName("suggestion-box")
	.setDescription("Send a suggestion or feature request to the Company Uno team");

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
	await interaction.showModal(buildSuggestionModal());
}
