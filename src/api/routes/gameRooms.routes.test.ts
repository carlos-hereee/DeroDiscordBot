import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("@db/models/GameRoom.js", () => ({ GameRoom: { find: vi.fn() } }));

import { createGameRoomsRouter } from "./gameRooms.routes.js";
import { GameRoom } from "@db/models/GameRoom.js";

const findMock = GameRoom.find as unknown as ReturnType<typeof vi.fn>;

// Every request rides the real Express chain through supertest. Calling the last handler
// directly once hid that requireGuildId sat in the chain as middleware, where it never
// called next() and every dashboard read hung (2026-10 item 280).
function getRooms(query: Record<string, string>) {
	const app = express();
	app.use("/api/game-rooms", createGameRoomsRouter());
	return request(app).get("/api/game-rooms").query(query).timeout(2_000);
}

const chain = (rows: unknown[]) => {
	const select = vi.fn().mockReturnThis();
	const sort = vi.fn().mockReturnThis();
	const limit = vi.fn().mockReturnThis();
	const lean = vi.fn().mockResolvedValue(rows);
	const query = { select, sort, limit, lean };
	findMock.mockReturnValue(query);
	return query;
};

beforeEach(() => vi.clearAllMocks());

describe("GET /api/game-rooms", () => {
	it("answers a request carrying a guildId instead of hanging", async () => {
		chain([]);
		const res = await getRooms({ guildId: "guild-1" });
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ rooms: [], nextCursor: null });
	});

	it("answers 400 without querying when the guildId is missing", async () => {
		const res = await getRooms({});
		expect(res.status).toBe(400);
		expect(findMock).not.toHaveBeenCalled();
	});

	// ⚠️ THE SECURITY CONTROL IS THE PROJECTION, and it is asserted here rather than
	// left to a code reader. `secret.word` is a live hangman answer; projecting it
	// away at the database means a field added to the secret later is excluded by
	// default rather than leaked until somebody notices.
	it("projects the secret away at the database", async () => {
		const query = chain([]);
		await getRooms({ guildId: "guild-1" });
		expect(query.select).toHaveBeenCalledWith(expect.stringContaining("-secret"));
	});

	// Guild scoping is invariant 2. There is deliberately no by-id route, so there is
	// nothing here that could 403 and thereby confirm a room exists elsewhere.
	it("scopes every query to the caller's guild", async () => {
		chain([]);
		await getRooms({ guildId: "guild-1" });
		expect(findMock.mock.calls[0][0]).toMatchObject({ guildId: "guild-1" });
	});

	// A live match is not history, and listing one would expose the player set of a
	// room the caller may not be able to see in Discord.
	it("lists terminal rooms only", async () => {
		chain([]);
		await getRooms({ guildId: "guild-1" });
		expect(findMock.mock.calls[0][0]).toMatchObject({ status: { $in: ["finished", "archived"] } });
	});

	it("clamps the limit rather than trusting it", async () => {
		const query = chain([]);
		await getRooms({ guildId: "guild-1", limit: "10000" });
		expect(query.limit).toHaveBeenCalledWith(100);

		const second = chain([]);
		await getRooms({ guildId: "guild-1", limit: "-5" });
		expect(second.limit).toHaveBeenCalledWith(1);

		const third = chain([]);
		await getRooms({ guildId: "guild-1", limit: "nonsense" });
		expect(third.limit).toHaveBeenCalledWith(25);
	});

	it("returns the move COUNT rather than the moves", async () => {
		chain([
			{
				roomId: "r1",
				game: "hangman",
				hostId: "h",
				playerIds: ["h", "p"],
				visibility: "public",
				winnerId: null,
				startedAt: null,
				endedAt: new Date("2026-08-12T10:00:00Z"),
				moves: [{}, {}, {}],
			},
		]);
		const res = await getRooms({ guildId: "guild-1" });

		const body = res.body as { rooms: Array<Record<string, unknown>> };
		expect(body.rooms[0].moveCount).toBe(3);
		expect(body.rooms[0]).not.toHaveProperty("moves");
		expect(body.rooms[0]).not.toHaveProperty("secret");
	});

	// A stale bookmark should hand back page one, not an error the dashboard has to
	// handle. Rejecting it would turn a harmless case into a failure mode.
	it("ignores an unparseable cursor instead of failing", async () => {
		chain([]);
		await getRooms({ guildId: "guild-1", cursor: "not-a-date" });
		expect(findMock.mock.calls[0][0]).not.toHaveProperty("endedAt");
	});

	it("applies a valid cursor as a keyset bound", async () => {
		chain([]);
		await getRooms({ guildId: "guild-1", cursor: "2026-08-12T10:00:00.000Z" });
		expect(findMock.mock.calls[0][0]).toHaveProperty("endedAt");
	});

	it("filters to a member's own matches when asked, players only", async () => {
		chain([]);
		await getRooms({ guildId: "guild-1", userId: "member-7" });
		// playerIds, never spectatorIds: watching a match is not playing one.
		expect(findMock.mock.calls[0][0]).toMatchObject({ playerIds: "member-7" });
	});

	it("answers 500 rather than leaking the error when the query throws", async () => {
		findMock.mockImplementation(() => {
			throw new Error("mongo down");
		});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

		const res = await getRooms({ guildId: "guild-1" });

		expect(res.status).toBe(500);
		expect(JSON.stringify(res.body)).not.toContain("mongo down");
		errorSpy.mockRestore();
	});
});
