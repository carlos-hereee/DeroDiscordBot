import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "discord.js";
import type { IMeeting } from "@db/models/Meeting.js";

// Action items become todos once each (2026-11 item 388 Phase 4): a rerun makes nothing new,
// a racing insert refused by the unique index reads as made, a missing ✅todos stops the
// rest, and the assignee is matched exactly and case insensitively to one speaker.

const t = vi.hoisted(() => ({
	existing: [] as Array<{ actionItemIndex: number | null }>,
	calls: [] as Array<{ index: number | null | undefined; assigneeId: string | null; creator: string | null }>,
	answer: { ok: true } as { ok: true } | { ok: false; reason: string },
	throwAt: -1,
}));

vi.mock("@db/stores/todoStore.js", () => ({ todoStore: { findForMeeting: async () => t.existing } }));
vi.mock("@features/todos/todoActions.js", () => ({
	createTodo: async (_c: unknown, _g: string, input: { actionItemIndex?: number | null; assigneeId: string | null }, actor: { userId: string | null }) => {
		if (input.actionItemIndex === t.throwAt) throw Object.assign(new Error("duplicate key"), { code: 11000 });
		t.calls.push({ index: input.actionItemIndex, assigneeId: input.assigneeId, creator: actor.userId });
		return t.answer.ok ? { ok: true, todo: {} } : t.answer;
	},
}));

import { createActionItemTodos } from "./actionItemsToTodos.js";
import { matchAssignee, type SpeakerName } from "./speakerNames.js";

const client = {} as Client;
const meeting = {
	meetingId: "meeting00001",
	guildId: "guild",
	hostId: "host",
	summary: {
		text: "Summary",
		decisions: [],
		actionItems: [
			{ text: "One", assigneeName: "Ben", assigneeId: "ben" },
			{ text: "Two", assigneeName: null, assigneeId: null },
			{ text: "Three", assigneeName: null, assigneeId: null },
		],
	},
} as unknown as IMeeting;

beforeEach(() => {
	t.existing = [];
	t.calls = [];
	t.answer = { ok: true };
	t.throwAt = -1;
});

describe("createActionItemTodos", () => {
	it("makes one todo per item, created by the member who started the recording", async () => {
		expect(await createActionItemTodos(client, meeting)).toBe(3);
		expect(t.calls).toEqual([
			{ index: 0, assigneeId: "ben", creator: "host" },
			{ index: 1, assigneeId: null, creator: "host" },
			{ index: 2, assigneeId: null, creator: "host" },
		]);
	});

	it("skips the items that already hold a todo, so a rerun makes nothing new", async () => {
		t.existing = [{ actionItemIndex: 0 }, { actionItemIndex: 2 }];
		expect(await createActionItemTodos(client, meeting)).toBe(1);
		expect(t.calls.map((call) => call.index)).toEqual([1]);
	});

	it("reads a duplicate key from a racing insert as already made", async () => {
		t.throwAt = 1;
		expect(await createActionItemTodos(client, meeting)).toBe(2);
	});

	it("stops at a missing ✅todos, leaving the items on the card", async () => {
		t.answer = { ok: false, reason: "noChannel" };
		expect(await createActionItemTodos(client, meeting)).toBe(0);
		expect(t.calls).toHaveLength(1);
	});
});

describe("matchAssignee", () => {
	const speakers = new Map<string, SpeakerName>([
		["ava", { displayName: "Ava Stone", username: "ava_s" }],
		["ben", { displayName: "Ben", username: "benr" }],
		["cal", { displayName: "Twin", username: "cal" }],
		["dee", { displayName: "Twin", username: "dee" }],
	]);

	it.each([
		["Ava Stone", "ava"],
		["  ava stone ", "ava"],
		["AVA_S", "ava"],
		["ben", "ben"],
		["Ava", null],
		["Twin", null],
		["", null],
		[null, null],
	])("matches %j to %j", (name, expected) => {
		expect(matchAssignee(name, speakers)).toBe(expected);
	});
});
