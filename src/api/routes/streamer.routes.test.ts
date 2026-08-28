import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn() } }));
vi.mock("@db/stores/eventStore.js", () => ({ eventStore: { findByGuildId: vi.fn() } }));
vi.mock("@db/stores/xpPeriodStore.js", () => ({
	xpPeriodStore: { statsForPeriod: vi.fn(), topInPeriod: vi.fn() },
}));
vi.mock("@db/stores/memberLevelStore.js", () => ({ memberLevelStore: { findManyInGuild: vi.fn() } }));

import { createStreamerRouter } from "./streamer.routes.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { eventStore } from "@db/stores/eventStore.js";
import { xpPeriodStore } from "@db/stores/xpPeriodStore.js";
import { memberLevelStore } from "@db/stores/memberLevelStore.js";

const configMock = guildConfigStore.findByGuildId as unknown as ReturnType<typeof vi.fn>;
const eventsMock = eventStore.findByGuildId as unknown as ReturnType<typeof vi.fn>;
const statsMock = xpPeriodStore.statsForPeriod as unknown as ReturnType<typeof vi.fn>;
const topMock = xpPeriodStore.topInPeriod as unknown as ReturnType<typeof vi.fn>;
const levelsMock = memberLevelStore.findManyInGuild as unknown as ReturnType<typeof vi.fn>;

// Same handler-extraction idiom as gameRooms.routes.test.ts: pull the route's
// terminal handler out of the router stack so the summary logic is testable
// without standing up Express.
type Handler = (req: Request, res: Response) => Promise<void>;
function routeHandler(): Handler {
	const router = createStreamerRouter();
	const layer = (router as unknown as { stack: Array<{ route?: { stack: Array<{ handle: Handler }> } }> }).stack.find(
		(entry) => entry.route
	);
	const chain = layer!.route!.stack;
	return chain[chain.length - 1].handle;
}

const makeRes = () => {
	const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };
	return res as unknown as Response & { json: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> };
};

const makeReq = (query: Record<string, string>) => ({ query }) as unknown as Request;

const seedHappyPath = () => {
	configMock.mockResolvedValue({ guildId: "guild-1", weekStart: "monday" });
	statsMock.mockResolvedValue({ activeMembers: 12, totalXp: 3400 });
	topMock.mockResolvedValue([
		{ userId: "u1", xp: 900 },
		{ userId: "u2", xp: 500 },
	]);
	levelsMock.mockResolvedValue([
		{ userId: "u1", username: "alice" },
		{ userId: "u2", username: "bob" },
	]);
	eventsMock.mockResolvedValue([
		{ name: "Friday stream", type: "recurring", active: true },
		{ name: "Retired event", type: "one-time", active: false },
	]);
};

beforeEach(() => vi.clearAllMocks());

describe("GET /api/streamer/recent-activity", () => {
	// Invariant 2: an unknown guild reads NOT FOUND, never as an empty summary,
	// so the route cannot be used to probe which guildIds the bot knows.
	it("404s a guild the bot has no config for", async () => {
		configMock.mockResolvedValue(null);
		const res = makeRes();
		await routeHandler()(makeReq({ guildId: "guild-x" }), res);
		expect(res.status).toHaveBeenCalledWith(404);
		expect(statsMock).not.toHaveBeenCalled();
	});

	it("summarizes the week: counts, named top members, active events only", async () => {
		seedHappyPath();
		const res = makeRes();
		await routeHandler()(makeReq({ guildId: "guild-1" }), res);

		const payload = res.json.mock.calls[0][0].data;
		expect(payload.activeMembers).toBe(12);
		expect(payload.totalXp).toBe(3400);
		expect(payload.topMembers).toEqual([
			{ username: "alice", xp: 900 },
			{ username: "bob", xp: 500 },
		]);
		// The retired event never reaches the summary.
		expect(payload.activeEvents).toEqual([{ name: "Friday stream", type: "recurring" }]);
	});

	// The period is computed from the GUILD'S OWN week boundary, so the summary
	// agrees with what /levels and the pinned board already show members.
	it("scopes every read to the caller's guild", async () => {
		seedHappyPath();
		await routeHandler()(makeReq({ guildId: "guild-1" }), makeRes());
		expect(statsMock.mock.calls[0][0]).toBe("guild-1");
		expect(topMock.mock.calls[0][0]).toBe("guild-1");
		expect(eventsMock.mock.calls[0][0]).toBe("guild-1");
	});

	// A member whose display name cannot be resolved is reported nameless, not
	// dropped: the xp is real either way.
	it("keeps an unresolvable top member with an empty name", async () => {
		seedHappyPath();
		levelsMock.mockResolvedValue([{ userId: "u1", username: "alice" }]);
		const res = makeRes();
		await routeHandler()(makeReq({ guildId: "guild-1" }), res);
		const payload = res.json.mock.calls[0][0].data;
		expect(payload.topMembers[1]).toEqual({ username: "", xp: 500 });
	});
});
