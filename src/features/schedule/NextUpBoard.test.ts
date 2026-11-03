import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TextChannel } from "discord.js";
import type { Client } from "discord.js";

// ── refreshNextUp's dedup (2026-10 item 280) ──
// Two refreshes racing (a reminder fire and an event write landing together) once both
// passed the dedup check before either recorded its post, so one decree posted twice,
// and the dedup set kept every key for the life of the process.

const mocks = vi.hoisted(() => ({
	findByGuildId: vi.fn(),
	findEvents: vi.fn(),
}));

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findByGuildId } }));
vi.mock("@db/stores/eventStore.js", () => ({ eventStore: { findByGuildId: mocks.findEvents } }));
vi.mock("@db/stores/eventOverrideStore.js", () => ({ eventOverrideStore: { findOne: vi.fn().mockResolvedValue(null) } }));
vi.mock("./decreeEditHandlers.js", () => ({
	decreeEditCustomIds: {
		parse: () => null,
		buildEditButton: (eventId: string, occurrenceUnix: number) => `edit_decree:${eventId}:${occurrenceUnix}`,
	},
}));

import { _postedDecreeCountForTest, _resetNextUpDedupForTest, refreshNextUp } from "./NextUpBoard.js";
import type { IGameEvent } from "@features/events/event.types.js";

const NOW = new Date("2030-01-01T00:00:00Z");
const START = new Date("2030-01-01T06:00:00Z");
const HOUR_MS = 60 * 60 * 1000;

const oneTimeEvent: IGameEvent = {
	eventId: "evt-1",
	name: "Launch",
	description: "",
	type: "one-time",
	intervalHours: 0,
	firstOccurrence: START,
	reminderOffsets: [30],
	guildId: "guild-1",
	prepSteps: [],
	active: true,
};

function harness(send: () => Promise<unknown>): Client {
	const channel = Object.create(TextChannel.prototype) as TextChannel;
	Object.assign(channel, { id: "ch-next", send: vi.fn(send), messages: { fetch: vi.fn().mockResolvedValue(new Map()) } });
	return { channels: { fetch: vi.fn(async () => channel) } } as unknown as Client;
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	_resetNextUpDedupForTest();
	mocks.findByGuildId.mockReset().mockResolvedValue({ nextDecreeChannelId: "ch-next" });
	mocks.findEvents.mockReset().mockResolvedValue([oneTimeEvent]);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("refreshNextUp", () => {
	it("posts a decree once when two refreshes race", async () => {
		const send = vi.fn(async () => ({ id: "msg-1" }));
		const client = harness(send);

		await Promise.all([refreshNextUp(client, "guild-1"), refreshNextUp(client, "guild-1")]);

		expect(send).toHaveBeenCalledTimes(1);
	});

	it("releases the claim when the post fails, so the next refresh retries", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const send = vi.fn().mockRejectedValueOnce(new Error("429")).mockResolvedValue({ id: "msg-1" });
		const client = harness(send);

		await refreshNextUp(client, "guild-1");
		await refreshNextUp(client, "guild-1");

		expect(send).toHaveBeenCalledTimes(2);
		error.mockRestore();
	});

	it("prunes a posted key once its occurrence has passed", async () => {
		const client = harness(async () => ({ id: "msg-1" }));
		await refreshNextUp(client, "guild-1");
		expect(_postedDecreeCountForTest()).toBe(1);

		vi.setSystemTime(new Date(START.getTime() + HOUR_MS));
		await refreshNextUp(client, "guild-1");

		expect(_postedDecreeCountForTest()).toBe(0);
	});
});
