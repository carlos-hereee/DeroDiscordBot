// src/db/models/MeetingTranscriptSegment.ts
import mongoose from "mongoose";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";

// ── MeetingTranscriptSegment ──
// What:  the words one consenting member said in one chunk of a recorded meeting (2026-11
//        item 388): who, when in the meeting, how long, and the speech to text result.
// Who:   features/meetings (Phase 3) writes one row per chunk through meetingTranscriptStore;
//        the summary job (Phase 4) reads a meeting's rows in order. Nothing else reads them.
// Where: guild scoped (invariant 2). This is the ONE model built to hold what people said,
//        which is why privacyTripwire.test.ts names it on its allowlist and nowhere else.
//
// ⚠️ THE WORDS EXPIRE. The TTL index below deletes every row
// BOT_CONSTANTS.MEETINGS.TRANSCRIPT_TTL_DAYS after it was written (owner decision D7), and
// a member's Stop recording me deletes their rows from meetings not yet summarized. Audio
// is never stored, here or anywhere. Never log a row's text.

export interface IMeetingTranscriptSegment {
	meetingId: string;
	guildId: string;
	speakerId: string;
	// Where in the meeting the chunk started, and how long it ran.
	offsetMs: number;
	durationMs: number;
	text: string;
	createdAt: Date;
}

const meetingTranscriptSegmentSchema = new mongoose.Schema<IMeetingTranscriptSegment>({
	meetingId: { type: String, required: true },
	guildId: { type: String, required: true },
	speakerId: { type: String, required: true },
	offsetMs: { type: Number, required: true, min: 0 },
	durationMs: { type: Number, required: true, min: 0 },
	text: { type: String, required: true },
	createdAt: { type: Date, required: true, default: () => new Date() },
});

// The summary job's read: one meeting's words in the order they were said.
meetingTranscriptSegmentSchema.index({ meetingId: 1, offsetMs: 1 });
// A member's Stop recording me deletes their rows from the meetings in their server.
meetingTranscriptSegmentSchema.index({ guildId: 1, speakerId: 1 });
// ⚠️ REQUIRED, the retention promise itself: MongoDB deletes each row this long after it was written.
meetingTranscriptSegmentSchema.index({ createdAt: 1 }, { expireAfterSeconds: BOT_CONSTANTS.MEETINGS.TRANSCRIPT_TTL_DAYS * 24 * 60 * 60 });

export const MeetingTranscriptSegment = mongoose.model<IMeetingTranscriptSegment>("MeetingTranscriptSegment", meetingTranscriptSegmentSchema);
