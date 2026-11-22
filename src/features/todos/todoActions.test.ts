import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { getPluginCopy } from "@base/copy/index.js";
import type { ITodo } from "@db/models/Todo.js";

// todoActions, the one todo write path (2026-11 item 388 Phase 2): refused while ✅todos is
// absent (R8), the server cap (A10), the D13 rights on every action, the reminders following
// every write, and the card redrawn from the row, posted again when its message is gone.
// Also the card's buttons per status and the longest customId under Discord's 100.

const m = vi.hoisted(() => ({
	rows: new Map<string, ITodo>(),
	openCount: 0,
	config: { todosChannelId: "todos-ch" } as { todosChannelId: string | null },
	sync: vi.fn(),
	remove: vi.fn(),
	schedule: vi.fn(),
	cancel: vi.fn(),
}));

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: async () => m.config } }));
vi.mock("@db/stores/meetingStore.js", () => ({ meetingStore: { findById: async () => null } }));
vi.mock("@db/stores/todoStore.js", () => ({
	todoStore: {
		insert: async (todo: ITodo) => (m.rows.set(todo.todoId, { ...todo }), { ...todo }),
		findById: async (_guildId: string, todoId: string) => (m.rows.has(todoId) ? { ...m.rows.get(todoId)! } : null),
		update: async (_guildId: string, todoId: string, changes: Partial<ITodo>) => {
			const row = m.rows.get(todoId);
			if (!row) return null;
			Object.assign(row, changes);
			return { ...row };
		},
		remove: async (_guildId: string, todoId: string) => m.rows.delete(todoId),
		countOpen: async () => m.openCount,
	},
}));
vi.mock("@features/reminders/dueReminders.js", () => ({ scheduleRemindersFor: m.schedule, cancelRemindersFor: m.cancel }));
vi.mock("@utils/cardMessage.js", () => ({ syncCardMessage: m.sync, deleteCardMessage: m.remove }));

const { completeTodo, createTodo, removeTodo, reopenTodo, setTodoDue, syncTodoCard } = await import("./todoActions.js");
const { buildTodoCard, todoCustomId, TODO_ACTIONS } = await import("./todoCard.js");

const client = {} as Client;
const holder = { userId: "holder", isAdmin: false };
const stranger = { userId: "stranger", isAdmin: false };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const copy = getPluginCopy(null);

beforeEach(() => {
	m.rows.clear();
	m.openCount = 0;
	m.config = { todosChannelId: "todos-ch" };
	m.sync.mockReset().mockResolvedValue("msg1");
	m.remove.mockReset().mockResolvedValue(undefined);
	m.schedule.mockReset().mockResolvedValue(undefined);
	m.cancel.mockReset().mockResolvedValue(undefined);
});

async function addHeldTodo(): Promise<ITodo> {
	const result = await createTodo(client, "g1", { text: "  Scout the ruins  ", dueAt: new Date("2030-01-01T00:00:00Z"), assigneeId: "holder" }, { userId: "creator", isAdmin: false });
	if (!result.ok) throw new Error(result.reason);
	await flush();
	return result.todo;
}

describe("createTodo", () => {
	it("refuses while ✅todos is absent", async () => {
		m.config = { todosChannelId: null };
		expect(await createTodo(client, "g1", { text: "x", dueAt: null, assigneeId: null }, holder)).toEqual({ ok: false, reason: "noChannel" });
	});

	it("refuses empty and overlong text, and a server at its open todo cap", async () => {
		expect(await createTodo(client, "g1", { text: "   ", dueAt: null, assigneeId: null }, holder)).toEqual({ ok: false, reason: "textInvalid" });
		expect(await createTodo(client, "g1", { text: "x".repeat(BOT_CONSTANTS.TODOS.TEXT_MAX + 1), dueAt: null, assigneeId: null }, holder)).toEqual({ ok: false, reason: "textInvalid" });
		m.openCount = BOT_CONSTANTS.TODOS.MAX_OPEN_PER_GUILD;
		expect(await createTodo(client, "g1", { text: "x", dueAt: null, assigneeId: null }, holder)).toEqual({ ok: false, reason: "cap" });
	});

	it("stores the trimmed todo, schedules its reminders and posts its card in ✅todos", async () => {
		const todo = await addHeldTodo();
		expect(todo.text).toBe("Scout the ruins");
		expect(todo.createdBy).toBe("creator");
		expect(m.schedule).toHaveBeenCalledWith({ kind: "todo", todo: expect.objectContaining({ todoId: todo.todoId }) });
		expect(m.sync).toHaveBeenCalledWith(client, "todos-ch", null, expect.anything());
		expect(m.rows.get(todo.todoId)?.messageId).toBe("msg1");
	});
});

describe("the D13 rights on every action", () => {
	it("refuses a stranger and lets the holder finish, date and reopen", async () => {
		const todo = await addHeldTodo();
		expect(await completeTodo(client, "g1", todo.todoId, stranger)).toEqual({ ok: false, reason: "notAllowed" });
		expect(await setTodoDue(client, "g1", todo.todoId, null, stranger)).toEqual({ ok: false, reason: "notAllowed" });
		expect(await removeTodo(client, "g1", todo.todoId, stranger)).toEqual({ ok: false, reason: "notAllowed" });
		const done = await completeTodo(client, "g1", todo.todoId, holder);
		expect(done.ok && done.todo.status).toBe("done");
		expect(m.schedule).toHaveBeenLastCalledWith({ kind: "todo", todo: expect.objectContaining({ status: "done" }) });
		expect(await completeTodo(client, "g1", todo.todoId, holder)).toEqual({ ok: false, reason: "alreadyDone" });
		const reopened = await reopenTodo(client, "g1", todo.todoId, { userId: "creator", isAdmin: false });
		expect(reopened.ok && reopened.todo.status).toBe("open");
	});

	it("deletes the row, cancels its reminders and removes its card", async () => {
		const todo = await addHeldTodo();
		expect((await removeTodo(client, "g1", todo.todoId, { userId: "anyone", isAdmin: true })).ok).toBe(true);
		expect(m.rows.has(todo.todoId)).toBe(false);
		expect(m.cancel).toHaveBeenCalledWith(todo.todoId);
		expect(m.remove).toHaveBeenCalledWith(client, "todos-ch", "msg1");
	});
});

describe("the card, drawn from the row", () => {
	it("reposts a card whose message is gone and stores the new id", async () => {
		const todo = await addHeldTodo();
		m.sync.mockResolvedValue("msg2");
		await syncTodoCard(client, { ...todo, channelId: "todos-ch", messageId: "msg1" }, { todosChannelId: "todos-ch", copy });
		expect(m.sync).toHaveBeenLastCalledWith(client, "todos-ch", "msg1", expect.anything());
		expect(m.rows.get(todo.todoId)?.messageId).toBe("msg2");
	});

	it("shows Assign to me only while nobody holds an open todo, and Reopen once done", async () => {
		const todo = await addHeldTodo();
		const labels = (row: ITodo) => (buildTodoCard(row, copy).components?.[0] as { components: { data: { label?: string } }[] }).components.map((button) => button.data.label);
		const words = copy.todoReminders.todos.buttons;
		expect(labels({ ...todo, assigneeId: null })).toContain(words.claim);
		expect(labels(todo)).not.toContain(words.claim);
		expect(labels({ ...todo, status: "done", doneAt: new Date(), doneBy: "holder" })).toEqual([words.reopen, words.remove]);
	});

	it("keeps the longest todo customId under Discord's 100 characters (R12)", () => {
		const longest = Math.max(...Object.values(TODO_ACTIONS).map((action) => todoCustomId(action, "x".repeat(12)).length));
		expect(longest).toBeLessThanOrEqual(BOT_CONSTANTS.DISCORD_LIMITS.MAX_CUSTOM_ID_LENGTH);
		expect(`mtg:cancelok:${"x".repeat(12)}`.length).toBeLessThanOrEqual(BOT_CONSTANTS.DISCORD_LIMITS.MAX_CUSTOM_ID_LENGTH);
	});
});
