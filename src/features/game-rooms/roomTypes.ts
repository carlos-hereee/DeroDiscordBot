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
export const GAME_SLUGS = ["hangman", "coinflip", "diceroll", "rps"] as const;
export type GameSlug = (typeof GAME_SLUGS)[number];

// ── Who may see the room ──
// "invite": @everyone is denied ViewChannel and each accepted member gets an explicit
// overwrite. "public": one @everyone overwrite grants view and denies send, so a 5000 member
// guild costs exactly the same as a 50 member one.
export const ROOM_VISIBILITIES = ["invite", "public"] as const;
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
