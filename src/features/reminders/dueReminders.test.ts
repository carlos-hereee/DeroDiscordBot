import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
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
		async closeStaleFiring(before: Date, at: Date) {
			const row = m.rows.find((candidate) => candidate.status === "firing" && candidate.updatedAt !== undefined && candidate.updatedAt <= before);
			if (!row) return null;
			Object.assign(row, { status: "missed", firedAt: at, text: null });
			return { ...row };
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

const { _resetDueReminders, scheduleRemindersFor, runDueReminders, stopDueReminders } = await import("./dueReminders.js");

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
	_resetDueReminders();
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
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

// A meeting whose RSVPs pass what one message may hold (2026-11 item 420, L14).
describe("a meeting's reminder reaches every RSVP", () => {
	const START = new Date(NOW.getTime() + HOUR);
	const LATE = new Date(NOW.getTime() + 45 * 60 * 1000 + BOT_CONSTANTS.REMINDERS.LATE_AFTER_MS + 1000);
	const member = (index: number): string => String(1_300_000_000_000_000_000n + BigInt(index));
	type Payload = { content: string; allowedMentions: { users: string[] } };
	const posts = (): Payload[] => m.post.mock.calls.map((call) => call[2] as Payload);

	async function remind(rsvpCount: number): Promise<string[]> {
		const rsvpIds = Array.from({ length: rsvpCount }, (_unused, index) => member(index));
		m.meeting = { meetingId: "meet1", guildId: "g1", title: "T".repeat(100), status: "scheduled", hostId: null, scheduledFor: START, rsvpIds } as unknown as IMeeting;
		await scheduleRemindersFor({ kind: "meeting", meeting: m.meeting }, NOW);
		await runDueReminders(client, LATE);
		return rsvpIds;
	}

	it.each([90, 250])("L14: %i RSVPs are each pinged exactly once, in messages Discord accepts", async (count) => {
		const rsvpIds = await remind(count);
		expect(posts().flatMap((payload) => payload.allowedMentions.users)).toEqual(rsvpIds);
		for (const payload of posts()) {
			expect(payload.content.length).toBeLessThanOrEqual(2000);
			expect(payload.allowedMentions.users.length).toBeLessThanOrEqual(100);
			expect(payload.content.match(/<@\d+>/g)).toEqual(payload.allowedMentions.users.map((id) => `<@${id}>`));
			expect(payload.content).toContain("starts <t:");
		}
		expect(m.rows.find((row) => row.leadKey === "meeting_lead")).toMatchObject({ status: "fired", deliveredBy: "channel" });
	});

	it("L14: nobody to ping still posts one message", async () => {
		await remind(0);
		expect(posts()).toHaveLength(1);
		expect(posts()[0].allowedMentions.users).toEqual([]);
		expect(posts()[0].content.startsWith('"TTT')).toBe(true);
	});

	it("L14: one refused message leaves the others sent, and the log says how many were missed, never who", async () => {
		m.post.mockReset().mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValue(true);
		await remind(250);
		expect(posts().length).toBeGreaterThan(2);
		expect(m.rows.find((row) => row.leadKey === "meeting_lead")).toMatchObject({ status: "fired", deliveredBy: "channel" });
		const logged = JSON.stringify((console.warn as unknown as { mock: { calls: unknown[] } }).mock.calls);
		expect(logged).toContain(`"unreached":${posts()[1].allowedMentions.users.length}`);
		expect(logged).not.toContain(member(0).slice(0, 12));
	});

	it("L14: every message refused is a failed delivery", async () => {
		m.post.mockReset().mockResolvedValue(false);
		await remind(90);
		expect(m.rows.find((row) => row.leadKey === "meeting_lead")).toMatchObject({ status: "fired", deliveredBy: "failed" });
	});
});

// A restart mid delivery, and a shutdown during the sweep (2026-11 item 420): L4, L8, L9.
describe("a reminder caught mid delivery", () => {
	const { FIRING_STALE_MS } = BOT_CONSTANTS.REMINDERS;
	const firing = (overrides: Partial<IReminder> = {}): IReminder => ({
		reminderId: "stuck",
		guildId: "g1",
		kind: "todo",
		targetId: "todo1",
		userId: "holder",
		text: null,
		channelId: null,
		leadKey: "todo_due",
		fireAt: new Date(NOW.getTime() - HOUR),
		status: "firing",
		deliveredBy: null,
		firedAt: null,
		updatedAt: new Date(NOW.getTime() - FIRING_STALE_MS),
		...overrides,
	});

	it("L8: one left firing is closed once as missed, never sent, and that todo's next due date is reminded again", async () => {
		m.rows.push(firing());
		// The due date was moved while the row sat firing, when scheduling could not rewrite it.
		m.todo = todoRow({ dueAt: new Date(NOW.getTime() + 3 * HOUR) });
		await runDueReminders(client, NOW);
		expect(m.dm).not.toHaveBeenCalled();
		expect(pendingFor("todo_due").map((row) => row.fireAt)).toEqual([new Date(NOW.getTime() + 3 * HOUR)]);
		expect(pendingFor("todo_lead")).toHaveLength(1);
		await runDueReminders(client, NOW);
		expect(m.rows).toHaveLength(2);
		await runDueReminders(client, new Date(NOW.getTime() + 3 * HOUR));
		expect(m.dm).toHaveBeenCalledTimes(2);
	});

	it("L8: one whose due date did not move is closed and not planned again", async () => {
		m.rows.push(firing());
		m.todo = todoRow({ dueAt: new Date(NOW.getTime() - HOUR) });
		await runDueReminders(client, NOW);
		expect(m.rows).toEqual([expect.objectContaining({ status: "missed", firedAt: NOW })]);
		expect(m.dm).not.toHaveBeenCalled();
	});

	it("L9: a recovered personal reminder holds no text and carries firedAt", async () => {
		m.rows.push(firing({ kind: "personal", targetId: null, leadKey: "personal", text: "Call the scouts" }));
		await runDueReminders(client, NOW);
		expect(m.rows[0]).toMatchObject({ status: "missed", firedAt: NOW, text: null });
		expect(m.dm).not.toHaveBeenCalled();
	});

	it("L8: one still inside the grace is left to its own delivery", async () => {
		m.rows.push(firing({ updatedAt: new Date(NOW.getTime() - FIRING_STALE_MS + 1) }));
		await runDueReminders(client, NOW);
		expect(m.rows[0].status).toBe("firing");
	});

	it("L4: told to stop, the sweep claims nothing more and the caller can wait for the delivery under way", async () => {
		m.todo = todoRow();
		await scheduleRemindersFor({ kind: "todo", todo: todoRow() }, NOW);
		let deliver: (outcome: string) => void = () => undefined;
		m.dm.mockImplementationOnce(() => new Promise((resolve) => (deliver = resolve)));
		const sweep = runDueReminders(client, new Date(NOW.getTime() + 3 * HOUR));
		await vi.waitFor(() => expect(m.dm).toHaveBeenCalledTimes(1));
		const stopped = stopDueReminders();
		deliver("sent");
		await stopped;
		await sweep;
		expect(m.dm).toHaveBeenCalledTimes(1);
		expect(m.rows.map((row) => row.status).sort()).toEqual(["fired", "pending"]);
		await runDueReminders(client, new Date(NOW.getTime() + 3 * HOUR));
		expect(m.dm).toHaveBeenCalledTimes(1);
	});
});
