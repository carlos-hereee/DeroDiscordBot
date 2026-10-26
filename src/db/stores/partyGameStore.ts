import { PartyGame, type IPartyGame, type PartyOpenFailure } from "@db/models/PartyGame.js";

// ── partyGameStore ──
// What:  the thin Mongoose wrapper over PartyGame, the scheduled party games.
// Who:   features/game-rooms/partyGamesSchedule.ts, partyGamesOpen.ts (the timed open), and
//        self destruct's server data delete.
// Where: every query carries guildId (invariant 2), so a partyGameId replayed from another
//        server's card reaches nothing. Whether a member may RSVP, and what a full list
//        means, live in the feature; this store only writes. House store rules apply: no
//        business logic, no tests (rule 6).

type NewPartyGame = Pick<IPartyGame, "guildId" | "partyGameId" | "game" | "hostId" | "startAt" | "durationMinutes" | "maxAttendees">;

export const partyGameStore = {
	async create(row: NewPartyGame): Promise<IPartyGame> {
		const doc = await PartyGame.create(row);
		return doc.toObject();
	},

	async findById(guildId: string, partyGameId: string): Promise<IPartyGame | null> {
		return PartyGame.findOne({ guildId, partyGameId }).lean<IPartyGame>();
	},

	async setMessages(guildId: string, partyGameId: string, ids: Partial<Pick<IPartyGame, "rsvpChannelId" | "rsvpMessageId" | "announcementMessageId">>) {
		return PartyGame.findOneAndUpdate({ guildId, partyGameId }, { $set: ids }, { new: true }).lean<IPartyGame>();
	},

	// One write: join the attendees and leave the decliners. With a cap, the filter only
	// matches while the list has room (its cap-th slot is empty) or already holds this
	// member, so the seat past the cap is refused by Mongo rather than by a read. Null
	// means the list was full or the game is gone.
	async attend(guildId: string, partyGameId: string, userId: string, maxAttendees: number): Promise<IPartyGame | null> {
		const room = maxAttendees > 0 ? { $or: [{ [`attendeeIds.${maxAttendees - 1}`]: { $exists: false } }, { attendeeIds: userId }] } : {};
		return PartyGame.findOneAndUpdate(
			{ guildId, partyGameId, ...room },
			{ $addToSet: { attendeeIds: userId }, $pull: { declinedIds: userId } },
			{ new: true }
		).lean<IPartyGame>();
	},

	async decline(guildId: string, partyGameId: string, userId: string): Promise<IPartyGame | null> {
		return PartyGame.findOneAndUpdate(
			{ guildId, partyGameId },
			{ $addToSet: { declinedIds: userId }, $pull: { attendeeIds: userId } },
			{ new: true }
		).lean<IPartyGame>();
	},

	// ── the timed open (2026-10 item 254, Arcade 4) ──
	// Every game not yet opened whose start has come, oldest first, across every guild.
	async findDueToOpen(now: Date, limit: number): Promise<IPartyGame[]> {
		return PartyGame.find({ openedAt: null, startAt: { $lte: now } })
			.sort({ startAt: 1 })
			.limit(limit)
			.lean<IPartyGame[]>();
	},

	// THE claim: one conditional write on a null openedAt. Null means another tick or
	// process opened this game already.
	async claimOpen(guildId: string, partyGameId: string, now: Date): Promise<IPartyGame | null> {
		return PartyGame.findOneAndUpdate({ guildId, partyGameId, openedAt: null }, { $set: { openedAt: now } }, { new: true }).lean<IPartyGame>();
	},

	async recordOpen(guildId: string, partyGameId: string, outcome: { openedLink: string | null; openFailure: PartyOpenFailure | null }): Promise<IPartyGame | null> {
		return PartyGame.findOneAndUpdate({ guildId, partyGameId }, { $set: outcome }, { new: true }).lean<IPartyGame>();
	},

	// Self destruct's server data delete (post-launch plan item 10): every row this guild owns.
	async deleteGuild(guildId: string) {
		return PartyGame.deleteMany({ guildId });
	},
};
