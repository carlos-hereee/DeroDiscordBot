import { MeetingSummaryJob, type IMeetingSummaryJob } from "@db/models/MeetingSummaryJob.js";

// ── meetingSummaryJobStore ──
// What:  every DB touch for MeetingSummaryJob (2026-11 item 388). Thin on purpose: the lease
//        length, the attempt cap and what a result writes are the summary routes' (Phase 4).
//        Every claim is one conditional write, modeled on partyGameStore.claimOpen. House
//        store rules apply: no business logic, no tests (rule 6).

export const meetingSummaryJobStore = {
	/** Queue a meeting's summary. A second call for the same meeting is refused by the unique index (11000). */
	async create(job: Pick<IMeetingSummaryJob, "jobId" | "guildId" | "meetingId">): Promise<void> {
		await MeetingSummaryJob.create({ ...job, status: "pending", attempts: 0 });
	},

	async findByJobId(jobId: string): Promise<IMeetingSummaryJob | null> {
		return MeetingSummaryJob.findOne({ jobId }).lean<IMeetingSummaryJob>();
	},

	async findForMeeting(guildId: string, meetingId: string): Promise<IMeetingSummaryJob | null> {
		return MeetingSummaryJob.findOne({ guildId, meetingId }).lean<IMeetingSummaryJob>();
	},

	/**
	 * Claim the oldest waiting job, or a leased one whose lease ran out, in one conditional
	 * write: it becomes leased under `leaseId` until `leaseUntil`, one attempt more. Null
	 * when no job waits, or another claim won it.
	 */
	async claimJob(now: Date, leaseId: string, leaseUntil: Date): Promise<IMeetingSummaryJob | null> {
		return MeetingSummaryJob.findOneAndUpdate(
			{ $or: [{ status: "pending" }, { status: "leased", leaseUntil: { $lte: now } }] },
			{ $set: { status: "leased", leaseId, leaseUntil }, $inc: { attempts: 1 } },
			{ new: true, sort: { createdAt: 1 } }
		).lean<IMeetingSummaryJob>();
	},

	/**
	 * Close a leased job as done or failed, only while `leaseId` is still its lease, so a
	 * result for a lease that was reset or reclaimed is refused. Null when it was not.
	 */
	async finishLease(jobId: string, leaseId: string, outcome: { status: "done" | "failed"; failureCode: string | null }): Promise<IMeetingSummaryJob | null> {
		return MeetingSummaryJob.findOneAndUpdate(
			{ jobId, status: "leased", leaseId },
			{ $set: { ...outcome, leaseId: null, leaseUntil: null } },
			{ new: true }
		).lean<IMeetingSummaryJob>();
	},

	/**
	 * Hand a leased job back to pending, only while `leaseId` is still its lease, for a result
	 * that says the model could not write it: the next claim tries again and counts an attempt.
	 * False when the lease was reset or reclaimed first.
	 */
	async releaseLease(jobId: string, leaseId: string): Promise<boolean> {
		const result = await MeetingSummaryJob.updateOne({ jobId, status: "leased", leaseId }, { $set: { status: "pending", leaseId: null, leaseUntil: null } });
		return result.modifiedCount === 1;
	},

	/**
	 * Put a waiting or leased job back to pending under a new leaseId, without counting an
	 * attempt, for a member's Stop recording me: a result built before it is then refused.
	 */
	async resetLease(guildId: string, meetingId: string, leaseId: string): Promise<void> {
		await MeetingSummaryJob.updateOne(
			{ guildId, meetingId, status: { $in: ["pending", "leased"] } },
			{ $set: { status: "pending", leaseId, leaseUntil: null } }
		);
	},

	/** Mark a job failed whatever its lease, for the attempt cap and an expired transcript. */
	async markFailed(jobId: string, failureCode: string): Promise<void> {
		await MeetingSummaryJob.updateOne({ jobId, status: { $in: ["pending", "leased"] } }, { $set: { status: "failed", failureCode, leaseId: null, leaseUntil: null } });
	},

	async deleteForMeeting(guildId: string, meetingId: string): Promise<void> {
		await MeetingSummaryJob.deleteMany({ guildId, meetingId });
	},

	// Self destruct's server data delete: every row this guild owns.
	async deleteGuild(guildId: string) {
		return MeetingSummaryJob.deleteMany({ guildId });
	},
};
