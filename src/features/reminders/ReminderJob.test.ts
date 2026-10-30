import { describe, it, expect, vi, beforeEach } from "vitest";
import { TextChannel } from "discord.js";
import type { Client } from "discord.js";

// ── fireReminder's ReminderLog row (2026-10 item 280) ──
// The row is the dedup key that stops a reminder firing twice, so it must land whenever
// the post did, whatever happens to the acknowledgement reaction afterwards, and it must
// carry the occurrence the scheduler dedups on rather than an override's moved time.

const mocks = vi.hoisted(() => ({
	findByGuildId: vi.fn(),
	create: vi.fn(),
}));

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findByGuildId } }));
vi.mock("@db/stores/reminderStore.js", () => ({ reminderStore: { create: mocks.create } }));
vi.mock("@utils/embedBuilder.js", () => ({ reminderEmbed: vi.fn(() => ({})) }));
vi.mock("@utils/mentions.js", () => ({ buildAudienceMention: vi.fn(() => ({ content: "@here", allowedMentions: { parse: [] } })) }));
vi.mock("@features/schedule/ScheduleBoard.js", () => ({ refreshSchedule: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@features/schedule/NextUpBoard.js", () => ({ refreshNextUp: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@features/leaderboard/LeaderboardBoard.js", () => ({ refreshLeaderboard: vi.fn().mockResolvedValue(undefined) }));

import { fireReminder } from "./ReminderJob.js";
import type { IGameEvent } from "@features/events/event.types.js";

const ORIGINAL = new Date("2030-01-01T12:00:00Z");
const MOVED_TO = new Date("2030-01-01T20:00:00Z");

const event: IGameEvent = {
	eventId: "evt-1",
	name: "Ruins",
	description: "",
	type: "recurring",
	intervalHours: 40,
	firstOccurrence: ORIGINAL,
	reminderOffsets: [30],
	guildId: "guild-1",
	prepSteps: [],
	active: true,
};

function harness(react: () => Promise<unknown>): Client {
	const channel = Object.create(TextChannel.prototype) as TextChannel;
	Object.assign(channel, { id: "ch-1", send: vi.fn(async () => ({ id: "msg-1", react })) });
	return { channels: { fetch: vi.fn(async () => channel) } } as unknown as Client;
}

beforeEach(() => {
	mocks.findByGuildId.mockReset().mockResolvedValue({ announcementsChannelId: "ch-1" });
	mocks.create.mockReset().mockResolvedValue(undefined);
});

describe("fireReminder", () => {
	it("writes the ReminderLog row even when the reaction fails, and does not throw", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const client = harness(async () => {
			throw new Error("Missing Permissions");
		});

		await expect(fireReminder(client, event, ORIGINAL, 30)).resolves.toBeUndefined();

		expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ eventId: "evt-1", eventOccurrence: ORIGINAL, offsetMinutes: 30, messageId: "msg-1" }));
		warn.mockRestore();
	});

	it("keys the row on the original occurrence when an override moved the fire", async () => {
		await fireReminder(harness(async () => undefined), event, MOVED_TO, 30, ORIGINAL);

		expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ eventOccurrence: ORIGINAL }));
	});
});
