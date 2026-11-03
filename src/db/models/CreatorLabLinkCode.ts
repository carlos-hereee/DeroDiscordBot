// src/db/models/CreatorLabLinkCode.ts
import mongoose from "mongoose";

// ── Dero: Creator Lab link codes (2026-11 item 283 Phase 4) ──
// One short lived, single use code per Discord user, shown privately by /creator-lab-connect. The
// creator pastes it into the Creator Lab tab, nexious-server redeems it at the signed
// /api/creator-lab/link/redeem, and the platform stores which Discord account Dero DMs analysis
// summaries to. The PendingPairing shape keyed by a USER instead of a guild: a Creator Lab link
// belongs to a person, wherever they ran the command. A TTL index reaps the rows.
export interface ICreatorLabLinkCode {
	code: string;
	discordUserId: string;
	// The Discord username when the code was issued, so the tab can name the linked account.
	discordUsername: string;
	expiresAt: Date;
	// null until redeemed; the atomic redeem flips it, which is what makes a code single use.
	consumedAt: Date | null;
}

const creatorLabLinkCodeSchema = new mongoose.Schema<ICreatorLabLinkCode>({
	// uppercase:true so the stored value always matches the uppercased lookup in redeem.
	code: { type: String, required: true, unique: true, uppercase: true },
	discordUserId: { type: String, required: true, index: true },
	discordUsername: { type: String, default: "" },
	expiresAt: { type: Date, required: true },
	consumedAt: { type: Date, default: null },
});

// Mongo's TTL monitor deletes a row once expiresAt passes (it lags up to a minute, so redeem
// re-checks expiresAt itself).
creatorLabLinkCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const CreatorLabLinkCode = mongoose.model<ICreatorLabLinkCode>("CreatorLabLinkCode", creatorLabLinkCodeSchema);
