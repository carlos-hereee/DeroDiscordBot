import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "discord.js";
import type { IMeeting } from "@db/models/Meeting.js";
import type { IReminder, ReminderLeadKey } from "@db/models/Reminder.js";
import type { ITodo } from "@db/models/Todo.js";

// dueReminders (2026-11 item 388 Phase 2): one row per (target, lead) however often a todo
// changes (R5), each due row delivered once even with two ticks racing or a restart between
// them, the DM closed fallback, the late and missed windows, the removed channel stop, the
// unpinged reminder for a todo nobody holds (D4), and a meeting pinging its host and RSVPs.
//
// The store is an in memory twin of reminderRowStore with the same rules: upsert skips a
// firing row, claimDue moves pending to firing in one step, and the marks need firing.

const m = vi.hoisted(() => ({
	rows: [] as IReminder[],
	todo: null as ITodo | null,
	meeting: null as IMeeting | null,
	config: { todosChannelId: "todos-ch", meetingNotesChannelId: "notes-ch" } as { todosChannelId: string | null; meetingNotesChannelId: string | null },
	dm: vi.fn(),
	post: vi.fn(),
	nextId: 0,
}));

vi.mock("@db/stores/reminderRowStore.js", () => ({
	reminderRowStore: {
		async upsertPending(targetId: string, leadKey: ReminderLeadKey, fields: Pick<IReminder, "reminderId" | "guildId" | "kind" | "userId" | "channelId" | "fireAt">) {
			const existing = m.rows.find((row) => row.targetId === targetId && row.leadKey === leadKey);
			if (existing?.status === "firing") return;
			const { reminderId, ...rest } = fields;
			if (existing) Object.assign(existing, rest, { status: "pending", deliveredBy: null, firedAt: null });
			else m.rows.push({ ...rest, reminderId, targetId, leadKey, text: null, status: "pending", deliveredBy: null, firedAt: null });
		},
		async cancelLead(targetId: string, leadKey: ReminderLeadKey) {
			for (const row of m.rows) if (row.targetId === targetId && row.leadKey === leadKey && row.status === "pending") row.status = "cancelled";
		},
		async cancelForTarget(targetId: string) {
			for (const row of m.rows) if (row.targetId === targetId && row.status === "pending") row.status = "cancelled";
		},
		async claimDue(now: Date) {
			const due = m.rows.filter((row) => row.status === "pending" && row.fireAt.getTime() <= now.getTime()).sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime())[0];
			if (!due) return null;
			due.status = "firing";
			return { ...due };
		},
		async markFired(reminderId: string, deliveredBy: IReminder["deliveredBy"], firedAt: Date) {
			const row = m.rows.find((candidate) => candidate.reminderId === reminderId && candidate.status === "firing");
			if (row) Object.assign(row, { status: "fired", deliveredBy, firedAt });
		},
		async markMissed(reminderId: string, at: Date) {
			const row = m.rows.find((candidate) => candidate.reminderId === reminderId && candidate.status === "firing");
			if (row) Object.assign(row, { status: "missed", firedAt: at });
		},
	},
}));
vi.mock("@db/stores/todoStore.js", () => ({ todoStore: { findById: async () => m.todo } }));
vi.mock("@db/stores/meetingStore.js", () => ({ meetingStore: { findById: async () => m.meeting } }));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: async () => m.config } }));
vi.mock("@utils/directMessage.js", () => ({ sendDirectMessage: m.dm }));
vi.mock("@utils/cardMessage.js", () => ({ postInChannel: m.post }));
vi.mock("@utils/shortId.js", () => ({ shortId: () => `rid${++m.nextId}` }));

const { scheduleRemindersFor, runDueReminders } = await import("./dueReminders.js");

const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-11-22T12:00:00.000Z");
const client = { guilds: { cache: new Map([["g1", { name: "Castle Rock" }]]) } } as unknown as Client;

const todoRow = (overrides: Partial<ITodo> = {}): ITodo => ({
	todoId: "todo1",
	guildId: "g1",
	text: "Sharpen the swords",
	createdBy: "creator",
	assigneeId: "holder",
	dueAt: new Date(NOW.getTime() + 3 * HOUR),
	status: "open",
	doneAt: null,
	doneBy: null,
	meetingId: null,
	actionItemIndex: null,
	channelId: null,
	messageId: null,
	...overrides,
});

const pendingFor = (leadKey: ReminderLeadKey) => m.rows.filter((row) => row.leadKey === leadKey && row.status === "pending");

beforeEach(() => {
	m.rows = [];
	m.todo = null;
	m.meeting = null;
	m.config = { todosChannelId: "todos-ch", meetingNotesChannelId: "notes-ch" };
	m.dm.mockReset().mockResolvedValue("sent");
	m.post.mockReset().mockResolvedValue(true);
	m.nextId = 0;
});

describe("scheduleRemindersFor keeps one pending row per lead (R5)", () => {
	it("plans the 1 hour lead and the due reminder for an open dated todo", async () => {
		await scheduleRemindersFor({ kind: "todo", todo: todoRow() }, NOW);
		expect(pendingFor("todo_lead").map((row) => row.fireAt)).toEqual([new Date(NOW.getTime() + 2 * HOUR)]);
		expect(pendingFor("todo_due").map((row) => row.fireAt)).toEqual([new Date(NOW.getTime() + 3 * HOUR)]);
	});

	it("survives setDue twice, a reassign and done then reopen with one row per lead", async () => {
		await scheduleRemindersFor({ kind: "todo", todo: todoRow() }, NOW);
		await scheduleRemindersFor({ kind: "todo", todo: todoRow({ dueAt: new Date(NOW.getTime() + 5 * HOUR) }) }, NOW);
		await scheduleRemindersFor({ kind: "todo", todo: todoRow({ dueAt: new Date(NOW.getTime() + 5 * HOUR), assigneeId: "other" }) }, NOW);
		await scheduleRemindersFor({ kind: "todo", todo: todoRow({ status: "done" }) }, NOW);
		await scheduleRemindersFor({ kind: "todo", todo: todoRow() }, NOW);
		expect(m.rows).toHaveLength(2);
		expect(pendingFor("todo_lead")).toHaveLength(1);
		expect(pendingFor("todo_due")).toHaveLength(1);
	});

	it("moves a due date after the lead fired and still holds one pending row per lead", async () => {
		await scheduleRemindersFor({ kind: "todo", todo: todoRow() }, NOW);
		m.todo = todoRow();
		await runDueReminders(client, new Date(NOW.getTime() + 2 * HOUR));
		expect(m.rows.find((row) => row.leadKey === "todo_lead")?.status).toBe("fired");
		await scheduleRemindersFor({ kind: "todo", todo: todoRow({ dueAt: new Date(NOW.getTime() + 10 * HOUR) }) }, new Date(NOW.getTime() + 2 * HOUR));
		expect(m.rows).toHaveLength(2);
		expect(pendingFor("todo_lead")).toHaveLength(1);
		expect(pendingFor("todo_due")).toHaveLength(1);
	});

	it("cancels a lead whose time already passed rather than sending it late", async () => {
		await scheduleRemindersFor({ kind: "todo", todo: todoRow() }, NOW);
		await scheduleRemindersFor({ kind: "todo", todo: todoRow({ dueAt: new Date(NOW.getTime() + 30 * 60 * 1000) }) }, NOW);
		expect(pendingFor("todo_lead")).toHaveLength(0);
		expect(pendingFor("todo_due")).toHaveLength(1);
	});
});

describe("runDueReminders delivers each row once", () => {
	it("sends a todo reminder by DM, once, even with two ticks racing and a restart after", async () => {
		await scheduleRemindersFor({ kind: "todo", todo: todoRow() }, NOW);
		m.todo = todoRow();
		const dueTime = new Date(NOW.getTime() + 3 * HOUR);
		await Promise.all([runDueReminders(client, dueTime), runDueReminders(client, dueTime)]);
		// A restart is a fresh call reading the same rows: nothing pending is left to claim.
		await runDueReminders(client, dueTime);
		expect(m.dm).toHaveBeenCalledTimes(2);
		expect(m.dm.mock.calls.map((call) => call[1])).toEqual(["holder", "holder"]);
		expect(m.rows.every((row) => row.status === "fired" && row.deliveredBy === "dm")).toBe(true);
	});

	it("pings the holder in ✅todos when their DMs are closed", async () => {
		await scheduleRemindersFor({ kind: "todo", todo: todoRow() }, NOW);
		m.todo = todoRow();
		m.dm.mockResolvedValue("closed");
		await runDueReminders(client, new Date(NOW.getTime() + 2 * HOUR));
		expect(m.post).toHaveBeenCalledWith(client, "todos-ch", expect.objectContaining({ allowedMentions: expect.objectContaining({ users: ["holder"] }) }));
		expect(m.rows.find((row) => row.leadKey === "todo_lead")?.deliveredBy).toBe("channel");
	});

	it("reminds the creator of a todo nobody holds (G2)", async () => {
		m.todo = todoRow({ assigneeId: null });
		await scheduleRemindersFor({ kind: "todo", todo: m.todo }, NOW);
		await runDueReminders(client, new Date(NOW.getTime() + 2 * HOUR));
		expect(m.dm).toHaveBeenCalledWith(client, "creator", expect.anything());
	});

	it("posts unpinged in ✅todos for a dashboard todo with no holder and no creator (D4)", async () => {
		m.todo = todoRow({ assigneeId: null, createdBy: null });
		await scheduleRemindersFor({ kind: "todo", todo: m.todo }, NOW);
		await runDueReminders(client, new Date(NOW.getTime() + 2 * HOUR));
		expect(m.dm).not.toHaveBeenCalled();
		expect(m.post).toHaveBeenCalledWith(client, "todos-ch", expect.objectContaining({ allowedMentions: expect.objectContaining({ users: [] }) }));
	});

	it("sends nothing and keeps the rows once ✅todos is removed", async () => {
		await scheduleRemindersFor({ kind: "todo", todo: todoRow() }, NOW);
		m.todo = todoRow();
		m.config = { todosChannelId: null, meetingNotesChannelId: "notes-ch" };
		await runDueReminders(client, new Date(NOW.getTime() + 3 * HOUR));
		expect(m.dm).not.toHaveBeenCalled();
		expect(m.post).not.toHaveBeenCalled();
		expect(m.rows).toHaveLength(2);
		expect(m.rows.every((row) => row.status === "missed")).toBe(true);
	});

	it("marks a reminder late inside the 6 hour window and missed past it (A9)", async () => {
		m.rows.push(
			{ reminderId: "late", guildId: "g1", kind: "personal", targetId: null, userId: "u1", text: "Drink water", channelId: "c1", leadKey: "personal", fireAt: new Date(NOW.getTime() - 2 * HOUR), status: "pending", deliveredBy: null, firedAt: null },
			{ reminderId: "old", guildId: "g1", kind: "personal", targetId: null, userId: "u1", text: "Stretch", channelId: "c1", leadKey: "personal", fireAt: new Date(NOW.getTime() - 7 * HOUR), status: "pending", deliveredBy: null, firedAt: null }
		);
		await runDueReminders(client, NOW);
		expect(m.dm).toHaveBeenCalledTimes(1);
		const sent = m.dm.mock.calls[0][2] as { content: string };
		expect(sent.content).toContain("Castle Rock");
		expect(sent.content).toContain("late");
		expect(m.rows.find((row) => row.reminderId === "late")?.status).toBe("fired");
		expect(m.rows.find((row) => row.reminderId === "old")?.status).toBe("missed");
	});

	it("falls a personal reminder back to the channel it was set in", async () => {
		m.rows.push({ reminderId: "p", guildId: "g1", kind: "personal", targetId: null, userId: "u1", text: "Call the scouts", channelId: "set-here", leadKey: "personal", fireAt: NOW, status: "pending", deliveredBy: null, firedAt: null });
		m.dm.mockResolvedValue("failed");
		await runDueReminders(client, NOW);
		expect(m.post).toHaveBeenCalledWith(client, "set-here", expect.objectContaining({ allowedMentions: expect.objectContaining({ users: ["u1"] }) }));
	});

	it("pings a scheduled meeting's host and every RSVP in 📝meeting-notes", async () => {
		m.meeting = {
			meetingId: "meet1",
			guildId: "g1",
			title: "War council",
			status: "scheduled",
			endReason: null,
			hostId: "host",
			scheduledFor: new Date(NOW.getTime() + HOUR),
			rsvpIds: ["a", "host", "b"],
			startedAt: null,
			endedAt: null,
			speakerIds: [],
			notesChannelId: "notes-ch",
			notesMessageId: null,
			scheduleMessageId: null,
			summary: null,
			sttSeconds: 0,
			spentCents: 0,
		};
		await scheduleRemindersFor({ kind: "meeting", meeting: m.meeting }, NOW);
		await runDueReminders(client, new Date(NOW.getTime() + 45 * 60 * 1000));
		expect(m.post).toHaveBeenCalledTimes(1);
		const [, channelId, payload] = m.post.mock.calls[0] as [Client, string, { content: string; allowedMentions: { users: string[] } }];
		expect(channelId).toBe("notes-ch");
		expect(payload.allowedMentions.users).toEqual(["host", "a", "b"]);
		expect(payload.content).toContain("War council");
	});
});
