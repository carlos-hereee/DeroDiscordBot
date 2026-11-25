import { beforeEach, describe, expect, it, vi } from "vitest";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { getPluginCopy } from "@base/copy/index.js";
import type { IReminder } from "@db/models/Reminder.js";

// Personal reminders (2026-11 item 388 Phase 2): the member's own zone first, then the
// server's; the 25 pending cap (A10); text limits; and the list's Cancel buttons fitting
// Discord's five rows of five with every customId under 100 characters.

const m = vi.hoisted(() => ({ pending: 0, zone: null as string | null, insert: vi.fn(), cancel: vi.fn(), handler: null as ((interaction: unknown) => Promise<void>) | null }));
vi.mock("@db/stores/reminderRowStore.js", () => ({
	reminderRowStore: {
		countPendingPersonal: async () => m.pending,
		insertPersonal: m.insert,
		cancelPersonal: m.cancel,
		listPendingPersonal: async () => [],
	},
}));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: async () => null } }));
vi.mock("@handlers/interactionRegistry.js", () => ({ registerButton: (_prefix: string, handler: typeof m.handler) => (m.handler = handler), registerModal: () => undefined }));
vi.mock("@db/stores/memberTimezoneStore.js", () => ({ memberTimezoneStore: { findZone: async () => m.zone } }));

const { buildReminderList, createPersonalReminder, registerPersonalReminderHandlers } = await import("./personalReminders.js");

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

describe("Cancel on the list", () => {
	it("L9: hands the store the moment of the press, which its expiry counts from", async () => {
		registerPersonalReminderHandlers();
		m.cancel.mockReset().mockResolvedValue(true);
		const update = vi.fn(async () => undefined);
		await m.handler!({ customId: "rmd:cancel:r1", guildId: "g1", user: { id: "u1" }, update });
		expect(m.cancel).toHaveBeenCalledWith("g1", "u1", "r1", expect.any(Date));
		expect(update).toHaveBeenCalledTimes(1);
	});
});

describe("buildReminderList", () => {
	it("L13: 25 reminders of 300 characters build, with every line and every Cancel button", () => {
		const rows: IReminder[] = Array.from({ length: BOT_CONSTANTS.REMINDERS.PERSONAL_MAX_PENDING }, (_unused, index) => ({
			reminderId: `r${index}`,
			guildId: "g1",
			kind: "personal",
			targetId: null,
			userId: "u1",
			text: "x".repeat(BOT_CONSTANTS.REMINDERS.TEXT_MAX),
			channelId: null,
			leadKey: "personal",
			fireAt: NOW,
			status: "pending",
			deliveredBy: null,
			firedAt: null,
		}));
		const reply = buildReminderList(rows, getPluginCopy(null));
		const embeds = (reply.embeds ?? []) as unknown as { data: { description: string } }[];
		expect(embeds[0].data.description.length).toBeLessThanOrEqual(4096);
		expect(embeds[0].data.description.split("\n")).toHaveLength(25);
		expect(embeds[0].data.description).toMatch(/^25\. <t:\d+:f>: x+/m);
		const components = (reply.components ?? []) as unknown as { components: unknown[] }[];
		expect(components.flatMap((row) => row.components)).toHaveLength(25);
	});

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
