import { Todo, type ITodo, type TodoStatus } from "@db/models/Todo.js";
import type { KeysetBound } from "./keysetBound.js";

// ── todoStore ──
// What:  every DB touch for Todo (2026-11 item 388). Thin on purpose: features/todos decides
//        who may change a todo and what a change redraws (Phase 2). House store rules apply:
//        no business logic, no tests (rule 6).

/** The fields a write may change; the ids and the guild are never rewritten. */
export type TodoChanges = Partial<Pick<ITodo, "text" | "assigneeId" | "dueAt" | "status" | "doneAt" | "doneBy" | "channelId" | "messageId">>;

export const todoStore = {
	async insert(todo: ITodo): Promise<ITodo> {
		const created = await Todo.create(todo);
		return created.toObject();
	},

	async findById(guildId: string, todoId: string): Promise<ITodo | null> {
		return Todo.findOne({ guildId, todoId }).lean<ITodo>();
	},

	/** Apply `changes` and hand back the row as it now stands, or null when it is gone. */
	async update(guildId: string, todoId: string, changes: TodoChanges): Promise<ITodo | null> {
		return Todo.findOneAndUpdate({ guildId, todoId }, { $set: changes }, { new: true }).lean<ITodo>();
	},

	/** True when there was a row to delete. */
	async remove(guildId: string, todoId: string): Promise<boolean> {
		const result = await Todo.deleteOne({ guildId, todoId });
		return result.deletedCount > 0;
	},

	/** How many open todos a server holds, for the per server cap. */
	async countOpen(guildId: string): Promise<number> {
		return Todo.countDocuments({ guildId, status: "open" });
	},

	/** A member's open todos in one server by due date, at most `limit`. Mongo sorts a null lowest, so undated todos come first. */
	async listOpenForAssignee(guildId: string, assigneeId: string, limit: number): Promise<ITodo[]> {
		return Todo.find({ guildId, assigneeId, status: "open" }).sort({ dueAt: 1, createdAt: 1 }).limit(limit).lean<ITodo[]>();
	},
	async countOpenForAssignee(guildId: string, assigneeId: string): Promise<number> {
		return Todo.countDocuments({ guildId, assigneeId, status: "open" });
	},
	/** The todos a meeting's action items made, by their place in its summary. */
	async findForMeeting(guildId: string, meetingId: string): Promise<ITodo[]> {
		return Todo.find({ guildId, meetingId }).sort({ actionItemIndex: 1 }).lean<ITodo[]>();
	},

	/** One page of a server's todos, newest first, after `before` (the dashboard list, 2026-11 item 388 Phase 5a). */
	async listPage(guildId: string, statuses: readonly TodoStatus[] | null, before: KeysetBound | null, limit: number): Promise<ITodo[]> {
		const filter: Record<string, unknown> = { guildId };
		if (statuses) filter.status = { $in: [...statuses] };
		if (before) filter.$or = [{ createdAt: { $lt: before.createdAt } }, { createdAt: before.createdAt, todoId: { $lt: before.id } }];
		return Todo.find(filter).select("-_id -__v").sort({ createdAt: -1, todoId: -1 }).limit(limit).lean<ITodo[]>();
	},

	/** The people on a server's most recently changed todos, for the dashboard's member list. */
	async recentPeople(guildId: string, limit: number): Promise<Pick<ITodo, "createdBy" | "assigneeId">[]> {
		return Todo.find({ guildId }, { _id: 0, createdBy: 1, assigneeId: 1 }).sort({ updatedAt: -1 }).limit(limit).lean<Pick<ITodo, "createdBy" | "assigneeId">[]>();
	},

	// Self destruct's server data delete: every row this guild owns.
	async deleteGuild(guildId: string) {
		return Todo.deleteMany({ guildId });
	},
};
