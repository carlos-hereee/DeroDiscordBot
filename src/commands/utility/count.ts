import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { creatorLabLiveEnabled } from "@utils/config.js";
import { errorEmbed, infoEmbed } from "@utils/embedBuilder.js";
import { showNotice } from "@utils/textModal.js";
import { liveCountCopy } from "@features/creator-lab/creatorLabCopy.js";
import {
	COUNTER_NAME_MAX_CHARS,
	formatStreamOffset,
	LIVE_NOTE_MAX_CHARS,
	logLiveCount,
	type LiveRefusal,
} from "@features/creator-lab/liveCaptureApi.js";

// ── /count name [note] (Creator Lab live capture, 2026-11 item 284 Phase 3) ──
// Any member, in a channel an app linked with /creator-lab-live-link, bumps a named counter ("death",
// "pog") at this moment of the live stream, and Dero privately answers the stream's new total. The
// server normalizes the name exactly like a manual +1 in the logger ("Death" and " DEATH " are one
// counter); there is no "did you mean" here, because a private answer cannot ask a question, so a near
// name is stored as typed and the team merges it after the stream. The row is written before the
// answer, like /highlight; the cooldown is per member PER COUNTER, so bumping two counters is fine.
//
// Additive and dark: behind CREATOR_LAB_LIVE_ENABLED (Risk R6), and it touches no existing flow.

export const data = new SlashCommandBuilder()
	.setName("count")
	.setDescription("Add one to a counter for this live stream, like deaths or pogs")
	.addStringOption((option) => option.setName("name").setDescription("The counter, like death or pog").setMaxLength(COUNTER_NAME_MAX_CHARS).setRequired(true))
	.addStringOption((option) => option.setName("note").setDescription("What happened, in a few words").setMaxLength(LIVE_NOTE_MAX_CHARS).setRequired(false));

/** The private line for a refusal, worded for a counter. */
export const countRefusalLine = (reason: LiveRefusal, retryAfterSeconds: number | null): string => {
	if (reason === "cooldown") return liveCountCopy.cooldown(retryAfterSeconds ?? 1);
	if (reason === "disabled") return liveCountCopy.unavailable;
	return liveCountCopy[reason];
};

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
	if (!creatorLabLiveEnabled) {
		await showNotice(interaction, { title: liveCountCopy.title, sections: [liveCountCopy.unavailable] });
		return;
	}
	if (!interaction.inGuild() || !interaction.channelId) {
		await showNotice(interaction, { title: liveCountCopy.title, sections: [liveCountCopy.guildOnly] });
		return;
	}
	// Deferred privately: the server may check Twitch before it answers, which can outlast 3 seconds.
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });
	const outcome = await logLiveCount(
		{ guildId: interaction.guildId, channelId: interaction.channelId, discordUserId: interaction.user.id },
		interaction.options.getString("name", true),
		interaction.options.getString("note")
	);
	if (outcome.kind === "counted") {
		await interaction.editReply({
			embeds: [infoEmbed(liveCountCopy.title, liveCountCopy.counted(outcome.counterName, outcome.count, formatStreamOffset(outcome.offsetSeconds)))],
		});
		return;
	}
	const line = countRefusalLine(outcome.reason, outcome.retryAfterSeconds);
	// Only a failure Dero cannot explain is an error; every other refusal is a state of the stream.
	const embed = outcome.reason === "unreachable" ? errorEmbed(line) : infoEmbed(liveCountCopy.title, line);
	await interaction.editReply({ embeds: [embed] });
}
