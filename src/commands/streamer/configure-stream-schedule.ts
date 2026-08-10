import {
	SlashCommandBuilder,
	ChatInputCommandInteraction,
	AutocompleteInteraction,
	PermissionFlagsBits,
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
import { refreshSchedule } from "@features/schedule/ScheduleBoard.js";
import { LOG_MESSAGES } from "@base/constants/log-messages.js";
import {
	parseFlexibleTime,
	nextOccurrenceInZone,
	isValidTimezone,
	searchTimezones,
} from "@utils/tzParser.js";

// ── /configure-stream-schedule ────────────────────────────────────────
// What:  creates a recurring weekly event on a fixed day + time of week
//        in the streamer's chosen timezone. Every 168 hours from the
//        first occurrence, the bot fires a reminder in the guild's
//        announcements channel pinging an optional role override
//        (defaults to the guild member role).
// Who:   streamers (or anyone running a weekly recurring stream / call).
//        Sibling to /configure-kvk-season, same primitive, simpler
//        input surface because the cadence is fixed at "weekly".
// When:  the streamer runs this once per recurring schedule. Re-running
//        with the same name short circuits with a "use /pause-schedule"
//        hint so two schedules never collide on a guild.
// Where: persists into the same Event collection as KvK events. Every
//        downstream system (ReminderScheduler, ScheduleBoard, Test
//        Reminder, /event-list) reads it without code changes, that
//        was the whole point of letting the data layer stay generic.
//        firstOccurrence is stored as UTC; Discord's <t:UNIX:F> renders
//        each viewer's local time so the timezone input affects only
//        the cadence anchor, not the render shape.
// How:   ① validate day + time + timezone; ② compute the next
//        occurrence as a UTC Date anchored on the user's chosen
//        timezone; ③ confirmation embed; ④ on confirm, eventStore.create
//        with type:"recurring", intervalHours:168, mentionRoleId:roleId,
//        paused:false; ⑤ kick a schedule board refresh.
//
// Time/timezone input contract:
//   - `time` accepts both 12h ("7pm", "7:30 pm", "9 am", "12am") and
//     24h ("19:30", "9:00", "9") formats. parseFlexibleTime in
//     tzParser.ts owns the regex.
//   - `timezone` is an IANA name ("America/New_York", "Europe/London",
//     "UTC"). Autocomplete surfaces a curated short-list first then
//     spills over to Intl.supportedValuesOf for the long tail. Default
//     is "UTC" if the streamer skips the option, which preserves the
//     pre-2026-04-25 behavior for any docs that say "all times are
//     UTC".

const c = rokCommanderCopy.streamSchedule;

// Day-of-week parsing. Accept full names; the option already constrains
// the choice list so this is a defensive map (case-insensitive in case
// the option ever loosens to a free string).
const DAY_TO_INDEX: Record<string, number> = {
	sunday: 0,
	monday: 1,
	tuesday: 2,
	wednesday: 3,
	thursday: 4,
	friday: 5,
	saturday: 6,
};

const DAY_LABEL: Record<number, string> = {
	0: "Sunday",
	1: "Monday",
	2: "Tuesday",
	3: "Wednesday",
	4: "Thursday",
	5: "Friday",
	6: "Saturday",
};

// Time parsing and timezone-aware next-occurrence math live in
// @utils/tzParser. parseFlexibleTime accepts the 12h/24h forms
// users actually type ("7pm", "7:30 pm", "19:30", "9", "12am"),
// nextOccurrenceInZone walks the cadence anchored on the user's
// timezone, and isValidTimezone is the validation gate before any
// Date math touches the input. Keeping that logic in tzParser
// instead of inline so a future "/configure-event-cadence" or
// similar command can reuse the same parser without duplication.

export const data = new SlashCommandBuilder()
	.setName("configure-stream-schedule")
	.setDescription("Set up a weekly stream / event reminder on a fixed day and time")
	.setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
	.addStringOption((option) =>
		option.setName("name").setDescription("Short label for this schedule (e.g. Friday Night Stream)").setRequired(true).setMaxLength(80)
	)
	.addStringOption((option) =>
		option
			.setName("day")
			.setDescription("Day of the week the stream happens")
			.setRequired(true)
			.addChoices(
				{ name: "Sunday", value: "sunday" },
				{ name: "Monday", value: "monday" },
				{ name: "Tuesday", value: "tuesday" },
				{ name: "Wednesday", value: "wednesday" },
				{ name: "Thursday", value: "thursday" },
				{ name: "Friday", value: "friday" },
				{ name: "Saturday", value: "saturday" }
			)
	)
	.addStringOption((option) =>
		option
			.setName("time")
			.setDescription("Start time, e.g. 7pm, 7:30 pm, 19:30, or 9 (12h or 24h, am/pm optional)")
			.setRequired(true)
	)
	.addStringOption((option) =>
		option
			.setName("timezone")
			.setDescription("Your timezone, e.g. America/New_York. Defaults to UTC if blank.")
			.setRequired(false)
			.setAutocomplete(true)
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

// ── autocomplete ──────────────────────────────────────────────
// What:  surface IANA timezone names matching the streamer's typed
//        input.
// Who:   Discord's autocomplete pipeline; main.ts dispatches to
//        this via the command registry's autocomplete export.
// When:  every keystroke in the timezone input.
// Where: only the `timezone` option uses autocomplete in this
//        command. Other options either have hardcoded choices
//        (day) or are free text (name, time, description).
// How:   defer to searchTimezones in tzParser. The returned array
//        is { name, value } pairs where name is the human-visible
//        zone string and value is the same string sent to execute().
//        Cap at 25, Discord rejects autocomplete responses larger
//        than that.
export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
	const focused = interaction.options.getFocused(true);
	if (focused.name !== "timezone") {
		// Defensive: future option additions might add their own
		// autocomplete; only respond when it's our zone option.
		await interaction.respond([]);
		return;
	}
	const matches = searchTimezones(focused.value, 25);
	await interaction.respond(matches.map((tz) => ({ name: tz, value: tz })));
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
	const guildId = interaction.guildId;
	if (!guildId) {
		// Slash commands inside DMs have no guild, this command only ever
		// makes sense inside a server. Discord's own permissioning blocks
		// most of this path but the explicit guard keeps the rest of the
		// function free of "what if guildId is null" branches.
		await interaction.reply({ embeds: [errorEmbed("Run this in a server, not a DM.")], flags: MessageFlags.Ephemeral });
		return;
	}

	// ── ① resolve channel + validate inputs ─────────────────────────
	// Same precondition as every other event-creating command: the guild
	// must have completed /setup so we know where reminders post. We also
	// look up GuildConfig to surface the fallback role in the confirmation
	// preview ("Pinging the guild member role").
	const config = await guildConfigStore.findByGuildId(guildId);
	if (!config?.announcementsChannelId) {
		await interaction.reply({ embeds: [errorEmbed(c.setupRequired)], flags: MessageFlags.Ephemeral });
		return;
	}

	const name = interaction.options.getString("name", true).trim();
	const dayRaw = interaction.options.getString("day", true).toLowerCase();
	const timeRaw = interaction.options.getString("time", true);
	// Default to UTC when the streamer leaves the timezone blank. This
	// preserves the pre-2026-04-25 contract where every time was UTC,
	// so any guild that had docs/runbook entries pointing at "type your
	// time in UTC" continues to work without changes.
	const timezoneRaw = interaction.options.getString("timezone", false)?.trim() || "UTC";
	const mentionRole = interaction.options.getRole("mention-role", false);
	const description = interaction.options.getString("description", false)?.trim() ?? "";

	const dayIndex = DAY_TO_INDEX[dayRaw];
	if (dayIndex === undefined) {
		await interaction.reply({ embeds: [errorEmbed(c.invalidDay)], flags: MessageFlags.Ephemeral });
		return;
	}

	const time = parseFlexibleTime(timeRaw);
	if (!time) {
		await interaction.reply({ embeds: [errorEmbed(c.invalidTime)], flags: MessageFlags.Ephemeral });
		return;
	}

	// Validate timezone before any Date math touches it. We never
	// trust an autocomplete pick blindly because Discord lets users
	// type-and-submit a value that wasn't in the suggestion list.
	if (!isValidTimezone(timezoneRaw)) {
		await interaction.reply({
			embeds: [errorEmbed(`Unknown timezone: \`${timezoneRaw}\`. Try names like \`America/New_York\`, \`Europe/London\`, or \`UTC\`.`)],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	// Duplicate-name guard. Active events only, a soft-deleted event with
	// the same name is allowed to be re-created (the streamer probably
	// retired the old schedule on purpose). Comparison is case-insensitive
	// so "Friday Night Stream" and "friday night stream" do not coexist.
	const existing = await eventStore.findByGuildId(guildId);
	if (existing.some((e) => e.name.toLowerCase() === name.toLowerCase())) {
		await interaction.reply({ embeds: [errorEmbed(c.alreadyExists(name))], flags: MessageFlags.Ephemeral });
		return;
	}

	// ── ② compute next occurrence ──────────────────────────────────
	// nextOccurrenceInZone is the timezone-aware replacement for the
	// old nextOccurrenceUtc helper. The returned Date is still UTC
	// (storage contract is unchanged) but the cadence anchor honors
	// the streamer's chosen timezone. Default UTC is preserved when
	// the streamer skipped the option.
	const firstOccurrence = nextOccurrenceInZone(dayIndex, time.hour, time.minute, timezoneRaw);
	const firstOccurrenceUnix = Math.floor(firstOccurrence.getTime() / 1000);
	const mentionRoleId = mentionRole?.id ?? null;

	// ── ③ confirmation embed ───────────────────────────────────────
	// Two-line preview: cadence + next fire, plus the audience line so
	// the streamer sees the role + channel before clicking save. Using
	// MessageFlags.Ephemeral so the preview does not clutter the channel
	// where the command was run. Timezone is rendered alongside the
	// cadence so the streamer can sanity-check that "Friday 7pm" got
	// interpreted in the zone they meant.
	const previewLines = [
		c.confirm.description(name, DAY_LABEL[dayIndex], firstOccurrenceUnix),
		`Timezone: \`${timezoneRaw}\``,
		"",
		c.confirm.audienceLine(mentionRoleId ?? config.memberRoleId ?? null, config.announcementsChannelId),
	];

	const confirmEmbed = new EmbedBuilder()
		.setTitle(c.confirm.title)
		.setDescription(previewLines.join("\n"))
		.setColor(rokCommanderCopy.COLORS.SCHEDULE);

	const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder().setCustomId("stream_confirm").setLabel(c.confirm.confirmButtonLabel).setStyle(ButtonStyle.Success),
		new ButtonBuilder().setCustomId("stream_cancel").setLabel(c.confirm.cancelButtonLabel).setStyle(ButtonStyle.Secondary)
	);

	const confirmMessage = await interaction.reply({
		embeds: [confirmEmbed],
		components: [row],
		flags: MessageFlags.Ephemeral,
	});

	// ── ④ wait for confirm / cancel ─────────────────────────────────
	try {
		const press = await confirmMessage.awaitMessageComponent({
			componentType: ComponentType.Button,
			time: 120_000,
			// Defensive filter: only the streamer who ran the command can
			// resolve their own ephemeral. Discord scopes this already since
			// the message is ephemeral, but the explicit user check is cheap
			// insurance.
			filter: (i) => i.user.id === interaction.user.id,
		});

		if (press.customId === "stream_cancel") {
			await press.update({ embeds: [errorEmbed(c.cancelled)], components: [] });
			return;
		}

		// confirmed, persist
		try {
			await eventStore.create({
				name,
				description,
				type: "recurring",
				intervalHours: 168, // weekly
				firstOccurrence,
				guildId,
				prepSteps: [],
				active: true,
				mentionRoleId,
				paused: false,
				// seasonEnd intentionally omitted, streamer schedules have
				// no season scope. Schema default is null, ScheduleBoard +
				// ReminderScheduler treat null as "no auto archive".
			});

			await press.update({
				embeds: [new EmbedBuilder().setDescription(c.saved(name)).setColor(rokCommanderCopy.COLORS.SCHEDULE)],
				components: [],
			});

			// Fire and forget, schedule board refresh failure must not
			// undo the successful save. Same pattern as the events route.
			refreshSchedule(interaction.client, guildId).catch((err) =>
				console.error(LOG_MESSAGES.schedule.refreshAfterRouteFailed("/configure-stream-schedule"), err)
			);
		} catch (err) {
			console.error("[configure-stream-schedule] save failed", err);
			await press.update({ embeds: [errorEmbed(c.saveFailed)], components: [] });
		}
	} catch {
		// awaitMessageComponent rejects on timeout. Editing the original
		// reply (instead of replying again) keeps the audit trail tidy:
		// the streamer sees one ephemeral message that walked through
		// preview → timed out.
		await interaction.editReply({ embeds: [errorEmbed(c.timedOut)], components: [] });
	}
}
