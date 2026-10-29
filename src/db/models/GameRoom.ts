// src/db/models/GameRoom.ts
import mongoose from "mongoose";
import { v4 } from "uuid";
import {
	GAME_SLUGS,
	NON_TERMINAL_ROOM_STATUSES,
	RATING_BANDS,
	ROOM_STATUSES,
	ROOM_VISIBILITIES,
	SPECTATOR_MODES,
	type GameSlug,
	type PendingNetworkJoin,
	type RatingBand,
	type RoomMove,
	type RoomSecret,
	type RoomStatus,
	type RoomVisibility,
	type SatelliteRoom,
	type SpectatorMode,
} from "@features/game-rooms/roomTypes.js";

/** One seat's chips at a Blackjack chip table; see IGameRoom.blackjackStacks. */
export interface BlackjackStackEntry {
	userId: string;
	// What the seat paid to sit, which decides a winner and the room's coins.
	buyIn: number;
	// The seat's chips as of the last settle, outside any bet then in play.
	stack: number;
}

/** The prompt line a turn posts for the member on the clock; see IGameRoom.turnPrompt. */
export interface TurnPromptRecord {
	fingerprint: string | null;
	messageId: string | null;
	playerId: string | null;
	layout: string | null;
	played: boolean;
}

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
//        every store method below takes guildId and filters on it. A network table's
//        satellites (Phase 5a of 2026-10 item 244) live in other guilds, so the satellite
//        lookups take the REMOTE guild and match it inside the satellite entry instead.
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
	// Explicit read-only spectators. Populated only while the spectator setting is "invite";
	// a room open to spectators expresses watching with a single @everyone overwrite instead,
	// and a room with no spectators has none, so this stays empty in both.
	spectatorIds: string[];
	visibility: RoomVisibility;
	// The host's spectator setting (2026-10 item 254, Arcade 11), chosen on the challenge
	// card's draft. Null means the host never chose, which reads as the default its
	// visibility always had (roomPermissions.effectiveSpectatorMode), so no backfill is owed.
	spectatorMode: SpectatorMode | null;
	// Null until RoomProvisioner creates the channel, and meaningful again only until the
	// sweep deletes it, or until a rematch takes the channel over and this FINISHED row
	// releases it (roomLifecycle.releaseChannel), after which only the rematch row points
	// at the channel. A non-null channelId does NOT prove the channel still exists.
	channelId: string | null;
	// The pinned opener card inside the room.
	openerMessageId: string | null;
	// The CODE of the guild invite minted at open (discord.gg/<code>), or null when the
	// mint failed or was skipped (only a room everyone may watch mints one, roomInvite).
	// Stored as the code rather than the full URL so the renderer owns the URL shape, and
	// so finish can delete exactly this invite once the match is over. Nothing queries by
	// it, so it carries no index.
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
	// Whether the host opened the match with Dero as its voice referee, on Monopoly and
	// Hold'em (2026-10 item 257 Phase 4b). Set on the DRAFT by the card's toggle and read off
	// the ROW (Monopoly on every move), because no match state copies it. Null on a row
	// written before it existed, which then reads monopolyReferee below: ALWAYS read the pair
	// through roomTypes.refereeOn, never either field alone.
	referee: boolean | null;
	// The stored Monopoly flag the referee field replaced. Still read for a row written
	// before the switch (a live draft or match keeps its referee across the deploy); nothing
	// writes it any more.
	monopolyReferee: boolean;
	// When the referee's one silent notice posted (2026-10 item 254, Arcade 7): null until the
	// referee was on and could not speak, on either referee game despite the name. On the ROW
	// rather than in the match's `secret`, because every Monopoly move rewrites that blob
	// from its own read and would drop it.
	monopolyRefereeNoticeAt: Date | null;
	// The prompt line that pings the member on the clock (2026-10 item 257 Phase 4a): which turn
	// it was posted for, where it sits, and whether the turn was played through its modal. On the
	// ROW rather than in `secret`, because Hold'em and Monopoly rewrite the secret wholesale from
	// their own read and would drop it. Written only by gameRoomStore.claimTurnPrompt and
	// setTurnPromptPlayed, never by a game.
	turnPrompt: TurnPromptRecord;
	// Hold'em and Blackjack, on the DRAFT (item 257 Phase 4a; Blackjack since 2026-10 item 267): the
	// buy in the host set on the challenge card for a chip table, or null for the default. Kept
	// under its Hold'em name because the draft buy in module serves both games through it. Every
	// joiner pays it on Join, so it cannot change once anybody has paid. buyInPaidBy lists the
	// members whose wallet was charged, the ledger the refunds on decline, removal and cancel read.
	holdemBuyIn: number | null;
	buyInPaidBy: string[];
	// A Blackjack chip table's stacks (2026-10 item 267, risk R5): one entry per seat still owed
	// chips, written when the table opens and after every settle. The table itself lives in
	// blackjackHandler's process Map, so this is what a restart, the idle sweep or any other
	// finish pays back. Each cash out CLAIMS its entry first (gameRoomStore.takeBlackjackStack),
	// so a seat is paid once. Empty on a free table and on every other game.
	blackjackStacks: BlackjackStackEntry[];
	// When a member last chose a Blackjack bet or action themselves, written with the stacks.
	// The idle sweep reads it instead of updatedAt, because a timed out turn plays itself and
	// writes the row, and a table nobody touches must still end on the idle clock.
	blackjackActedAt: Date | null;
	// ── the host's say over who joins (2026-10 item 244 Phase 4) ──
	// Set on the draft by the challenge card's host controls and read on every join,
	// on the card and, for Hold'em, at the table's Buy in and Take a seat. Each
	// defaults to the behavior a room had before the controls existed, so an older
	// row reads as an open door: any band, no approval, nobody removed.
	// The rating band a joiner's rating in this game must fit (ratingEngine.fitsBand).
	ratingBand: RatingBand;
	// True turns a join into a request in pendingJoinIds that the host accepts or declines.
	requireApproval: boolean;
	// Members waiting on the host's answer. Never also in the pool or playerIds.
	pendingJoinIds: string[];
	// Members the host removed. They can never rejoin THIS room, by any button or
	// select, and a match they were removed from never moves their rating.
	kickedIds: string[];
	// Hold'em only: while true, a joiner may claim a free seat mid tournament and is
	// dealt in at the start of the next hand. The host's Open seats and Close seats.
	seatsOpen: boolean;
	// ── Dero bot opponents (2026-10 item 250 Phase 5) ──
	// botsOffered: whether this draft's card offers Play vs bots, decided when the card
	// opens from the game and the server's switch. botSeats: how many Dero bots the host
	// chose, read when the match is seeded and by a rematch. The bots themselves live in
	// the game's own state, NEVER in playerIds (game-rooms/botSeat.ts says why), and the
	// bot driver finds the rooms to drive by botSeats.
	botsOffered: boolean;
	botSeats: number;
	// The host's Casual (unrated) choice on a Hold'em, Monopoly or Battleship draft
	// (2026-10 item 254, Arcade 6). A casual match is never rated, even once every bot
	// seat went to a person, and the choice is what lets a joiner take a bot's seat
	// before the start (challengeBoard).
	casual: boolean;
	// What the card says the host's creation or Edit settings choices could not apply (a
	// refused network choice, a buy in out of range), shown under the card's settings line
	// until the next Edit settings (2026-10 item 263 Phase 2a). On the row because the card
	// is redrawn from the row at every join, and a note gone at the first join is no note.
	settingsNotes: string[];
	// ── network tables (2026-10 item 244 Phase 5a) ──
	// True for a table open to players from other servers. Only a network room may
	// carry satellites, and its players are named by display name and server tag
	// rather than by mention, because a mention of a member of another server does not
	// resolve. False on every older row, which therefore reads as a server room.
	network: boolean;
	// One linked channel per remote guild that seats players here, in the order they
	// opened. Children of THIS row: they hold no transcript, no status and no clock of
	// their own, so every room invariant stays on the host row (satelliteRooms.ts).
	satellites: SatelliteRoom[];
	// The server each member of ANOTHER server asked from, while they wait on the host's
	// Requests answer at a network table (2026-10 item 244 Phase 5b). Their id waits in
	// pendingJoinIds like anyone's; this is what tells the host's accept which server to
	// open their satellite in, since a member may share several servers with Dero.
	pendingNetworkJoins: PendingNetworkJoin[];
	// Hangman's hidden word and hint stack. Null for duel and rps, which have no secret.
	secret: RoomSecret | null;
	moves: RoomMove[];
	winnerId: string | null;
	// The players who chose Save this match to my profile when the room was archived (2026-10
	// item 257 Phase 3b). Written by nothing and read by nothing since 2026-10 item 263 decision
	// 2 made every finished match a member played list in their history by playerIds; kept, with
	// its index, so older rows need no migration.
	savedBy: string[];
	startedAt: Date | null;
	endedAt: Date | null;
	// The moment the sweep may delete this room's channel. See the index note below: this is
	// stamped by roomLifecycle.finish and by nothing else, which is what makes the sweep safe.
	// roomLifecycle.releaseChannel is the one other writer, and it only ever clears it to
	// null when a rematch takes the channel over, so the finished row stays "finished" with
	// no clock and no channel for good.
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

// A satellite is addressed by its guild and channel, never by an id of its own, so
// _id is off for the same reason the transcript's is.
const satelliteRoomSchema = new mongoose.Schema<SatelliteRoom>(
	{
		guildId: { type: String, required: true },
		channelId: { type: String, required: true },
		userIds: { type: [String], default: [] },
		tableMessageId: { type: String, default: null },
	},
	{ _id: false }
);

// A waiting remote member and the server they asked from, addressed by the member, so
// _id is off for the same reason again.
const pendingNetworkJoinSchema = new mongoose.Schema<PendingNetworkJoin>(
	{
		userId: { type: String, required: true },
		guildId: { type: String, required: true },
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
		// Null by default, so a row written before the setting existed keeps the matrix its
		// visibility gave it. Mongoose skips the enum check for null.
		spectatorMode: { type: String, enum: [...SPECTATOR_MODES, null], default: null },
		channelId: { type: String, default: null },
		openerMessageId: { type: String, default: null },
		inviteCode: { type: String, default: null },
		boardMessageId: { type: String, default: null },
		status: { type: String, required: true, enum: [...ROOM_STATUSES], default: "draft" },
		rematchedFromRoomId: { type: String, default: null },
		// Off by default, so a row written before the field existed reads as auctions off.
		monopolyAuctions: { type: Boolean, default: false },
		// ⚠️ NULL by default, never false: Mongoose fills a default into a row that lacks the
		// field when it loads, and a false there would hide an older Monopoly row's
		// monopolyReferee: true. Null falls through to it in roomTypes.refereeOn.
		referee: { type: Boolean, default: null },
		// Off by default for the same reason as the auctions: an older row reads as no referee.
		monopolyReferee: { type: Boolean, default: false },
		// Null on every older row, which reads as no notice posted yet.
		monopolyRefereeNoticeAt: { type: Date, default: null },
		// Nulls on every older row, which reads as no prompt posted yet.
		turnPrompt: {
			fingerprint: { type: String, default: null },
			messageId: { type: String, default: null },
			playerId: { type: String, default: null },
			layout: { type: String, default: null },
			played: { type: Boolean, default: false },
		},
		holdemBuyIn: { type: Number, default: null },
		buyInPaidBy: { type: [String], default: [] },
		blackjackStacks: {
			type: [{ _id: false, userId: { type: String, required: true }, buyIn: { type: Number, required: true }, stack: { type: Number, required: true } }],
			default: [],
		},
		blackjackActedAt: { type: Date, default: null },
		// The host controls. Every default is the open door a room had before them, so
		// no older row needs a backfill.
		ratingBand: { type: String, enum: [...RATING_BANDS], default: "any" },
		requireApproval: { type: Boolean, default: false },
		pendingJoinIds: { type: [String], default: [] },
		// No index: a lookup always arrives with its roomId, and the arrays stay small.
		kickedIds: { type: [String], default: [] },
		seatsOpen: { type: Boolean, default: false },
		// Off and zero by default, so an older row reads as no bots and needs no backfill.
		botsOffered: { type: Boolean, default: false },
		botSeats: { type: Number, default: 0, min: 0 },
		// Off by default, so an older row reads as the host's Rated choice and needs no backfill.
		casual: { type: Boolean, default: false },
		// Empty by default, so an older row's card shows no note and needs no backfill.
		settingsNotes: { type: [String], default: [] },
		// Off and empty by default, so an older row reads as a server room with no window
		// anywhere else, and needs no backfill.
		network: { type: Boolean, default: false },
		satellites: { type: [satelliteRoomSchema], default: [] },
		// Empty by default, so an older row has nobody waiting from another server.
		pendingNetworkJoins: { type: [pendingNetworkJoinSchema], default: [] },
		// Mixed rather than a typed subdocument: only hangman populates it, its shape will grow
		// as other games gain hidden state, and a strict subschema here would silently drop the
		// next game's fields the way GuildConfig.schedulePaused was dropped before it was declared.
		secret: { type: mongoose.Schema.Types.Mixed, default: null },
		moves: { type: [roomMoveSchema], default: [] },
		winnerId: { type: String, default: null },
		// Empty by default, so an older row reads as saved by nobody and needs no backfill.
		savedBy: { type: [String], default: [] },
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

// A member's match history in this guild (/account view:saved, gameRoomStore.findByUserInGuild).
// playerIds is an array, so this is a multikey index; endedAt descending gives the newest first
// cursor for free.
gameRoomSchema.index({ guildId: 1, playerIds: 1, endedAt: -1 });

// The old saved matches read (item 257 Phase 3b), unused since the match history reads playerIds
// above. Kept beside it until an index cleanup drops it with savedBy. Sparse in effect, since most
// rows have an empty savedBy and contribute no index entries.
gameRoomSchema.index({ guildId: 1, savedBy: 1, endedAt: -1 });

// ── The satellite lookups (2026-10 item 244 Phase 5a) ──
// What:  a press in a satellite channel finds its host row by that channel, and a member
//        leaving ANY guild checks whether a satellite seats them. Both run on events that
//        fire for every guild the bot is in (every satellite click, every departure), so
//        each must be an index seek rather than a scan of the whole rooms history.
// How:   PARTIAL on network: true, so only network rooms are indexed at all and the
//        thousands of ordinary rooms cost these indexes nothing. A query reaches them only
//        when it names network: true itself, which every satellite query in gameRoomStore
//        does. Single field multikey indexes rather than one compound over guildId and
//        channelId: a Discord snowflake is unique across every guild, so the channel or
//        user id alone is selective, and the guildId check rides the $elemMatch filter.
gameRoomSchema.index({ "satellites.channelId": 1 }, { partialFilterExpression: { network: true } });
gameRoomSchema.index({ "satellites.userIds": 1 }, { partialFilterExpression: { network: true } });

// ── Retention NOTE (deliberately no TTL) ──
// Mirrors PlayerActivity: this collection is the historical record the dashboard reads back,
// not throwaway dedup state, so a blind TTL would silently delete a guild's game history.
// "archived" means the Discord channel is gone, NOT that the row should be. Retention stays an
// owner decision, opt-in via an env var plus a daily cron, the same shape as the PlayerActivity
// retention sweep. The { guildId, status } index above is what a future pruner would range-scan.

export const GameRoom = mongoose.model<IGameRoom>("GameRoom", gameRoomSchema);
