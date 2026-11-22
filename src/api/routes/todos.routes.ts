import { Router, type Request, type Response } from "express";
import type { Client } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { TODO_STATUSES, type TodoStatus } from "@db/models/Todo.js";
import { meetingStore } from "@db/stores/meetingStore.js";
import { memberLevelStore } from "@db/stores/memberLevelStore.js";
import { todoStore } from "@db/stores/todoStore.js";
import { createTodo, editTodo, removeTodo, type TodoEdit, type TodoRefusal } from "@features/todos/todoActions.js";
import { DASHBOARD_ACTOR } from "@features/todos/todoRights.js";
import { requireGuildId } from "../middleware/requireGuildId.js";
import { isSchedulableTime, isSnowflake, readOptionalDate, strictBody, type Body } from "../utils/bodyGuards.js";
import { enrichWithNicknames } from "../utils/enrichWithNicknames.js";
import { clampLimit, nextCursor, parseCursor } from "../utils/keysetCursor.js";
import { withoutMongoKeys } from "../utils/withoutMongoKeys.js";

// ── /api/todos ──────────────────────────────────────────────────────────────
// What:  the dashboard's Meetings tab reads and edits a server's todos (2026-11 item 388
//        Phase 5a, owner decision D19): list, add, edit, delete, and the members a todo may
//        be given to.
// Who:   the Company Uno dashboard through the plugin proxy, for rok-commander and
//        general-events alike. Mounted behind verifySignature in server.ts.
// Where: guild scoping is a SECURITY BOUNDARY (invariant 2). requireGuildId runs in every
//        handler and every read and write is keyed by that guild, so another guild's todoId
//        is simply not found and answers 404, never 403.
// How:   every write goes through features/todos/todoActions, the one todo write path, so the
//        card in ✅todos redraws (saying "Updated from the dashboard") and the reminders follow.
//        The dashboard acts as DASHBOARD_ACTOR: the proxy forwards only an app owner's or a
//        link owner's request, so the members' D13 rights matrix does not apply here.
// Does NOT: reach a person. createdBy stays null for a dashboard todo (D4).

const CREATE_KEYS = ["text", "dueAt", "assigneeId"] as const;
const EDIT_KEYS = ["text", "dueAt", "assigneeId", "status"] as const;

/** Each refusal's answer. The codes are what the client maps to its own message. */
const REFUSALS: Record<TodoRefusal, { status: number; code: string }> = {
	noChannel: { status: 409, code: "TODOS_CHANNEL_MISSING" },
	cap: { status: 409, code: "TODOS_CAP_REACHED" },
	notFound: { status: 404, code: "TODO_NOT_FOUND" },
	textInvalid: { status: 400, code: "TODO_TEXT_INVALID" },
	// The dashboard actor holds every right and an edit never refuses a status it already has,
	// so these three are unreachable here; they keep the table exhaustive.
	notAllowed: { status: 403, code: "TODO_NOT_ALLOWED" },
	alreadyDone: { status: 409, code: "TODO_CONFLICT" },
	alreadyOpen: { status: 409, code: "TODO_CONFLICT" },
	alreadyHeld: { status: 409, code: "TODO_CONFLICT" },
};

type TodoParams = { todoId: string };

const refuse = (res: Response, status: number, code: string): void => {
	res.status(status).json({ error: code, code });
};

function readStatuses(raw: unknown): TodoStatus[] | null | "invalid" {
	if (raw === undefined) return null;
	return typeof raw === "string" && (TODO_STATUSES as readonly string[]).includes(raw) ? [raw as TodoStatus] : "invalid";
}

// A holder must be in the server: without this check the dashboard could have Dero remind, by
// direct message, any Discord account that shares another server with it.
async function isGuildMember(client: Client, guildId: string, userId: string): Promise<boolean> {
	const guild = client.guilds.cache.get(guildId);
	if (!guild) return false;
	return (await guild.members.fetch(userId).catch(() => null)) !== null;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; code: string };

// The text, due date and holder keys a create and an edit share, checked by type and time.
async function readTodoFields(client: Client, guildId: string, body: Body): Promise<Parsed<TodoEdit>> {
	const edit: TodoEdit = {};
	if ("text" in body) {
		if (typeof body.text !== "string") return { ok: false, code: "TODO_TEXT_INVALID" };
		edit.text = body.text;
	}
	const dueAt = readOptionalDate(body, "dueAt");
	if (dueAt === "invalid" || (dueAt instanceof Date && !isSchedulableTime(dueAt))) return { ok: false, code: "TODO_DUE_INVALID" };
	if (dueAt !== undefined) edit.dueAt = dueAt;
	if ("assigneeId" in body) {
		const assigneeId = body.assigneeId;
		if (assigneeId !== null && !isSnowflake(assigneeId)) return { ok: false, code: "TODO_ASSIGNEE_INVALID" };
		if (assigneeId !== null && !(await isGuildMember(client, guildId, assigneeId))) return { ok: false, code: "TODO_ASSIGNEE_NOT_MEMBER" };
		edit.assigneeId = assigneeId;
	}
	if ("status" in body) {
		if (typeof body.status !== "string" || !(TODO_STATUSES as readonly string[]).includes(body.status)) return { ok: false, code: "TODO_STATUS_INVALID" };
		edit.status = body.status as TodoStatus;
	}
	return { ok: true, value: edit };
}

// Everyone already on a todo or a meeting here first, then the most recently active members,
// up to DASHBOARD.MEMBERS_MAX, named as the server shows them (plan assumption A8).
async function knownMembers(client: Client, guildId: string): Promise<{ userId: string; displayName: string }[]> {
	const { MEMBERS_MAX, MEMBER_SOURCE_ROWS } = BOT_CONSTANTS.DASHBOARD;
	const ids = new Set<string>();
	const add = (id: string | null | undefined): void => {
		if (id && ids.size < MEMBERS_MAX) ids.add(id);
	};
	for (const row of await todoStore.recentPeople(guildId, MEMBER_SOURCE_ROWS)) [row.assigneeId, row.createdBy].forEach(add);
	for (const row of await meetingStore.recentPeople(guildId, MEMBER_SOURCE_ROWS)) [row.hostId, ...row.rsvpIds, ...row.speakerIds].forEach(add);
	const storedNames = new Map<string, string>();
	for (const row of await memberLevelStore.recentlyActive(guildId, MEMBERS_MAX)) {
		storedNames.set(row.userId, row.username);
		add(row.userId);
	}
	// A member Discord cannot name keeps the name their level row stored, else their id.
	const records = [...ids].map((userId) => ({ userId, username: storedNames.get(userId) ?? userId }));
	const named = await enrichWithNicknames(client, guildId, records);
	return named.map((record) => ({ userId: record.userId, displayName: record.username }));
}

export function createTodosRouter(client: Client): Router {
	const router = Router();

	router.get("/", async (req: Request, res: Response) => {
		const guildId = requireGuildId(req, res);
		if (guildId === null) return;
		const statuses = readStatuses(req.query.status);
		if (statuses === "invalid") return refuse(res, 400, "TODO_STATUS_INVALID");
		const limit = clampLimit(req.query.limit);
		const todos = await todoStore.listPage(guildId, statuses, parseCursor(req.query.cursor), limit);
		res.json({ todos: todos.map(withoutMongoKeys), nextCursor: nextCursor(todos, limit, (todo) => ({ createdAt: todo.createdAt, id: todo.todoId })) });
	});

	router.get("/members", async (req: Request, res: Response) => {
		const guildId = requireGuildId(req, res);
		if (guildId === null) return;
		res.json({ members: await knownMembers(client, guildId) });
	});

	router.post("/", async (req: Request, res: Response) => {
		const guildId = requireGuildId(req, res);
		if (guildId === null) return;
		const body = strictBody(req.body, CREATE_KEYS);
		if (!body || typeof body.text !== "string") return refuse(res, 400, "INVALID_BODY");
		const fields = await readTodoFields(client, guildId, body);
		if (!fields.ok) return refuse(res, 400, fields.code);
		const { text = "", dueAt = null, assigneeId = null } = fields.value;
		const result = await createTodo(client, guildId, { text, dueAt, assigneeId }, DASHBOARD_ACTOR);
		if (!result.ok) return refuse(res, REFUSALS[result.reason].status, REFUSALS[result.reason].code);
		res.status(201).json({ todo: withoutMongoKeys(result.todo) });
	});

	router.patch("/:todoId", async (req: Request<TodoParams>, res: Response) => {
		const guildId = requireGuildId(req, res);
		if (guildId === null) return;
		const body = strictBody(req.body, EDIT_KEYS);
		if (!body || Object.keys(body).length === 0) return refuse(res, 400, "INVALID_BODY");
		const fields = await readTodoFields(client, guildId, body);
		if (!fields.ok) return refuse(res, 400, fields.code);
		const result = await editTodo(client, guildId, req.params.todoId, fields.value, DASHBOARD_ACTOR);
		if (!result.ok) return refuse(res, REFUSALS[result.reason].status, REFUSALS[result.reason].code);
		res.json({ todo: withoutMongoKeys(result.todo) });
	});

	router.delete("/:todoId", async (req: Request<TodoParams>, res: Response) => {
		const guildId = requireGuildId(req, res);
		if (guildId === null) return;
		const result = await removeTodo(client, guildId, req.params.todoId, DASHBOARD_ACTOR);
		if (!result.ok) return refuse(res, REFUSALS[result.reason].status, REFUSALS[result.reason].code);
		res.json({ deleted: true });
	});

	return router;
}
