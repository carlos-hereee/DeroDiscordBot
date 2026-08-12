// ── Leveling shared types ──
// What:  the vocabulary every other leveling module speaks. Slugs, xp sources,
//        game outcomes and the per game record shape.
// Who:   the MemberLevel and XpPeriod models, memberLevelStore, awardXp,
//        xpWriter, the achievement engine, /account and /levels.
// When:  compile time only. Deliberately types plus frozen literal lists so a
//        Mongoose model can import it without dragging feature code into the DB
//        layer, exactly the role @features/game-rooms/roomTypes.ts plays for
//        GameRoom.ts.
// Where: sits below the model in the dependency graph. Nothing here may import a
//        store, a handler, or discord.js.
// How:   string-literal unions with a runtime array beside each, matching
//        roomTypes.ts. The runtime arrays exist because Mongoose needs them for
//        enum validators and the suite needs them to sweep every case, and a
//        second hand-written copy is how two lists silently stop agreeing.

// ── Which games keep a win/loss record ──
//
// ⚠️ This is NOT @features/game-rooms/roomTypes.ts's GAME_SLUGS and must not be
// swapped for it. That list means "games that get their own channel", so it
// holds exactly hangman, duel and rps today, deliberately excludes fortune
// (single player), and will gain battleship and holdem but never blackjack.
// This list means "games that keep a record on /account", which is a different
// question with a different answer.
//
// Blackjack is the clearest illustration that the two questions differ, and the
// reason is NOT that it is single player: it grew multi seat tables on
// 2026-08-11. It stays out of the room list because a blackjack hand takes a
// minute, so a table runs in place on one edited message the way a hangman round
// already does. A room is earned by DURATION and a transcript worth keeping,
// which is why holdem (six players, 45 plus minutes) gets one and a blackjack
// table does not.
//
// Fortune is absent here too, and for its own reason: a reading has no winner,
// so it has no record. It is counted by MemberLevel.fortuneReadings instead,
// which is what backs the hidden dero-knows achievement.
//
// The last three are declared from Phase 1 even though their games land in
// phases 6 to 8. A Mongoose Map needs no migration to gain a key, so declaring
// them early costs nothing and means the /account renderer, the achievement
// definitions and the award API all speak one closed union from day one.
export const LEVELING_GAME_SLUGS = ["duel", "rps", "hangman", "blackjack", "battleship", "holdem"] as const;
export type LevelingGameSlug = (typeof LEVELING_GAME_SLUGS)[number];

// ── Where an award came from ──
// Not decoration. `source` is what lets a message award STAGE into the write
// buffer while an admin correction or a game result writes through immediately,
// and it is what the achievement engine reads to avoid re-entering itself (an
// unlock grants xp, which could level a member up, which would re-evaluate the
// unlock). See the recursion note in achievementEngine when Phase 4 lands.
export const XP_SOURCES = ["message", "reaction", "voice", "game", "gameRoom", "achievement", "admin"] as const;
export type XpSource = (typeof XP_SOURCES)[number];

// ── How a round ended for one member ──
// "assist" is the one that needs explaining: it means you materially advanced a
// round somebody else won. Hangman is the only current game with a genuine
// assist (you revealed at least one correct letter in a round another member
// solved), which is why the participants set has to exist there at all.
export const GAME_OUTCOMES = ["won", "lost", "drawn", "assist"] as const;
export type GameOutcome = (typeof GAME_OUTCOMES)[number];

// ── The per game record ──
// The K/D/A style line members will screenshot. `played` counts rounds taken
// part in, so it is incremented for every outcome including an assist, and the
// four outcome counters partition it.
export interface IGameRecord {
	played: number;
	won: number;
	lost: number;
	drawn: number;
	assists: number;
}

// The lifetime counters that are NOT per game. Every achievement metric reads
// one of these or a games-map field, which is what lets the achievement engine
// add zero new listeners and zero new writes on the message path.
export const LIFETIME_COUNTERS = ["messages", "reactionsGiven", "voiceMinutes", "fortuneReadings"] as const;
export type LifetimeCounter = (typeof LIFETIME_COUNTERS)[number];

// ── One unlocked achievement, as stored ──
// `earnedBy` is a human sentence composed AT UNLOCK TIME ("sent 251 messages"),
// not reconstructed later, because /account shows HOW an achievement was earned
// and the counters will have moved on by the time anyone looks.
export interface IAchievementUnlock {
	id: string;
	tier: string;
	at: Date;
	earnedBy: string;
}
