import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IGameRequest } from "@db/models/GameRequest.js";

// ── an in memory GameRequest collection ──────────────────────────────────────
// Mirrors what the real store guarantees and nothing more: rows scoped by guildId, the
// unique { guildId, nameKey } index (a second create throws 11000), and $addToSet and
// $pull semantics on voterIds. So every rule tested below is the feature's, not a mock's.
// Every read hands back a COPY, the way a lean query returns a fresh object.
const fake = vi.hoisted(() => {
	const rows: IGameRequest[] = [];
	const state = { clock: 0 };
	const find = (guildId: string, nameKey: string) => rows.find((row) => row.guildId === guildId && row.nameKey === nameKey) ?? null;
	const copyOf = (row: IGameRequest | null): IGameRequest | null => (row ? { ...row, voterIds: [...row.voterIds] } : null);
	const store = {
		listByGuild: vi.fn(async (guildId: string) => rows.filter((row) => row.guildId === guildId).map((row) => copyOf(row) as IGameRequest)),
		countByGuild: vi.fn(async (guildId: string) => rows.filter((row) => row.guildId === guildId).length),
		findByKey: vi.fn(async (guildId: string, nameKey: string) => copyOf(find(guildId, nameKey))),
		create: vi.fn(async (row: Omit<IGameRequest, "createdAt">) => {
			if (find(row.guildId, row.nameKey)) throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
			state.clock += 1;
			const created = { ...row, voterIds: [...row.voterIds], createdAt: new Date(Date.UTC(2026, 9, 23, 0, 0, state.clock)) };
			rows.push(created);
			return copyOf(created) as IGameRequest;
		}),
		addVoter: vi.fn(async (guildId: string, nameKey: string, userId: string) => {
			const row = find(guildId, nameKey);
			if (row && !row.voterIds.includes(userId)) row.voterIds.push(userId);
			return copyOf(row);
		}),
		removeVoter: vi.fn(async (guildId: string, nameKey: string, userId: string) => {
			const row = find(guildId, nameKey);
			if (row) row.voterIds = row.voterIds.filter((id) => id !== userId);
			return copyOf(row);
		}),
		deleteByKey: vi.fn(async (guildId: string, nameKey: string) => {
			const index = rows.findIndex((row) => row.guildId === guildId && row.nameKey === nameKey);
			return index === -1 ? null : (rows.splice(index, 1)[0] ?? null);
		}),
	};
	const reset = () => {
		rows.length = 0;
		state.clock = 0;
	};
	return { rows, find, store, reset };
});

vi.mock("@db/stores/gameRequestStore.js", () => ({ gameRequestStore: fake.store }));

import { gameRequestStore } from "@db/stores/gameRequestStore.js";
import {
	GAME_REQUEST_NAME_MAX,
	GAME_REQUEST_POOL_CAP,
	addGameRequest,
	listGameRequests,
	normalizeGameName,
	rankGameRequests,
	removeGameRequest,
	toggleGameRequestVote,
} from "./gameRequests.js";

const GUILD = "guild-1";
const OTHER_GUILD = "guild-2";

beforeEach(() => {
	fake.reset();
	vi.clearAllMocks();
});

describe("normalizeGameName", () => {
	it("trims and collapses spacing, and keys the name on its lowercase form", () => {
		expect(normalizeGameName("  Settlers   of  Catan ")).toEqual({ ok: true, name: "Settlers of Catan", nameKey: "settlers of catan" });
	});

	it("refuses a name outside 2 to 40 characters", () => {
		expect(normalizeGameName("a")).toEqual({ ok: false, reason: "length" });
		expect(normalizeGameName("   ")).toEqual({ ok: false, reason: "length" });
		expect(normalizeGameName("x".repeat(GAME_REQUEST_NAME_MAX + 1))).toEqual({ ok: false, reason: "length" });
		expect(normalizeGameName("Go").ok).toBe(true);
		expect(normalizeGameName("x".repeat(GAME_REQUEST_NAME_MAX)).ok).toBe(true);
	});

	it("breaks every mention form so a stored name can never ping", () => {
		for (const raw of ["@everyone", "@here party", "<@123456> chess", "<@&987> night", "<#555> darts"]) {
			const check = normalizeGameName(raw);
			expect(check.ok, raw).toBe(true);
			if (!check.ok) continue;
			expect(check.name, raw).not.toMatch(/@everyone|@here|<@!?&?\d+>|<#\d+>/);
		}
	});
});

describe("addGameRequest", () => {
	it("adds a game with the adder's vote already on it", async () => {
		const result = await addGameRequest(GUILD, "member-1", "Chess");
		expect(result).toMatchObject({ ok: true, request: { name: "Chess", nameKey: "chess", addedBy: "member-1", voterIds: ["member-1"] } });
	});

	it("refuses a duplicate ignoring case and spacing, and names the request already there", async () => {
		await addGameRequest(GUILD, "member-1", "Chess");

		const result = await addGameRequest(GUILD, "member-2", "  cHESS ");

		expect(result).toEqual({ ok: false, reason: "duplicate", existingName: "Chess" });
		expect(fake.rows).toHaveLength(1);
	});

	it("refuses a duplicate that lost the race to the unique index", async () => {
		// The read saw nothing, then another member's insert landed first.
		const findMock = gameRequestStore.findByKey as unknown as ReturnType<typeof vi.fn>;
		await addGameRequest(GUILD, "member-1", "Chess");
		findMock.mockResolvedValueOnce(null);

		const result = await addGameRequest(GUILD, "member-2", "chess");

		expect(result).toEqual({ ok: false, reason: "duplicate", existingName: "Chess" });
		expect(fake.rows).toHaveLength(1);
	});

	it("keeps each server's ballot apart", async () => {
		await addGameRequest(GUILD, "member-1", "Chess");
		expect((await addGameRequest(OTHER_GUILD, "member-1", "Chess")).ok).toBe(true);
		expect(await listGameRequests(GUILD)).toHaveLength(1);
		expect(await listGameRequests(OTHER_GUILD)).toHaveLength(1);
	});

	it("refuses a new game once the ballot holds as many as the vote select can show", async () => {
		for (let index = 0; index < GAME_REQUEST_POOL_CAP; index += 1) await addGameRequest(GUILD, "member-1", `Game ${index}`);

		expect(await addGameRequest(GUILD, "member-1", "One too many")).toEqual({ ok: false, reason: "full" });
		// A name already there is still pointed at, full or not.
		expect(await addGameRequest(GUILD, "member-2", "game 3")).toEqual({ ok: false, reason: "duplicate", existingName: "Game 3" });
	});

	it("refuses a name of the wrong length before touching the store", async () => {
		expect(await addGameRequest(GUILD, "member-1", "x")).toEqual({ ok: false, reason: "length" });
		expect(gameRequestStore.create).not.toHaveBeenCalled();
	});
});

describe("toggleGameRequestVote", () => {
	it("casts a vote, and a second pick takes it back", async () => {
		await addGameRequest(GUILD, "member-1", "Chess");

		const cast = await toggleGameRequestVote(GUILD, "chess", "member-2");
		expect(cast).toMatchObject({ ok: true, voted: true });
		expect(fake.find(GUILD, "chess")?.voterIds).toEqual(["member-1", "member-2"]);

		const takenBack = await toggleGameRequestVote(GUILD, "chess", "member-2");
		expect(takenBack).toMatchObject({ ok: true, voted: false });
		expect(fake.find(GUILD, "chess")?.voterIds).toEqual(["member-1"]);
	});

	it("gives a member one vote per game however often they pick it", async () => {
		await addGameRequest(GUILD, "member-1", "Chess");
		for (let press = 0; press < 5; press += 1) await toggleGameRequestVote(GUILD, "chess", "member-2");

		// An odd number of picks leaves the vote cast, once.
		expect(fake.find(GUILD, "chess")?.voterIds.filter((id) => id === "member-2")).toEqual(["member-2"]);
	});

	it("answers notFound for a game no longer on the ballot", async () => {
		expect(await toggleGameRequestVote(GUILD, "chess", "member-2")).toEqual({ ok: false, reason: "notFound" });
	});
});

describe("rankGameRequests", () => {
	it("puts the most votes first, then the older request", async () => {
		await addGameRequest(GUILD, "a", "Chess");
		await addGameRequest(GUILD, "b", "Darts");
		await addGameRequest(GUILD, "c", "Uno");
		await toggleGameRequestVote(GUILD, "uno", "d");

		expect((await listGameRequests(GUILD)).map((request) => request.name)).toEqual(["Uno", "Chess", "Darts"]);
	});

	it("does not reorder the list it was given", () => {
		const input = [
			{ guildId: GUILD, nameKey: "b", name: "B", addedBy: "x", voterIds: [], createdAt: new Date(2) },
			{ guildId: GUILD, nameKey: "a", name: "A", addedBy: "x", voterIds: ["y"], createdAt: new Date(1) },
		];
		expect(rankGameRequests(input).map((request) => request.name)).toEqual(["A", "B"]);
		expect(input.map((request) => request.name)).toEqual(["B", "A"]);
	});
});

describe("removeGameRequest", () => {
	it("strikes the request and reports it, and reports null once it is gone", async () => {
		await addGameRequest(GUILD, "member-1", "Chess");

		expect((await removeGameRequest(GUILD, "chess"))?.name).toBe("Chess");
		expect(await removeGameRequest(GUILD, "chess")).toBeNull();
		expect(fake.rows).toHaveLength(0);
	});

	it("cannot reach another server's request with the same key", async () => {
		await addGameRequest(OTHER_GUILD, "member-1", "Chess");
		expect(await removeGameRequest(GUILD, "chess")).toBeNull();
		expect(fake.rows).toHaveLength(1);
	});
});
