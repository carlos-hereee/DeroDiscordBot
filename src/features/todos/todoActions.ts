import type { Client } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { getPluginCopy, type ICopyConfig, type IPluginCopy } from "@base/copy/index.js";
import type { ITodo, TodoStatus } from "@db/models/Todo.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { meetingStore } from "@db/stores/meetingStore.js";
import { todoStore, type TodoChanges } from "@db/stores/todoStore.js";
import { cancelRemindersFor, scheduleRemindersFor } from "@features/reminders/dueReminders.js";
import { deleteCardMessage, syncCardMessage } from "@utils/cardMessage.js";
import { shortId } from "@utils/shortId.js";
import { buildTodoCard } from "./todoCard.js";
import { canAssignTodo, canManageTodo, type TodoActor } from "./todoRights.js";

// ── todoActions ─────────────────────────────────────────────────────────────
// What:  the ONE write path for todos (2026-11 item 388 Phase 2): create, assign, setDue,
//        complete, reopen and remove. Each re-checks the rights (todoRights, owner decision
//        D13), writes the row, brings the reminders in line, and redraws the card in ✅todos.
// Who:   todoHandlers (buttons and modals), commands/utility/todo.ts, and from Phase 4 the
//        meeting action items and from Phase 5 the dashboard routes. A second write path
//        would let one surface skip the rights or forget the reminders, so none exists.
// When:  every action is refused while ✅todos is absent (R8): todos are off in that server.
// How:   the row write is the primary action and is awaited; the reminder rows follow it
//        (awaited, errors logged and never thrown back); the card redraw is fire and forget,
//        so a slow or failing Discord never turns a saved todo into a refusal.

/** Why an action was refused; each has its own private line in the packs. */
export type TodoRefusal = "noChannel" | "cap" | "notFound" | "notAllowed" | "alreadyDone" | "alreadyOpen" | "alreadyHeld" | "textInvalid";

export type TodoResult = { ok: true; todo: ITodo } | { ok: false; reason: TodoRefusal };

/** A new todo. `meetingId` and `actionItemIndex` are set only for a meeting's action items (Phase 4). */
export interface NewTodo {
	text: string;
	dueAt: Date | null;
	assigneeId: string | null;
	meetingId?: string | null;
	actionItemIndex?: number | null;
}

interface TodosContext {
	todosChannelId: string;
	copy: IPluginCopy;
}

const refuse = (reason: TodoRefusal): TodoResult => ({ ok: false, reason });

async function todosContext(guildId: string): Promise<TodosContext | null> {
	const config = await guildConfigStore.findByGuildId(guildId);
	if (!config?.todosChannelId) return null;
	return { todosChannelId: config.todosChannelId, copy: getPluginCopy(config as unknown as ICopyConfig) };
}

/** The trimmed text, or null when it is empty or too long. */
export function cleanTodoText(raw: string): string | null {
	const text = raw.trim();
	return text.length > 0 && text.length <= BOT_CONSTANTS.TODOS.TEXT_MAX ? text : null;
}

// The link to the notes card of the meeting a todo came from, read off that meeting's row.
async function meetingNotesUrl(todo: ITodo): Promise<string | null> {
	if (!todo.meetingId) return null;
	const meeting = await meetingStore.findById(todo.guildId, todo.meetingId);
	if (!meeting?.notesChannelId || !meeting.notesMessageId) return null;
	return `https://discord.com/channels/${todo.guildId}/${meeting.notesChannelId}/${meeting.notesMessageId}`;
}

/**
 * Show `todo`'s card in ✅todos: edited in place, or posted again (and its new id stored)
 * when its message is gone or ✅todos was rebuilt under a new id. Exported for the tests.
 */
export async function syncTodoCard(client: Client, todo: ITodo, context: TodosContext, fromDashboard = false): Promise<void> {
	const current = todo.channelId === context.todosChannelId ? todo.messageId : null;
	const messageId = await syncCardMessage(client, context.todosChannelId, current, buildTodoCard(todo, context.copy, await meetingNotesUrl(todo), fromDashboard));
	if (messageId && messageId !== todo.messageId) await todoStore.update(todo.guildId, todo.todoId, { channelId: context.todosChannelId, messageId });
}

// After every saved write: reminders in line with the row, then the card redrawn.
async function afterWrite(client: Client, todo: ITodo, context: TodosContext, actor: TodoActor): Promise<void> {
	await scheduleRemindersFor({ kind: "todo", todo }).catch((error: unknown) =>
		console.error("[todoActions] the todo's reminders could not be scheduled", { todoId: todo.todoId, error: error instanceof Error ? error.name : "unknown" })
	);
	void syncTodoCard(client, todo, context, actor.fromDashboard === true).catch((error: unknown) =>
		console.error("[todoActions] the todo card could not be redrawn", { todoId: todo.todoId, error: error instanceof Error ? error.name : "unknown" })
	);
}

/** Add a todo. Any member may (D13); the server cap still applies (A10). */
export async function createTodo(client: Client, guildId: string, input: NewTodo, actor: TodoActor): Promise<TodoResult> {
	const context = await todosContext(guildId);
	if (!context) return refuse("noChannel");
	const text = cleanTodoText(input.text);
	if (!text) return refuse("textInvalid");
	if ((await todoStore.countOpen(guildId)) >= BOT_CONSTANTS.TODOS.MAX_OPEN_PER_GUILD) return refuse("cap");
	const todo = await todoStore.insert({
		todoId: shortId(),
		guildId,
		text,
		createdBy: actor.userId,
		assigneeId: input.assigneeId,
		dueAt: input.dueAt,
		status: "open",
		doneAt: null,
		doneBy: null,
		meetingId: input.meetingId ?? null,
		actionItemIndex: input.actionItemIndex ?? null,
		channelId: null,
		messageId: null,
	});
	await afterWrite(client, todo, context, actor);
	return { ok: true, todo };
}

// Load, check, write, follow up: the shape every change to an existing todo shares.
async function changeTodo(
	client: Client,
	guildId: string,
	todoId: string,
	actor: TodoActor,
	check: (todo: ITodo) => TodoRefusal | null,
	changes: (todo: ITodo) => TodoChanges
): Promise<TodoResult> {
	const context = await todosContext(guildId);
	if (!context) return refuse("noChannel");
	const before = await todoStore.findById(guildId, todoId);
	if (!before) return refuse("notFound");
	const refusal = check(before);
	if (refusal) return refuse(refusal);
	const after = await todoStore.update(guildId, todoId, changes(before));
	if (!after) return refuse("notFound");
	await afterWrite(client, after, context, actor);
	return { ok: true, todo: after };
}

/** Give the todo to `assigneeId` (null takes it from its holder). Anyone may claim an unheld todo for themselves. */
export function assignTodo(client: Client, guildId: string, todoId: string, assigneeId: string | null, actor: TodoActor): Promise<TodoResult> {
	return changeTodo(
		client,
		guildId,
		todoId,
		actor,
		(todo) => {
			if (canAssignTodo(todo, assigneeId, actor)) return null;
			// A claim that lost the race to someone else reads as taken, not as forbidden.
			return todo.assigneeId !== null && assigneeId === actor.userId ? "alreadyHeld" : "notAllowed";
		},
		() => ({ assigneeId })
	);
}

/** Set or clear the due date. The reminders move with it. */
export function setTodoDue(client: Client, guildId: string, todoId: string, dueAt: Date | null, actor: TodoActor): Promise<TodoResult> {
	return changeTodo(client, guildId, todoId, actor, (todo) => (canManageTodo(todo, actor) ? null : "notAllowed"), () => ({ dueAt }));
}

/** Mark the todo done. Its reminders are cancelled by the reminder sync. */
export function completeTodo(client: Client, guildId: string, todoId: string, actor: TodoActor, now: Date = new Date()): Promise<TodoResult> {
	return changeTodo(
		client,
		guildId,
		todoId,
		actor,
		(todo) => {
			if (!canManageTodo(todo, actor)) return "notAllowed";
			return todo.status === "done" ? "alreadyDone" : null;
		},
		() => ({ status: "done", doneAt: now, doneBy: actor.userId })
	);
}

/** Open a done todo again, inside the server's open todo cap. */
export async function reopenTodo(client: Client, guildId: string, todoId: string, actor: TodoActor): Promise<TodoResult> {
	const atCap = (await todoStore.countOpen(guildId)) >= BOT_CONSTANTS.TODOS.MAX_OPEN_PER_GUILD;
	return changeTodo(
		client,
		guildId,
		todoId,
		actor,
		(todo) => {
			if (!canManageTodo(todo, actor)) return "notAllowed";
			if (todo.status === "open") return "alreadyOpen";
			return atCap ? "cap" : null;
		},
		() => ({ status: "open", doneAt: null, doneBy: null })
	);
}

/** Several changes to one todo in a single write, as the dashboard's edit sends them. An absent key is left as it is. */
export interface TodoEdit {
	text?: string;
	dueAt?: Date | null;
	assigneeId?: string | null;
	status?: TodoStatus;
}

/**
 * Apply `edit` to a todo in one write, so a dashboard save that changes the text, the holder,
 * the due date and the status redraws the card and moves the reminders once (2026-11 item 388
 * Phase 5a). The manage right covers every field. Marking done stamps who and when; opening a
 * done todo again sits inside the server cap; a status equal to the current one changes nothing.
 */
export async function editTodo(client: Client, guildId: string, todoId: string, edit: TodoEdit, actor: TodoActor, now: Date = new Date()): Promise<TodoResult> {
	const text = edit.text === undefined ? undefined : cleanTodoText(edit.text);
	if (text === null) return refuse("textInvalid");
	const atCap = edit.status === "open" && (await todoStore.countOpen(guildId)) >= BOT_CONSTANTS.TODOS.MAX_OPEN_PER_GUILD;
	return changeTodo(
		client,
		guildId,
		todoId,
		actor,
		(todo) => {
			if (!canManageTodo(todo, actor)) return "notAllowed";
			return atCap && todo.status === "done" ? "cap" : null;
		},
		(todo) => {
			const changes: TodoChanges = {};
			if (text !== undefined) changes.text = text;
			if (edit.dueAt !== undefined) changes.dueAt = edit.dueAt;
			if (edit.assigneeId !== undefined) changes.assigneeId = edit.assigneeId;
			if (edit.status === "done" && todo.status === "open") Object.assign(changes, { status: "done", doneAt: now, doneBy: actor.userId });
			if (edit.status === "open" && todo.status === "done") Object.assign(changes, { status: "open", doneAt: null, doneBy: null });
			return changes;
		}
	);
}

/** Delete the todo, its reminders and its card. */
export async function removeTodo(client: Client, guildId: string, todoId: string, actor: TodoActor): Promise<TodoResult> {
	const context = await todosContext(guildId);
	if (!context) return refuse("noChannel");
	const todo = await todoStore.findById(guildId, todoId);
	if (!todo) return refuse("notFound");
	if (!canManageTodo(todo, actor)) return refuse("notAllowed");
	if (!(await todoStore.remove(guildId, todoId))) return refuse("notFound");
	await cancelRemindersFor(todoId).catch((error: unknown) =>
		console.error("[todoActions] the todo's reminders could not be cancelled", { todoId, error: error instanceof Error ? error.name : "unknown" })
	);
	if (todo.channelId && todo.messageId) void deleteCardMessage(client, todo.channelId, todo.messageId);
	return { ok: true, todo };
}
