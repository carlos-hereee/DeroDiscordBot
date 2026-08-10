import {
	SlashCommandBuilder,
	ChatInputCommandInteraction,
	PermissionFlagsBits,
	MessageFlags,
} from "discord.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { errorEmbed } from "@utils/embedBuilder.js";
import { postGoLiveAnnouncement } from "@features/schedule/postGoLiveAnnouncement.js";

// ── /go-live-soon ─────────────────────────────────────────────────────
// What:  one-shot panic-button announcement. Does NOT create an Event.
//        Posts directly to the guild's announcements channel with a
//        single embed pinging the configured role (or an override).
//        Lead-time choices map to fixed minute deltas so the embed can
//        render an honest "stream starts at <t:UNIX:t>" timestamp.
// Who:   streamers who forgot to pre-announce. Discord communities
//        notice when a streamer goes live without a heads-up; this is
//        the 30-second escape hatch that fixes that.
// When:  on demand, ad-hoc. No persistence, if the streamer wants
//        recurring reminders they should run /configure-stream-schedule.
//        Two /go-live-soon calls in a row will produce two separate
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

export const data = new SlashCommandBuilder()
	.setName("go-live-soon")
	.setDescription("Post a quick going-live announcement (one-shot, no recurring reminder)")
	.setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
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

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
	const guildId = interaction.guildId;
	if (!guildId) {
		await interaction.reply({ embeds: [errorEmbed("Run this in a server, not a DM.")], flags: MessageFlags.Ephemeral });
		return;
	}

	const whenKey = interaction.options.getString("when", true);
	const note = interaction.options.getString("note", false)?.trim() || null;
	const mentionRole = interaction.options.getRole("mention-role", false);
	const mentionRoleIdOverride = mentionRole?.id ?? null;

	const result = await postGoLiveAnnouncement(interaction.client, guildId, whenKey, note, mentionRoleIdOverride);

	if (result.ok) {
		await interaction.reply({ content: c.posted, flags: MessageFlags.Ephemeral });
		return;
	}

	// Map the discriminated reason back to the pack copy. Discord's
	// option choices constrain whenKey at the API boundary so the
	// invalid-lead-time branch is defensive only, but the helper still
	// returns it for callers (eg the button) that might pass arbitrary
	// strings in the future.
	const errorMsg =
		result.reason === "setup-required"
			? c.setupRequired
			: result.reason === "invalid-lead-time"
				? c.invalidLeadTime
				: c.postFailed;

	await interaction.reply({
		embeds: [errorEmbed(errorMsg)],
		flags: MessageFlags.Ephemeral,
	});
}
