// src/db/models/ChipGift.ts
import mongoose from "mongoose";

// ── ChipGift ──
// What:  a chip gift the platform owner set aside for one member, redeemed once through
//        /secret-code: who it is for, how many chips, and whether it was collected.
// Who:   features/economy/chipGift.ts only, through chipGiftStore. `/platform birthday-gift`
//        writes a row and /secret-code collects it.
// Where: userId is the immutable Discord id, never a username, which a member can change.
//
// ⚠️ THIS ROW DOES NOT GUARD THE PAYMENT. The wallet does: the row's id is written into
// ChipWallet.paidGifts in the same write as the chips, so a crash anywhere pays once.
// `status` only says which gift is next, and a row still pending after a paid crash is
// closed on the member's next entry.

export const CHIP_GIFT_STATUSES = ["pending", "redeemed"] as const;
export type ChipGiftStatus = (typeof CHIP_GIFT_STATUSES)[number];

export interface IChipGift {
	userId: string;
	chips: number;
	// The owner's Discord id, for the audit trail.
	grantedBy: string;
	status: ChipGiftStatus;
	grantedAt: Date;
	redeemedAt?: Date | null;
}

const chipGiftSchema = new mongoose.Schema<IChipGift>({
	userId: { type: String, required: true },
	chips: { type: Number, required: true, min: 1 },
	grantedBy: { type: String, required: true },
	status: { type: String, enum: CHIP_GIFT_STATUSES, default: "pending", required: true },
	grantedAt: { type: Date, required: true },
	redeemedAt: { type: Date, required: false },
});

// ⚠️ REQUIRED: one waiting gift per member, so `/platform birthday-gift` run twice corrects
// the amount rather than stacking two payouts. PARTIAL, so a collected gift leaves room for
// next year's. The second index is the read of whether a member ever collected one.
chipGiftSchema.index({ userId: 1 }, { unique: true, partialFilterExpression: { status: "pending" } });
chipGiftSchema.index({ userId: 1, status: 1 });

export const ChipGift = mongoose.model<IChipGift>("ChipGift", chipGiftSchema);
