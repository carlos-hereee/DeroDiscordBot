import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { creatorLabLiveEnabled } from "@utils/config.js";
import { errorEmbed, infoEmbed } from "@utils/embedBuilder.js";
import { showNotice } from "@utils/textModal.js";
import { liveHighlightCopy } from "@features/creator-lab/creatorLabCopy.js";
import { formatStreamOffset, LIVE_NOTE_MAX_CHARS, logLiveHighlight, type LiveRefusal } from "@features/creator-lab/liveCaptureApi.js";

// ── /highlight [note] (Creator Lab live capture, 2026-11 item 284 Phase 3) ──
// Any member, in a channel an app linked with /creator-lab-live-link, marks the moment of the live
// stream for that app's highlight log. The server decides everything: which app (from the channel's
// link, never from the member), whether the linked Twitch channel is live, the member's cooldown and
// the stream's cap. It writes the row BEFORE it answers, so "Saved at 1:02:05" always means saved.
// Every answer is private; nothing posts in the channel, so a busy chat stays a chat.
//
// Additive and dark: behind CREATOR_LAB_LIVE_ENABLED (Risk R6), and it touches no existing flow.

export const data = new SlashCommandBuilder()
	.setName("highlight")
	.setDescription("Mark this moment of the live stream for the team's Creator Lab highlight log")
	.addStringOption((option) => option.setName("note").setDescription("What happened, in a few words").setMaxLength(LIVE_NOTE_MAX_CHARS).setRequired(false));

/** The private line for a refusal, worded for a highlight. */
export const highlightRefusalLine = (reason: LiveRefusal, retryAfterSeconds: number | null): string => {
	if (reason === "cooldown") return liveHighlightCopy.cooldown(retryAfterSeconds ?? 1);
	if (reason === "disabled") return liveHighlightCopy.unavailable;
	return liveHighlightCopy[reason];
};

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
	if (!creatorLabLiveEnabled) {
		await showNotice(interaction, { title: liveHighlightCopy.title, sections: [liveHighlightCopy.unavailable] });
		return;
	}
	if (!interaction.inGuild() || !interaction.channelId) {
		await showNotice(interaction, { title: liveHighlightCopy.title, sections: [liveHighlightCopy.guildOnly] });
		return;
	}
	// Deferred privately: the server may check Twitch before it answers, which can outlast 3 seconds.
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });
	const outcome = await logLiveHighlight(
		{ guildId: interaction.guildId, channelId: interaction.channelId, discordUserId: interaction.user.id },
		interaction.options.getString("note")
	);
	if (outcome.kind === "saved") {
		await interaction.editReply({ embeds: [infoEmbed(liveHighlightCopy.title, liveHighlightCopy.saved(formatStreamOffset(outcome.offsetSeconds)))] });
		return;
	}
	const line = highlightRefusalLine(outcome.reason, outcome.retryAfterSeconds);
	// Only a failure Dero cannot explain is an error; every other refusal is a state of the stream.
	const embed = outcome.reason === "unreachable" ? errorEmbed(line) : infoEmbed(liveHighlightCopy.title, line);
	await interaction.editReply({ embeds: [embed] });
}
