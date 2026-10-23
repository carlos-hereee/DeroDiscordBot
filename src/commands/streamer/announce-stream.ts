import {
	SlashCommandBuilder,
	ChatInputCommandInteraction,
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ComponentType,
	MessageFlags,
	EmbedBuilder,
} from "discord.js";
import { eventStore } from "@db/stores/eventStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { errorEmbed } from "@utils/embedBuilder.js";
import { parseEventDateTimeMinutes } from "@utils/dateParser.js";
import { refreshSchedule } from "@features/schedule/ScheduleBoard.js";
import { LOG_MESSAGES } from "@base/constants/log-messages.js";

// ── /announce-stream ──────────────────────────────────────────────────
// What:  schedules a one-time stream announcement at a specific future
//        date+time. Creates a one-time Event so the existing
//        ReminderScheduler fires the standard reminder offsets (default
//        30 and 15 min before) automatically, no special-case logic
//        needed downstream.
// Who:   streamers planning a one-off (charity stream, special guest,
//        scheduled premiere). Pairs with /go-live-soon for the
//        forgot-to-announce case and /configure-stream-schedule for
//        recurring weekly cadence.
// When:  on demand. The streamer types the date once, the bot handles
//        the reminders. After the stream the event auto-deactivates
//        (one-time event handling in ReminderScheduler already does
//        this, we get it for free).
// Where: writes a one-time Event into the same collection as KvK and
//        weekly stream events. ScheduleBoard renders it next to other
//        active events with no special casing.
// How:   ① parse + validate the date (must be in the future); ②
//        confirmation embed; ③ on confirm, eventStore.create with
//        type:"one-time"; ④ kick a schedule board refresh.

const c = rokCommanderCopy.announceStream;

export const data = new SlashCommandBuilder()
	.setName("announce-stream")
	.setDescription("Schedule a one-off stream announcement at a specific future date/time")
	.addStringOption((option) =>
		option.setName("title").setDescription("Stream title (e.g. Charity Stream, Patch Day)").setRequired(true).setMaxLength(80)
	)
	.addStringOption((option) =>
		option.setName("when-utc").setDescription("Date and time in UTC, format MM/DD @HH:MM (e.g. 04/26 @19:30)").setRequired(true)
	)
	.addRoleOption((option) =>
		option
			.setName("mention-role")
			.setDescription("Role to ping when reminders fire (defaults to the guild member role)")
			.setRequired(false)
	)
	.addStringOption((option) =>
		option
			.setName("description")
			.setDescription("Optional one-liner shown in the reminder embed")
			.setRequired(false)
			.setMaxLength(500)
	);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
	const guildId = interaction.guildId;
	if (!guildId) {
		await interaction.reply({ embeds: [errorEmbed("Run this in a server, not a DM.")], flags: MessageFlags.Ephemeral });
		return;
	}

	const config = await guildConfigStore.findByGuildId(guildId);
	if (!config?.announcementsChannelId) {
		await interaction.reply({ embeds: [errorEmbed(c.setupRequired)], flags: MessageFlags.Ephemeral });
		return;
	}

	const title = interaction.options.getString("title", true).trim();
	const whenRaw = interaction.options.getString("when-utc", true);
	const mentionRole = interaction.options.getRole("mention-role", false);
	const description = interaction.options.getString("description", false)?.trim() ?? "";

	// Parse + validate. Past dates are rejected outright, a one-time
	// event whose firstOccurrence is already in the past would never
	// fire (ReminderScheduler's diff-window check skips negative diffs)
	// so accepting it would silently swallow the streamer's input.
	const startDate = parseEventDateTimeMinutes(whenRaw);
	if (!startDate) {
		await interaction.reply({ embeds: [errorEmbed(c.invalidDateTime)], flags: MessageFlags.Ephemeral });
		return;
	}
	if (startDate.getTime() <= Date.now()) {
		await interaction.reply({ embeds: [errorEmbed(c.dateInPast)], flags: MessageFlags.Ephemeral });
		return;
	}

	const startUnix = Math.floor(startDate.getTime() / 1000);
	const mentionRoleId = mentionRole?.id ?? null;

	// ── confirmation preview ──
	// Same two-line pattern as /configure-stream-schedule so the streamer
	// sees a familiar form: when + where + who. Color reuses SCHEDULE so
	// the preview matches the eventual schedule board entry.
	const previewLines = [
		c.confirm.description(title, startUnix),
		"",
		c.confirm.audienceLine(mentionRoleId ?? config.memberRoleId ?? null, config.announcementsChannelId),
	];

	const confirmEmbed = new EmbedBuilder()
		.setTitle(c.confirm.title)
		.setDescription(previewLines.join("\n"))
		.setColor(rokCommanderCopy.COLORS.SCHEDULE);

	const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder().setCustomId("announce_confirm").setLabel(c.confirm.confirmButtonLabel).setStyle(ButtonStyle.Success),
		new ButtonBuilder().setCustomId("announce_cancel").setLabel(c.confirm.cancelButtonLabel).setStyle(ButtonStyle.Secondary)
	);

	const confirmMessage = await interaction.reply({
		embeds: [confirmEmbed],
		components: [row],
		flags: MessageFlags.Ephemeral,
	});

	try {
		const press = await confirmMessage.awaitMessageComponent({
			componentType: ComponentType.Button,
			time: 120_000,
			filter: (i) => i.user.id === interaction.user.id,
		});

		if (press.customId === "announce_cancel") {
			await press.update({ embeds: [errorEmbed(c.cancelled)], components: [] });
			return;
		}

		// confirmed, persist as a one-time event. intervalHours is set
		// to a sentinel-ish value (1) because the schema requires it and
		// the recurring math is ignored for type:"one-time" events. The
		// scheduler reads firstOccurrence directly for one-time fires.
		try {
			await eventStore.create({
				name: title,
				description,
				type: "one-time",
				intervalHours: 1, // unused for one-time events but required by schema
				firstOccurrence: startDate,
				guildId,
				prepSteps: [],
				active: true,
				mentionRoleId,
				paused: false,
			});

			await press.update({
				embeds: [new EmbedBuilder().setDescription(c.saved(title)).setColor(rokCommanderCopy.COLORS.SCHEDULE)],
				components: [],
			});

			refreshSchedule(interaction.client, guildId).catch((err) =>
				console.error(LOG_MESSAGES.schedule.refreshAfterRouteFailed("/announce-stream"), err)
			);
		} catch (err) {
			console.error("[announce-stream] save failed", err);
			await press.update({ embeds: [errorEmbed(c.saveFailed)], components: [] });
		}
	} catch {
		await interaction.editReply({ embeds: [errorEmbed(c.timedOut)], components: [] });
	}
}
