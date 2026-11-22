// src/db/models/MeetingSummaryJob.ts
import mongoose from "mongoose";

// ── MeetingSummaryJob ──
// What:  the durable request for one meeting's summary (2026-11 item 388, owner decision D9):
//        it waits in Mongo until the launcher's Dero brain claims it, however long the
//        launcher is away, and records how the claim went.
// Who:   features/meetings (Phase 3) creates it when a meeting ends; the summary routes
//        (Phase 4) claim it with a lease and accept its result, through meetingSummaryJobStore.
// Where: guild scoped (invariant 2), one per meeting.
//
// ⚠️ THE LEASE IS THE ONE CLAIM. A claim is a conditional write from pending (or from a
// leased job whose leaseUntil passed) that stamps a fresh leaseId; a result is accepted only
// when it echoes the job's current leaseId. A member's Stop recording me resets a leased job
// to pending with a new leaseId, so a result built from their words is refused (the D1 sub
// question answer in the plan's session notes).

export const SUMMARY_JOB_STATUSES = ["pending", "leased", "done", "failed"] as const;
export type SummaryJobStatus = (typeof SUMMARY_JOB_STATUSES)[number];

export interface IMeetingSummaryJob {
	jobId: string;
	guildId: string;
	meetingId: string;
	status: SummaryJobStatus;
	leaseId: string | null;
	leaseUntil: Date | null;
	attempts: number;
	failureCode: string | null;
	createdAt?: Date;
	updatedAt?: Date;
}

const meetingSummaryJobSchema = new mongoose.Schema<IMeetingSummaryJob>(
	{
		jobId: { type: String, required: true },
		guildId: { type: String, required: true },
		meetingId: { type: String, required: true },
		status: { type: String, enum: SUMMARY_JOB_STATUSES, default: "pending", required: true },
		leaseId: { type: String, default: null },
		leaseUntil: { type: Date, default: null },
		attempts: { type: Number, default: 0, min: 0 },
		failureCode: { type: String, default: null },
	},
	{ timestamps: true }
);

// ⚠️ REQUIRED: one job per meeting, so a meeting that ends twice queues one summary.
meetingSummaryJobSchema.index({ meetingId: 1 }, { unique: true });
meetingSummaryJobSchema.index({ jobId: 1 }, { unique: true });
// The claim's read: the oldest waiting job, or a leased one whose lease ran out.
meetingSummaryJobSchema.index({ status: 1, leaseUntil: 1, createdAt: 1 });

export const MeetingSummaryJob = mongoose.model<IMeetingSummaryJob>("MeetingSummaryJob", meetingSummaryJobSchema);
