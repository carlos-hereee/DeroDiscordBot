import { Meeting, type IMeeting, type MeetingStatus } from "@db/models/Meeting.js";
import type { KeysetBound } from "./keysetBound.js";

/** A meeting as the dashboard list shows it: every field but the summary, which only the detail reads. */
export type MeetingListRow = Omit<IMeeting, "summary">;
/** The people on a meeting, for the dashboard's member list. */
export type MeetingPeople = Pick<IMeeting, "hostId" | "rsvpIds" | "speakerIds">;

// ── meetingStore ──
// What:  every DB touch for Meeting (2026-11 item 388). Thin on purpose: features/meetings
//        owns the lifecycle and the order of its writes (Phases 2 to 4). House store rules
//        apply: no business logic, no tests (rule 6).

/** The fields a write may change; the ids and the guild are never rewritten. */
export type MeetingChanges = Partial<Omit<IMeeting, "meetingId" | "guildId" | "createdAt" | "updatedAt">>;

export const meetingStore = {
	/** Insert a meeting. A second live meeting in one guild is refused by the partial unique index (11000). */
	async insert(meeting: IMeeting): Promise<IMeeting> {
		const created = await Meeting.create(meeting);
		return created.toObject();
	},

	async findById(guildId: string, meetingId: string): Promise<IMeeting | null> {
		return Meeting.findOne({ guildId, meetingId }).lean<IMeeting>();
	},

	/** The guild's one live recording, or null. */
	async findRecording(guildId: string): Promise<IMeeting | null> {
		return Meeting.findOne({ guildId, status: "recording" }).lean<IMeeting>();
	},

	/** Every meeting still marked recording in any guild, for the boot recovery. */
	async findAllRecording(): Promise<IMeeting[]> {
		return Meeting.find({ status: "recording" }).lean<IMeeting[]>();
	},

	/** Every meeting still waiting for its summary that ended at or before `before`, for the repair pass. */
	async findSummarizingEndedBefore(before: Date): Promise<IMeeting[]> {
		return Meeting.find({ status: "summarizing", endedAt: { $lte: before } }).lean<IMeeting[]>();
	},

	/**
	 * Every open meeting (findOpenIds' statuses) in any guild that lists a speaker and has not been
	 * over since before `endedAfter`, for the removals a restart cut off. A recording has no end yet.
	 */
	async findOpenWithSpeakers(endedAfter: Date): Promise<Pick<IMeeting, "guildId" | "meetingId" | "speakerIds">[]> {
		return Meeting.find(
			{ status: { $in: ["recording", "summarizing", "failed"] }, "speakerIds.0": { $exists: true }, $or: [{ endedAt: null }, { endedAt: { $gte: endedAfter } }] },
			{ _id: 0, guildId: 1, meetingId: 1, speakerIds: 1 }
		).lean<Pick<IMeeting, "guildId" | "meetingId" | "speakerIds">[]>();
	},

	/**
	 * Move a meeting from `from` to the changes' status in one conditional write, so two
	 * ends racing (End pressed as the time cap fires) end it once. Null when another write
	 * moved it first.
	 */
	async claimTransition(guildId: string, meetingId: string, from: MeetingStatus, changes: MeetingChanges): Promise<IMeeting | null> {
		return Meeting.findOneAndUpdate({ guildId, meetingId, status: from }, { $set: changes }, { new: true }).lean<IMeeting>();
	},

	/** Apply `changes` whatever the status, for the card ids and the spend totals. */
	async update(guildId: string, meetingId: string, changes: MeetingChanges): Promise<IMeeting | null> {
		return Meeting.findOneAndUpdate({ guildId, meetingId }, { $set: changes }, { new: true }).lean<IMeeting>();
	},

	/**
	 * The meetings a withdrawal still reaches: recording, waiting for its summary, or failed, which
	 * has a transcript and no summary (2026-11 item 420). meetingConsent's removal is the one caller.
	 */
	async findOpenIds(guildId: string): Promise<string[]> {
		const rows = await Meeting.find({ guildId, status: { $in: ["recording", "summarizing", "failed"] } }, { meetingId: 1 }).lean<Pick<IMeeting, "meetingId">[]>();
		return rows.map((row) => row.meetingId);
	},

	/** Add one transcribed chunk's seconds and the cents it reserved to the meeting's totals. */
	async addUsage(guildId: string, meetingId: string, sttSeconds: number, cents: number): Promise<void> {
		await Meeting.updateOne({ guildId, meetingId }, { $inc: { sttSeconds, spentCents: cents } });
	},

	/** Add a captured member once, so a speaker who comes back is listed once. */
	async addSpeaker(guildId: string, meetingId: string, userId: string): Promise<void> {
		await Meeting.updateOne({ guildId, meetingId }, { $addToSet: { speakerIds: userId } });
	},

	/** Add or take away a member's RSVP on a scheduled meeting. Null when it is no longer scheduled. */
	async setRsvp(guildId: string, meetingId: string, userId: string, attending: boolean): Promise<IMeeting | null> {
		const change = attending ? { $addToSet: { rsvpIds: userId } } : { $pull: { rsvpIds: userId } };
		return Meeting.findOneAndUpdate({ guildId, meetingId, status: "scheduled" }, change, { new: true }).lean<IMeeting>();
	},
	/** Whether a member is on the captured list. */
	async hasSpeaker(guildId: string, meetingId: string, userId: string): Promise<boolean> {
		return (await Meeting.exists({ guildId, meetingId, speakerIds: userId })) !== null;
	},

	/** Take a member off the captured list, for a withdrawal. */
	async removeSpeaker(guildId: string, meetingId: string, userId: string): Promise<void> {
		await Meeting.updateOne({ guildId, meetingId }, { $pull: { speakerIds: userId } });
	},

	/** True when there was a row to delete. */
	async remove(guildId: string, meetingId: string): Promise<boolean> {
		const result = await Meeting.deleteOne({ guildId, meetingId });
		return result.deletedCount > 0;
	},

	/** One page of a server's meetings, newest first, after `before`, without the summary (the dashboard list, 2026-11 item 388 Phase 5a). */
	async listPage(guildId: string, statuses: readonly MeetingStatus[] | null, before: KeysetBound | null, limit: number): Promise<MeetingListRow[]> {
		const filter: Record<string, unknown> = { guildId };
		if (statuses) filter.status = { $in: [...statuses] };
		if (before) filter.$or = [{ createdAt: { $lt: before.createdAt } }, { createdAt: before.createdAt, meetingId: { $lt: before.id } }];
		return Meeting.find(filter).select("-_id -__v -summary").sort({ createdAt: -1, meetingId: -1 }).limit(limit).lean<MeetingListRow[]>();
	},

	/** The people on a server's most recently changed meetings, for the dashboard's member list. */
	async recentPeople(guildId: string, limit: number): Promise<MeetingPeople[]> {
		return Meeting.find({ guildId }, { _id: 0, hostId: 1, rsvpIds: 1, speakerIds: 1 }).sort({ updatedAt: -1 }).limit(limit).lean<MeetingPeople[]>();
	},

	// Self destruct's server data delete: every row this guild owns.
	async deleteGuild(guildId: string) {
		return Meeting.deleteMany({ guildId });
	},
};
