import { EmbedBuilder, ColorResolvable } from "discord.js";
import { IGameEvent, IPrepStep } from "@features/events/event.types.js";
import { getPluginCopy, type ICopyConfig } from "@base/copy/getCopy.js";
import type { IPluginCopy } from "@base/copy/types.js";

// ── plugin-aware copy ─────────────────────────────────────────────────
// Every builder takes an optional `guildConfig` and resolves its copy through
// getPluginCopy(guildConfig): non-ROK guilds (pluginId !== "rok-commander")
// render the neutral general-events pack, ROK guilds keep the kingdom voice.
// guildConfig is optional and defaults to undefined, which getPluginCopy
// resolves to the rok-commander pack, so a caller that has not been threaded
// yet behaves exactly as it did before the plugin-copy migration: the
// rok-commander default.

interface IListEventField {
	name: string;
	type: "recurring" | "one-time";
	nextOccurrenceTs: number; // unix seconds
	intervalHours: number | null; // null for one-time
	// unix seconds. null for regular announcements that opted out of the
	// KvK season scope (announcementType "regular"). The list embed hides
	// the "Season ends" line for those rows entirely.
	seasonEndTs: number | null;
	// Paused state mirrors the schedule board: when true the row gets a
	// "⏸️ paused" tag in the field name and a reminder body line. v1.5.1
	// added this so /events list stops misrepresenting paused events as
	// active. Optional so existing callers that do not surface pause state
	// continue to compile.
	paused?: boolean;
	// unix seconds. null for indefinite pauses; set when the streamer
	// passed `days:N` to /events pause so the row can show an auto-resume
	// timestamp instead of leaving readers guessing when reminders return.
	pausedUntilTs?: number | null;
}

export function listEventsEmbed(
	fields: IListEventField[],
	announcementsChannelId: string | null = null,
	guildConfig?: ICopyConfig | null
): EmbedBuilder {
	const copy = getPluginCopy(guildConfig);
	const c = copy.listEvents;
	// the destination channel is the same for every event in the guild, so it
	// renders once in the embed description instead of being repeated per row.
	// an unset value (guild has not finished /setup) is treated as a soft warning.
	const description = announcementsChannelId ? c.postedToHeader(announcementsChannelId) : c.postedToHeaderUnset;
	const embed = base(guildConfig).setTitle(c.title).setDescription(description).setColor(copy.COLORS.SCHEDULE);

	for (const field of fields) {
		const lines: string[] = [];
		const occurrenceLabel = field.type === "recurring" ? c.nextOccurrenceLabel : c.scheduledDateLabel;

		// Paused rows lead with the pause notice and skip the next-occurrence
		// line entirely. Pairing "paused" with a fire time was misleading,
		// admins read it as "still firing at X". The interval line is also
		// suppressed for the same reason (cadence is meaningless while paused).
		// Mirrors the schedule board's pause vocabulary so the two surfaces
		// stay consistent.
		if (field.paused) {
			lines.push("⏸️ _Reminders paused, resume with `/events resume`_");
			if (field.pausedUntilTs !== null && field.pausedUntilTs !== undefined) {
				// relative + absolute so the admin can scan "in 3 days" without
				// doing timezone math, then confirm the exact moment.
				lines.push(`**Auto-resumes:** <t:${field.pausedUntilTs}:R> · <t:${field.pausedUntilTs}:f>`);
			}
		} else {
			lines.push(`**${occurrenceLabel}:** <t:${field.nextOccurrenceTs}:F>`);
			if (field.type === "recurring" && field.intervalHours !== null) {
				lines.push(c.intervalLabel(field.intervalHours));
			}
		}
		// Regular announcements skip the "Season ends" line. See IScheduleField
		// notes, same reasoning, the embed must not render "Invalid Date"
		// when the field is null.
		if (field.seasonEndTs !== null) {
			lines.push(`**${c.seasonEndLabel}:** <t:${field.seasonEndTs}:D>`);
		}

		const headerName = field.paused
			? `${c.fieldName(field.name, field.type)} · ⏸️ paused`
			: c.fieldName(field.name, field.type);
		embed.addFields({ name: headerName, value: lines.join("\n"), inline: false });
	}

	return embed;
}

// ── private ───────────────────────────────────────────────────
function base(guildConfig?: ICopyConfig | null): EmbedBuilder {
	// Dero as the author brands every embed at once (the single chokepoint all
	// embed builders flow through). The icon 404s gracefully to name-only until
	// the web app deploys the PNG, so this is safe to ship ahead of that. AUTHOR
	// and FOOTER are identical across packs today, but resolving through the
	// pack keeps the chokepoint honest if a pack ever diverges.
	const copy = getPluginCopy(guildConfig);
	return new EmbedBuilder()
		.setTimestamp()
		.setAuthor({ name: copy.AUTHOR.name, iconURL: copy.AUTHOR.iconURL })
		.setFooter({ text: copy.FOOTER });
}

// ── public ────────────────────────────────────────────────────
export function reminderEmbed(
	event: IGameEvent,
	occurrence: Date,
	offsetMinutes: number,
	imageUrl: string | null = null,
	guildConfig?: ICopyConfig | null
): EmbedBuilder {
	const copy = getPluginCopy(guildConfig);
	const c = copy.reminder;
	const embed = base(guildConfig)
		.setTitle(c.title(event.name, offsetMinutes))
		.setDescription(c.description)
		.setColor(copy.COLORS.REMINDER)
		.addFields(
			{
				name: c.checklistField,
				value: (event.prepSteps as IPrepStep[])
					.sort((a, b) => a.order - b.order)
					.map((step, i) => `${i + 1}. ${step.label}`)
					.join("\n"),
			},
			{
				name: c.timeField,
				value: `<t:${Math.floor(occurrence.getTime() / 1000)}:F>`,
			}
		);
	// Reminders use a small corner thumbnail (the large banner is reserved for
	// go-live and decree posts). Guard so a null image is a clean no-op and an
	// event with no image and no guild default posts exactly as before.
	if (imageUrl) embed.setThumbnail(imageUrl);
	return embed;
}
// ── test reminder embed ──
// dispatched from the admin dashboard as a drill.
// renders the same checklist + time fields as reminderEmbed so admins can
// verify prep step formatting end to end, but prefixes the title with [TEST]
// so Mortals instantly know it is not a real alert.
export function testReminderEmbed(event: IGameEvent, nextOccurrence: Date, guildConfig?: ICopyConfig | null): EmbedBuilder {
	const copy = getPluginCopy(guildConfig);
	const c = copy.testReminder;
	return base(guildConfig)
		.setTitle(c.title(event.name))
		.setDescription(c.description)
		.setColor(copy.COLORS.REMINDER)
		.addFields(
			{
				name: c.checklistField,
				value: (event.prepSteps as IPrepStep[])
					.sort((a, b) => a.order - b.order)
					.map((step, i) => `${i + 1}. ${step.label}`)
					.join("\n"),
			},
			{
				name: c.timeField,
				value: `<t:${Math.floor(nextOccurrence.getTime() / 1000)}:F>`,
			}
		);
}

// ── season end embed ──
export function seasonEndEmbed(guildConfig?: ICopyConfig | null): EmbedBuilder {
	const copy = getPluginCopy(guildConfig);
	const c = copy.seasonEnd;
	return base(guildConfig).setTitle(c.title).setDescription(c.description).setColor(copy.COLORS.SEASON_END);
}

// ── schedule board embed ──
// rendered into the pinned message in the event-schedule channel. three
// states: season ended, no events configured, or a roster of events split
// into an active block + an optional "completed this season" block at the
// bottom. the caller resolves the events + the guild's announcements
// channel id + the canonical season anchor so this function stays pure.
export interface IScheduleField {
	name: string;
	type: "recurring" | "one-time";
	// unix seconds. null when the event has no remaining future occurrences
	// (one-time event already in the past, but still active).
	nextOccurrenceTs: number | null;
	intervalHours: number | null;
	// unix seconds. null for regular announcements that opted out of the
	// KvK season scope (announcementType "regular"). Retained because
	// upstream (ScheduleBoard.toField) still computes it cheaply, but the
	// schedule embed no longer renders a per-row season-end line, the
	// banner moved to the description (see options.guildSeasonEndTs).
	seasonEndTs: number | null;
	// when true, the row renders with a "paused" tag in the field name and a
	// short "Reminders paused" line in the body. Caller (ScheduleBoard.toField)
	// reads event.paused directly so the board reflects the live DB state on
	// every refresh tick.
	paused?: boolean;
	// unix seconds for the original firstOccurrence date. For one-time
	// events this is the only date the event ever fires on; for recurring
	// events it anchors the cadence. Used by the completed block to render
	// the "Concluded" date once a one-time occurrence is in the past.
	firstOccurrenceTs: number;
	// True iff the event is one-time AND its firstOccurrence is in the past.
	// Recurring events are never completed within a live season, they
	// recur forever until the season closes. The caller (ScheduleBoard.toField)
	// computes this against Date.now() at refresh time so the partition
	// reflects the moment the embed renders.
	isCompleted: boolean;
}

export function scheduleBoardEmbed(
	fields: IScheduleField[],
	announcementsChannelId: string | null,
	options: { seasonEnded?: boolean; guildSeasonEndTs?: number | null } = {},
	guildConfig?: ICopyConfig | null
): EmbedBuilder {
	const copy = getPluginCopy(guildConfig);
	const c = copy.scheduleBoard;
	const embed = base(guildConfig).setTitle(c.title).setColor(copy.COLORS.SCHEDULE).setFooter({ text: c.footer });

	if (options.seasonEnded) {
		return embed.setDescription(c.seasonEnded).setColor(copy.COLORS.SEASON_END);
	}

	if (fields.length === 0) {
		return embed.setDescription(c.noEvents);
	}

	// ── description: greeting + bolded season-end banner ──
	// What:  the season anchor renders ONCE at the top so the eye lands on
	//        it before scanning the per-event roster. Per-row season-end
	//        lines were dropped, every event in a guild shares the same
	//        seasonEnd, so repeating it on N rows was noise.
	// Who:   read by every warrior in the alliance (channel is public).
	// When:  guildSeasonEndTs is provided when the guild has at least one
	//        KvK event with a seasonEnd. A null/undefined value signals a
	//        regular-announcements-only guild and the banner is omitted.
	// How:   single newline-separated paragraph appended to the existing
	//        greeting so the channel callout and the season banner stay
	//        visually adjacent at the top of the embed.
	const greeting = c.description(announcementsChannelId);
	const seasonEndLine =
		options.guildSeasonEndTs !== undefined && options.guildSeasonEndTs !== null
			? `\n\n**${c.seasonEndTopLabel}:** <t:${options.guildSeasonEndTs}:D>`
			: "";
	embed.setDescription(`${greeting}${seasonEndLine}`);

	// Partition into active (current/future) and completed (one-time, past).
	// Active block keeps the order received from the caller (sorted ascending
	// by nextOccurrenceTs in ScheduleBoard.refreshSchedule). Completed block
	// re-sorts descending by firstOccurrenceTs so the most recently concluded
	// event leads, that's the row a returning warrior is most likely to want.
	//
	// ── field count audit (2026-04-27) ──
	//   typical KvK guild: 6 active + 1 heading + 4 completed = 11 fields
	//   Discord cap: 25 fields per embed, 6000 chars total per embed
	//   Headroom is more than 2x today. If a future feature pushes the
	//   roster past ~15 active rows, re-audit before shipping, the 25-field
	//   cap is silent (Discord drops overflow without an error).
	const active = fields.filter((f) => !f.isCompleted);
	const completed = fields.filter((f) => f.isCompleted).sort((a, b) => b.firstOccurrenceTs - a.firstOccurrenceTs);

	for (const field of active) {
		embed.addFields(buildActiveField(field, c));
	}

	if (completed.length > 0) {
		// ── single-field completed section ──
		// What:  collapse the heading + every completed entry into ONE
		//        Discord embed field. The heading becomes the field name
		//        (rendered bold) and all entries are concatenated into
		//        the field value, separated by blank lines.
		// Who:   readers of the schedule board. The previous layout split
		//        the heading into its own field with an empty value,
		//        which made Discord stack two field-gaps under the
		//        heading (one for the empty value, one for the field
		//        separator). The visual effect was a heading that looked
		//        attached to the active block above it instead of the
		//        completed entries below it.
		// When:  every refresh that has at least one completed event.
		//        Skipped entirely when completed.length === 0 so guilds
		//        with no concluded events do not get an empty field.
		// Where: pairs with buildCompletedLine below, the line builder
		//        is now plain text with markdown bolding (since the
		//        field-name auto-bold is gone), not a full Discord field.
		// How:   join entries with `\n\n` so each entry is visually
		//        separated by a blank line but still inside the same
		//        field, which Discord renders without an additional gap.
		const completedValue = completed.map((field) => buildCompletedLine(field, c)).join("\n\n");
		embed.addFields({
			name: c.completedSectionTitle,
			value: completedValue,
			inline: false,
		});
	}

	return embed;
}

// ── private: scheduleBoardEmbed row builders ──

function buildActiveField(field: IScheduleField, c: IPluginCopy["scheduleBoard"]): { name: string; value: string; inline: false } {
	const lines: string[] = [];
	const occurrenceLabel = field.type === "recurring" ? c.nextOccurrenceLabel : c.scheduledDateLabel;

	// Paused rows lead with the pause notice so the eye lands on it before
	// the timestamps. The next-occurrence math still runs (occurrences are
	// pure schedule arithmetic) but readers should treat them as "would have
	// fired" not "will fire".
	if (field.paused) {
		lines.push("⏸️ _Reminders paused, resume with `/events resume`_");
	}

	if (field.nextOccurrenceTs !== null) {
		// both relative ("in 2 hours") and full date, so Mortals in any
		// timezone see a correct local time.
		lines.push(`**${occurrenceLabel}:** <t:${field.nextOccurrenceTs}:R> · <t:${field.nextOccurrenceTs}:f>`);
	} else {
		lines.push(`**${occurrenceLabel}:** _awaiting next season_`);
	}

	if (field.type === "recurring" && field.intervalHours !== null) {
		lines.push(c.intervalLabel(field.intervalHours));
	}

	const headerName = field.paused ? `${c.fieldName(field.name, field.type)} · ⏸️ paused` : c.fieldName(field.name, field.type);
	return { name: headerName, value: lines.join("\n"), inline: false };
}

function buildCompletedLine(field: IScheduleField, c: IPluginCopy["scheduleBoard"]): string {
	// Completed entries render inside a SINGLE field's value (see
	// scheduleBoardEmbed for the rationale on why we no longer give
	// each completed event its own field). The auto-bold that field
	// names get for free is gone here, so the event name is wrapped
	// in markdown bold explicitly. The concluded line stays italic
	// for the "label vs value" visual hierarchy.
	return `**${c.fieldName(field.name, field.type)}**\n_${c.completedDateLabel}:_ <t:${field.firstOccurrenceTs}:D>`;
}
// ── confirmation embed ──
export function leaderboardEmbed(
	eventName: string,
	ranked: {
		username: string;
		totalScore: number;
		eventsAttended: number;
		totalAcknowledged: number;
	}[],
	guildConfig?: ICopyConfig | null
): EmbedBuilder {
	const copy = getPluginCopy(guildConfig);
	const c = copy.leaderboard;
	// Empty standings only happen for the pinned LeaderboardBoard (the command
	// short-circuits with an ephemeral "no activity" reply before it ever calls
	// this builder), so an empty `ranked` renders the board's empty-state copy
	// rather than an embed with a blank description.
	const description = ranked.length
		? ranked
				.map((p, i) => c.row(c.medals[i] ?? `**${i + 1}.**`, p.username, p.totalScore, p.eventsAttended, p.totalAcknowledged))
				.join("\n\n")
		: c.boardEmptyState;
	return base(guildConfig)
		.setTitle(c.title(eventName))
		.setColor(copy.COLORS.LEADERBOARD)
		.setDescription(description)
		.setFooter({ text: c.footer });
}
// ── KvK configuration confirmation embed ──
export function kvkConfirmationEmbed(
	dates: {
		seasonEnd: Date;
		ruinsFirst: Date;
		altarFirst: Date;
		kauEasy: Date;
		kauNormal: Date;
		kauHard: Date;
		kauNightmare: Date;
		channelId: string;
	},
	guildConfig?: ICopyConfig | null
): EmbedBuilder {
	const copy = getPluginCopy(guildConfig);
	const c = copy.kvkConfirmation;
	const t = (date: Date) => `<t:${Math.floor(date.getTime() / 1000)}:F>`;

	return base(guildConfig)
		.setTitle(c.title)
		.setDescription(c.description)
		.setColor(copy.COLORS.CONFIRMATION)
		.addFields(
			{
				name: c.fields.seasonEnd,
				value: `<t:${Math.floor(dates.seasonEnd.getTime() / 1000)}:D>`,
				inline: false,
			},
			{
				name: c.fields.ruins.name,
				value: [`First occurrence: ${t(dates.ruinsFirst)}`, c.fields.ruins.interval].join("\n"),
				inline: false,
			},
			{
				name: c.fields.altar.name,
				value: [`First occurrence: ${t(dates.altarFirst)}`, c.fields.altar.interval].join("\n"),
				inline: false,
			},
			{
				name: c.fields.kau.name,
				value: [
					`Easy:      ${t(dates.kauEasy)}`,
					`Normal:    ${t(dates.kauNormal)}  *(+14 days)*`,
					`Hard:      ${t(dates.kauHard)}  *(+17 days)*`,
					`Nightmare: ${t(dates.kauNightmare)}  *(+6 days)*`,
				].join("\n"),
				inline: false,
			},
			{
				name: c.fields.channel,
				value: `<#${dates.channelId}>`,
				inline: false,
			}
		);
}

export function errorEmbed(message: string, guildConfig?: ICopyConfig | null): EmbedBuilder {
	const copy = getPluginCopy(guildConfig);
	return base(guildConfig).setTitle(copy.error.title).setDescription(message).setColor(copy.COLORS.ERROR);
}

export function infoEmbed(title: string, description: string, color: ColorResolvable = "Blurple", guildConfig?: ICopyConfig | null): EmbedBuilder {
	return base(guildConfig).setTitle(title).setDescription(description).setColor(color);
}

export function arrivalEmbed(guildName: string, ownerId: string, guildConfig?: ICopyConfig | null): EmbedBuilder {
	const copy = getPluginCopy(guildConfig);
	const c = copy.arrival;
	return base(guildConfig).setTitle(c.title).setDescription(c.description(guildName, ownerId)).setColor(copy.COLORS.ARRIVAL);
}

// ── pairing code DM embed (FUTURE_PLANS item 63) ──
// Fires on guildCreate, before the guild has selected a plugin pack, so the
// rok-commander default (via getPluginCopy with no config) is the de facto
// voice exactly as it is for the arrival embed. Reuses the ARRIVAL color so
// the claim code reads as part of the same welcome moment.
export function pairingCodeEmbed(code: string, guildConfig?: ICopyConfig | null): EmbedBuilder {
	const copy = getPluginCopy(guildConfig);
	const c = copy.pairingCode;
	return base(guildConfig).setTitle(c.title).setDescription(c.description(code)).setColor(copy.COLORS.ARRIVAL);
}
