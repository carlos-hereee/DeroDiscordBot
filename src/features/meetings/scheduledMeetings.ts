import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	LabelBuilder,
	MessageFlags,
	ModalBuilder,
	TextInputBuilder,
	TextInputStyle,
	type ButtonInteraction,
	type Client,
	type GuildMember,
	type ModalSubmitInteraction,
	type RepliableInteraction,
} from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { getPluginCopy, type ICopyConfig, type IPluginCopy } from "@base/copy/index.js";
import type { IMeeting } from "@db/models/Meeting.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { meetingStore } from "@db/stores/meetingStore.js";
import { cancelRemindersFor, scheduleRemindersFor } from "@features/reminders/dueReminders.js";
import { readMemberTimezone } from "@features/reminders/memberTimezone.js";
import { registerButton, registerModal } from "@handlers/interactionRegistry.js";
import { syncCardMessage, type CardPayload } from "@utils/cardMessage.js";
import { infoEmbed } from "@utils/embedBuilder.js";
import { parseReminderTime } from "@utils/reminderTimeParser.js";
import { shortId } from "@utils/shortId.js";
import { acknowledgeConfirm, acknowledgeTextModal, showConfirm, showModalOrReply, showNotice, type ConfirmInteraction } from "@utils/textModal.js";
import { isMeetingHost } from "./meetingHosts.js";

// ── scheduledMeetings ───────────────────────────────────────────────────────
// What:  a meeting set for later (2026-11 item 388 Phase 2): /meeting schedule and Schedule a
//        meeting on the 📝meeting-notes intro open one modal (title, when); a host's Submit
//        stores a Meeting row with status scheduled and posts its card in 📝meeting-notes,
//        where members press I'll be there and a host presses Cancel. Its reminders ping the
//        host and every RSVP there (dueReminders).
// Who:   commands/utility/meeting.ts, the intro row, main.ts (the mtg prefix); Phase 5's
//        dashboard calls scheduleMeeting and cancelScheduledMeeting, the one write path.
// Model: features/game-rooms/partyGamesSchedule.ts rsvpCard and handleRsvpButton.
// Does NOT: record. Start recording and End recording are mtg buttons, so they arrive here and
//        are handed to meetingLifecycle through useRecordingControls, which keeps this file
//        free of an import of the lifecycle (the lifecycle imports this file).

/** Every meeting customId: `mtg:<action>` or `mtg:<action>:<meetingId>`. */
export const MEETING_PREFIX = "mtg";
const ACTIONS = { schedule: "schedule", rsvp: "rsvp", cancel: "cancel", confirmCancel: "cancelok", record: "rec", end: "end" } as const;
/** The mtg actions other meeting modules build buttons for. */
export const MEETING_ACTIONS = { record: ACTIONS.record, end: ACTIONS.end } as const;
const TITLE_FIELD_ID = "title";
const WHEN_FIELD_ID = "when";
// A typed time is short (30m, 12/24@18:00); the cap only keeps a pasted paragraph out.
const WHEN_INPUT_MAX = 40;

export const meetingCustomId = (action: string, meetingId?: string): string => (meetingId ? `${MEETING_PREFIX}:${action}:${meetingId}` : `${MEETING_PREFIX}:${action}`);
const toSeconds = (date: Date): number => Math.floor(new Date(date).getTime() / 1000);

/** Why a schedule or a cancel was refused. */
export type MeetingRefusal = "noChannel" | "titleInvalid" | "notFound" | "notScheduled";
export type MeetingResult = { ok: true; meeting: IMeeting } | { ok: false; reason: MeetingRefusal };

// ── the card ────────────────────────────────────────────────────────────────

// Start recording on a scheduled card, shown only while it is scheduled; a host's press starts
// this row's recording rather than a new meeting.
function startRecordingButtons(meeting: IMeeting, copy: IPluginCopy): ButtonBuilder[] {
	return [new ButtonBuilder().setCustomId(meetingCustomId(ACTIONS.record, meeting.meetingId)).setLabel(copy.meetingRecording.startButton).setEmoji("🎙️").setStyle(ButtonStyle.Primary)];
}

/** What a Start recording or End recording press runs; meetingLifecycle registers it at boot. */
export interface RecordingControls {
	start(interaction: ButtonInteraction, input: { scheduledMeetingId?: string }): Promise<void>;
	end(interaction: ButtonInteraction, meetingId: string | null): Promise<void>;
}

let recordingControls: RecordingControls | null = null;

/** Hand the recording presses to the lifecycle. Called once from registerMeetingRecording. */
export function useRecordingControls(controls: RecordingControls): void {
	recordingControls = controls;
}

/**
 * The scheduled meeting card, drawn from its row. `updatedFromDashboard` marks a redraw a
 * dashboard write caused (2026-11 item 388 Phase 5a). Exported for the tests.
 */
export function buildScheduledMeetingCard(meeting: IMeeting, copy: IPluginCopy, updatedFromDashboard = false): CardPayload {
	const words = copy.todoReminders.meetings.card;
	const start = meeting.scheduledFor ? toSeconds(meeting.scheduledFor) : 0;
	const lines = [words.description(meeting.hostId, start)];
	if (meeting.status === "cancelled") lines.push("", words.cancelledLine);
	if (updatedFromDashboard) lines.push("", words.updatedFromDashboard);
	const embed = infoEmbed(words.title(meeting.title), lines.join("\n"), copy.COLORS.SCHEDULE).addFields({
		name: words.attendingTitle(meeting.rsvpIds.length),
		value: meeting.rsvpIds.length > 0 ? words.names(meeting.rsvpIds, BOT_CONSTANTS.PARTY_GAME_NAMES_SHOWN) : words.nobodyYet,
	});
	const components =
		meeting.status === "scheduled"
			? [
					new ActionRowBuilder<ButtonBuilder>().addComponents(
						new ButtonBuilder().setCustomId(meetingCustomId(ACTIONS.rsvp, meeting.meetingId)).setLabel(words.rsvp).setEmoji("✅").setStyle(ButtonStyle.Success),
						...startRecordingButtons(meeting, copy),
						new ButtonBuilder().setCustomId(meetingCustomId(ACTIONS.cancel, meeting.meetingId)).setLabel(words.cancel).setStyle(ButtonStyle.Secondary)
					),
				]
			: [];
	return { embeds: [embed], components, allowedMentions: { parse: [], users: [], roles: [] } };
}

/** Start recording and Schedule a meeting, the 📝meeting-notes intro's row. */
export function buildMeetingNotesIntroRow(copy: IPluginCopy): ActionRowBuilder<ButtonBuilder> {
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder().setCustomId(meetingCustomId(ACTIONS.record)).setLabel(copy.meetingRecording.startButton).setEmoji("🎙️").setStyle(ButtonStyle.Success),
		new ButtonBuilder().setCustomId(meetingCustomId(ACTIONS.schedule)).setLabel(copy.todoReminders.meetings.intro.schedule).setEmoji("📅").setStyle(ButtonStyle.Primary)
	);
}

async function syncMeetingCard(client: Client, meeting: IMeeting, channelId: string, copy: IPluginCopy, fromDashboard = false): Promise<void> {
	const current = meeting.notesChannelId === channelId ? meeting.scheduleMessageId : null;
	const messageId = await syncCardMessage(client, channelId, current, buildScheduledMeetingCard(meeting, copy, fromDashboard));
	if (messageId && messageId !== meeting.scheduleMessageId) await meetingStore.update(meeting.guildId, meeting.meetingId, { notesChannelId: channelId, scheduleMessageId: messageId });
}

/** Redraw a meeting's scheduled card from its row, wherever it was posted. */
export async function redrawScheduledMeetingCard(client: Client, meeting: IMeeting): Promise<void> {
	if (!meeting.notesChannelId || !meeting.scheduleMessageId) return;
	const config = await guildConfigStore.findByGuildId(meeting.guildId);
	await syncMeetingCard(client, meeting, meeting.notesChannelId, getPluginCopy(config as unknown as ICopyConfig | null));
}

// ── the one write path ──────────────────────────────────────────────────────

interface NotesContext {
	channelId: string;
	copy: IPluginCopy;
}

async function notesContext(guildId: string): Promise<NotesContext | null> {
	const config = await guildConfigStore.findByGuildId(guildId);
	if (!config?.meetingNotesChannelId) return null;
	return { channelId: config.meetingNotesChannelId, copy: getPluginCopy(config as unknown as ICopyConfig) };
}

/** Where a write came from; a dashboard write marks the card it redraws. */
export interface MeetingWriteOptions {
	fromDashboard?: boolean;
}

function afterWrite(client: Client, meeting: IMeeting, context: NotesContext, options: MeetingWriteOptions = {}): Promise<void> {
	void syncMeetingCard(client, meeting, context.channelId, context.copy, options.fromDashboard === true).catch((error: unknown) =>
		console.error("[scheduledMeetings] the meeting card could not be redrawn", { meetingId: meeting.meetingId, error: error instanceof Error ? error.name : "unknown" })
	);
	const reminders = meeting.status === "scheduled" ? scheduleRemindersFor({ kind: "meeting", meeting }) : cancelRemindersFor(meeting.meetingId);
	return reminders.catch((error: unknown) =>
		console.error("[scheduledMeetings] the meeting's reminders could not be updated", { meetingId: meeting.meetingId, error: error instanceof Error ? error.name : "unknown" })
	);
}

/**
 * Store a scheduled meeting and post its card. `hostId` is null from the dashboard, which has
 * no Discord identity (D4). The caller checks the host and reads the time; this checks the rest.
 */
export async function scheduleMeeting(
	client: Client,
	guildId: string,
	input: { title: string; startsAt: Date; hostId: string | null },
	options: MeetingWriteOptions = {}
): Promise<MeetingResult> {
	const context = await notesContext(guildId);
	if (!context) return { ok: false, reason: "noChannel" };
	const title = input.title.trim();
	if (title.length === 0 || title.length > BOT_CONSTANTS.MEETINGS.TITLE_MAX) return { ok: false, reason: "titleInvalid" };
	const meeting = await meetingStore.insert({
		meetingId: shortId(),
		guildId,
		title,
		status: "scheduled",
		endReason: null,
		hostId: input.hostId,
		scheduledFor: input.startsAt,
		rsvpIds: [],
		startedAt: null,
		endedAt: null,
		speakerIds: [],
		notesChannelId: context.channelId,
		notesMessageId: null,
		scheduleMessageId: null,
		summary: null,
		sttSeconds: 0,
		spentCents: 0,
	});
	await afterWrite(client, meeting, context, options);
	return { ok: true, meeting };
}

// A conditional write that matched nothing: the row is gone, or it is no longer scheduled.
async function missedRefusal(guildId: string, meetingId: string): Promise<MeetingResult> {
	return { ok: false, reason: (await meetingStore.findById(guildId, meetingId)) ? "notScheduled" : "notFound" };
}

/** Call a scheduled meeting off: status cancelled in one conditional write, reminders off, card redrawn. */
export async function cancelScheduledMeeting(client: Client, guildId: string, meetingId: string, options: MeetingWriteOptions = {}): Promise<MeetingResult> {
	const context = await notesContext(guildId);
	if (!context) return { ok: false, reason: "noChannel" };
	const cancelled = await meetingStore.claimTransition(guildId, meetingId, "scheduled", { status: "cancelled" });
	if (!cancelled) return missedRefusal(guildId, meetingId);
	await afterWrite(client, cancelled, context, options);
	return { ok: true, meeting: cancelled };
}

/**
 * Change a scheduled meeting's title or start time (the dashboard's edit, 2026-11 item 388
 * Phase 5a). One conditional write on status scheduled, so an edit racing Start recording
 * never rewrites a meeting already recording; the reminders move with the time. The caller
 * checks the time is in the future.
 */
export async function editScheduledMeeting(
	client: Client,
	guildId: string,
	meetingId: string,
	edit: { title?: string; startsAt?: Date },
	options: MeetingWriteOptions = {}
): Promise<MeetingResult> {
	const context = await notesContext(guildId);
	if (!context) return { ok: false, reason: "noChannel" };
	const changes: { title?: string; scheduledFor?: Date } = {};
	if (edit.title !== undefined) {
		const title = edit.title.trim();
		if (title.length === 0 || title.length > BOT_CONSTANTS.MEETINGS.TITLE_MAX) return { ok: false, reason: "titleInvalid" };
		changes.title = title;
	}
	if (edit.startsAt !== undefined) changes.scheduledFor = edit.startsAt;
	const edited = await meetingStore.claimTransition(guildId, meetingId, "scheduled", changes);
	if (!edited) return missedRefusal(guildId, meetingId);
	await afterWrite(client, edited, context, options);
	return { ok: true, meeting: edited };
}

// ── Discord ─────────────────────────────────────────────────────────────────

interface PressContext {
	guildId: string;
	copy: IPluginCopy;
	serverTimezone: unknown;
	hasNotesChannel: boolean;
}

async function pressContext(interaction: RepliableInteraction): Promise<PressContext | null> {
	const guildId = interaction.guildId;
	if (!guildId) return null;
	const config = await guildConfigStore.findByGuildId(guildId);
	return { guildId, copy: getPluginCopy(config as unknown as ICopyConfig | null), serverTimezone: config?.timezone, hasNotesChannel: Boolean(config?.meetingNotesChannelId) };
}

async function presserIsHost(interaction: RepliableInteraction): Promise<boolean> {
	if (!interaction.guild) return false;
	const member: GuildMember | null = interaction.inCachedGuild() ? interaction.member : await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
	return isMeetingHost(member, interaction.guild);
}

const notice = (interaction: RepliableInteraction, copy: IPluginCopy, line: string): Promise<void> =>
	showNotice(interaction, { title: copy.todoReminders.meetings.noticeTitle, sections: [line] });

/** The private line for a refused schedule or cancel. */
export function meetingRefusalLine(reason: MeetingRefusal, copy: IPluginCopy): string {
	const words = copy.todoReminders.meetings;
	if (reason === "noChannel") return words.channelMissing;
	if (reason === "titleInvalid") return words.titleInvalid(BOT_CONSTANTS.MEETINGS.TITLE_MAX);
	return reason === "notFound" ? words.gone : words.notScheduled;
}

/** The schedule modal. Exported for the tests. */
export function buildScheduleMeetingModal(copy: IPluginCopy): ModalBuilder {
	const words = copy.todoReminders.meetings.modal;
	return new ModalBuilder()
		.setCustomId(meetingCustomId(ACTIONS.schedule))
		.setTitle(words.title)
		.addLabelComponents(
			new LabelBuilder()
				.setLabel(words.titleLabel)
				.setTextInputComponent(new TextInputBuilder().setCustomId(TITLE_FIELD_ID).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(BOT_CONSTANTS.MEETINGS.TITLE_MAX)),
			new LabelBuilder()
				.setLabel(words.whenLabel)
				.setTextInputComponent(
					new TextInputBuilder().setCustomId(WHEN_FIELD_ID).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(WHEN_INPUT_MAX).setPlaceholder(copy.todoReminders.todos.timeHint)
				)
		);
}

/** Open the schedule modal for a host while 📝meeting-notes exists. Shared by the intro button and /meeting schedule. */
export async function openScheduleMeetingModal(interaction: Extract<RepliableInteraction, { showModal: unknown }>): Promise<void> {
	const context = await pressContext(interaction);
	if (!context) return;
	if (!context.hasNotesChannel) return notice(interaction, context.copy, meetingRefusalLine("noChannel", context.copy));
	if (!(await presserIsHost(interaction))) return notice(interaction, context.copy, context.copy.todoReminders.meetings.notHost);
	await showModalOrReply(interaction, buildScheduleMeetingModal(context.copy), () => ({ content: context.copy.todoReminders.meetings.notHost, flags: MessageFlags.Ephemeral }));
}

async function handleScheduleSubmit(interaction: ModalSubmitInteraction, context: PressContext): Promise<void> {
	// Re-gated: a modal Submit is reachable without the button that opened it.
	if (!(await presserIsHost(interaction))) return notice(interaction, context.copy, context.copy.todoReminders.meetings.notHost);
	const zone = await readMemberTimezone(context.guildId, interaction.user.id, context.serverTimezone);
	const when = parseReminderTime(interaction.fields.getTextInputValue(WHEN_FIELD_ID), zone);
	if (!when.ok) return notice(interaction, context.copy, context.copy.todoReminders.reminders.time[when.reason]);
	const result = await scheduleMeeting(interaction.client, context.guildId, { title: interaction.fields.getTextInputValue(TITLE_FIELD_ID), startsAt: when.at, hostId: interaction.user.id });
	// The card in 📝meeting-notes is the answer (an answer is never a private notice), so a
	// saved meeting only closes the modal; a refusal is said privately.
	if (result.ok) return acknowledgeTextModal(interaction);
	await notice(interaction, context.copy, meetingRefusalLine(result.reason, context.copy));
}

// The redrawn card, now saying it was cancelled, is the answer to a cancel.
async function cancelByHost(interaction: ConfirmInteraction, context: PressContext, meetingId: string): Promise<void> {
	if (!(await presserIsHost(interaction))) return notice(interaction, context.copy, context.copy.todoReminders.meetings.notHost);
	const result = await cancelScheduledMeeting(interaction.client, context.guildId, meetingId);
	if (result.ok) return acknowledgeConfirm(interaction);
	await notice(interaction, context.copy, meetingRefusalLine(result.reason, context.copy));
}

// I'll be there toggles: a second press takes the RSVP back. The card the press came from is
// redrawn in place, which is the whole answer, as on a party game card.
async function handleRsvp(interaction: ButtonInteraction, context: PressContext, meetingId: string): Promise<void> {
	const before = await meetingStore.findById(context.guildId, meetingId);
	if (!before) return notice(interaction, context.copy, context.copy.todoReminders.meetings.gone);
	const attending = !before.rsvpIds.includes(interaction.user.id);
	const after = await meetingStore.setRsvp(context.guildId, meetingId, interaction.user.id, attending);
	if (!after) return notice(interaction, context.copy, context.copy.todoReminders.meetings.notScheduled);
	await interaction.update(buildScheduledMeetingCard(after, context.copy));
}

async function handleMeetingButton(interaction: ButtonInteraction): Promise<void> {
	const [, action, meetingId] = interaction.customId.split(":");
	if (action === ACTIONS.schedule) return openScheduleMeetingModal(interaction);
	if (action === ACTIONS.record) return recordingControls?.start(interaction, { scheduledMeetingId: meetingId });
	if (action === ACTIONS.end) return recordingControls?.end(interaction, meetingId ?? null);
	const context = await pressContext(interaction);
	if (!context || !meetingId) return;
	if (action === ACTIONS.rsvp) return handleRsvp(interaction, context, meetingId);
	if (action === ACTIONS.confirmCancel) return cancelByHost(interaction, context, meetingId);
	if (action !== ACTIONS.cancel) return;
	if (!(await presserIsHost(interaction))) return notice(interaction, context.copy, context.copy.todoReminders.meetings.notHost);
	const meeting = await meetingStore.findById(context.guildId, meetingId);
	if (!meeting) return notice(interaction, context.copy, context.copy.todoReminders.meetings.gone);
	const words = context.copy.todoReminders.meetings.confirmCancel;
	await showConfirm(interaction, { title: words.title, sections: [words.body(meeting.title)], confirmId: meetingCustomId(ACTIONS.confirmCancel, meetingId) }, null);
}

async function handleMeetingModal(interaction: ModalSubmitInteraction): Promise<void> {
	const [, action, meetingId] = interaction.customId.split(":");
	const context = await pressContext(interaction);
	if (!context) return;
	if (action === ACTIONS.schedule) return handleScheduleSubmit(interaction, context);
	if (action === ACTIONS.confirmCancel && meetingId) return cancelByHost(interaction, context, meetingId);
}

/** Register the mtg buttons and modals. Called once at boot from main.ts. */
export function registerScheduledMeetingHandlers(): void {
	registerButton(MEETING_PREFIX, handleMeetingButton);
	registerModal(MEETING_PREFIX, handleMeetingModal);
}
