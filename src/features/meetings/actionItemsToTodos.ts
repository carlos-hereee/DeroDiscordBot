import type { Client } from "discord.js";
import type { IMeeting } from "@db/models/Meeting.js";
import { todoStore } from "@db/stores/todoStore.js";
import { createTodo } from "@features/todos/todoActions.js";

// ── actionItemsToTodos ──────────────────────────────────────────────────────
// What:  one todo card in ✅todos per action item of a summarized meeting (2026-11 item 388
//        Phase 4, owner decision D12), through todoActions.createTodo, the one todo write
//        path, so the card and its reminders follow as for any todo.
// Who:   summaryResult, after the summary is written onto the Meeting row.
// How:   idempotent on meetingId plus the item's index: the indexes already holding a todo
//        are skipped, and the partial unique index on Todo refuses a racing second insert,
//        which is read as already made. The creator is the member who started the recording
//        (owner decision G2), so an unassigned item's reminders reach them.
// When ✅todos is absent, or the server's open todo cap is reached, the remaining items stay
//        on the notes card only.

const MONGO_DUPLICATE_KEY = 11000;

const isDuplicateKey = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === MONGO_DUPLICATE_KEY;

/** Make the meeting's missing action item todos. Returns how many were created now. */
export async function createActionItemTodos(client: Client, meeting: IMeeting): Promise<number> {
	const items = meeting.summary?.actionItems ?? [];
	if (items.length === 0) return 0;
	const existing = await todoStore.findForMeeting(meeting.guildId, meeting.meetingId);
	const made = new Set(existing.map((todo) => todo.actionItemIndex));

	let created = 0;
	for (const [index, item] of items.entries()) {
		if (made.has(index)) continue;
		try {
			const result = await createTodo(
				client,
				meeting.guildId,
				{ text: item.text, dueAt: null, assigneeId: item.assigneeId, meetingId: meeting.meetingId, actionItemIndex: index },
				{ userId: meeting.hostId, isAdmin: false }
			);
			if (result.ok) {
				created += 1;
				continue;
			}
			// No ✅todos or a full server: no later item can be made either.
			if (result.reason === "noChannel" || result.reason === "cap") break;
		} catch (error) {
			if (!isDuplicateKey(error)) throw error;
		}
	}
	return created;
}
