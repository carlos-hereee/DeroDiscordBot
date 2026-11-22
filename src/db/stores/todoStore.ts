import { Todo, type ITodo } from "@db/models/Todo.js";

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

	/** The todos a meeting's action items made, by their place in its summary. */
	async findForMeeting(guildId: string, meetingId: string): Promise<ITodo[]> {
		return Todo.find({ guildId, meetingId }).sort({ actionItemIndex: 1 }).lean<ITodo[]>();
	},

	// Self destruct's server data delete: every row this guild owns.
	async deleteGuild(guildId: string) {
		return Todo.deleteMany({ guildId });
	},
};
