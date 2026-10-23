import { describe, it, expect } from "vitest";
import { GameRoom } from "./GameRoom.js";
import { GAME_SLUGS, NON_TERMINAL_ROOM_STATUSES, RATING_BANDS, ROOM_STATUSES, ROOM_VISIBILITIES } from "@features/game-rooms/roomTypes.js";

// ── GameRoom index and enum declarations ──────────────────────────────────
// SCOPE NOTE, read this before adding to the file. These are SCHEMA assertions, not store
// tests (house rule 6 says stores are thin wrappers and are not tested). They exist because
// the guarantees this feature rests on are declarative: "one open room per host" is a partial
// unique index, and "the sweep cannot touch a live game" is a status filter that only works if
// the index behind it is the one we think it is. Both are invisible at the call site and both
// fail silently when wrong, so they are pinned here.
//
// What this file CANNOT prove: that Mongo actually rejects the second insert. That needs a live
// server (mongodb-memory-server is not a dependency of this repo, and the house pattern set by
// pendingPairingStore.test.ts is to pin the SHAPES that make a Mongo guarantee hold rather than
// to stand up a database). The enforcement itself is covered by end to end scenario 7 in the
// master plan: same host, second attempt, expect a jump link to the first room.
//
// Importing the model is safe here: mongoose.model() only registers a schema. It opens no
// connection, so nothing in this file can hang waiting on Mongo.

type DeclaredIndex = [Record<string, unknown>, Record<string, unknown>];
const indexes = GameRoom.schema.indexes() as unknown as DeclaredIndex[];

const findIndex = (key: Record<string, unknown>): DeclaredIndex | undefined =>
	indexes.find(([fields]) => JSON.stringify(fields) === JSON.stringify(key));

describe("GameRoom indexes", () => {
	it("declares the roomId unique index exactly once", () => {
		// Declared by the field-level `unique: true`. Declaring it AGAIN via schema.index() would
		// make Mongoose 8 log a duplicate-index warning on every boot, so the count is the assertion.
		const roomIdIndexes = indexes.filter(([fields]) => JSON.stringify(fields) === JSON.stringify({ roomId: 1 }));
		expect(roomIdIndexes).toHaveLength(1);
		expect(roomIdIndexes[0][1].unique).toBe(true);
	});

	it("enforces one open room per host with a PARTIAL unique index, not a plain one", () => {
		const hostIndex = findIndex({ guildId: 1, hostId: 1 });
		expect(hostIndex).toBeDefined();
		const options = hostIndex![1];
		expect(options.unique).toBe(true);
		// Partial is load bearing. A plain unique index here would make a host's SECOND EVER room
		// collide with their first finished one, so nobody could ever play twice.
		expect(options.partialFilterExpression).toEqual({
			status: { $in: [...NON_TERMINAL_ROOM_STATUSES] },
		});
	});

	it("scopes the partial filter to exactly the non-terminal statuses", () => {
		// The filter must not drift from the list the store queries with. If these ever disagree,
		// the index stops covering the query it exists for and the guarantee evaporates silently.
		expect([...NON_TERMINAL_ROOM_STATUSES]).toEqual(["draft", "open", "playing"]);
		expect([...NON_TERMINAL_ROOM_STATUSES].every((status) => (ROOM_STATUSES as readonly string[]).includes(status))).toBe(
			true
		);
		expect([...NON_TERMINAL_ROOM_STATUSES]).not.toContain("finished");
		expect([...NON_TERMINAL_ROOM_STATUSES]).not.toContain("archived");
	});

	it("indexes the archive sweep's query on status first", () => {
		// The sweep filters status "finished" AND archiveAt <= now. Leading with status keeps the
		// scan off the far larger set of archived rows.
		expect(findIndex({ status: 1, archiveAt: 1 })).toBeDefined();
	});

	it("indexes the per-guild cap query and the dashboard history query", () => {
		expect(findIndex({ guildId: 1, status: 1 })).toBeDefined();
		expect(findIndex({ guildId: 1, playerIds: 1, endedAt: -1 })).toBeDefined();
	});

	it("does not carry a redundant standalone guildId index", () => {
		// { guildId: 1, status: 1 } already serves every guildId-only query as its prefix. A second
		// single-field index would cost a write on every move append and buy nothing.
		expect(findIndex({ guildId: 1 })).toBeUndefined();
	});
});

describe("GameRoom enums stay in step with roomTypes", () => {
	const enumOf = (path: string): string[] =>
		(GameRoom.schema.path(path) as unknown as { enumValues: string[] }).enumValues;

	it("accepts exactly the declared game slugs", () => {
		expect(enumOf("game")).toEqual([...GAME_SLUGS]);
		// A Monopoly row would fail validation on create without this.
		expect(enumOf("game")).toContain("monopoly");
	});

	it("accepts exactly the declared statuses and defaults to draft", () => {
		expect(enumOf("status")).toEqual([...ROOM_STATUSES]);
		expect(GameRoom.schema.path("status").options.default).toBe("draft");
	});

	it("accepts exactly the declared visibilities and defaults to invite", () => {
		// Default private on purpose: a room that accidentally opened public would expose a match
		// the host meant to keep to two people, and capability alone must never expose anything.
		expect(enumOf("visibility")).toEqual([...ROOM_VISIBILITIES]);
		expect(GameRoom.schema.path("visibility").options.default).toBe("invite");
	});
});

describe("GameRoom archive safety", () => {
	it("leaves archiveAt null by default, so an unfinished room can never match the sweep", () => {
		// This is the other half of risk R3. The sweep filters on status AND archiveAt, and a room
		// that is still playing has archiveAt null, so no filter bug can reach a live game.
		expect(GameRoom.schema.path("archiveAt").options.default).toBe(null);
		expect(GameRoom.schema.path("endedAt").options.default).toBe(null);
	});
});

describe("GameRoom host controls (2026-10 item 244 Phase 4)", () => {
	it("defaults every control to the open door an older row reads as", () => {
		const room = new GameRoom({ guildId: "guild-1", game: "holdem", hostId: "host-1" });
		expect(room.ratingBand).toBe("any");
		expect(room.requireApproval).toBe(false);
		expect([...room.pendingJoinIds]).toEqual([]);
		expect([...room.kickedIds]).toEqual([]);
		expect(room.seatsOpen).toBe(false);
	});

	it("accepts exactly the rating bands the rating engine reads", () => {
		expect((GameRoom.schema.path("ratingBand") as unknown as { enumValues: string[] }).enumValues).toEqual([...RATING_BANDS]);
	});

	// Phase 4 added no index. Phase 5a (2026-10 item 244) adds exactly the two partial
	// satellite indexes and nothing else, so the one open room per host index is still
	// the same index it was.
	it("adds only the partial satellite indexes, so the one open room per host index is the same index it was", () => {
		const declared = indexes.map(([fields]) => JSON.stringify(fields)).sort();
		expect(declared).toEqual(
			[
				{ roomId: 1 },
				{ guildId: 1, status: 1 },
				{ guildId: 1, hostId: 1 },
				{ status: 1, archiveAt: 1 },
				{ guildId: 1, playerIds: 1, endedAt: -1 },
				{ "satellites.channelId": 1 },
				{ "satellites.userIds": 1 },
			]
				.map((fields) => JSON.stringify(fields))
				.sort()
		);
		expect(findIndex({ guildId: 1, hostId: 1 })?.[1]).toEqual({
			unique: true,
			partialFilterExpression: { status: { $in: [...NON_TERMINAL_ROOM_STATUSES] } },
			background: true,
		});
	});
});

describe("GameRoom network tables (2026-10 item 244 Phase 5a)", () => {
	it("reads an older row as a server room with no satellites", () => {
		const room = new GameRoom({ guildId: "guild-1", game: "holdem", hostId: "host-1" });
		expect(room.network).toBe(false);
		expect([...room.satellites]).toEqual([]);
	});

	// Partial on network: true, so the thousands of ordinary rooms cost these indexes
	// nothing, and every satellite query names network: true to reach them.
	it("indexes the satellite lookups partially, over network rooms only", () => {
		for (const key of [{ "satellites.channelId": 1 }, { "satellites.userIds": 1 }]) {
			const index = findIndex(key);
			expect(index).toBeDefined();
			expect(index![1].partialFilterExpression).toEqual({ network: true });
			expect(index![1].unique).toBeUndefined();
		}
	});

	it("keeps a satellite as a plain child entry with no id of its own", () => {
		const room = new GameRoom({
			guildId: "guild-1",
			game: "holdem",
			hostId: "host-1",
			network: true,
			satellites: [{ guildId: "guild-2", channelId: "sat-1", userIds: ["remote-1"] }],
		});
		const stored = room.toObject().satellites[0] as unknown as Record<string, unknown>;
		expect(stored).toEqual({ guildId: "guild-2", channelId: "sat-1", userIds: ["remote-1"], tableMessageId: null });
	});
});
