import { MemberTimezone, type IMemberTimezone } from "@db/models/MemberTimezone.js";

// ── memberTimezoneStore ──
// What:  every DB touch for MemberTimezone (2026-11 item 388). Thin on purpose: whether a
//        zone is valid and which zone a time is read in are features/reminders' (Phase 2).
//        House store rules apply: no business logic, no tests (rule 6).

export const memberTimezoneStore = {
	/** A member's own zone in one server, or null when they never set one. */
	async findZone(guildId: string, userId: string): Promise<string | null> {
		const row = await MemberTimezone.findOne({ guildId, userId }, { timezone: 1 }).lean<Pick<IMemberTimezone, "timezone">>();
		return row?.timezone ?? null;
	},

	async setZone(guildId: string, userId: string, timezone: string): Promise<void> {
		await MemberTimezone.updateOne({ guildId, userId }, { $set: { timezone } }, { upsert: true });
	},

	// Self destruct's server data delete: every row this guild owns.
	async deleteGuild(guildId: string) {
		return MemberTimezone.deleteMany({ guildId });
	},
};
