import { describe, it, expect } from "vitest";
import { MemberLevel } from "./MemberLevel.js";
import { LEVELING_GAME_SLUGS } from "@features/leveling/levelingTypes.js";

// ── MemberLevel schema and index declarations ─────────────────────────────
// SCOPE NOTE, read this before adding to the file. These are SCHEMA assertions,
// not store tests (house rule 6 says stores are thin wrappers and are not
// tested). They exist because the guarantees this feature rests on are
// DECLARATIVE and every one of them fails silently when wrong:
//
//   • the unique { guildId, userId } index is what turns a concurrent-upsert
//     race into a retryable duplicate-key error instead of two rows for one
//     member, each holding half their xp,
//   • the { guildId, totalXp } index is what makes rank an index-only count
//     rather than a sort of the guild,
//   • strict mode DROPS a write to an undeclared path in silence, which this
//     repo has already shipped once (see the schedulePaused post mortem in
//     GuildConfig.ts).
//
// What this file CANNOT prove: that Mongo actually rejects the second insert.
// That needs a live server (mongodb-memory-server is not a dependency here, and
// the house pattern set by GameRoom.test.ts is to pin the SHAPES that make a
// Mongo guarantee hold rather than to stand up a database).
//
// Importing the model is safe: mongoose.model() only registers a schema. It
// opens no connection, so nothing here can hang waiting on Mongo.

type DeclaredIndex = [Record<string, unknown>, Record<string, unknown>];
const indexes = MemberLevel.schema.indexes() as unknown as DeclaredIndex[];

const findIndex = (key: Record<string, unknown>): DeclaredIndex | undefined =>
	indexes.find(([fields]) => JSON.stringify(fields) === JSON.stringify(key));

const baseRow = { guildId: "guild-1", userId: "user-1", username: "silent" };

describe("MemberLevel indexes", () => {
	it("declares the memberLevelId unique index exactly once", () => {
		// Declared by the field-level `unique: true`. Declaring it AGAIN via
		// schema.index() would make Mongoose 8 log a duplicate-index warning on
		// every boot, so the count is the assertion.
		const idIndexes = indexes.filter(([fields]) => JSON.stringify(fields) === JSON.stringify({ memberLevelId: 1 }));
		expect(idIndexes).toHaveLength(1);
		expect(idIndexes[0][1].unique).toBe(true);
	});

	it("enforces one row per member per guild with a UNIQUE compound index", () => {
		// This is the whole basis of awardXp's retry-once-on-11000 recovery. Two
		// concurrent upserts on a missing key both attempt an insert; the loser
		// gets a duplicate-key error and retries into the row the winner created.
		// Drop the `unique` here and the race silently creates a SECOND row
		// instead, and every read afterwards sees a fraction of the member's xp.
		const memberIndex = findIndex({ guildId: 1, userId: 1 });
		expect(memberIndex).toBeDefined();
		expect(memberIndex![1].unique).toBe(true);
	});

	it("indexes rank and the all time board as a descending xp scan", () => {
		// /account computes rank as 1 + countDocuments({ guildId, totalXp: $gt }),
		// which is index-only against exactly this key. Without it, rank degrades
		// to a collection scan on the busiest read in the feature.
		expect(findIndex({ guildId: 1, totalXp: -1 })).toBeDefined();
	});

	it("does not carry a redundant standalone guildId index", () => {
		// Both compound indexes lead with guildId and serve guildId-only queries as
		// their prefix, so a third single-field index would cost a write on every
		// flush and buy nothing.
		expect(findIndex({ guildId: 1 })).toBeUndefined();
	});

	it("carries NO TTL, because this is the durable record", () => {
		// The contrast that matters: XpPeriod DOES have a TTL, because its rows are
		// derivable per period aggregates. These rows are not derivable from
		// anything, so an expiry here would silently delete a guild's progression.
		for (const [, options] of indexes) {
			expect(options.expireAfterSeconds).toBeUndefined();
		}
	});
});

describe("level is derived, never stored", () => {
	it("declares no `level` path at all", () => {
		// The single most likely "helpful" edit to this model, and the one that
		// breaks it. A stored level drifts the instant an admin runs /xp set-level
		// or the guild changes its curve preset, and nothing recomputes it.
		expect(MemberLevel.schema.path("level")).toBeUndefined();
	});

	it("declares totalXp as the only xp field", () => {
		expect(MemberLevel.schema.path("totalXp")).toBeDefined();
		expect(MemberLevel.schema.path("weekXp")).toBeUndefined();
		expect(MemberLevel.schema.path("monthXp")).toBeUndefined();
	});

	it("starts announcedLevel below level 1 so a first level up is claimable", () => {
		// announcedLevel is a high water mark for the announcement claim, not a
		// level. It must begin below the level every member starts at, or nobody's
		// first level up would ever be announced.
		const doc = new MemberLevel(baseRow);
		expect(doc.announcedLevel).toBe(0);
		expect(doc.totalXp).toBe(0);
	});
});

describe("the per game record round trips", () => {
	it("keeps all five counters for a game slug", () => {
		// The K/D/A line members screenshot. A dropped counter here would read as
		// a member simply never having won.
		const doc = new MemberLevel({
			...baseRow,
			games: { duel: { played: 9, won: 5, lost: 3, drawn: 1, assists: 0 } },
		});

		const record = doc.games.get("duel");
		expect(record).toBeDefined();
		expect(record!.played).toBe(9);
		expect(record!.won).toBe(5);
		expect(record!.lost).toBe(3);
		expect(record!.drawn).toBe(1);
		expect(record!.assists).toBe(0);
	});

	it("accepts every declared leveling slug, including the three whose games have not shipped", () => {
		// blackjack, battleship and holdem are declared from Phase 1 on purpose: a
		// Mongoose Map needs no migration to gain a key, so the award API and the
		// /account renderer speak one closed union from day one.
		const games = Object.fromEntries(
			LEVELING_GAME_SLUGS.map((slug) => [slug, { played: 1, won: 1, lost: 0, drawn: 0, assists: 0 }])
		);
		const doc = new MemberLevel({ ...baseRow, games });

		for (const slug of LEVELING_GAME_SLUGS) {
			expect(doc.games.get(slug), `${slug} was dropped`).toBeDefined();
		}
	});

	it("records an assist, which only hangman can produce today", () => {
		const doc = new MemberLevel({
			...baseRow,
			games: { hangman: { played: 4, won: 1, lost: 0, drawn: 0, assists: 3 } },
		});
		expect(doc.games.get("hangman")!.assists).toBe(3);
	});

	it("defaults to an empty map rather than undefined", () => {
		// /account renders the record table off this map, so undefined here would
		// be a crash on a member's very first profile view.
		const doc = new MemberLevel(baseRow);
		expect(doc.games).toBeDefined();
		expect(doc.games.size).toBe(0);
	});
});

describe("the unlocked achievement list round trips", () => {
	it("keeps the earning sentence alongside the tier", () => {
		// earnedBy exists precisely so /account can say HOW an achievement was
		// earned. It is composed at unlock time because the counters will have
		// moved on by the time anyone looks at it.
		const at = new Date(2026, 7, 11, 12, 0, 0);
		const doc = new MemberLevel({
			...baseRow,
			unlocked: [{ id: "voice-of-the-realm", tier: "silver", at, earnedBy: "sent 251 messages" }],
		});

		expect(doc.unlocked).toHaveLength(1);
		expect(doc.unlocked[0].id).toBe("voice-of-the-realm");
		expect(doc.unlocked[0].tier).toBe("silver");
		expect(doc.unlocked[0].earnedBy).toBe("sent 251 messages");
		expect(doc.unlocked[0].at).toEqual(at);
	});

	it("defaults to an empty array", () => {
		expect(new MemberLevel(baseRow).unlocked).toEqual([]);
	});
});

describe("the control case: strict mode really is on", () => {
	// Without this, every round trip above could pass for the wrong reason. If
	// strict mode were off, an undeclared field would round trip happily and the
	// assertions would be measuring nothing.
	it("silently drops an undeclared top level field", () => {
		const withGhost = { ...baseRow, definitelyNotAField: "ghost" } as unknown as Record<string, unknown>;
		expect(new MemberLevel(withGhost).get("definitelyNotAField")).toBeUndefined();
	});

	it("silently drops an undeclared counter inside a game record", () => {
		// The nastier half: a typo'd counter name in awardXp would vanish without
		// an error and the record would simply never move.
		const doc = new MemberLevel({
			...baseRow,
			games: { duel: { played: 1, wonn: 1 } },
		} as unknown as Record<string, unknown>);
		expect(doc.games.get("duel")!.won).toBe(0);
		expect((doc.games.get("duel") as unknown as Record<string, unknown>).wonn).toBeUndefined();
	});
});
