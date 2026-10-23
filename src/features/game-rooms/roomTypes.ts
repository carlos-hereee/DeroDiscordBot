// ── Game room shared types ──
// What:  the vocabulary every other game-rooms module speaks. A room is one match of one
//        mini game, played inside its own Discord text channel, whose entire history is an
//        append-only scroll persisted to Mongo.
// Who:   the GameRoom model, gameRoomStore, the provisioner, the archive sweep, the trail
//        poster, the challenge board, and (later) the dashboard API route. Everything in
//        features/game-rooms plus db/models/GameRoom.ts imports from here.
// When:  compile time only. This module is deliberately types + frozen literal lists, so it
//        can be imported from a Mongoose model without dragging feature code into the DB layer.
// Where: sits below the model in the dependency graph, so nothing here may import a store, a
//        handler, or discord.js. Keeping it dependency-free is what lets the pure modules
//        (roomPermissions, roomNaming) stay Discord-free and unit testable.
// How:   string-literal unions rather than TypeScript enums, matching the rest of the repo
//        (HangmanStartResult, ChallengeRejectionReason). The status/game lists are ALSO
//        exported as runtime arrays because Mongoose needs them for its `enum` validators and
//        the partial index filter, and a second hand-written copy of either list is how the
//        index and the query silently stop agreeing.

// ── Which game a room is playing ──
// Needing two or more humans is NECESSARY but not sufficient. Fortune is single player and
// stays a plain slash command, so it is deliberately absent. Blackjack is the case that
// shows the rest of the rule: it grew multi seat tables on 2026-08-11 and still does not
// belong here, because a hand takes a minute and a table runs in place on one edited
// message. A room is earned by DURATION and a transcript worth keeping, which is why
// battleship and holdem will join this list and a blackjack table will not.
// Monopoly is the longest of them all (2 to 6 players, played until one is left
// standing), which is exactly the duration rule above.
// The two solo- slugs are the arcade host's one-player forms, routed through the same
// provisioner so they hold the host's one-room slot, count against the guild cap, and
// count as PRIVATE rooms for the tier quota. They are their OWN slugs rather than a
// `mode: "solo"` field on hangman/blackjack so every customId, enum validator and trail
// entry is unambiguous about which form was played, and so SELF_BOARDED_GAMES can name
// solo-blackjack (rides its own edited board message) without a mode branch.
export const GAME_SLUGS = ["hangman", "coinflip", "diceroll", "rps", "battleship", "holdem", "monopoly", "solo-hangman", "solo-blackjack"] as const;
export type GameSlug = (typeof GAME_SLUGS)[number];

// ── Who may see the room ──
// "invite": @everyone is denied ViewChannel and each accepted member gets an explicit
// overwrite. "public": one @everyone overwrite grants view and denies send, so a 5000 member
// guild costs exactly the same as a 50 member one. "solo": a variant of "invite", never of
// "public" (@everyone denied ViewChannel, NO spectators, only the host in playerIds), so a
// solo room is private by construction and counts as private wherever the tier quota asks.
export const ROOM_VISIBILITIES = ["invite", "public", "solo"] as const;
export type RoomVisibility = (typeof ROOM_VISIBILITIES)[number];

// ── Lifecycle ──
// draft    the host is still choosing visibility and opponents; no channel exists yet
// open     the challenge card is live on the board, waiting for joiners
// playing  the channel exists and the match is running
// finished the match ended, the channel is locked read-only, archiveAt is stamped
// archived the channel has been deleted; the Mongo transcript is all that remains
export const ROOM_STATUSES = ["draft", "open", "playing", "finished", "archived"] as const;
export type RoomStatus = (typeof ROOM_STATUSES)[number];

// ── Non-terminal statuses ──
// What:  the statuses that count as "this host already has a room open".
// Who:   three call sites that MUST agree: the partial unique index on the GameRoom schema,
//        gameRoomStore.findOpenByHost, and gameRoomStore.countOpenInGuild.
// When:  read at schema build time (the index) and on every room-open attempt (the queries).
// Where: this is the F11 "one open room per host" rule, and it is enforced at the DATABASE by
//        the partial index rather than only in application code, so a redeploy mid-draft
//        cannot let a host slip a second room through.
// How:   exported once and spread into each `$in` filter. If this list and the index filter
//        ever diverge, the index stops covering the query it exists for and the guarantee
//        quietly evaporates with no error anywhere, which is why there is exactly one copy.
export const NON_TERMINAL_ROOM_STATUSES = ["draft", "open", "playing"] as const;

// ── How wide a host's rating band is (2026-10 item 244 Phase 4) ──
// "any" admits everyone; "close" and "tight" admit a joiner whose display rating sits
// within BOT_CONSTANTS.RATINGS.BAND_CLOSE or BAND_TIGHT of the host's. Declared HERE,
// in the dependency free vocabulary, rather than in features/ratings/ratingEngine.ts,
// because the GameRoom model needs the list for its enum validator and a model must
// not load the rating library to get it. ratingEngine re-exports it, so the band
// math and the stored value read one list.
export const RATING_BANDS = ["any", "close", "tight"] as const;
export type RatingBand = (typeof RATING_BANDS)[number];

// ── How far a server lets its challenges reach (2026-10 item 244 Phase 4) ──
// A CEILING on the visibility a host may pick, set by an admin on GuildConfig:
// "invite-only" allows invite rooms only, "server" adds public rooms (the behavior
// every server had before the setting existed, so it is the default), and "network"
// is stored now for the network tables of Phase 5, which until then reads exactly
// like "server". Here for the same reason as RATING_BANDS: the GuildConfig model
// needs the list for its enum validator.
export const CHALLENGE_REACHES = ["invite-only", "server", "network"] as const;
export type ChallengeReach = (typeof CHALLENGE_REACHES)[number];

// ── A table's window in another server (2026-10 item 244 Phase 5a) ──
// What:  one linked channel in a REMOTE guild that mirrors a network table, so a member
//        of that guild can play a seat at a table hosted somewhere they cannot see.
// Where: a CHILD of the host room row, never a room of its own. The transcript, status,
//        winner, archive clock and the one open room per host index all stay on the host
//        row; a satellite only says where the mirror lives and who plays through it.
//        satelliteRooms.ts opens, relays to, locks and deletes these.
export interface SatelliteRoom {
	// The remote guild the channel lives in. Never the host room's own guild.
	guildId: string;
	channelId: string;
	// The members of that guild seated through this channel. Only they may press a
	// control here, whatever else the room's lists say.
	userIds: string[];
	// The mirrored table message, edited in place on every relay. Null until the first
	// relay posts it. Stored on the row so a redeploy edits the same message rather
	// than posting a second table under the first.
	tableMessageId: string | null;
}

// ── A single entry in the append-only scroll ──
// `kind` drives how the trail renders the entry, never whether it is recorded. `meta` is
// persisted for the future dashboard but never rendered into Discord, so a handler can stash
// structured detail (the resulting mask, the dice roll) without deciding how it looks.
export type RoomMoveKind = "guess" | "hint" | "join" | "forfeit" | "system";

export interface RoomMove {
	actorId: string;
	at: Date;
	kind: RoomMoveKind;
	// The human-readable line, already composed: "played E", "revealed a hint".
	text: string;
	meta?: Record<string, unknown>;
}

// ── The hidden half of a room ──
// What:  everything a player must not see until the round ends. Today only hangman uses it;
//        duel and rps leave it null.
// When:  written once at room open (host authoring, or a fallback pick from the word bank) and
//        read on every guess. `revealedHints` advances as the room accumulates wrong guesses.
// Where: lives ONLY on the GameRoom row. It must never reach an embed, a customId, a log line,
//        or the API list response while the room's status is non-terminal (risk R12).
export interface RoomSecret {
	word: string;
	// The opening hint, required of any host who authors their own word.
	hint: string;
	// Up to three further hints, unlocked at wrong-guess thresholds.
	extraHints: string[];
	// How many of extraHints the room has earned so far.
	revealedHints: number;
	// Null when the word came from the bundled bank rather than a host.
	authoredBy: string | null;
}
