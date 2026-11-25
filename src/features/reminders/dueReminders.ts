import type { Client } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { getPluginCopy, type ICopyConfig, type IPluginCopy } from "@base/copy/index.js";
import type { IMeeting } from "@db/models/Meeting.js";
import type { IReminder, ReminderDelivery, ReminderLeadKey } from "@db/models/Reminder.js";
import type { ITodo } from "@db/models/Todo.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { meetingStore } from "@db/stores/meetingStore.js";
import { reminderRowStore } from "@db/stores/reminderRowStore.js";
import { todoStore } from "@db/stores/todoStore.js";
import { postInChannel } from "@utils/cardMessage.js";
import { sendDirectMessage } from "@utils/directMessage.js";
import { mentionBatches } from "@utils/mentions.js";
import { shortId } from "@utils/shortId.js";

// ── dueReminders ────────────────────────────────────────────────────────────
// What:  every todo, meeting and personal reminder Dero sends (2026-11 item 388, owner
//        decisions D14, D15, D23 and D29): scheduleRemindersFor and cancelRemindersFor keep
//        one Reminder row per (target, lead), and runDueReminders delivers the due rows once.
// Who:   todoActions and scheduledMeetings call schedule and cancel after every write;
//        ReminderScheduler's guarded minute tick calls runDueReminders; personalReminders
//        writes its own rows and runDueReminders delivers them.
// How:   each due row is CLAIMED pending to firing in one conditional write before anything
//        is sent (the partyGameStore claimOpen shape), so two ticks or two processes racing
//        deliver it once, and a restart never sends what already went. A row past the late
//        window is closed as missed, never sent (A9). A row a restart left firing is closed as
//        missed too, never sent again, and its todo's or meeting's leads are planned again, since
//        scheduling leaves a firing row alone (2026-11 item 420, L8).
// Does NOT: touch the KvK reminders (ReminderJob, ReminderLog), which are occurrence shaped
//        and post to the announcements channel by invariant 1.

/** What a reminder is scheduled for. */
export type ReminderTarget = { kind: "todo"; todo: ITodo } | { kind: "meeting"; meeting: IMeeting };

interface PlannedLead {
	leadKey: ReminderLeadKey;
	fireAt: Date;
}

const toSeconds = (date: Date): number => Math.floor(new Date(date).getTime() / 1000);

// The leads a target wants right now. A todo wants them only while open with a due date,
// a meeting only while scheduled with a start; anything else wants none, which cancels them.
function plannedLeads(target: ReminderTarget): PlannedLead[] {
	const { REMINDERS } = BOT_CONSTANTS;
	if (target.kind === "todo") {
		const { status, dueAt } = target.todo;
		if (status !== "open" || !dueAt) return [];
		const due = new Date(dueAt);
		return [
			{ leadKey: "todo_lead", fireAt: new Date(due.getTime() - REMINDERS.TODO_LEAD_MS) },
			{ leadKey: "todo_due", fireAt: due },
		];
	}
	const { status, scheduledFor } = target.meeting;
	if (status !== "scheduled" || !scheduledFor) return [];
	const start = new Date(scheduledFor);
	return [
		{ leadKey: "meeting_lead", fireAt: new Date(start.getTime() - REMINDERS.MEETING_LEAD_MS) },
		{ leadKey: "meeting_start", fireAt: start },
	];
}

const LEAD_KEYS_BY_KIND: Readonly<Record<ReminderTarget["kind"], readonly ReminderLeadKey[]>> = {
	todo: ["todo_lead", "todo_due"],
	meeting: ["meeting_lead", "meeting_start"],
};

/**
 * Bring a todo's or a meeting's reminder rows in line with the row as it now stands: one
 * pending row per lead still ahead (upserted, never a second row: R5 of the plan's session
 * notes), and every other lead cancelled. A lead already behind `now` (a todo due in 30
 * minutes has no 1 hour lead) is cancelled rather than sent at once as late.
 */
export async function scheduleRemindersFor(target: ReminderTarget, now: Date = new Date()): Promise<void> {
	const targetId = target.kind === "todo" ? target.todo.todoId : target.meeting.meetingId;
	const guildId = target.kind === "todo" ? target.todo.guildId : target.meeting.guildId;
	// The row records who a todo reminder is for at the time it was planned; delivery reads the
	// todo again, so a reassign between the two still reaches the current holder (G2, D4).
	const userId = target.kind === "todo" ? (target.todo.assigneeId ?? target.todo.createdBy) : null;
	const ahead = plannedLeads(target).filter((lead) => lead.fireAt.getTime() > now.getTime());
	for (const leadKey of LEAD_KEYS_BY_KIND[target.kind]) {
		const lead = ahead.find((candidate) => candidate.leadKey === leadKey);
		if (!lead) {
			await reminderRowStore.cancelLead(targetId, leadKey);
			continue;
		}
		await reminderRowStore.upsertPending(targetId, leadKey, { reminderId: shortId(), guildId, kind: target.kind, userId, channelId: null, fireAt: lead.fireAt });
	}
}

/** Cancel every pending reminder of a todo or a meeting, for one done, deleted or cancelled. */
export async function cancelRemindersFor(targetId: string): Promise<void> {
	await reminderRowStore.cancelForTarget(targetId);
}

// ── delivery ────────────────────────────────────────────────────────────────

interface DeliveryContext {
	client: Client;
	copy: IPluginCopy;
	serverName: string;
	todosChannelId: string | null;
	meetingNotesChannelId: string | null;
	late: boolean;
}

/** What one claimed row came to: delivered one way or another, or nothing to send (missed). */
type DeliveryOutcome = ReminderDelivery | "nothing";

const pingOnly = (userIds: string[]) => ({ users: userIds, roles: [] as string[], parse: [] as never[] });

function withLateNote(line: string, context: DeliveryContext): string {
	return context.late ? `${line}\n-# ${context.copy.todoReminders.reminders.lateNote}` : line;
}

// A DM first; when Discord refuses it (closed or failed), the member is pinged in the
// fallback channel instead, so the reminder still reaches them (D15).
async function directOrChannel(context: DeliveryContext, userId: string, dmLine: string, fallbackChannelId: string | null, channelLine: string): Promise<ReminderDelivery> {
	const dm = await sendDirectMessage(context.client, userId, { content: withLateNote(dmLine, context) });
	if (dm === "sent") return "dm";
	if (!fallbackChannelId) return "failed";
	const posted = await postInChannel(context.client, fallbackChannelId, { content: withLateNote(channelLine, context), allowedMentions: pingOnly([userId]) });
	return posted ? "channel" : "failed";
}

async function deliverTodo(row: IReminder, context: DeliveryContext): Promise<DeliveryOutcome> {
	// A removed ✅todos stops todo reminders and keeps the rows (D18): nothing is sent.
	if (!context.todosChannelId || !row.targetId) return "nothing";
	const todo = await todoStore.findById(row.guildId, row.targetId);
	if (!todo || todo.status !== "open" || !todo.dueAt) return "nothing";
	const words = context.copy.todoReminders.todos.reminder;
	const isLead = row.leadKey === "todo_lead";
	const dueSeconds = toSeconds(todo.dueAt);
	const recipient = todo.assigneeId ?? todo.createdBy;
	if (!recipient) {
		// A dashboard todo nobody holds has nobody to ping (owner decision D4): it is said in
		// ✅todos with no mention at all.
		const line = isLead ? words.unownedLead(todo.text, dueSeconds) : words.unownedDue(todo.text);
		const posted = await postInChannel(context.client, context.todosChannelId, { content: withLateNote(line, context), allowedMentions: pingOnly([]) });
		return posted ? "channel" : "failed";
	}
	const mention = `<@${recipient}>`;
	return directOrChannel(
		context,
		recipient,
		isLead ? words.dmLead(context.serverName, todo.text, dueSeconds) : words.dmDue(context.serverName, todo.text),
		context.todosChannelId,
		isLead ? words.channelLead(mention, todo.text, dueSeconds) : words.channelDue(mention, todo.text)
	);
}

// One message per batch of people, each with the whole line and the late note, because a full
// RSVP list passes what one message may hold (2026-11 item 420, L14). Delivered once any was
// accepted: the row is at most once, so a refused batch is counted in the log, never sent again.
async function deliverMeeting(row: IReminder, context: DeliveryContext): Promise<DeliveryOutcome> {
	const channelId = context.meetingNotesChannelId;
	if (!channelId || !row.targetId) return "nothing";
	const meeting = await meetingStore.findById(row.guildId, row.targetId);
	if (!meeting || meeting.status !== "scheduled" || !meeting.scheduledFor) return "nothing";
	const { title } = meeting;
	const startSeconds = toSeconds(meeting.scheduledFor);
	// The host and every RSVP, each once, and exactly those ids may ping.
	const pinged = [...new Set([...(meeting.hostId ? [meeting.hostId] : []), ...meeting.rsvpIds])];
	const words = context.copy.todoReminders.meetings.reminder;
	const contentFor = (userIds: readonly string[]): string => {
		const mentions = userIds.map((id) => `<@${id}>`).join(" ");
		const line = row.leadKey === "meeting_lead" ? words.lead(mentions, title, startSeconds) : words.start(mentions, title);
		return withLateNote(line.trim(), context);
	};
	const batches = mentionBatches(pinged, contentFor([]).length);
	// With nobody to ping it is still said in the channel.
	if (batches.length === 0) batches.push([]);

	let accepted = 0;
	let unreached = 0;
	for (const batch of batches) {
		if (await postInChannel(context.client, channelId, { content: contentFor(batch), allowedMentions: pingOnly(batch) })) accepted += 1;
		else unreached += batch.length;
	}
	if (accepted < batches.length) {
		console.warn("[dueReminders] a meeting reminder was refused for part of its people", { reminderId: row.reminderId, refused: batches.length - accepted, unreached });
	}
	return accepted > 0 ? "channel" : "failed";
}

async function deliverPersonal(row: IReminder, context: DeliveryContext): Promise<DeliveryOutcome> {
	if (!row.userId || !row.text) return "nothing";
	const words = context.copy.todoReminders.reminders;
	return directOrChannel(context, row.userId, words.dm(context.serverName, row.text), row.channelId, words.channel(`<@${row.userId}>`, row.text));
}

const DELIVERERS: Readonly<Record<IReminder["kind"], (row: IReminder, context: DeliveryContext) => Promise<DeliveryOutcome>>> = {
	todo: deliverTodo,
	meeting: deliverMeeting,
	personal: deliverPersonal,
};

async function deliveryContext(client: Client, row: IReminder, now: Date): Promise<DeliveryContext> {
	const config = await guildConfigStore.findByGuildId(row.guildId);
	return {
		client,
		copy: getPluginCopy(config as unknown as ICopyConfig | null),
		serverName: client.guilds.cache.get(row.guildId)?.name ?? row.guildId,
		todosChannelId: config?.todosChannelId ?? null,
		meetingNotesChannelId: config?.meetingNotesChannelId ?? null,
		late: now.getTime() - new Date(row.fireAt).getTime() > BOT_CONSTANTS.REMINDERS.LATE_AFTER_MS,
	};
}

// One claimed row, start to finish. A row with nothing left to send, or one older than the
// late window, is closed as missed; a delivery that throws is closed as failed rather than
// left firing, since a firing row is never claimed again and would sit there for good.
async function settleClaimed(client: Client, row: IReminder, now: Date): Promise<void> {
	if (now.getTime() - new Date(row.fireAt).getTime() > BOT_CONSTANTS.REMINDERS.LATE_WINDOW_MS) {
		await reminderRowStore.markMissed(row.reminderId, now);
		return;
	}
	let outcome: DeliveryOutcome;
	try {
		outcome = await DELIVERERS[row.kind](row, await deliveryContext(client, row, now));
	} catch (error) {
		console.error("[dueReminders] a reminder delivery failed", { reminderId: row.reminderId, kind: row.kind, error: error instanceof Error ? error.name : "unknown" });
		outcome = "failed";
	}
	if (outcome === "nothing") await reminderRowStore.markMissed(row.reminderId, now);
	else await reminderRowStore.markFired(row.reminderId, outcome, now);
}

// ── a delivery a restart cut off ────────────────────────────────────────────

// The todo or meeting a closed row belonged to, as it stands now, or null when it is gone.
async function targetOf(row: IReminder): Promise<ReminderTarget | null> {
	if (!row.targetId) return null;
	if (row.kind === "todo") {
		const todo = await todoStore.findById(row.guildId, row.targetId);
		return todo ? { kind: "todo", todo } : null;
	}
	const meeting = await meetingStore.findById(row.guildId, row.targetId);
	return meeting ? { kind: "meeting", meeting } : null;
}

// At most once, as item 388 R7 asks: whether the cut off delivery reached anyone is unknown, so it
// is closed and never sent again. Planning again only writes leads still ahead, so a due date that
// was moved while the row sat firing is reminded, and one that was not is left closed.
async function closeStaleDeliveries(now: Date): Promise<void> {
	const staleBefore = new Date(now.getTime() - BOT_CONSTANTS.REMINDERS.FIRING_STALE_MS);
	for (let closed = 0; closed < BOT_CONSTANTS.REMINDERS.MAX_DELIVERIES_PER_TICK; closed++) {
		const row = await reminderRowStore.closeStaleFiring(staleBefore, now);
		if (!row) return;
		console.warn("[dueReminders] a reminder left firing was closed as missed", { reminderId: row.reminderId, kind: row.kind });
		try {
			const target = await targetOf(row);
			if (target) await scheduleRemindersFor(target, now);
		} catch (error) {
			console.error("[dueReminders] the next reminders could not be planned", { reminderId: row.reminderId, kind: row.kind, error: error instanceof Error ? error.name : "unknown" });
		}
	}
}

// ── the sweep ───────────────────────────────────────────────────────────────

// Shutdown's: the sweeps under way, and whether to claim nothing more.
const sweeps = new Set<Promise<void>>();
let isStopped = false;

/**
 * Shutdown: claim no new row from here on. Resolves once the delivery under way, if any, has
 * ended, so its row is closed rather than left firing. main.ts bounds the wait.
 */
export async function stopDueReminders(): Promise<void> {
	isStopped = true;
	await Promise.all([...sweeps]);
}

/** Forget a stop. Tests only. */
export function _resetDueReminders(): void {
	isStopped = false;
	sweeps.clear();
}

/**
 * Deliver every reminder due at `now`, at most MAX_DELIVERIES_PER_TICK of them; the rest wait
 * for the next tick. Never throws, so the minute tick it rides cannot be broken by it.
 */
export function runDueReminders(client: Client, now: Date = new Date()): Promise<void> {
	if (isStopped) return Promise.resolve();
	const sweep: Promise<void> = sweepDueReminders(client, now).finally(() => sweeps.delete(sweep));
	sweeps.add(sweep);
	return sweep;
}

async function sweepDueReminders(client: Client, now: Date): Promise<void> {
	// On its own, so rows that cannot be closed never hold up the ones that are due.
	await closeStaleDeliveries(now).catch((error: unknown) =>
		console.error("[dueReminders] rows left firing could not be closed", error instanceof Error ? error.name : "unknown")
	);
	try {
		for (let delivered = 0; delivered < BOT_CONSTANTS.REMINDERS.MAX_DELIVERIES_PER_TICK; delivered++) {
			if (isStopped) return;
			const row = await reminderRowStore.claimDue(now);
			if (!row) return;
			await settleClaimed(client, row, now);
		}
	} catch (error) {
		console.error("[dueReminders] the due reminder sweep failed", error instanceof Error ? error.name : "unknown");
	}
}
