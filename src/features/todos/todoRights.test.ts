import { describe, expect, it } from "vitest";
import { canAssignTodo, canClaimTodo, canManageTodo, type TodoActor } from "./todoRights.js";

// The D13 rights matrix (2026-11 item 388): the holder, the creator and admins manage a todo;
// anyone may claim an open one nobody holds; the dashboard (no Discord id) manages as an admin.

const HOLDER = "111";
const CREATOR = "222";
const STRANGER = "333";
const held = { assigneeId: HOLDER, createdBy: CREATOR, status: "open" as const };
const unheld = { assigneeId: null, createdBy: CREATOR, status: "open" as const };
const member = (userId: string): TodoActor => ({ userId, isAdmin: false });
const admin: TodoActor = { userId: STRANGER, isAdmin: true };
const dashboard: TodoActor = { userId: null, isAdmin: true };

describe("canManageTodo", () => {
	it.each([
		["the holder", member(HOLDER), true],
		["the creator", member(CREATOR), true],
		["an admin", admin, true],
		["the dashboard", dashboard, true],
		["anyone else", member(STRANGER), false],
		["an unknown non admin", { userId: null, isAdmin: false }, false],
	])("%s: %s", (_who, actor, allowed) => {
		expect(canManageTodo(held, actor)).toBe(allowed);
	});
});

describe("canClaimTodo and canAssignTodo", () => {
	it("lets anyone claim an open todo nobody holds, and only for themselves", () => {
		expect(canClaimTodo(unheld, member(STRANGER))).toBe(true);
		expect(canAssignTodo(unheld, STRANGER, member(STRANGER))).toBe(true);
		expect(canAssignTodo(unheld, HOLDER, member(STRANGER))).toBe(false);
	});

	it("refuses a claim on a held or done todo", () => {
		expect(canClaimTodo(held, member(STRANGER))).toBe(false);
		expect(canClaimTodo({ ...unheld, status: "done" }, member(STRANGER))).toBe(false);
		expect(canAssignTodo(held, STRANGER, member(STRANGER))).toBe(false);
	});

	it("lets a manager give the todo to anyone or to nobody", () => {
		expect(canAssignTodo(held, STRANGER, member(CREATOR))).toBe(true);
		expect(canAssignTodo(held, null, member(HOLDER))).toBe(true);
		expect(canAssignTodo(held, null, member(STRANGER))).toBe(false);
	});
});
