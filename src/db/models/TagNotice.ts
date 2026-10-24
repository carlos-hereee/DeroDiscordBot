// src/db/models/TagNotice.ts
import mongoose from "mongoose";

// ── TagNotice ──
// The tag notice's 30 day throttle for a member who has NOT accepted the network
// notice (2026-10 item 244 Phase 5b). A consenting member's last notice lives on their
// NetworkConsent row (lastTagNoticeAt); a member with no consent has no such row, and
// writing one for them would read as consent, so their one timestamp lives here
// instead. Written and read only by features/ratings/tagNotice.ts through
// tagNoticeStore.
//
// It holds a user id and a date and nothing else: no server, no tag, no rating.

export interface ITagNotice {
	userId: string;
	lastNoticeAt: Date;
}

const tagNoticeSchema = new mongoose.Schema<ITagNotice>({
	userId: { type: String, required: true },
	lastNoticeAt: { type: Date, required: true },
});

// ⚠️ REQUIRED. The throttle claim is a conditional upsert, and this constraint is what
// makes two rated wins in the same tick land on one row: the second claim collides and
// sends nothing, instead of inserting a second row and a second notice.
tagNoticeSchema.index({ userId: 1 }, { unique: true });

export const TagNotice = mongoose.model<ITagNotice>("TagNotice", tagNoticeSchema);
