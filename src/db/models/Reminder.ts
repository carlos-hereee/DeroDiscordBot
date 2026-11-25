// src/db/models/Reminder.ts
import mongoose from "mongoose";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";

// ── Reminder ──
// What:  one reminder to fire once (2026-11 item 388): a todo's lead or due reminder, a
//        scheduled meeting's lead or start reminder, or a member's own remind me.
// Who:   features/reminders/dueReminders.ts (Phase 2) through reminderRowStore: every todo
//        and meeting write schedules or cancels its rows, and the minute tick claims each
//        due row once and delivers it.
// Where: guild scoped (invariant 2). NOT the KvK ReminderLog (db/models/ReminderLog.ts),
//        which is event occurrence shaped and posts to the announcements channel; that is
//        why its store is reminderRowStore and not reminderStore.
//
// ⚠️ STATUS IS THE ONE DELIVERY CLAIM: pending becomes firing in one conditional write
// before anything is sent, so a restart or two overlapping ticks deliver a row once.

export const REMINDER_KINDS = ["todo", "meeting", "personal"] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];

export const REMINDER_LEAD_KEYS = ["todo_lead", "todo_due", "meeting_lead", "meeting_start", "personal"] as const;
export type ReminderLeadKey = (typeof REMINDER_LEAD_KEYS)[number];

export const REMINDER_STATUSES = ["pending", "firing", "fired", "missed", "cancelled"] as const;
export type ReminderStatus = (typeof REMINDER_STATUSES)[number];

export const REMINDER_DELIVERIES = ["dm", "channel", "failed"] as const;
export type ReminderDelivery = (typeof REMINDER_DELIVERIES)[number];

export interface IReminder {
	reminderId: string;
	guildId: string;
	kind: ReminderKind;
	// The todo or meeting a reminder belongs to; null for a personal reminder.
	targetId: string | null;
	// The member reminded: a personal reminder's owner or a todo's assignee (or creator); null for a meeting.
	userId: string | null;
	// A personal reminder's own words; null for the other kinds. Never logged.
	text: string | null;
	// Where a personal reminder falls back when the member's DMs are closed.
	channelId: string | null;
	leadKey: ReminderLeadKey;
	fireAt: Date;
	status: ReminderStatus;
	deliveredBy: ReminderDelivery | null;
	firedAt: Date | null;
	createdAt?: Date;
	updatedAt?: Date;
}

const reminderSchema = new mongoose.Schema<IReminder>(
	{
		reminderId: { type: String, required: true },
		guildId: { type: String, required: true },
		kind: { type: String, enum: REMINDER_KINDS, required: true },
		targetId: { type: String, default: null },
		userId: { type: String, default: null },
		text: { type: String, default: null, maxlength: BOT_CONSTANTS.REMINDERS.TEXT_MAX },
		channelId: { type: String, default: null },
		leadKey: { type: String, enum: REMINDER_LEAD_KEYS, required: true },
		fireAt: { type: Date, required: true },
		status: { type: String, enum: REMINDER_STATUSES, default: "pending", required: true },
		deliveredBy: { type: String, enum: [...REMINDER_DELIVERIES, null], default: null },
		firedAt: { type: Date, default: null },
	},
	{ timestamps: true }
);

reminderSchema.index({ reminderId: 1 }, { unique: true });
// The minute tick's read: the due pending rows, oldest first.
reminderSchema.index({ status: 1, fireAt: 1 });
// A member's pending personal reminders, for /remind list and the per member cap.
reminderSchema.index({ guildId: 1, userId: 1, kind: 1, status: 1 });
// ⚠️ REQUIRED: one row per todo or meeting per lead, which scheduling upserts into. Filtered
// on $type string, NOT $exists: MongoDB matches a stored null under $exists true, so an
// $exists filter would put every personal reminder (targetId null) on one key and refuse
// the second one in the whole collection.
reminderSchema.index({ targetId: 1, leadKey: 1 }, { unique: true, partialFilterExpression: { targetId: { $type: "string" } } });
// A fired row, and its private text, is deleted this long after it fired (R18). So is a cancelled
// personal row and one cut off mid delivery, whose firedAt is when they were closed and whose text
// is already gone (2026-11 item 420). A null firedAt never expires.
reminderSchema.index({ firedAt: 1 }, { expireAfterSeconds: BOT_CONSTANTS.REMINDERS.FIRED_TTL_DAYS * 24 * 60 * 60 });

export const Reminder = mongoose.model<IReminder>("Reminder", reminderSchema);
