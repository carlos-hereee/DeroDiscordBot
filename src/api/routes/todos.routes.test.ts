import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import type { Client } from "discord.js";
import type { ITodo } from "@db/models/Todo.js";

// /api/todos, the dashboard's todo reads and writes (2026-11 item 388 Phase 5a), through the
// real Express chain and the real todoActions write path: every route answers 400 without a
// guildId and 404 for another guild's todo, a body with an unknown key is refused, the R8
// 409 holds while ✅todos is absent, and a dashboard edit redraws the card in ✅todos saying
// it was updated from the dashboard. Only the stores, the reminders and Discord are faked.

const HOLDER = "123456789012345678";
const STRANGER = "223456789012345678";

const m = vi.hoisted(() => ({
	rows: new Map<string, ITodo>(),
	config: { todosChannelId: "todos-ch" } as { todosChannelId: string | null } | null,
	sync: vi.fn(),
	deleteCard: vi.fn(),
	schedule: vi.fn(),
	cancel: vi.fn(),
	levels: [] as Array<{ userId: string; username: string }>,
	meetingPeople: [] as Array<{ hostId: string | null; rsvpIds: string[]; speakerIds: string[] }>,
}));

const key = (guildId: string, todoId: string) => `${guildId}/${todoId}`;

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: async () => m.config } }));
vi.mock("@db/stores/meetingStore.js", () => ({ meetingStore: { findById: async () => null, recentPeople: async () => m.meetingPeople } }));
vi.mock("@db/stores/memberLevelStore.js", () => ({ memberLevelStore: { recentlyActive: async () => m.levels } }));
vi.mock("@db/stores/todoStore.js", () => ({
	todoStore: {
		insert: async (todo: ITodo) => (m.rows.set(key(todo.guildId, todo.todoId), { ...todo, createdAt: new Date() }), { ...todo }),
		findById: async (guildId: string, todoId: string) => (m.rows.has(key(guildId, todoId)) ? { ...m.rows.get(key(guildId, todoId))! } : null),
		update: async (guildId: string, todoId: string, changes: Partial<ITodo>) => {
			const row = m.rows.get(key(guildId, todoId));
			if (!row) return null;
			Object.assign(row, changes);
			return { ...row };
		},
		remove: async (guildId: string, todoId: string) => m.rows.delete(key(guildId, todoId)),
		countOpen: async () => 0,
		listPage: vi.fn(async (guildId: string, statuses: string[] | null, _before: unknown, limit: number) =>
			[...m.rows.values()].filter((row) => row.guildId === guildId && (!statuses || statuses.includes(row.status))).slice(0, limit)
		),
		recentPeople: async (guildId: string) => [...m.rows.values()].filter((row) => row.guildId === guildId),
	},
}));
vi.mock("@features/reminders/dueReminders.js", () => ({ scheduleRemindersFor: m.schedule, cancelRemindersFor: m.cancel }));
vi.mock("@utils/cardMessage.js", () => ({ syncCardMessage: m.sync, deleteCardMessage: m.deleteCard }));

const { createTodosRouter } = await import("./todos.routes.js");
const { apiErrorHandler } = await import("../middleware/apiErrorHandler.js");
const { todoStore } = await import("@db/stores/todoStore.js");

const member = (id: string, displayName: string) => ({ id, displayName, user: { username: `${displayName}-user`, globalName: null } });
const membersById = new Map([
	[HOLDER, member(HOLDER, "Ada")],
	[STRANGER, member(STRANGER, "Grace")],
]);
const guild = {
	members: {
		fetch: async (arg: string | { user: string[] }) => {
			if (typeof arg === "string") {
				const found = membersById.get(arg);
				if (!found) throw new Error("unknown member");
				return found;
			}
			return new Map(arg.user.filter((id) => membersById.has(id)).map((id) => [id, membersById.get(id)!]));
		},
	},
};
const client = { guilds: { cache: new Map([["guild-1", guild]]), fetch: async () => null } } as unknown as Client;

function app() {
	const server = express();
	server.use(express.json());
	server.use("/api/todos", createTodosRouter(client));
	server.use(apiErrorHandler);
	return request(server);
}

function seed(guildId: string, todoId: string, changes: Partial<ITodo> = {}): ITodo {
	const row: ITodo = {
		todoId,
		guildId,
		text: "Book the hall",
		createdBy: HOLDER,
		assigneeId: null,
		dueAt: null,
		status: "open",
		doneAt: null,
		doneBy: null,
		meetingId: null,
		actionItemIndex: null,
		channelId: "todos-ch",
		messageId: "card-1",
		createdAt: new Date("2026-11-20T10:00:00Z"),
		...changes,
	};
	m.rows.set(key(guildId, todoId), row);
	return row;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const inAnHour = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();
const lastCardText = (): string => {
	const payload = m.sync.mock.calls.at(-1)?.[3] as { embeds: Array<{ data: { description?: string } }> };
	return payload.embeds[0]?.data.description ?? "";
};

beforeEach(() => {
	m.rows.clear();
	m.config = { todosChannelId: "todos-ch" };
	m.levels = [];
	m.meetingPeople = [];
	m.sync.mockReset().mockResolvedValue("card-1");
	m.deleteCard.mockReset().mockResolvedValue(undefined);
	m.schedule.mockReset().mockResolvedValue(undefined);
	m.cancel.mockReset().mockResolvedValue(undefined);
});

describe("every todo route needs a guildId", () => {
	it.each([
		["get", "/api/todos"],
		["get", "/api/todos/members"],
		["post", "/api/todos"],
		["patch", "/api/todos/t1"],
		["delete", "/api/todos/t1"],
	] as const)("%s %s answers 400 without one", async (method, path) => {
		const res = await app()[method](path).send({ text: "x" }).timeout(2_000);
		expect(res.status).toBe(400);
	});
});

describe("GET /api/todos", () => {
	it("lists this guild's todos only, with a null cursor on the last page", async () => {
		seed("guild-1", "t1");
		seed("guild-2", "t2");
		const res = await app().get("/api/todos").query({ guildId: "guild-1" });
		expect(res.status).toBe(200);
		expect(res.body.todos.map((todo: ITodo) => todo.todoId)).toEqual(["t1"]);
		expect(res.body.nextCursor).toBeNull();
	});

	it("clamps the limit, reads a status, and refuses an unknown status", async () => {
		await app().get("/api/todos").query({ guildId: "guild-1", limit: "500", status: "done" });
		expect(vi.mocked(todoStore.listPage)).toHaveBeenLastCalledWith("guild-1", ["done"], null, 100);
		const res = await app().get("/api/todos").query({ guildId: "guild-1", status: "archived" });
		expect(res.status).toBe(400);
		expect(res.body.code).toBe("TODO_STATUS_INVALID");
	});

	it("hands back a cursor naming the last row of a full page", async () => {
		seed("guild-1", "t1");
		const res = await app().get("/api/todos").query({ guildId: "guild-1", limit: "1" });
		expect(res.body.nextCursor).toBe("2026-11-20T10:00:00.000Z~t1");
	});
});

describe("GET /api/todos/members", () => {
	it("lists the people on todos and meetings first, then active members, by their server names", async () => {
		seed("guild-1", "t1", { createdBy: HOLDER });
		m.meetingPeople = [{ hostId: null, rsvpIds: [STRANGER], speakerIds: [] }];
		m.levels = [{ userId: "323456789012345678", username: "Linus" }];
		const res = await app().get("/api/todos/members").query({ guildId: "guild-1" });
		expect(res.status).toBe(200);
		expect(res.body.members).toEqual([
			{ userId: HOLDER, displayName: "Ada" },
			{ userId: STRANGER, displayName: "Grace" },
			{ userId: "323456789012345678", displayName: "Linus" },
		]);
	});
});

describe("POST /api/todos", () => {
	it("adds a todo with no Discord creator and posts its card marked from the dashboard", async () => {
		const res = await app().post("/api/todos").query({ guildId: "guild-1" }).send({ text: "Order banners", dueAt: inAnHour(), assigneeId: HOLDER });
		expect(res.status).toBe(201);
		expect(res.body.todo).toMatchObject({ text: "Order banners", createdBy: null, assigneeId: HOLDER, status: "open" });
		await flush();
		expect(m.schedule).toHaveBeenCalled();
		expect(lastCardText()).toContain("Updated from the dashboard.");
	});

	it.each([
		[{ text: "x", note: "extra" }, "INVALID_BODY"],
		[{ dueAt: null }, "INVALID_BODY"],
		[{ text: "x", dueAt: "2020-01-01T00:00:00Z" }, "TODO_DUE_INVALID"],
		[{ text: "x", dueAt: "soon" }, "TODO_DUE_INVALID"],
		[{ text: "x", assigneeId: "not-a-snowflake" }, "TODO_ASSIGNEE_INVALID"],
		[{ text: "x", assigneeId: "923456789012345678" }, "TODO_ASSIGNEE_NOT_MEMBER"],
		[{ text: "   " }, "TODO_TEXT_INVALID"],
	])("refuses %j with 400 %s", async (body, code) => {
		const res = await app().post("/api/todos").query({ guildId: "guild-1" }).send(body);
		expect(res.status).toBe(400);
		expect(res.body.code).toBe(code);
		expect(m.rows.size).toBe(0);
	});

	it("answers 409 while ✅todos is absent (R8)", async () => {
		m.config = { todosChannelId: null };
		const res = await app().post("/api/todos").query({ guildId: "guild-1" }).send({ text: "Order banners" });
		expect(res.status).toBe(409);
		expect(res.body.code).toBe("TODOS_CHANNEL_MISSING");
	});
});

describe("PATCH /api/todos/:todoId", () => {
	it("applies the edit in one write and redraws the card in ✅todos marked from the dashboard", async () => {
		seed("guild-1", "t1");
		const res = await app().patch("/api/todos/t1").query({ guildId: "guild-1" }).send({ text: "Book the big hall", assigneeId: STRANGER, status: "done" });
		expect(res.status).toBe(200);
		expect(res.body.todo).toMatchObject({ text: "Book the big hall", assigneeId: STRANGER, status: "done", doneBy: null });
		expect(res.body.todo.doneAt).not.toBeNull();
		await flush();
		expect(m.sync).toHaveBeenCalledTimes(1);
		expect(m.sync.mock.calls[0][1]).toBe("todos-ch");
		expect(m.sync.mock.calls[0][2]).toBe("card-1");
		expect(lastCardText()).toContain("Updated from the dashboard.");
		expect(m.schedule).toHaveBeenCalledTimes(1);
	});

	it("answers 404 for another guild's todo and changes nothing", async () => {
		seed("guild-2", "t2");
		const res = await app().patch("/api/todos/t2").query({ guildId: "guild-1" }).send({ text: "Mine now" });
		expect(res.status).toBe(404);
		expect(m.rows.get(key("guild-2", "t2"))?.text).toBe("Book the hall");
	});

	it("refuses an empty body, an unknown key and an unknown status", async () => {
		seed("guild-1", "t1");
		for (const body of [{}, { holder: HOLDER }, { status: "archived" }]) {
			const res = await app().patch("/api/todos/t1").query({ guildId: "guild-1" }).send(body);
			expect(res.status).toBe(400);
		}
	});

	it("answers 409 while ✅todos is absent (R8)", async () => {
		seed("guild-1", "t1");
		m.config = { todosChannelId: null };
		const res = await app().patch("/api/todos/t1").query({ guildId: "guild-1" }).send({ text: "Later" });
		expect(res.status).toBe(409);
		expect(res.body.code).toBe("TODOS_CHANNEL_MISSING");
	});
});

describe("DELETE /api/todos/:todoId", () => {
	it("deletes the todo, cancels its reminders and takes its card away", async () => {
		seed("guild-1", "t1");
		const res = await app().delete("/api/todos/t1").query({ guildId: "guild-1" });
		expect(res.status).toBe(200);
		expect(m.rows.has(key("guild-1", "t1"))).toBe(false);
		expect(m.cancel).toHaveBeenCalledWith("t1");
		expect(m.deleteCard).toHaveBeenCalledWith(client, "todos-ch", "card-1");
	});

	it("answers 404 for another guild's todo", async () => {
		seed("guild-2", "t2");
		const res = await app().delete("/api/todos/t2").query({ guildId: "guild-1" });
		expect(res.status).toBe(404);
		expect(m.rows.has(key("guild-2", "t2"))).toBe(true);
	});

	it("answers 409 while ✅todos is absent (R8)", async () => {
		seed("guild-1", "t1");
		m.config = null;
		const res = await app().delete("/api/todos/t1").query({ guildId: "guild-1" });
		expect(res.status).toBe(409);
	});
});
