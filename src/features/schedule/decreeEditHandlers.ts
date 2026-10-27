import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ComponentType,
	EmbedBuilder,
	MessageFlags,
	ModalBuilder,
	StringSelectMenuBuilder,
	TextInputBuilder,
	TextInputStyle,
	type ButtonInteraction,
	type GuildMember,
	type ModalSubmitInteraction,
	type StringSelectMenuInteraction,
} from "discord.js";

import { registerButton, registerModal } from "@handlers/interactionRegistry.js";
import { eventStore } from "@db/stores/eventStore.js";
import { eventOverrideStore } from "@db/stores/eventOverrideStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { canEditDecree } from "@utils/permissions.js";
import { errorEmbed } from "@utils/embedBuilder.js";
import { parseFlexibleTime, isValidTimezone, localTimeToUtc, dateInTimezone } from "@utils/tzParser.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import type { Client } from "discord.js";
import { refreshSchedule } from "@features/schedule/ScheduleBoard.js";
import { adminLog } from "@features/setup/adminLog.js";
import { setupCopy } from "@features/setup/setupCopy.js";
import { showErrorNotice } from "@utils/textModal.js";

// ── customId prefixes ───────────────────────────────────────────────
// What:  the wire format every persistent decree-edit interaction uses.
//        Keeps the dispatcher contract in one place so the registry, the
//        NextUpBoard post builder, and the handlers below all agree.
// How:   `<prefix>:<eventId>:<occurrenceUnix>` for the Edit button and
//        modal-submit. The apply-once / apply-permanent buttons live
//        inside an awaitMessageComponent collector so they only need
//        unique-per-interaction local IDs and do NOT register globally.
export const DECREE_EDIT_BUTTON_PREFIX = "edit_decree";
export const DECREE_EDIT_MODAL_PREFIX = "edit_decree_modal";
const APPLY_ONCE_LOCAL_ID = "edit_decree_once";
const APPLY_PERMANENT_LOCAL_ID = "edit_decree_perm";
const CANCEL_LOCAL_ID = "edit_decree_cancel";
const TIMEZONE_SELECT_LOCAL_ID = "edit_decree_tz";

// 5 minutes is enough for an editor to read the proposed-changes embed
// and click Apply, but short enough that the awaitMessageComponent
// collector cleans up reasonably if the user walks away.
const APPLY_SCOPE_TIMEOUT_MS = 300_000;

// ── timezone select options ─────────────────────────────────────────
// What:  the curated 25 IANA zones surfaced in the post-modal timezone
//        dropdown. Discord caps StringSelectMenu at 25 options, so this
//        list is the entire surface, no "Other" fallback. UTC sits
//        first as the safe default for editors who do not want to think
//        about zones; the rest are ranked by ROK player concentration
//        (heavy NA + EU, plus the major APAC and one each Mexico /
//        Brazil / Sydney for the long tail).
// Who:   read by handleEditModalSubmit when prompting for a timezone
//        after a time-of-day was provided in the modal. Each option's
//        `value` MUST be a valid IANA name because resolveOverrideTime
//        passes it straight to localTimeToUtc, which trusts the input.
// When:  static. If a future ROK community adds a zone we do not cover,
//        edit this list AND the same change in tzParser COMMON_TIMEZONES
//        so the autocomplete and the dropdown stay in sync.
// Where: kept in this file (rather than tzParser) so the order can drift
//        from autocomplete without breaking either surface, the dropdown
//        sees only 25 options, autocomplete can paginate the full set.
// How:   `label` is what Discord shows the user (max 100 chars, friendly
//        names). `value` is the IANA identifier sent back to the bot.
//        `description` repeats the IANA name as a small subtitle so users
//        can verify the zone they picked.
const TIMEZONE_OPTIONS: ReadonlyArray<{ label: string; value: string; description: string }> = [
	{ label: "UTC", value: "UTC", description: "Coordinated Universal Time" },
	{ label: "Eastern Time (US)", value: "America/New_York", description: "America/New_York" },
	{ label: "Central Time (US)", value: "America/Chicago", description: "America/Chicago" },
	{ label: "Mountain Time (US)", value: "America/Denver", description: "America/Denver" },
	{ label: "Pacific Time (US)", value: "America/Los_Angeles", description: "America/Los_Angeles" },
	{ label: "Arizona", value: "America/Phoenix", description: "America/Phoenix" },
	{ label: "Alaska", value: "America/Anchorage", description: "America/Anchorage" },
	{ label: "Hawaii", value: "America/Honolulu", description: "America/Honolulu" },
	{ label: "Toronto", value: "America/Toronto", description: "America/Toronto" },
	{ label: "Mexico City", value: "America/Mexico_City", description: "America/Mexico_City" },
	{ label: "São Paulo", value: "America/Sao_Paulo", description: "America/Sao_Paulo" },
	{ label: "London", value: "Europe/London", description: "Europe/London" },
	{ label: "Paris", value: "Europe/Paris", description: "Europe/Paris" },
	{ label: "Berlin", value: "Europe/Berlin", description: "Europe/Berlin" },
	{ label: "Madrid", value: "Europe/Madrid", description: "Europe/Madrid" },
	{ label: "Rome", value: "Europe/Rome", description: "Europe/Rome" },
	{ label: "Athens", value: "Europe/Athens", description: "Europe/Athens" },
	{ label: "Moscow", value: "Europe/Moscow", description: "Europe/Moscow" },
	{ label: "Tokyo", value: "Asia/Tokyo", description: "Asia/Tokyo" },
	{ label: "Shanghai", value: "Asia/Shanghai", description: "Asia/Shanghai" },
	{ label: "Hong Kong", value: "Asia/Hong_Kong", description: "Asia/Hong_Kong" },
	{ label: "Singapore", value: "Asia/Singapore", description: "Asia/Singapore" },
	{ label: "Manila", value: "Asia/Manila", description: "Asia/Manila" },
	{ label: "Kolkata (IST)", value: "Asia/Kolkata", description: "Asia/Kolkata" },
	{ label: "Sydney", value: "Australia/Sydney", description: "Australia/Sydney" },
];

// ── customId helpers ────────────────────────────────────────────────
// Keep parsing centralized so a future format change (e.g., adding a
// version byte) only touches this file.

function buildEditButtonCustomId(eventId: string, occurrenceUnix: number): string {
	return `${DECREE_EDIT_BUTTON_PREFIX}:${eventId}:${occurrenceUnix}`;
}

function buildEditModalCustomId(eventId: string, occurrenceUnix: number): string {
	return `${DECREE_EDIT_MODAL_PREFIX}:${eventId}:${occurrenceUnix}`;
}

function parseDecreeCustomId(customId: string): { eventId: string; occurrenceUnix: number } | null {
	const parts = customId.split(":");
	// expected: [prefix, eventId, occurrenceUnix]. anything else is malformed.
	if (parts.length !== 3) return null;
	const eventId = parts[1];
	const occurrenceUnix = Number(parts[2]);
	if (!eventId || !Number.isFinite(occurrenceUnix)) return null;
	return { eventId, occurrenceUnix };
}

export const decreeEditCustomIds = {
	buildEditButton: buildEditButtonCustomId,
	buildEditModal: buildEditModalCustomId,
	parse: parseDecreeCustomId,
};

// ── modal field IDs ─────────────────────────────────────────────────
// All three modal fields are optional. Empty string in any field means
// "do not change". At least one must carry a value; the modal handler
// rejects the submit otherwise. Timezone is no longer a modal field,
// it is collected via a StringSelectMenu after submit when (and only
// when) a new time-of-day was provided. Discord modals cannot host
// select menus, hence the split.
const FIELD_TITLE = "title";
const FIELD_DESCRIPTION = "description";
const FIELD_TIME = "time";

// ── parsed-modal shape ──────────────────────────────────────────────

interface IParsedModalValues {
	overrideTitle: string | null;
	overrideDescription: string | null;
	// Combined time-of-day + timezone. null when the editor left the
	// time field blank. Resolved to a UTC Date keyed off the occurrence
	// the modal targets, the date portion of the override matches the
	// original occurrence date, only the hour/minute (in the given zone)
	// shift.
	overrideTime: Date | null;
}

// Raw extracted values BEFORE timezone resolution. The handler uses
// this shape to decide whether to prompt the editor for a timezone:
// when timeOfDay is non-null the editor must pick a zone before the
// preview can render; when it is null the preview goes straight to
// the apply-scope buttons.
interface IExtractedValues {
	overrideTitle: string | null;
	overrideDescription: string | null;
	timeOfDay: { hour: number; minute: number } | null;
}

// ── extractAndValidate ──────────────────────────────────────────────
// What:  pure structural validator. Trims every field, parses the time
//        string into hour/minute, and rejects empty submits. Does NOT
//        compute the UTC override Date, that needs a timezone the
//        modal cannot collect (Discord modals only accept TextInput).
// Who:   handleEditModalSubmit (production) and parseModalValues (the
//        backward-compat wrapper unit tests still call).
// When:  immediately after the modal submit lands, before any further
//        interaction prompts.
// Where: pairs with resolveOverrideTime below. The handler stitches
//        the two together with a StringSelectMenu interaction in
//        between when timeOfDay is non-null.
// How:   ① trim every input. ② normalize empty strings to null for the
//        text fields. ③ if a time string was supplied, run it through
//        parseFlexibleTime; reject on parse failure. ④ require at
//        least one non-null field.
export function extractAndValidate(
	rawTitle: string,
	rawDescription: string,
	rawTime: string
): { ok: true; values: IExtractedValues } | { ok: false; reason: string } {
	const trimmedTitle = rawTitle.trim();
	const trimmedDescription = rawDescription.trim();
	const trimmedTime = rawTime.trim();

	const overrideTitle = trimmedTitle.length > 0 ? trimmedTitle : null;
	const overrideDescription = trimmedDescription.length > 0 ? trimmedDescription : null;

	let timeOfDay: { hour: number; minute: number } | null = null;
	if (trimmedTime.length > 0) {
		const parsed = parseFlexibleTime(trimmedTime);
		if (!parsed) {
			return { ok: false, reason: `Time '${trimmedTime}' is not a recognized format. Examples: 7pm, 19:30, 9:30am.` };
		}
		timeOfDay = parsed;
	}

	if (overrideTitle === null && overrideDescription === null && timeOfDay === null) {
		return { ok: false, reason: "Nothing to change, fill in at least one field (title, description, or time)." };
	}

	return { ok: true, values: { overrideTitle, overrideDescription, timeOfDay } };
}

// ── resolveOverrideTime ─────────────────────────────────────────────
// What:  combine a parsed time-of-day with an IANA timezone and the
//        original occurrence date to produce the final UTC Date stored
//        on the override.
// Who:   handleEditModalSubmit after the editor picks a timezone from
//        the StringSelectMenu, and parseModalValues for backward-compat
//        with the unit tests that exercise the full pipeline.
// When:  exactly once per edit that includes a time change. Skipped
//        entirely when timeOfDay is null.
// Where: pairs with extractAndValidate. The split lets the handler
//        ask for the timezone interactively without duplicating the
//        time-string regex.
// How:   ① validate the timezone is a real IANA name. ② project the
//        original occurrence into the editor's timezone to get the
//        wall-clock date components. ③ rebuild the wall-clock instant
//        with the new hour/minute and run it back through localTimeToUtc.
export function resolveOverrideTime(
	timeOfDay: { hour: number; minute: number },
	timezone: string,
	originalOccurrence: Date
): { ok: true; date: Date } | { ok: false; reason: string } {
	if (!isValidTimezone(timezone)) {
		return { ok: false, reason: `Timezone '${timezone}' is not a recognized IANA name (e.g. America/New_York).` };
	}
	// Combine the new time-of-day with the date portion of the
	// original occurrence as it falls in the editor's timezone. This
	// preserves the editor's intent: "shift this fire to 9pm on the
	// same day" instead of accidentally rolling to the next day in
	// UTC for a wide-zone offset.
	const dateInZone = dateInTimezone(originalOccurrence, timezone);
	const date = localTimeToUtc(dateInZone.year, dateInZone.month, dateInZone.day, timeOfDay.hour, timeOfDay.minute, timezone);
	return { ok: true, date };
}

// ── parseModalValues ────────────────────────────────────────────────
// Backward-compat wrapper. Production code uses extractAndValidate +
// resolveOverrideTime directly so the timezone select can sit between
// the two. This wrapper preserves the pre-redesign signature so the
// existing unit tests keep working without rewrites: pass an empty
// timezone string and the function defaults to UTC, matching the
// legacy "blank timezone defaults to UTC" contract.
export function parseModalValues(
	rawTitle: string,
	rawDescription: string,
	rawTime: string,
	rawTimezone: string,
	originalOccurrence: Date
): { ok: true; values: IParsedModalValues } | { ok: false; reason: string } {
	// Preserve the legacy ordering: a timezone without a time is its
	// own error message regardless of what the other fields look like.
	// extractAndValidate would otherwise short-circuit on the "nothing
	// to change" branch first, which is technically true but loses the
	// more actionable hint about the ambiguity. The new production flow
	// never reaches this branch (the modal does not collect a timezone,
	// that is what the StringSelectMenu is for), but the wrapper
	// still has to honor the contract for the unit tests that exercise
	// every input combination.
	const trimmedTime = rawTime.trim();
	const trimmedTimezone = rawTimezone.trim();
	if (trimmedTimezone.length > 0 && trimmedTime.length === 0) {
		return { ok: false, reason: "A time is required when a timezone is provided. Leave both blank to keep the original fire time." };
	}

	const extracted = extractAndValidate(rawTitle, rawDescription, rawTime);
	if (!extracted.ok) return extracted;

	let overrideTime: Date | null = null;
	if (extracted.values.timeOfDay !== null) {
		const timezone = trimmedTimezone.length > 0 ? trimmedTimezone : "UTC";
		const resolved = resolveOverrideTime(extracted.values.timeOfDay, timezone, originalOccurrence);
		if (!resolved.ok) return resolved;
		overrideTime = resolved.date;
	}

	return {
		ok: true,
		values: {
			overrideTitle: extracted.values.overrideTitle,
			overrideDescription: extracted.values.overrideDescription,
			overrideTime,
		},
	};
}

// ── proposed-changes embed ──────────────────────────────────────────
// Renders the "before / after" delta the editor sees before they confirm
// scope (apply once vs apply permanent). Skipping unchanged fields keeps
// the embed scannable for editors who only tweaked one dimension.

function proposedChangesEmbed(
	eventName: string,
	eventDescription: string,
	originalOccurrence: Date,
	values: IParsedModalValues
): EmbedBuilder {
	const lines: string[] = [];
	if (values.overrideTitle !== null) {
		lines.push(`**Title**`);
		lines.push(`~~${eventName}~~`);
		lines.push(`→ ${values.overrideTitle}`);
		lines.push("");
	}
	if (values.overrideDescription !== null) {
		lines.push(`**Description**`);
		const before = eventDescription.length > 0 ? eventDescription : "_(empty)_";
		lines.push(`~~${before}~~`);
		lines.push(`→ ${values.overrideDescription}`);
		lines.push("");
	}
	if (values.overrideTime !== null) {
		const beforeTs = Math.floor(originalOccurrence.getTime() / 1000);
		const afterTs = Math.floor(values.overrideTime.getTime() / 1000);
		lines.push(`**Fire time**`);
		lines.push(`~~<t:${beforeTs}:F>~~`);
		lines.push(`→ <t:${afterTs}:F>`);
	}

	return new EmbedBuilder()
		.setTitle("📜 Proposed decree edit")
		.setDescription(lines.join("\n").trim() || "_(no changes)_")
		.setColor(rokCommanderCopy.COLORS.CONFIRMATION);
}

// ── audit-log helper ────────────────────────────────────────────────

async function logAudit(
	guildId: string,
	actorId: string,
	eventId: string,
	action: "decree_edit_once" | "decree_edit_permanent",
	before: Record<string, unknown>,
	after: Record<string, unknown>,
	originalOccurrence?: Date
): Promise<void> {
	try {
		await botLogStore.logAudit(guildId, {
			actorId,
			eventId,
			action,
			before,
			after,
			originalOccurrence: originalOccurrence?.toISOString(),
		});
	} catch (error) {
		// Audit failure must never block the user-visible apply path. Log
		// loud and move on, losing one audit row is recoverable from the
		// server-side reminder log + the EventOverride row itself.
		console.error("[decreeEdit] audit log write failed", { guildId, eventId, action }, error);
	}
}

// ── handler: Edit button click ──────────────────────────────────────

async function handleEditButton(interaction: ButtonInteraction): Promise<void> {
	const parsed = parseDecreeCustomId(interaction.customId);
	if (!parsed) {
		await showErrorNotice(interaction, "This decree button is malformed and cannot be processed.");
		return;
	}

	if (!interaction.guildId) {
		// Buttons posted to a guild channel always have guildId; this guard
		// satisfies the type narrowing and protects against a future change
		// that exposes the bot to DMs without anchoring config lookups.
		await showErrorNotice(interaction, "Decree edits can only be applied inside a guild.");
		return;
	}

	const config = await guildConfigStore.findByGuildId(interaction.guildId);
	if (!config) {
		await showErrorNotice(interaction, rokCommanderCopy.responses.setupRequired);
		return;
	}

	const member = interaction.member as GuildMember | null;
	if (!member || !canEditDecree(member, config)) {
		await showErrorNotice(interaction, rokCommanderCopy.responses.noWizardPowers);
		return;
	}

	const event = await eventStore.findByIdInGuild(parsed.eventId, interaction.guildId);
	if (!event) {
		await showErrorNotice(interaction, "That decree no longer exists.");
		return;
	}

	// Look up an existing override for the same occurrence so the modal
	// can prefill the most recent edit rather than the original event values.
	const occurrence = new Date(parsed.occurrenceUnix * 1000);
	const existingOverride = await eventOverrideStore.findOne({ eventId: event.eventId, originalOccurrence: occurrence });

	const modal = new ModalBuilder()
		.setCustomId(buildEditModalCustomId(event.eventId, parsed.occurrenceUnix))
		.setTitle("Edit decree");

	const titleInput = new TextInputBuilder()
		.setCustomId(FIELD_TITLE)
		.setLabel("Title (leave blank to keep current)")
		.setStyle(TextInputStyle.Short)
		.setRequired(false)
		.setMaxLength(80)
		.setValue(existingOverride?.overrideTitle ?? event.name);

	const descriptionInput = new TextInputBuilder()
		.setCustomId(FIELD_DESCRIPTION)
		.setLabel("Description (leave blank to keep current)")
		.setStyle(TextInputStyle.Paragraph)
		.setRequired(false)
		.setMaxLength(1000)
		.setValue(existingOverride?.overrideDescription ?? event.description ?? "");

	const timeInput = new TextInputBuilder()
		.setCustomId(FIELD_TIME)
		.setLabel("New time (e.g. 7pm, 19:30), blank to keep")
		.setStyle(TextInputStyle.Short)
		.setRequired(false)
		.setMaxLength(20)
		.setValue("");

	// Timezone deliberately NOT a modal field. Discord modals only host
	// TextInputBuilder components, no select menus. The handler below
	// surfaces a StringSelectMenu after submit when the editor provided
	// a new time, so the dropdown lives on a follow-up ephemeral.
	modal.addComponents(
		new ActionRowBuilder<TextInputBuilder>().addComponents(titleInput),
		new ActionRowBuilder<TextInputBuilder>().addComponents(descriptionInput),
		new ActionRowBuilder<TextInputBuilder>().addComponents(timeInput)
	);

	await interaction.showModal(modal);
}

// ── handler: modal submit ───────────────────────────────────────────
// Two-step flow because Discord modals cannot host StringSelectMenu:
//   ① validate the modal text fields via extractAndValidate.
//   ② if a new time-of-day was provided, post an ephemeral with a
//      timezone select dropdown + cancel button. Resolve the override
//      Date with resolveOverrideTime once the editor picks a zone.
//   ③ render the proposed-changes embed + apply-scope buttons (apply
//      once, apply permanent, cancel) on the same ephemeral.
// When step ② is skipped (no time change), step ③ replies directly.
// The apply-scope buttons and the timezone select live inside this
// collector, they are NOT registered globally because their lifetime
// is bounded to this submit.

async function handleEditModalSubmit(submission: ModalSubmitInteraction): Promise<void> {
	const parsed = parseDecreeCustomId(submission.customId);
	if (!parsed) {
		await submission.reply({
			embeds: [errorEmbed("This edit modal is malformed and cannot be processed.")],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	if (!submission.guildId) {
		await submission.reply({
			embeds: [errorEmbed("Decree edits can only be applied inside a guild.")],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const config = await guildConfigStore.findByGuildId(submission.guildId);
	if (!config) {
		await submission.reply({
			embeds: [errorEmbed(rokCommanderCopy.responses.setupRequired)],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	// Re-verify permission on submit. Discord could in theory cache a
	// modal across a role change between Edit-click and Submit, so the
	// gate must run twice for defense in depth.
	const member = submission.member as GuildMember | null;
	if (!member || !canEditDecree(member, config)) {
		await submission.reply({
			embeds: [errorEmbed(rokCommanderCopy.responses.noWizardPowers)],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const event = await eventStore.findByIdInGuild(parsed.eventId, submission.guildId);
	if (!event) {
		await submission.reply({
			embeds: [errorEmbed("That decree no longer exists.")],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const originalOccurrence = new Date(parsed.occurrenceUnix * 1000);
	const extracted = extractAndValidate(
		submission.fields.getTextInputValue(FIELD_TITLE),
		submission.fields.getTextInputValue(FIELD_DESCRIPTION),
		submission.fields.getTextInputValue(FIELD_TIME)
	);
	if (!extracted.ok) {
		await submission.reply({
			embeds: [errorEmbed(extracted.reason)],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	// ── branch on whether a timezone is needed ─────────────────────
	// timeOfDay non-null means the editor changed the fire time and
	// must pick a zone before we can resolve the override Date. Else
	// we go straight to the apply-scope step with a null override time.
	if (extracted.values.timeOfDay !== null) {
		await runTimezoneThenApply(submission, event, extracted.values, originalOccurrence);
	} else {
		await runApplyScope(submission, event, {
			overrideTitle: extracted.values.overrideTitle,
			overrideDescription: extracted.values.overrideDescription,
			overrideTime: null,
		}, originalOccurrence);
	}
}

// ── runTimezoneThenApply ────────────────────────────────────────────
// Posts the timezone select ephemeral, resolves the chosen zone into
// a UTC Date via resolveOverrideTime, then chains into runApplyScope
// using the same ephemeral message so the editor never sees more than
// one in-flight prompt at a time.
async function runTimezoneThenApply(
	submission: ModalSubmitInteraction,
	event: { eventId: string; name: string; description: string; guildId: string },
	values: IExtractedValues,
	originalOccurrence: Date
): Promise<void> {
	if (values.timeOfDay === null) {
		// Defensive, caller already gates on this. Unreachable in practice.
		return;
	}

	// ── timezone select prompt ──
	// What:  single StringSelectMenu, no cancel button. Earlier iterations
	//        included a cancel button on its own row, but pairing a
	//        select with a button on the same ephemeral broke the
	//        awaitMessageComponent pipeline in discord.js 14.25, the
	//        default collector quietly filters to ComponentType.Button
	//        only, so the select click never landed and Discord timed
	//        out the interaction with no log on our side.
	// Who:   editors who provided a new fire time on the modal. Editors
	//        without a time change skip this branch entirely.
	// When:  immediately after handleEditModalSubmit dispatches into
	//        runTimezoneThenApply.
	// Where: pairs with the explicit `componentType: ComponentType.StringSelect`
	//        filter on awaitMessageComponent below, the explicit filter
	//        is what actually fixes the 14.25 silent-drop bug, the
	//        cancel-button removal just keeps the flow simple. If the
	//        editor wants to bail out, they can dismiss the ephemeral
	//        or let the 5-minute timeout fire (and the timed-out edit
	//        message tells them what to do).
	// How:   25-option dropdown sourced from TIMEZONE_OPTIONS (Discord's
	//        hard cap on StringSelectMenu). UTC sits first as the safe
	//        default. min/max values both 1 so the editor must pick
	//        exactly one zone before the interaction completes.
	const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
		new StringSelectMenuBuilder()
			.setCustomId(TIMEZONE_SELECT_LOCAL_ID)
			.setPlaceholder("Pick the timezone for the new time")
			.setMinValues(1)
			.setMaxValues(1)
			.addOptions(TIMEZONE_OPTIONS.map((opt) => ({ label: opt.label, value: opt.value, description: opt.description })))
	);

	await submission.reply({
		content: `Time **${formatTimeOfDay(values.timeOfDay)}**, which timezone is that in?`,
		components: [selectRow],
		flags: MessageFlags.Ephemeral,
	});

	// ── collector-based select wait ──
	// What:  use createMessageComponentCollector + Promise wrapping rather
	//        than awaitMessageComponent. The latter was silently dropping
	//        the select click in discord.js 14.25 even with an explicit
	//        ComponentType.StringSelect filter, Discord timed out the
	//        interaction with no error on our side because the collector
	//        emitted nothing. Switching to the streaming collector and
	//        wrapping the first event in a Promise gives us identical
	//        semantics with reliable wire handling.
	// Who:   editors who provided a new fire time.
	// When:  one shot per edit. max:1 closes the collector after the
	//        first matching click; the timeout still fires if nobody
	//        picks anything within APPLY_SCOPE_TIMEOUT_MS.
	// Where: pairs with the explicit filter on customId so a stray
	//        click from a different message instance cannot match.
	// How:   collector emits 'collect' with the StringSelectMenuInteraction.
	//        We capture it via a one-shot Promise resolved from inside
	//        the listener. 'end' resolves with null to signal timeout.
	const fetched = await submission.fetchReply();
	let selectInteraction: StringSelectMenuInteraction | null = null;
	await new Promise<void>((resolve) => {
		const collector = fetched.createMessageComponentCollector({
			componentType: ComponentType.StringSelect,
			filter: (i) => i.user.id === submission.user.id && i.customId === TIMEZONE_SELECT_LOCAL_ID,
			time: APPLY_SCOPE_TIMEOUT_MS,
			max: 1,
		});
		collector.on("collect", (interaction) => {
			selectInteraction = interaction as StringSelectMenuInteraction;
		});
		collector.on("end", () => {
			resolve();
		});
	});

	if (!selectInteraction) {
		await submission
			.editReply({
				content: "Timezone selection timed out, re-run the edit to retry.",
				components: [],
			})
			.catch(() => undefined);
		return;
	}

	// Reassign through a const so TypeScript narrows correctly after this
	// point. The let-binding above was assigned inside a Promise callback,
	// which defeats control-flow analysis, TS would otherwise type the
	// variable as `never` past the null guard above. The const captures
	// the narrowed value once and gives every subsequent reference a
	// stable StringSelectMenuInteraction type.
	const tzInteraction: StringSelectMenuInteraction = selectInteraction;
	const selectedTimezone = tzInteraction.values[0];
	const resolved = resolveOverrideTime(values.timeOfDay, selectedTimezone, originalOccurrence);
	if (!resolved.ok) {
		// resolveOverrideTime only fails on invalid IANA names, the
		// curated list is sealed and validated, so this is unreachable
		// unless TIMEZONE_OPTIONS drifts out of sync with Intl.
		await tzInteraction.update({
			content: resolved.reason,
			components: [],
		});
		return;
	}

	// Hand off to the apply-scope step. We pass the existing message
	// reference and the select interaction so runApplyScope can update
	// the SAME ephemeral instead of replying to a fresh one, the editor
	// experiences a single in-place prompt change, not a new message.
	await runApplyScope(
		submission,
		event,
		{
			overrideTitle: values.overrideTitle,
			overrideDescription: values.overrideDescription,
			overrideTime: resolved.date,
		},
		originalOccurrence,
		tzInteraction
	);
}

// ── runApplyScope ───────────────────────────────────────────────────
// Renders the proposed-changes embed and the apply-scope buttons.
// When called from the no-timezone branch the function replies to the
// modal submission. When called from runTimezoneThenApply it updates
// the existing select-menu ephemeral via the passed-through select
// interaction so the editor sees one continuous flow.
async function runApplyScope(
	submission: ModalSubmitInteraction,
	event: { eventId: string; name: string; description: string; guildId: string },
	values: IParsedModalValues,
	originalOccurrence: Date,
	selectInteraction?: StringSelectMenuInteraction
): Promise<void> {
	const guildId = submission.guildId!;
	const previewEmbed = proposedChangesEmbed(event.name, event.description ?? "", originalOccurrence, values);

	const applyRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder().setCustomId(APPLY_ONCE_LOCAL_ID).setLabel("Apply to this fire only").setStyle(ButtonStyle.Primary),
		new ButtonBuilder().setCustomId(APPLY_PERMANENT_LOCAL_ID).setLabel("Apply to all future fires").setStyle(ButtonStyle.Danger),
		new ButtonBuilder().setCustomId(CANCEL_LOCAL_ID).setLabel("Cancel").setStyle(ButtonStyle.Secondary)
	);

	if (selectInteraction) {
		// Came from the timezone select, update the existing ephemeral
		// in place so the editor sees the prompt morph from "pick a tz"
		// into "confirm scope" without a new message. content omitted on
		// purpose: passing an empty string here was rejected on the wire
		// in early testing, and omitting the field leaves the prior
		// "Time **HH:MM**, which timezone is that in?" line untouched,
		// which actually reads fine alongside the proposed-changes embed
		// as a confirmation breadcrumb.
		await selectInteraction.update({
			embeds: [previewEmbed],
			components: [applyRow],
		});
	} else {
		// First reply path (no timezone needed). InteractionResponse
		// supports awaitMessageComponent directly, same as the legacy
		// flow.
		await submission.reply({
			embeds: [previewEmbed],
			components: [applyRow],
			flags: MessageFlags.Ephemeral,
		});
	}

	let choice: ButtonInteraction;
	try {
		// In both branches the ephemeral is the same Discord message
		// (interaction.update reuses the original reply), so awaitMessageComponent
		// on the original reply token surfaces the apply-scope click.
		const fetched = await submission.fetchReply();
		choice = (await fetched.awaitMessageComponent({
			componentType: ComponentType.Button,
			time: APPLY_SCOPE_TIMEOUT_MS,
			filter: (i) => i.user.id === submission.user.id,
		})) as ButtonInteraction;
	} catch {
		await submission
			.editReply({
				embeds: [previewEmbed.setFooter({ text: "Edit timed out, re-run the edit to retry." })],
				components: [],
			})
			.catch(() => undefined);
		return;
	}

	if (choice.customId === CANCEL_LOCAL_ID) {
		await choice.update({ embeds: [previewEmbed.setFooter({ text: "Edit cancelled." })], components: [] });
		return;
	}

	if (choice.customId === APPLY_ONCE_LOCAL_ID) {
		await applyOnce(choice, guildId, event, values, originalOccurrence, previewEmbed);
		return;
	}

	if (choice.customId === APPLY_PERMANENT_LOCAL_ID) {
		await applyPermanent(choice, guildId, event, values, previewEmbed);
		return;
	}
}

// ── formatTimeOfDay ─────────────────────────────────────────────────
// Renders the parsed { hour, minute } back as a wall-clock string for
// the timezone-select prompt label. 24h format with zero-padded
// minutes; the editor sees what they typed echoed back so they can
// catch typos before committing to a timezone.
function formatTimeOfDay(t: { hour: number; minute: number }): string {
	const hh = String(t.hour).padStart(2, "0");
	const mm = String(t.minute).padStart(2, "0");
	return `${hh}:${mm}`;
}

// ── apply branches ──────────────────────────────────────────────────

async function applyOnce(
	interaction: ButtonInteraction,
	guildId: string,
	event: { eventId: string; name: string; description: string },
	values: IParsedModalValues,
	originalOccurrence: Date,
	previewEmbed: EmbedBuilder
): Promise<void> {
	try {
		const before = {
			eventId: event.eventId,
			name: event.name,
			description: event.description,
			originalOccurrence: originalOccurrence.toISOString(),
		};
		await eventOverrideStore.upsert({
			eventId: event.eventId,
			guildId,
			originalOccurrence,
			overrideTitle: values.overrideTitle,
			overrideDescription: values.overrideDescription,
			overrideTime: values.overrideTime,
		});
		const after = {
			overrideTitle: values.overrideTitle,
			overrideDescription: values.overrideDescription,
			overrideTime: values.overrideTime?.toISOString() ?? null,
		};
		await logAudit(guildId, interaction.user.id, event.eventId, "decree_edit_once", before, after, originalOccurrence);
		adminLog.emitFor(interaction, guildId, "schedule.update", { subject: event.name, detail: setupCopy.adminLog.editedOnce, eventId: event.eventId });

		// Fire-and-forget refresh so the schedule board picks up any
		// time-shifted occurrence on its next read. Errors here must
		// never undo the successful override write.
		refreshSchedule(interaction.client as Client, guildId).catch((err) =>
			console.error("[decreeEdit] schedule refresh after apply-once failed", err)
		);

		await interaction.update({
			embeds: [previewEmbed.setFooter({ text: "✅ Override saved for this fire only." })],
			components: [],
		});
	} catch (error) {
		console.error("[decreeEdit] apply-once failed", error);
		await interaction
			.update({
				embeds: [errorEmbed("Failed to save the override. The fire was not modified.")],
				components: [],
			})
			.catch(() => undefined);
	}
}

async function applyPermanent(
	interaction: ButtonInteraction,
	guildId: string,
	event: { eventId: string; name: string; description: string },
	values: IParsedModalValues,
	previewEmbed: EmbedBuilder
): Promise<void> {
	try {
		const before = {
			eventId: event.eventId,
			name: event.name,
			description: event.description,
		};
		const update: Record<string, unknown> = {};
		if (values.overrideTitle !== null) update.name = values.overrideTitle;
		if (values.overrideDescription !== null) update.description = values.overrideDescription;
		if (values.overrideTime !== null) update.firstOccurrence = values.overrideTime;

		const updated = await eventStore.updateInGuild(event.eventId, guildId, update);
		if (!updated) {
			await interaction.update({
				embeds: [errorEmbed("Failed to update the decree, it may have been deleted.")],
				components: [],
			});
			return;
		}

		const after = {
			name: updated.name,
			description: updated.description,
			firstOccurrence: updated.firstOccurrence.toISOString(),
		};
		await logAudit(guildId, interaction.user.id, event.eventId, "decree_edit_permanent", before, after);
		adminLog.emitFor(interaction, guildId, "schedule.update", { subject: updated.name, detail: setupCopy.adminLog.editedEveryFire, eventId: event.eventId });

		refreshSchedule(interaction.client as Client, guildId).catch((err) =>
			console.error("[decreeEdit] schedule refresh after apply-permanent failed", err)
		);

		await interaction.update({
			embeds: [previewEmbed.setFooter({ text: "✅ Decree updated permanently, all future fires will use the new values." })],
			components: [],
		});
	} catch (error) {
		console.error("[decreeEdit] apply-permanent failed", error);
		await interaction
			.update({
				embeds: [errorEmbed("Failed to update the decree.")],
				components: [],
			})
			.catch(() => undefined);
	}
}

// ── public bootstrap ────────────────────────────────────────────────

export function registerDecreeEditHandlers(): void {
	registerButton(DECREE_EDIT_BUTTON_PREFIX, handleEditButton);
	registerModal(DECREE_EDIT_MODAL_PREFIX, handleEditModalSubmit);
}
