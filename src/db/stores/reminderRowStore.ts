import { Reminder, type IReminder, type ReminderDelivery, type ReminderLeadKey } from "@db/models/Reminder.js";

// ── reminderRowStore ──
// What:  every DB touch for Reminder (2026-11 item 388), the todo, meeting and personal
//        reminders. Named apart from reminderStore.ts, which is the KvK ReminderLog store and
//        is not this. Thin on purpose: when a reminder fires and where it goes is
//        features/reminders/dueReminders.ts (Phase 2). Every claim is one conditional write,
//        modeled on partyGameStore.claimOpen. House store rules apply: no logic, no tests (rule 6).

/** What scheduling writes onto a todo's or a meeting's row for one lead. */
export type ScheduledReminderFields = Pick<IReminder, "reminderId" | "guildId" | "kind" | "userId" | "channelId" | "fireAt">;

export const reminderRowStore = {
	/**
	 * Write a todo's or a meeting's reminder for one lead as pending at `fireAt`, one row per
	 * (targetId, leadKey) whatever was there (R5 of the plan's session notes): a cancelled,
	 * fired or missed row is rewritten rather than duplicated. A row that is FIRING is left
	 * alone, so a delivery in progress is never reset; the filter then matches nothing and
	 * the upsert's insert collides with that row on the unique index, which is caught here.
	 */
	async upsertPending(targetId: string, leadKey: ReminderLeadKey, fields: ScheduledReminderFields): Promise<void> {
		const { reminderId, ...rest } = fields;
		try {
			await Reminder.updateOne(
				{ targetId, leadKey, status: { $ne: "firing" } },
				{ $set: { ...rest, status: "pending", deliveredBy: null, firedAt: null, text: null }, $setOnInsert: { reminderId } },
				{ upsert: true }
			);
		} catch (error) {
			// 11000 here means the row is firing right now; that delivery stands.
			if ((error as { code?: number }).code !== 11000) throw error;
		}
	},

	/** A member's own reminder, which has no target and so never collides. */
	async insertPersonal(reminder: Pick<IReminder, "reminderId" | "guildId" | "userId" | "text" | "channelId" | "fireAt">): Promise<void> {
		await Reminder.create({ ...reminder, kind: "personal", targetId: null, leadKey: "personal", status: "pending" });
	},

	/** Cancel a target's pending reminders, for a todo done or deleted or a meeting cancelled. */
	async cancelForTarget(targetId: string): Promise<void> {
		await Reminder.updateMany({ targetId, status: "pending" }, { $set: { status: "cancelled" } });
	},

	/** Cancel one lead of a target, for a lead whose time has already passed when it is scheduled. */
	async cancelLead(targetId: string, leadKey: ReminderLeadKey): Promise<void> {
		await Reminder.updateMany({ targetId, leadKey, status: "pending" }, { $set: { status: "cancelled" } });
	},
	/**
	 * Cancel one of a member's own pending reminders, its private text gone at once and `at` set
	 * as the date the empty row expires from. True when it was pending.
	 */
	async cancelPersonal(guildId: string, userId: string, reminderId: string, at: Date): Promise<boolean> {
		const result = await Reminder.updateOne(
			{ guildId, userId, reminderId, kind: "personal", status: "pending" },
			{ $set: { status: "cancelled", firedAt: at, text: null } }
		);
		return result.modifiedCount > 0;
	},

	/**
	 * Close one row left firing since `before` as missed, in one conditional write, so two processes
	 * close it once. Its text goes with it: only a personal row has any, and it will never be sent.
	 * Null when none is stale.
	 */
	async closeStaleFiring(before: Date, at: Date): Promise<IReminder | null> {
		return Reminder.findOneAndUpdate({ status: "firing", updatedAt: { $lte: before } }, { $set: { status: "missed", firedAt: at, text: null } }, { new: true }).lean<IReminder>();
	},

	/** A member's pending personal reminders in one server, soonest first. */
	async listPendingPersonal(guildId: string, userId: string): Promise<IReminder[]> {
		return Reminder.find({ guildId, userId, kind: "personal", status: "pending" }).sort({ fireAt: 1 }).lean<IReminder[]>();
	},

	/** How many personal reminders a member has waiting in one server, for the cap. */
	async countPendingPersonal(guildId: string, userId: string): Promise<number> {
		return Reminder.countDocuments({ guildId, userId, kind: "personal", status: "pending" });
	},

	/** Claim the oldest due pending row, pending to firing in one write. Null when none is due. */
	async claimDue(now: Date): Promise<IReminder | null> {
		return Reminder.findOneAndUpdate({ status: "pending", fireAt: { $lte: now } }, { $set: { status: "firing" } }, { new: true, sort: { fireAt: 1 } }).lean<IReminder>();
	},

	/** Close a claimed row as fired, saying how it was delivered. */
	async markFired(reminderId: string, deliveredBy: ReminderDelivery, firedAt: Date): Promise<void> {
		await Reminder.updateOne({ reminderId, status: "firing" }, { $set: { status: "fired", deliveredBy, firedAt } });
	},

	/** Close a claimed row as missed, for one older than the late window. */
	async markMissed(reminderId: string, at: Date): Promise<void> {
		await Reminder.updateOne({ reminderId, status: "firing" }, { $set: { status: "missed", firedAt: at } });
	},

	// Self destruct's server data delete: every row this guild owns.
	async deleteGuild(guildId: string) {
		return Reminder.deleteMany({ guildId });
	},
};
