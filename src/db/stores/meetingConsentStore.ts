import { MeetingConsent, type IMeetingConsent } from "@db/models/MeetingConsent.js";

// ── meetingConsentStore ──
// What:  every DB touch for MeetingConsent (2026-11 item 388). Thin on purpose: what counts
//        as consent (the version and the revoke) is features/meetings/meetingConsent.ts, on
//        utils/consentVersion.ts. House store rules apply: no business logic, no tests (rule 6).

export const meetingConsentStore = {
	/** The rows of these members in this server that are not revoked, for the version check. */
	async findActiveRows(guildId: string, userIds: readonly string[]): Promise<IMeetingConsent[]> {
		if (userIds.length === 0) return [];
		return MeetingConsent.find({ guildId, userId: { $in: [...userIds] }, revokedAt: null }).lean<IMeetingConsent[]>();
	},

	async findByMember(guildId: string, userId: string): Promise<IMeetingConsent | null> {
		return MeetingConsent.findOne({ guildId, userId }).lean<IMeetingConsent>();
	},

	/** Which of these members hold a revoked row, for the removals a restart cut off. */
	async findRevokedIds(guildId: string, userIds: readonly string[]): Promise<string[]> {
		if (userIds.length === 0) return [];
		const rows = await MeetingConsent.find({ guildId, userId: { $in: [...userIds] }, revokedAt: { $ne: null } }, { userId: 1 }).lean<Pick<IMeetingConsent, "userId">[]>();
		return rows.map((row) => row.userId);
	},

	// I agree: one upsert that also clears an earlier revoke, so a member who stopped and
	// agrees again is captured again.
	async accept(guildId: string, userId: string, version: number, acceptedAt: Date): Promise<void> {
		await MeetingConsent.updateOne({ guildId, userId }, { $set: { version, acceptedAt, revokedAt: null } }, { upsert: true });
	},

	/** No thanks or Stop recording me. True when the member had a consent to revoke. */
	async revoke(guildId: string, userId: string, revokedAt: Date): Promise<boolean> {
		const result = await MeetingConsent.updateOne({ guildId, userId, revokedAt: null }, { $set: { revokedAt } });
		return result.modifiedCount > 0;
	},

	// Self destruct's server data delete: every row this guild owns.
	async deleteGuild(guildId: string) {
		return MeetingConsent.deleteMany({ guildId });
	},
};
