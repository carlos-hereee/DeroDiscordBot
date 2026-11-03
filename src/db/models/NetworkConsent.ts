// src/db/models/NetworkConsent.ts
import mongoose from "mongoose";

// ── NetworkConsent ──
// One row per member who accepted the network notice (2026-10 item 244 Phase 5b):
// that their display name, server tag, moves and ratings may be shown in OTHER
// servers on the network. Written by the consent buttons in
// features/game-rooms/networkJoin.ts through networkConsentStore; read before any
// cross server display (a network table's doors, the network board's host line, the
// network scope boards and the server ratings). /rating network leave deletes it.
//
// ⚠️ NO ROW MEANS NO CONSENT, and nothing else may stand in for one. A member with no
// row is never named outside their own server. `version` is the notice they accepted:
// a later notice raises BOT_CONSTANTS.NETWORK.CONSENT_VERSION, and a row below it reads
// as not consented until they accept the new one.

export interface INetworkConsent {
	userId: string;
	version: number;
	acceptedAt: Date;
	// The last time this member was shown the tag notice (features/ratings/tagNotice.ts),
	// so it goes out at most once per 30 days. Null until the first one.
	lastTagNoticeAt: Date | null;
}

const networkConsentSchema = new mongoose.Schema<INetworkConsent>(
	{
		userId: { type: String, required: true },
		version: { type: Number, required: true },
		acceptedAt: { type: Date, required: true },
		lastTagNoticeAt: { type: Date, default: null },
	},
	{ timestamps: true }
);

// ⚠️ REQUIRED, not an optimization. Accepting is an upsert, and this constraint is what
// keeps a member who presses Accept twice in one tick on ONE row, which is also what lets
// /rating network leave delete their consent with a single delete.
networkConsentSchema.index({ userId: 1 }, { unique: true });

export const NetworkConsent = mongoose.model<INetworkConsent>("NetworkConsent", networkConsentSchema);
