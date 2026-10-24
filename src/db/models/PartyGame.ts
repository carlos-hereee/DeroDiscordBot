// src/db/models/PartyGame.ts
import mongoose from "mongoose";

// ── PartyGame ──
// What:  one scheduled party game per row (post-launch plan item 3): which game, when
//        it starts, how long it runs, how many may come, and who said they will or
//        will not. Written when an admin submits the schedule modal in 🎉party-games.
// Who:   features/game-rooms/partyGamesSchedule.ts only, through partyGameStore. The
//        RSVP card in 🔜upcoming-events is drawn from this row on every press.
// Where: guild scoped like every row here (invariant 2), and keyed by its own id, which
//        rides the RSVP buttons' customIds.
//
// ⚠️ THE ATTENDEE LIST LIVES HERE, NOT ON THE CARD. The plan sketched it as an embed
// field, but two members pressing I will attend in the same tick would each read the
// same field and write it back, and one of them would vanish; a capped list read off an
// embed cannot refuse the seat past the cap atomically either. $addToSet with a size
// guard on this row does both in one server side write.

export interface IPartyGame {
	guildId: string;
	partyGameId: string;
	game: "hangman";
	hostId: string;
	startAt: Date;
	durationMinutes: number;
	// 0 means no cap.
	maxAttendees: number;
	attendeeIds: string[];
	declinedIds: string[];
	// The RSVP card in 🔜upcoming-events and the line in 📢announcements, for edits.
	rsvpChannelId: string | null;
	rsvpMessageId: string | null;
	announcementMessageId: string | null;
	createdAt: Date;
}

const partyGameSchema = new mongoose.Schema<IPartyGame>(
	{
		guildId: { type: String, required: true },
		partyGameId: { type: String, required: true },
		game: { type: String, required: true, enum: ["hangman"] },
		hostId: { type: String, required: true },
		startAt: { type: Date, required: true },
		durationMinutes: { type: Number, required: true },
		maxAttendees: { type: Number, required: true, default: 0 },
		attendeeIds: { type: [String], default: [] },
		declinedIds: { type: [String], default: [] },
		rsvpChannelId: { type: String, default: null },
		rsvpMessageId: { type: String, default: null },
		announcementMessageId: { type: String, default: null },
	},
	{ timestamps: { createdAt: true, updatedAt: false } }
);

partyGameSchema.index({ guildId: 1, partyGameId: 1 }, { unique: true });

export const PartyGame = mongoose.model<IPartyGame>("PartyGame", partyGameSchema);
