// src/db/models/Meeting.ts
import mongoose from "mongoose";

// ── Meeting ──
// What:  one Meeting Hall meeting (2026-11 item 388): scheduled, being recorded, being
//        summarized, done, failed or cancelled; who hosted it, who was captured, its
//        notes card, and the summary the launcher wrote.
// Who:   features/meetings (Phases 2 to 4) through meetingStore, and the dashboard routes
//        (Phase 5). The notes card in 📝meeting-notes is drawn from this row.
// Where: guild scoped (invariant 2) and keyed by its own 12 character id. The words said
//        live in MeetingTranscriptSegment, never here, so this row outlives the 30 day
//        transcript; the summary stays until the meeting is deleted.
//
// hostId is null for a meeting scheduled from the dashboard (owner decision D4).

export const MEETING_STATUSES = ["scheduled", "recording", "summarizing", "done", "failed", "cancelled"] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

export const MEETING_END_REASONS = ["host", "cap_time", "cap_spend", "empty_room", "interrupted", "session_end"] as const;
export type MeetingEndReason = (typeof MEETING_END_REASONS)[number];

export interface IMeetingActionItem {
	text: string;
	// The name the summary gave, and the consenting speaker it matched, if any.
	assigneeName: string | null;
	assigneeId: string | null;
}

export interface IMeetingSummary {
	text: string;
	decisions: string[];
	actionItems: IMeetingActionItem[];
}

export interface IMeeting {
	meetingId: string;
	guildId: string;
	title: string;
	status: MeetingStatus;
	endReason: MeetingEndReason | null;
	hostId: string | null;
	scheduledFor: Date | null;
	rsvpIds: string[];
	startedAt: Date | null;
	endedAt: Date | null;
	// The consenting members whose speech was captured.
	speakerIds: string[];
	notesChannelId: string | null;
	notesMessageId: string | null;
	scheduleMessageId: string | null;
	summary: IMeetingSummary | null;
	sttSeconds: number;
	spentCents: number;
	createdAt?: Date;
	updatedAt?: Date;
}

const actionItemSchema = new mongoose.Schema<IMeetingActionItem>(
	{
		text: { type: String, required: true },
		assigneeName: { type: String, default: null },
		assigneeId: { type: String, default: null },
	},
	{ _id: false }
);

const summarySchema = new mongoose.Schema<IMeetingSummary>(
	{
		text: { type: String, required: true },
		decisions: { type: [String], default: () => [] as string[] },
		actionItems: { type: [actionItemSchema], default: () => [] as IMeetingActionItem[] },
	},
	{ _id: false }
);

const meetingSchema = new mongoose.Schema<IMeeting>(
	{
		meetingId: { type: String, required: true },
		guildId: { type: String, required: true },
		title: { type: String, required: true },
		status: { type: String, enum: MEETING_STATUSES, required: true },
		endReason: { type: String, enum: [...MEETING_END_REASONS, null], default: null },
		hostId: { type: String, default: null },
		scheduledFor: { type: Date, default: null },
		rsvpIds: { type: [String], default: () => [] as string[] },
		startedAt: { type: Date, default: null },
		endedAt: { type: Date, default: null },
		speakerIds: { type: [String], default: () => [] as string[] },
		notesChannelId: { type: String, default: null },
		notesMessageId: { type: String, default: null },
		scheduleMessageId: { type: String, default: null },
		summary: { type: summarySchema, default: null },
		sttSeconds: { type: Number, default: 0, min: 0 },
		spentCents: { type: Number, default: 0, min: 0 },
	},
	{ timestamps: true }
);

meetingSchema.index({ guildId: 1, meetingId: 1 }, { unique: true });
// The dashboard list, newest first, and the boot recovery's read of meetings still marked live.
meetingSchema.index({ guildId: 1, status: 1, createdAt: -1 });
// ⚠️ REQUIRED: one live meeting per server, held by the database rather than a Map, because
// a Map dies on every Railway deploy. PARTIAL, so every finished meeting leaves the guild's
// one slot free for the next.
meetingSchema.index({ guildId: 1 }, { unique: true, partialFilterExpression: { status: "recording" } });
// The scheduled meeting reminders' read.
meetingSchema.index({ status: 1, scheduledFor: 1 });

export const Meeting = mongoose.model<IMeeting>("Meeting", meetingSchema);
