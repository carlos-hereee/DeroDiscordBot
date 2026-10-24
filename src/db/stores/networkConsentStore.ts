// src/db/stores/networkConsentStore.ts
import { NetworkConsent, type INetworkConsent } from "@db/models/NetworkConsent.js";

// ── Network consent store ──
// Every DB touch for NetworkConsent. Thin on purpose: features/game-rooms/networkRules.ts
// decides what counts as consent (the version), and features/ratings decides who is
// shown where. The store reads one member's row or a list's consenting members in one
// query, writes an acceptance as one upsert, deletes a member's row, and claims the tag
// notice's 30 day throttle atomically.

export const networkConsentStore = {
	/** One member's row, or null when they never accepted (or left the network). */
	async findByUserId(userId: string): Promise<INetworkConsent | null> {
		return NetworkConsent.findOne({ userId }).lean<INetworkConsent | null>();
	},

	/** Which of these members accepted a notice at `minVersion` or later. */
	async findConsentingUserIds(userIds: readonly string[], minVersion: number): Promise<Set<string>> {
		if (userIds.length === 0) return new Set();
		const rows = await NetworkConsent.find({ userId: { $in: [...userIds] }, version: { $gte: minVersion } }, { userId: 1 }).lean<
			Pick<INetworkConsent, "userId">[]
		>();
		return new Set(rows.map((row) => row.userId));
	},

	/** Every member who accepted a notice at `minVersion` or later, for the server ratings. */
	async allConsentingUserIds(minVersion: number): Promise<string[]> {
		const rows = await NetworkConsent.find({ version: { $gte: minVersion } }, { userId: 1 }).lean<Pick<INetworkConsent, "userId">[]>();
		return rows.map((row) => row.userId);
	},

	// Accepting twice is harmless: the version and the date move, and a tag notice stamp
	// already on the row stays, so accepting again never resets the 30 day throttle.
	async accept(userId: string, version: number, acceptedAt: Date): Promise<void> {
		await NetworkConsent.updateOne({ userId }, { $set: { version, acceptedAt }, $setOnInsert: { lastTagNoticeAt: null } }, { upsert: true });
	},

	/** Delete a member's consent. True when there was a row to delete. */
	async deleteForUser(userId: string): Promise<boolean> {
		const result = await NetworkConsent.deleteOne({ userId });
		return result.deletedCount > 0;
	},

	/**
	 * Claim the tag notice for a consenting member: stamp `now` only when their last
	 * notice is older than `cutoff` (or there was none), in one conditional write. True
	 * when this call won the claim; false when a notice went out inside the window, or
	 * the member has no consent row (tagNoticeStore covers them).
	 */
	async claimTagNotice(userId: string, cutoff: Date, now: Date): Promise<boolean> {
		const claimed = await NetworkConsent.findOneAndUpdate(
			{ userId, $or: [{ lastTagNoticeAt: null }, { lastTagNoticeAt: { $lte: cutoff } }] },
			{ $set: { lastTagNoticeAt: now } },
			{ new: true }
		).lean<INetworkConsent | null>();
		return claimed !== null;
	},
};
