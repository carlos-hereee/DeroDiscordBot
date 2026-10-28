import { type RepliableInteraction, type SlashCommandSubcommandBuilder } from "discord.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { postGoLiveAnnouncement, type TGoLiveResult } from "@features/schedule/postGoLiveAnnouncement.js";
import type { CommandOptionReader } from "@handlers/commandOptions.js";
import { showErrorNotice, showNotice } from "@utils/textModal.js";
import { getPluginCopy } from "@base/copy/getCopy.js";
import { answerInChannel } from "@utils/answerInChannel.js";

// ── /events stream soon ─────────────────────────────────────────────────────
// What:  one-shot panic-button announcement. Does NOT create an Event.
//        Posts directly to the guild's announcements channel with a
//        single embed pinging the configured role (or an override).
//        Lead-time choices map to fixed minute deltas so the embed can
//        render an honest "stream starts at <t:UNIX:t>" timestamp.
// Who:   streamers who forgot to pre-announce. Discord communities
//        notice when a streamer goes live without a heads-up; this is
//        the 30-second escape hatch that fixes that.
// When:  on demand, ad-hoc. No persistence, if the streamer wants
//        recurring reminders they should run /events stream weekly.
//        Two /events stream soon calls in a row will produce two separate
//        announcement messages on purpose: each one is a fresh "now-ish"
//        signal, not an edit of the previous.
// Where: posts to guildConfig.announcementsChannelId. Same channel that
//        ReminderJob and TestReminderJob target, the home base
//        announcements channel is the single source of truth for outward
//        bot communication.
// How:   the actual channel resolution + embed composition + allowed-
//        mentions discipline lives in postGoLiveAnnouncement so the
//        schedule channel's Go Live Now button shares the same code
//        path. This handler only parses the slash command inputs and
//        acks the interaction.

const c = rokCommanderCopy.goLiveSoon;

/** Why a go live post did not happen. */
type GoLiveRefusal = Extract<TGoLiveResult, { ok: false }>["reason"];

/** The options this handler reads, added to the merged command's subcommand. */
export function addGoLiveSoonOptions(sub: SlashCommandSubcommandBuilder): SlashCommandSubcommandBuilder {
	return sub
		.addStringOption((option) =>
			option
				.setName("when")
				.setDescription("When does the stream start?")
				.setRequired(true)
				.addChoices(
					{ name: "Now", value: "now" },
					{ name: "In 10 minutes", value: "10m" },
					{ name: "In 30 minutes", value: "30m" },
					{ name: "In 1 hour", value: "1h" },
					{ name: "In 3 hours", value: "3h" },
					{ name: "In 6 hours", value: "6h" }
				)
		)
		.addStringOption((option) =>
			option.setName("note").setDescription("Optional one-liner (game, what you're doing, etc)").setRequired(false).setMaxLength(500)
		)
		.addRoleOption((option) =>
			option
				.setName("mention-role")
				.setDescription("Role to ping for this announcement (defaults to the guild member role)")
				.setRequired(false)
		);
}

export async function goLiveSoon(interaction: RepliableInteraction, options: CommandOptionReader): Promise<void> {
	const guildId = interaction.guildId;
	if (!guildId) {
		await showNotice(interaction, { title: getPluginCopy(null).notice.schedule, sections: ["Run this in a server, not a DM."] });
		return;
	}

	const whenKey = options.getString("when", true);
	const note = options.getString("note", false)?.trim() || null;
	const mentionRole = options.getRole("mention-role", false);
	const mentionRoleIdOverride = mentionRole?.id ?? null;

	const result = await postGoLiveAnnouncement(interaction.client, guildId, whenKey, note, mentionRoleIdOverride);

	if (result.ok) {
		// A confirmation of work done is an answer, so it posts in 🛠️server-config and pings the admin who ran it (owner rule 1, 2026-10 item 263 R3-11).
		await answerInChannel(interaction, "admin", { content: c.posted });
		return;
	}

	// Discord's option choices constrain whenKey at the API boundary, so the
	// invalid-lead-time branch is defensive only, but the helper still returns it for
	// callers (eg the button) that might pass arbitrary strings in the future.
	await answerGoLiveRefusal(interaction, result.reason);
}

/**
 * A go live post that did not happen: a missing setup or a lead time no choice offers is a
 * state, a notice titled Schedule; only a post Discord refused is a failure and keeps the
 * error title (owner rule 1). Shared by /events stream soon and the board's Go live now.
 */
export async function answerGoLiveRefusal(interaction: RepliableInteraction, reason: GoLiveRefusal): Promise<void> {
	if (reason === "post-failed") {
		await showErrorNotice(interaction, c.postFailed);
		return;
	}
	const message = reason === "setup-required" ? c.setupRequired : c.invalidLeadTime;
	await showNotice(interaction, { title: getPluginCopy(null).notice.schedule, sections: [message] });
}
