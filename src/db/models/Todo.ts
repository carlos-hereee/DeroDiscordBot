// src/db/models/Todo.ts
import mongoose from "mongoose";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";

// ── Todo ──
// What:  one todo card in ✅todos (2026-11 item 388): its text, who made it, who holds it,
//        when it is due, whether it is done, and the meeting action item it came from.
// Who:   features/todos (Phase 2) through todoStore, the one write path every surface
//        calls: the card's buttons, /todo, the meeting summary's action items and the
//        dashboard routes. The card in ✅todos is drawn from this row.
// Where: guild scoped like every row here (invariant 2), keyed by its own 12 character id
//        (utils/shortId.ts), which rides the card's button customIds.
//
// createdBy is null for a todo written from the dashboard, because the proxy forwards no
// person's Discord id (owner decision D4 of the plan's session notes).

export const TODO_STATUSES = ["open", "done"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface ITodo {
	todoId: string;
	guildId: string;
	text: string;
	createdBy: string | null;
	assigneeId: string | null;
	dueAt: Date | null;
	status: TodoStatus;
	doneAt: Date | null;
	doneBy: string | null;
	// The meeting and the action item's place in its summary, for a todo made from one.
	meetingId: string | null;
	actionItemIndex: number | null;
	// Where the card was posted, so a press or a dashboard edit redraws it in place.
	channelId: string | null;
	messageId: string | null;
	createdAt?: Date;
	updatedAt?: Date;
}

const todoSchema = new mongoose.Schema<ITodo>(
	{
		todoId: { type: String, required: true },
		guildId: { type: String, required: true },
		text: { type: String, required: true, minlength: 1, maxlength: BOT_CONSTANTS.TODOS.TEXT_MAX },
		createdBy: { type: String, default: null },
		assigneeId: { type: String, default: null },
		dueAt: { type: Date, default: null },
		status: { type: String, enum: TODO_STATUSES, default: "open", required: true },
		doneAt: { type: Date, default: null },
		doneBy: { type: String, default: null },
		meetingId: { type: String, default: null },
		actionItemIndex: { type: Number, default: null },
		channelId: { type: String, default: null },
		messageId: { type: String, default: null },
	},
	{ timestamps: true }
);

todoSchema.index({ guildId: 1, todoId: 1 }, { unique: true });
// The open list, the due reminders' rescheduling and the per server cap all read this way.
todoSchema.index({ guildId: 1, status: 1, dueAt: 1 });
// ⚠️ REQUIRED, the idempotency of a meeting's action items: a summary result delivered
// twice makes each todo once. Filtered on $type string, NOT $exists: MongoDB matches a
// stored null under $exists true, so an $exists filter would put every manual todo
// (meetingId null, actionItemIndex null) on one key and refuse the second one.
todoSchema.index({ meetingId: 1, actionItemIndex: 1 }, { unique: true, partialFilterExpression: { meetingId: { $type: "string" } } });

export const Todo = mongoose.model<ITodo>("Todo", todoSchema);
