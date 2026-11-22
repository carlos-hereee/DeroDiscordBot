import type { ITodo } from "@db/models/Todo.js";

// ── todoRights ──────────────────────────────────────────────────────────────
// What:  who may do what to a todo (2026-11 item 388, owner decision D13). Pure, so the
//        rights matrix is tested without Discord.
// Who:   todoActions, the one write path, re-checks these on every action whatever surface
//        it came from (a button press, a modal Submit, a command, the dashboard).

/** Who is acting on a todo. `userId` is null for the dashboard, which has no Discord identity (D4). */
export interface TodoActor {
	userId: string | null;
	// The server owner or an admin (utils/permissions.ts isOwnerOrAdmin), or the dashboard,
	// whose app owner manages the whole server's todos.
	isAdmin: boolean;
	// True for a dashboard write, so the card it redraws says "Updated from the dashboard".
	fromDashboard?: boolean;
}

/**
 * The dashboard's actor (2026-11 item 388 Phase 5a): no Discord identity (D4), and every right,
 * because the proxy forwards only an app owner's or a link owner's request, who manages the
 * whole server's todos. The D13 matrix is for members pressing cards.
 */
export const DASHBOARD_ACTOR: Readonly<TodoActor> = { userId: null, isAdmin: true, fromDashboard: true };

/** The holder, the member who added it, or an admin may change a todo, reassign it, date it or delete it. */
export function canManageTodo(todo: Pick<ITodo, "assigneeId" | "createdBy">, actor: TodoActor): boolean {
	if (actor.isAdmin) return true;
	if (!actor.userId) return false;
	return todo.assigneeId === actor.userId || todo.createdBy === actor.userId;
}

/** Anyone may take an open todo nobody holds yet (Assign to me). */
export function canClaimTodo(todo: Pick<ITodo, "assigneeId" | "status">, actor: TodoActor): boolean {
	return actor.userId !== null && todo.status === "open" && todo.assigneeId === null;
}

/** May this actor give the todo to `assigneeId`? A manager may give it to anyone; anyone else only claim it. */
export function canAssignTodo(todo: Pick<ITodo, "assigneeId" | "createdBy" | "status">, assigneeId: string | null, actor: TodoActor): boolean {
	if (canManageTodo(todo, actor)) return true;
	return assigneeId !== null && assigneeId === actor.userId && canClaimTodo(todo, actor);
}
