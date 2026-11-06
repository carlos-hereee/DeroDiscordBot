import { ChipGift, type IChipGift } from "@db/models/ChipGift.js";

// ── chipGiftStore ──
// What:  every DB touch for ChipGift, the gifts `/platform birthday-gift` sets aside.
// Who:   features/economy/chipGift.ts, which owns the order of the writes. House store
//        rules apply: no business logic, no tests (rule 6).

/** A stored gift with the id its wallet receipt is keyed by. */
export type StoredChipGift = IChipGift & { _id: unknown };

export const chipGiftStore = {
	/** Save a member's waiting gift, or correct the one already waiting. */
	async savePending(gift: Pick<IChipGift, "userId" | "chips" | "grantedBy" | "grantedAt">): Promise<void> {
		const { userId, ...fields } = gift;
		await ChipGift.updateOne({ userId, status: "pending" }, { $set: fields }, { upsert: true });
	},

	async findPending(userId: string): Promise<StoredChipGift | null> {
		return ChipGift.findOne({ userId, status: "pending" }).lean<StoredChipGift>();
	},

	async hasRedeemed(userId: string): Promise<boolean> {
		return (await ChipGift.exists({ userId, status: "redeemed" })) !== null;
	},

	async markRedeemed(giftId: unknown, now: Date): Promise<void> {
		await ChipGift.updateOne({ _id: giftId, status: "pending" }, { $set: { status: "redeemed", redeemedAt: now } });
	},
};
