import { beforeEach, describe, expect, it, vi } from "vitest";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { getPluginCopy } from "@base/copy/index.js";
import type { IReminder } from "@db/models/Reminder.js";

// Personal reminders (2026-11 item 388 Phase 2): the member's own zone first, then the
// server's; the 25 pending cap (A10); text limits; and the list's Cancel buttons fitting
// Discord's five rows of five with every customId under 100 characters.

const m = vi.hoisted(() => ({ pending: 0, zone: null as string | null, insert: vi.fn() }));
vi.mock("@db/stores/reminderRowStore.js", () => ({ reminderRowStore: { countPendingPersonal: async () => m.pending, insertPersonal: m.insert } }));
vi.mock("@db/stores/memberTimezoneStore.js", () => ({ memberTimezoneStore: { findZone: async () => m.zone } }));

const { buildReminderList, createPersonalReminder } = await import("./personalReminders.js");

const NOW = new Date("2026-11-22T15:00:00.000Z");
const input = { guildId: "g1", userId: "u1", channelId: "c1", whenText: "7pm", text: "Feed the dragon", serverTimezone: "UTC" };

beforeEach(() => {
	m.pending = 0;
	m.zone = null;
	m.insert.mockReset().mockResolvedValue(undefined);
});

describe("createPersonalReminder", () => {
	it("reads the time in the member's own zone before the server's", async () => {
		expect(await createPersonalReminder(input, NOW)).toEqual({ ok: true, fireAt: new Date("2026-11-22T19:00:00.000Z") });
		m.zone = "America/Chicago";
		expect(await createPersonalReminder(input, NOW)).toEqual({ ok: true, fireAt: new Date("2026-11-23T01:00:00.000Z") });
		expect(m.insert).toHaveBeenLastCalledWith(expect.objectContaining({ channelId: "c1", text: "Feed the dragon", userId: "u1" }));
	});

	it("refuses past the cap, bad text and an unreadable time, storing nothing", async () => {
		m.pending = BOT_CONSTANTS.REMINDERS.PERSONAL_MAX_PENDING;
		expect(await createPersonalReminder(input, NOW)).toEqual({ ok: false, reason: "cap" });
		m.pending = 0;
		expect(await createPersonalReminder({ ...input, text: " " }, NOW)).toEqual({ ok: false, reason: "textInvalid" });
		expect(await createPersonalReminder({ ...input, whenText: "later" }, NOW)).toEqual({ ok: false, reason: "unreadable" });
		expect(m.insert).not.toHaveBeenCalled();
	});
});

describe("buildReminderList", () => {
	it("gives the full 25 reminders five rows of five Cancel buttons, each id under 100", () => {
		const rows: IReminder[] = Array.from({ length: BOT_CONSTANTS.REMINDERS.PERSONAL_MAX_PENDING }, (_unused, index) => ({
			reminderId: `r${String(index).padStart(11, "0")}`,
			guildId: "g1",
			kind: "personal",
			targetId: null,
			userId: "u1",
			text: "x",
			channelId: null,
			leadKey: "personal",
			fireAt: NOW,
			status: "pending",
			deliveredBy: null,
			firedAt: null,
		}));
		const reply = buildReminderList(rows, getPluginCopy(null));
		const components = (reply.components ?? []) as unknown as { components: { data: { custom_id: string } }[] }[];
		expect(components).toHaveLength(5);
		const ids = components.flatMap((row) => row.components.map((button) => button.data.custom_id));
		expect(ids).toHaveLength(25);
		expect(Math.max(...ids.map((id) => id.length))).toBeLessThanOrEqual(BOT_CONSTANTS.DISCORD_LIMITS.MAX_CUSTOM_ID_LENGTH);
	});
});
