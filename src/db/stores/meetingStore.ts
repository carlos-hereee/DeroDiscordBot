import { Meeting, type IMeeting, type MeetingStatus } from "@db/models/Meeting.js";

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

	/** The meetings whose transcript can still change: recording, or waiting for its summary. */
	async findOpenIds(guildId: string): Promise<string[]> {
		const rows = await Meeting.find({ guildId, status: { $in: ["recording", "summarizing"] } }, { meetingId: 1 }).lean<Pick<IMeeting, "meetingId">[]>();
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
	/** Take a member off the captured list, for Stop recording me. */
	async removeSpeaker(guildId: string, meetingId: string, userId: string): Promise<void> {
		await Meeting.updateOne({ guildId, meetingId }, { $pull: { speakerIds: userId } });
	},

	/** True when there was a row to delete. */
	async remove(guildId: string, meetingId: string): Promise<boolean> {
		const result = await Meeting.deleteOne({ guildId, meetingId });
		return result.deletedCount > 0;
	},

	// Self destruct's server data delete: every row this guild owns.
	async deleteGuild(guildId: string) {
		return Meeting.deleteMany({ guildId });
	},
};
