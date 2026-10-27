// ── Game room shared types ──
// What:  the vocabulary every other game-rooms module speaks. A room is one match of one
//        mini game, played inside its own Discord text channel, whose entire history is an
//        append-only scroll persisted to Mongo.
// Who:   the GameRoom model, gameRoomStore, the provisioner, the archive sweep, the trail
//        poster, the challenge board, and (later) the dashboard API route. Everything in
//        features/game-rooms plus db/models/GameRoom.ts imports from here.
// When:  compile time only. This module is deliberately types + frozen literal lists (and
//        the pure membership checks of two of them), so it can be imported from a
//        Mongoose model without dragging feature code into the DB layer.
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
// stays a plain slash command, so it is deliberately absent: a reading has no room.
// Monopoly is the longest of them all (2 to 6 players, played until one is left standing).
// Blackjack gets a room too, by the owner's decision on 2026-10-26 (2026-10 item 254,
// Arcade 1): nothing is played in ⚔️challenges, so a table that once ran in place on one
// edited message there now plays in a room of its own like every other game.
// The solo- slugs are the arcade's one-player forms, routed through the same provisioner
// so they hold the host's one-room slot, count against the guild cap, and count as
// PRIVATE rooms for the tier quota. They are their OWN slugs rather than a `mode: "solo"`
// field so every customId, enum validator and trail entry is unambiguous about which form
// was played, and so SELF_BOARDED_GAMES can name solo-blackjack without a mode branch. The
// three solo luck slugs are a round against Dero (Play Dero instead, and a /mini-game
// against Dero typed in ⚔️challenges): the coin and the dice play the moment the room
// opens, and rock paper scissors asks for its throw in the room.
export const GAME_SLUGS = [
	"hangman",
	"coinflip",
	"diceroll",
	"rps",
	"battleship",
	"holdem",
	"monopoly",
	"blackjack",
	"solo-hangman",
	"solo-blackjack",
	"solo-coinflip",
	"solo-diceroll",
	"solo-rps",
] as const;
export type GameSlug = (typeof GAME_SLUGS)[number];

// ── Game families several modules branch on (2026-10 item 254, Arcade 1) ──
// Listed once, with their membership checks beside them, so the opener, the boot recovery,
// the room-rate top up and the rematch check cannot drift into different lists. Pure list
// membership, so they keep this module dependency free.
// The rooms whose hand is dealt by blackjackHandler and lives only in its process Map.
export const BLACKJACK_ROOM_GAMES = ["blackjack", "solo-blackjack"] as const satisfies readonly GameSlug[];
// The one round solo rooms against Dero, each finished as soon as its round is played.
export const SOLO_LUCK_GAMES = ["solo-coinflip", "solo-diceroll", "solo-rps"] as const satisfies readonly GameSlug[];
export type SoloLuckSlug = (typeof SOLO_LUCK_GAMES)[number];

// The solo rooms a finished match offers Rematch in. Rock paper scissors is the one luck
// round here (2026-10 item 257 Phase 4b): its throw is asked in the room, so a second round
// is one more prompt in the same channel; a coin flip or a dice roll is a single press from
// the card or the 🕹️games row instead. Read by the result card and the rematch check alike.
export const SOLO_REMATCH_GAMES = ["solo-hangman", "solo-blackjack", "solo-rps"] as const satisfies readonly GameSlug[];

export const isBlackjackRoomGame = (game: GameSlug): boolean => (BLACKJACK_ROOM_GAMES as readonly GameSlug[]).includes(game);
export const isSoloLuckGame = (game: GameSlug): game is SoloLuckSlug => (SOLO_LUCK_GAMES as readonly GameSlug[]).includes(game);
export const isSoloRematchGame = (game: GameSlug): boolean => (SOLO_REMATCH_GAMES as readonly GameSlug[]).includes(game);

/** Whether a finished room of this game offers Rematch on its result card. */
export const offersRematch = (game: GameSlug): boolean => !isSoloLuckGame(game) || isSoloRematchGame(game);

// The games whose matches Dero can referee out loud (2026-10 item 257 Phase 4b, decision 13):
// the ones with voice lines. A game gains the challenge card's referee toggle only when its
// lines exist, so this list grows with them and never ahead of them.
export const REFEREE_GAMES = ["monopoly", "holdem"] as const satisfies readonly GameSlug[];
export const offersReferee = (game: GameSlug): boolean => (REFEREE_GAMES as readonly GameSlug[]).includes(game);

/**
 * Whether Dero referees this match. The field is `referee`; a row written before it existed
 * carries Monopoly's old `monopolyReferee` instead, so a null falls through to that, and a
 * live draft or match keeps its referee across the deploy that introduced the new field.
 * Structural rather than typed on IGameRoom, so this module stays import free.
 */
export const refereeOn = (room: { referee?: boolean | null; monopolyReferee?: boolean | null }): boolean => room.referee ?? room.monopolyReferee ?? false;

// ── Who may see the room ──
// "invite": @everyone is denied ViewChannel and each accepted member gets an explicit
// overwrite. "public": one @everyone overwrite grants view and denies send, so a 5000 member
// guild costs exactly the same as a 50 member one. "solo": a variant of "invite", never of
// "public" (@everyone denied ViewChannel, NO spectators, only the host in playerIds), so a
// solo room is private by construction and counts as private wherever the tier quota asks.
export const ROOM_VISIBILITIES = ["invite", "public", "solo"] as const;
export type RoomVisibility = (typeof ROOM_VISIBILITIES)[number];

// ── Who may watch the room (2026-10 item 254, Arcade 11) ──
// The host's spectator setting, a second axis beside visibility: visibility says who may
// PLAY (anyone who presses Join, or only the members the host picked), this says who may
// WATCH. "open": everyone, through the one @everyone overwrite. "invite": only the members
// the host invited, through spectatorIds. "none": only the players. A row stores null until
// the host chooses, and roomPermissions.effectiveSpectatorMode reads null as the default its
// visibility always had, so a room opened before the setting existed keeps its matrix.
export const SPECTATOR_MODES = ["open", "invite", "none"] as const;
export type SpectatorMode = (typeof SPECTATOR_MODES)[number];

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

// ── A member of another server waiting on the host's answer (2026-10 item 244 Phase 5b) ──
// The server they pressed the network board's Join in, so the host's accept opens their
// satellite there. Removed once they are accepted, declined or removed.
export interface PendingNetworkJoin {
	userId: string;
	guildId: string;
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
