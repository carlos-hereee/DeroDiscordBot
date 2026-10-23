// src/db/models/GameRoom.ts
import mongoose from "mongoose";
import { v4 } from "uuid";
import {
	GAME_SLUGS,
	NON_TERMINAL_ROOM_STATUSES,
	ROOM_STATUSES,
	ROOM_VISIBILITIES,
	type GameSlug,
	type RoomMove,
	type RoomSecret,
	type RoomStatus,
	type RoomVisibility,
} from "@features/game-rooms/roomTypes.js";

// ── GameRoom ──
// What:  one match of one mini game, played in its own Discord text channel, with its full
//        move list kept as an append-only transcript.
// Who:   written by RoomProvisioner (open), roomTrail (every move), roomLifecycle (finish and
//        archive) and the archive sweep. Read by every gameroom: button handler to rehydrate
//        state, and later by the dashboard's GET /api/game-rooms.
// When:  a row is born in "draft" the moment a member presses Start a challenge, and dies in
//        "archived" once the sweep deletes its channel. The row OUTLIVES the channel on
//        purpose: the transcript is the product, the channel is just where it was played.
// Where: this is the bot's first USER-keyed collection. Every other collection is keyed on a
//        guild or an event, so guild scoping here is a security boundary (invariant 2) and
//        every store method below takes guildId and filters on it.
// How:   ① the row is the single source of restart-survivable truth. The existing games keep
//        their state in a module-scoped Map, which Railway's SIGTERM destroys on every deploy;
//        anything a handler needs to resume a room after a redeploy lives HERE, and the only
//        other tier is the roomId riding in the customId. ② status drives the whole lifecycle,
//        including which rows the archive sweep may touch.

export interface IGameRoom {
	roomId: string;
	guildId: string;
	game: GameSlug;
	hostId: string;
	// Write access inside the room. Always includes hostId.
	playerIds: string[];
	// Explicit read-only spectators. Populated in "invite" mode only; a public room expresses
	// spectatorship with a single @everyone overwrite instead, so this stays empty.
	spectatorIds: string[];
	visibility: RoomVisibility;
	// Null until RoomProvisioner creates the channel, and meaningful again only until the
	// sweep deletes it. A non-null channelId does NOT prove the channel still exists.
	channelId: string | null;
	// The pinned opener card inside the room.
	openerMessageId: string | null;
	// The CODE of the guild invite minted at open (discord.gg/<code>), or null when the
	// mint failed or was skipped. Stored as the code rather than the full URL so the
	// renderer owns the URL shape. Nothing queries by it, so it carries no index.
	inviteCode: string | null;
	// The live card on the ⚔️challenges board, edited as the challenge progresses.
	boardMessageId: string | null;
	status: RoomStatus;
	// The FINISHED room this one was opened as a rematch of, or null. Written once at
	// create and used as the idempotency key for the Rematch button: a finished room's
	// result card stays clickable for the whole archive window, and without this a
	// scrolled-back second press would spawn a room per click. Queried by
	// findByRematchedFrom, rarely enough that it carries no index.
	rematchedFromRoomId: string | null;
	// Monopoly only: whether the host opened the match with auctions on. Set on the DRAFT
	// by the card's toggle and read once, when the provisioner seeds the match, which then
	// carries it in its own settings; nothing reads this field after the match starts.
	monopolyAuctions: boolean;
	// Monopoly only: whether the host opened the match with Dero as its voice referee.
	// Set on the DRAFT by the card's toggle like the auction choice, but unlike it,
	// read on EVERY move (roomMonopolyReferee), because the match state never copies it.
	monopolyReferee: boolean;
	// Hangman's hidden word and hint stack. Null for duel and rps, which have no secret.
	secret: RoomSecret | null;
	moves: RoomMove[];
	winnerId: string | null;
	startedAt: Date | null;
	endedAt: Date | null;
	// The moment the sweep may delete this room's channel. See the index note below: this is
	// written by roomLifecycle.finish and by nothing else, which is what makes the sweep safe.
	archiveAt: Date | null;
	// Stamped by the schema's timestamps option on every write, which is what the idle
	// sweep reads as a room's last action for every game but Hold'em.
	createdAt?: Date;
	updatedAt?: Date;
}

// One entry in the append-only scroll. _id is disabled because these are a transcript, not
// addressable documents: nothing ever looks a move up by id, and a per-move ObjectId would add
// 12 bytes and a pointless index-shaped field to every row.
const roomMoveSchema = new mongoose.Schema<RoomMove>(
	{
		actorId: { type: String, required: true },
		at: { type: Date, required: true },
		kind: { type: String, required: true },
		text: { type: String, required: true },
		// Mixed on purpose: each game stashes its own structured detail here (the resulting
		// hangman mask, a dice roll, an rps pair) for the future dashboard. It is PERSISTED but
		// never rendered into Discord, so widening it later needs no migration.
		meta: { type: mongoose.Schema.Types.Mixed, default: undefined },
	},
	{ _id: false }
);

const gameRoomSchema = new mongoose.Schema<IGameRoom>(
	{
		// Rides every customId, so it must be stable and URL/customId safe. uuid v4 matches
		// PlayerActivity.activityId. `unique` here declares the index; do NOT also declare it
		// via schema.index() or Mongoose 8 logs a duplicate-index warning on every boot.
		roomId: { type: String, required: true, unique: true, default: v4 },
		// Deliberately NOT `index: true`. The { guildId, status } compound below already serves
		// every guildId-only query as its prefix, so a standalone index here would cost a write
		// on every move append and buy nothing.
		guildId: { type: String, required: true },
		// Spread the readonly const tuples into mutable arrays: Mongoose's enum option is typed
		// as any[] and will not accept a `readonly` tuple directly.
		game: { type: String, required: true, enum: [...GAME_SLUGS] },
		hostId: { type: String, required: true },
		playerIds: { type: [String], default: [] },
		spectatorIds: { type: [String], default: [] },
		visibility: { type: String, required: true, enum: [...ROOM_VISIBILITIES], default: "invite" },
		channelId: { type: String, default: null },
		openerMessageId: { type: String, default: null },
		inviteCode: { type: String, default: null },
		boardMessageId: { type: String, default: null },
		status: { type: String, required: true, enum: [...ROOM_STATUSES], default: "draft" },
		rematchedFromRoomId: { type: String, default: null },
		// Off by default, so a row written before the field existed reads as auctions off.
		monopolyAuctions: { type: Boolean, default: false },
		// Off by default for the same reason: an older row reads as no referee.
		monopolyReferee: { type: Boolean, default: false },
		// Mixed rather than a typed subdocument: only hangman populates it, its shape will grow
		// as other games gain hidden state, and a strict subschema here would silently drop the
		// next game's fields the way GuildConfig.schedulePaused was dropped before it was declared.
		secret: { type: mongoose.Schema.Types.Mixed, default: null },
		moves: { type: [roomMoveSchema], default: [] },
		winnerId: { type: String, default: null },
		startedAt: { type: Date, default: null },
		endedAt: { type: Date, default: null },
		archiveAt: { type: Date, default: null },
	},
	{ timestamps: true }
);

// ── Indexes ──

// Per-guild cap (GAME_ROOM_MAX_PER_GUILD) and the "what is live in this guild" reads. Also
// serves guildId-only queries as a prefix, which is why guildId carries no index of its own.
gameRoomSchema.index({ guildId: 1, status: 1 });

// ── The one-open-room-per-host rule, enforced by Mongo ──
// What:  a host may hold exactly ONE non-terminal room per guild (requirement F11).
// Who:   RoomProvisioner relies on this; gameRoomStore.findOpenByHost is the friendly
//        pre-check that produces a jump link instead of a duplicate-key error.
// When:  on every insert or status change into draft/open/playing.
// Where: the enforcement deliberately lives HERE and not only in application code. The
//        in-memory Map the existing challengeFlow uses for the same job dies on every Railway
//        deploy, so a redeploy mid-draft would let a host open a second room. A unique index
//        survives the process.
// How:   PARTIAL so it constrains only live rooms. Without the filter, a host's second ever
//        room would collide with their first finished one and nobody could play twice. The
//        filter list is imported, not retyped, so the index and the store queries that depend
//        on it cannot drift apart.
gameRoomSchema.index(
	{ guildId: 1, hostId: 1 },
	{ unique: true, partialFilterExpression: { status: { $in: [...NON_TERMINAL_ROOM_STATUSES] } } }
);

// The archive sweep's query, exactly: status "finished" AND archiveAt <= now. Leading with
// status keeps the scan off the far larger set of archived rows.
gameRoomSchema.index({ status: 1, archiveAt: 1 });

// The future dashboard's "show me my game history in this guild" query. playerIds is an array,
// so this is a multikey index; endedAt descending gives the newest-first cursor for free.
gameRoomSchema.index({ guildId: 1, playerIds: 1, endedAt: -1 });

// ── Retention NOTE (deliberately no TTL) ──
// Mirrors PlayerActivity: this collection is the historical record the dashboard reads back,
// not throwaway dedup state, so a blind TTL would silently delete a guild's game history.
// "archived" means the Discord channel is gone, NOT that the row should be. Retention stays an
// owner decision, opt-in via an env var plus a daily cron, the same shape as the PlayerActivity
// retention sweep. The { guildId, status } index above is what a future pruner would range-scan.

export const GameRoom = mongoose.model<IGameRoom>("GameRoom", gameRoomSchema);
