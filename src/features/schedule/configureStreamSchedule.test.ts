import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RepliableInteraction } from "discord.js";

const mocks = vi.hoisted(() => ({
	create: vi.fn(),
	findEvents: vi.fn(async () => []),
	findConfig: vi.fn(),
	showNotice: vi.fn(),
	askInChannel: vi.fn(),
}));

vi.mock("@db/stores/eventStore.js", () => ({ eventStore: { create: mocks.create, findByGuildId: mocks.findEvents } }));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findConfig } }));
vi.mock("@features/schedule/ScheduleBoard.js", () => ({ refreshSchedule: vi.fn(async () => undefined) }));
vi.mock("@features/setup/adminLog.js", () => ({ adminLog: { emitFor: vi.fn() } }));
vi.mock("@utils/answerInChannel.js", () => ({ askInChannel: mocks.askInChannel }));
vi.mock("@utils/textModal.js", () => ({ showNotice: mocks.showNotice }));

import { configureStreamSchedule } from "./configureStreamSchedule.js";
import { getUpcomingOccurrences } from "@features/events/occurrenceCalculator.js";
import type { IGameEvent } from "@features/events/event.types.js";
import type { CommandOptionReader } from "@handlers/commandOptions.js";

// ── /events stream weekly holds its local time (2026-10 item 263 Phase 4c) ──

const interaction = { guildId: "g1", client: {} } as unknown as RepliableInteraction;

function optionsFor(timezone: string | null): CommandOptionReader {
	const strings: Record<string, string | null> = { name: "Friday Night", day: "friday", time: "7pm", timezone };
	return {
		getString: (name: string) => strings[name] ?? null,
		getRole: () => null,
	} as unknown as CommandOptionReader;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-10-28T12:00:00Z"));
	mocks.findConfig.mockResolvedValue({ announcementsChannelId: "ch-announce", memberRoleId: null, timezone: "America/New_York" });
	mocks.askInChannel.mockResolvedValue({
		awaitPress: vi.fn(async () => ({ customId: "stream_confirm", update: vi.fn() })),
		edit: vi.fn(),
	});
});

afterEach(() => vi.useRealTimers());

describe("configureStreamSchedule", () => {
	it("defaults a blank timezone to the server's and stores it on the event", async () => {
		await configureStreamSchedule(interaction, optionsFor(null));

		expect(mocks.create).toHaveBeenCalledWith(
			expect.objectContaining({ intervalHours: 168, timezone: "America/New_York", firstOccurrence: new Date("2026-10-30T23:00:00.000Z") })
		);
	});

	it("keeps a typed timezone over the server's", async () => {
		await configureStreamSchedule(interaction, optionsFor("Europe/Berlin"));

		expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ timezone: "Europe/Berlin" }));
	});

	it("creates a stream that fires at 7 PM New York on both sides of the 2026-11-01 change", async () => {
		await configureStreamSchedule(interaction, optionsFor(null));
		const stored = mocks.create.mock.calls[0][0] as IGameEvent;

		vi.setSystemTime(new Date("2026-10-29T12:00:00Z"));
		expect(getUpcomingOccurrences(stored, 2).map((date) => date.toISOString())).toEqual(["2026-10-30T23:00:00.000Z", "2026-11-07T00:00:00.000Z"]);
	});

	it("reads UTC on a server that never picked a zone", async () => {
		mocks.findConfig.mockResolvedValue({ announcementsChannelId: "ch-announce", memberRoleId: null });

		await configureStreamSchedule(interaction, optionsFor(null));

		expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ timezone: "UTC", firstOccurrence: new Date("2026-10-30T19:00:00.000Z") }));
	});
});
