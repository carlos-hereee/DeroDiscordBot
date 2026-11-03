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
//
// ⚠️ openedAt IS THE ONE OPEN CLAIM (2026-10 item 254, Arcade 4). The 5 minute game room
// sweep opens a game whose start has come by first setting openedAt where it is still
// null, in one conditional write, so a restart, an overlapping tick or a second process
// on a deploy opens each game at most once. It is never cleared.

// The games a party can be scheduled for. A hand kept mirror of PARTY_GAMES in
// features/game-rooms/partyGamesSchedule.ts (the data layer imports no feature), pinned
// equal by partyGamesSchedule.test.ts.
export const PARTY_GAME_SLUGS = ["hangman", "holdem", "monopoly"] as const;

// Why a scheduled game could not open at its time, shown on the RSVP card.
export const PARTY_OPEN_FAILURES = ["alreadyHosting", "noChannel", "noAccess", "alreadyRunning", "failed"] as const;
export type PartyOpenFailure = (typeof PARTY_OPEN_FAILURES)[number];

export interface IPartyGame {
	guildId: string;
	partyGameId: string;
	game: (typeof PARTY_GAME_SLUGS)[number];
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
	// Set once, by the sweep's claim, when the start time came (see the note above).
	openedAt: Date | null;
	// What the open did, for the RSVP card: the challenge card's (or the party channel's)
	// link when it opened, or why it could not. Both null until the claim, and on a game
	// whose window had already passed when the claim found it.
	openedLink: string | null;
	openFailure: PartyOpenFailure | null;
	createdAt: Date;
}

const partyGameSchema = new mongoose.Schema<IPartyGame>(
	{
		guildId: { type: String, required: true },
		partyGameId: { type: String, required: true },
		game: { type: String, required: true, enum: [...PARTY_GAME_SLUGS] },
		hostId: { type: String, required: true },
		startAt: { type: Date, required: true },
		durationMinutes: { type: Number, required: true },
		maxAttendees: { type: Number, required: true, default: 0 },
		attendeeIds: { type: [String], default: [] },
		declinedIds: { type: [String], default: [] },
		rsvpChannelId: { type: String, default: null },
		rsvpMessageId: { type: String, default: null },
		announcementMessageId: { type: String, default: null },
		// Null by default, so a row scheduled before the open existed is claimed like any other.
		openedAt: { type: Date, default: null },
		openedLink: { type: String, default: null },
		openFailure: { type: String, enum: [...PARTY_OPEN_FAILURES, null], default: null },
	},
	{ timestamps: { createdAt: true, updatedAt: false } }
);

partyGameSchema.index({ guildId: 1, partyGameId: 1 }, { unique: true });
// The sweep's question, every 5 minutes across every guild: which games have not been
// opened and are due. Every row is claimed once its start passes, so the unopened set
// stays as small as the schedule ahead.
partyGameSchema.index({ openedAt: 1, startAt: 1 });

export const PartyGame = mongoose.model<IPartyGame>("PartyGame", partyGameSchema);
