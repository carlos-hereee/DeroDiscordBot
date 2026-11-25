import { MeetingTranscriptSegment, type IMeetingTranscriptSegment } from "@db/models/MeetingTranscriptSegment.js";

// ── meetingTranscriptStore ──
// What:  every DB touch for MeetingTranscriptSegment (2026-11 item 388), the one store that
//        holds what consenting members said. Thin on purpose: features/meetings decides who
//        is captured and when a member's words are taken out. House store rules apply: no
//        business logic, no tests (rule 6). Never log what these methods read or write.

export const meetingTranscriptStore = {
	async insertSegment(segment: Omit<IMeetingTranscriptSegment, "createdAt">): Promise<void> {
		await MeetingTranscriptSegment.create(segment);
	},

	/** One meeting's words in the order they were said. Empty once the TTL has taken them. */
	async listForMeeting(guildId: string, meetingId: string): Promise<IMeetingTranscriptSegment[]> {
		return MeetingTranscriptSegment.find({ guildId, meetingId }).sort({ offsetMs: 1 }).lean<IMeetingTranscriptSegment[]>();
	},

	/** Whether a meeting kept any words, so an empty recording makes no summary job. */
	async hasAny(guildId: string, meetingId: string): Promise<boolean> {
		return (await MeetingTranscriptSegment.exists({ guildId, meetingId })) !== null;
	},

	/** Whether a meeting holds any words of this member. */
	async hasSpeaker(guildId: string, meetingId: string, speakerId: string): Promise<boolean> {
		return (await MeetingTranscriptSegment.exists({ guildId, meetingId, speakerId })) !== null;
	},

	/** Delete one member's words from these meetings, for a withdrawal. Returns how many went. */
	async deleteForSpeaker(guildId: string, meetingIds: readonly string[], speakerId: string): Promise<number> {
		if (meetingIds.length === 0) return 0;
		const result = await MeetingTranscriptSegment.deleteMany({ guildId, speakerId, meetingId: { $in: [...meetingIds] } });
		return result.deletedCount;
	},

	/** Delete a meeting's words, when the meeting itself is deleted. */
	async deleteForMeeting(guildId: string, meetingId: string): Promise<void> {
		await MeetingTranscriptSegment.deleteMany({ guildId, meetingId });
	},

	// Self destruct's server data delete: every row this guild owns.
	async deleteGuild(guildId: string) {
		return MeetingTranscriptSegment.deleteMany({ guildId });
	},
};
