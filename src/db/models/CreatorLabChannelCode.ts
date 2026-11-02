// src/db/models/CreatorLabChannelCode.ts
import mongoose from "mongoose";

// ── Dero: Creator Lab live channel codes (2026-11 item 284 Phase 3) ──
// One short lived, single use code per Discord CHANNEL, shown privately by /creator-lab-live-link to a
// member with Manage Server. An app admin pastes it into Creator Lab's Live capture settings,
// nexious-server redeems it at the signed /api/creator-lab/live-link/redeem, and the app's /highlight
// and /count then write from this channel. Seeing the code proves control of the channel; pasting it
// proves the Company Uno side; neither can claim the other alone. The CreatorLabLinkCode shape keyed by
// a channel instead of a person. A TTL index reaps the rows.
export interface ICreatorLabChannelCode {
	code: string;
	guildId: string;
	channelId: string;
	// The names when the code was issued, so the settings panel can say which channel is linked.
	guildName: string;
	channelName: string;
	// Who ran the command: audit only, the server never scopes anything by it.
	discordUserId: string;
	expiresAt: Date;
	// null until redeemed; the atomic redeem flips it, which is what makes a code single use.
	consumedAt: Date | null;
}

const creatorLabChannelCodeSchema = new mongoose.Schema<ICreatorLabChannelCode>({
	// uppercase:true so the stored value always matches the uppercased lookup in redeem.
	code: { type: String, required: true, unique: true, uppercase: true },
	guildId: { type: String, required: true },
	channelId: { type: String, required: true, index: true },
	guildName: { type: String, default: "" },
	channelName: { type: String, default: "" },
	discordUserId: { type: String, required: true },
	expiresAt: { type: Date, required: true },
	consumedAt: { type: Date, default: null },
});

// Mongo's TTL monitor deletes a row once expiresAt passes (it lags up to a minute, so redeem
// re-checks expiresAt itself).
creatorLabChannelCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const CreatorLabChannelCode = mongoose.model<ICreatorLabChannelCode>("CreatorLabChannelCode", creatorLabChannelCodeSchema);
