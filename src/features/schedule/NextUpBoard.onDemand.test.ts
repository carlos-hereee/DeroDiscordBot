import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TextChannel } from "discord.js";
import type { Client } from "discord.js";

// ── the upcoming events channel, built when a decree is due (2026-11 item 285 Phase 3) ──
// A Headquarters only server has no upcoming events channel. refreshNextUp builds it
// through onDemandChannel only once an event has an occurrence inside the 24 hour
// horizon, before it reads the channel; a server with nothing due builds nothing.

const mocks = vi.hoisted(() => ({
	findByGuildId: vi.fn(),
	findEvents: vi.fn(),
	ensureOnDemandChannel: vi.fn(),
}));

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findByGuildId } }));
vi.mock("@db/stores/eventStore.js", () => ({ eventStore: { findByGuildId: mocks.findEvents } }));
vi.mock("@db/stores/eventOverrideStore.js", () => ({ eventOverrideStore: { findOne: vi.fn().mockResolvedValue(null) } }));
vi.mock("./decreeEditHandlers.js", () => ({
	decreeEditCustomIds: { parse: () => null, buildEditButton: (eventId: string, occurrenceUnix: number) => `edit_decree:${eventId}:${occurrenceUnix}` },
}));
vi.mock("@features/setup/onDemandChannel.js", () => ({ ensureOnDemandChannel: mocks.ensureOnDemandChannel }));

import { _resetNextUpDedupForTest, refreshNextUp } from "./NextUpBoard.js";
import type { IGameEvent } from "@features/events/event.types.js";

const NOW = new Date("2030-01-01T00:00:00Z");
const guild = { id: "guild-1" };

const eventAt = (firstOccurrence: Date, overrides: Partial<IGameEvent> = {}): IGameEvent => ({
	eventId: "evt-1",
	name: "Launch",
	description: "",
	type: "one-time",
	intervalHours: 0,
	firstOccurrence,
	reminderOffsets: [30],
	guildId: "guild-1",
	prepSteps: [],
	active: true,
	...overrides,
});

function harness(): { client: Client; send: ReturnType<typeof vi.fn>; fetchChannel: ReturnType<typeof vi.fn> } {
	const send = vi.fn(async () => ({ id: "decree" }));
	const channel = Object.create(TextChannel.prototype) as TextChannel;
	Object.assign(channel, { id: "ch-built", send, messages: { fetch: vi.fn().mockResolvedValue(new Map()) } });
	const fetchChannel = vi.fn(async () => channel);
	const client = { channels: { fetch: fetchChannel }, guilds: { cache: new Map([["guild-1", guild]]) } } as unknown as Client;
	return { client, send, fetchChannel };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	_resetNextUpDedupForTest();
	mocks.findByGuildId.mockReset().mockResolvedValue({ nextDecreeChannelId: null });
	mocks.findEvents.mockReset().mockResolvedValue([eventAt(new Date("2030-01-01T06:00:00Z"))]);
	mocks.ensureOnDemandChannel.mockReset().mockResolvedValue({ id: "ch-built" });
});

afterEach(() => {
	vi.useRealTimers();
});

describe("refreshNextUp on a server with no upcoming events channel", () => {
	it("builds the channel when a decree is due, before reading it, and posts the decree there", async () => {
		const { client, send, fetchChannel } = harness();
		await refreshNextUp(client, "guild-1");

		expect(mocks.ensureOnDemandChannel).toHaveBeenCalledWith(guild, "nextDecreeChannelId");
		expect(mocks.ensureOnDemandChannel.mock.invocationCallOrder[0]!).toBeLessThan(fetchChannel.mock.invocationCallOrder[0]!);
		expect(fetchChannel).toHaveBeenCalledWith("ch-built");
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("builds nothing when no event falls inside the next 24 hours", async () => {
		mocks.findEvents.mockResolvedValue([eventAt(new Date("2030-01-03T06:00:00Z"))]);
		const { client, fetchChannel } = harness();
		await refreshNextUp(client, "guild-1");
		expect(mocks.ensureOnDemandChannel).not.toHaveBeenCalled();
		expect(fetchChannel).not.toHaveBeenCalled();
	});

	it("builds nothing for a paused event", async () => {
		mocks.findEvents.mockResolvedValue([eventAt(new Date("2030-01-01T06:00:00Z"), { paused: true } as Partial<IGameEvent>)]);
		await refreshNextUp(harness().client, "guild-1");
		expect(mocks.ensureOnDemandChannel).not.toHaveBeenCalled();
	});

	it("stops quietly when nothing could be built", async () => {
		mocks.ensureOnDemandChannel.mockResolvedValue(null);
		const { client, fetchChannel } = harness();
		await refreshNextUp(client, "guild-1");
		expect(fetchChannel).not.toHaveBeenCalled();
	});

	it("never builds once the channel is stored", async () => {
		mocks.findByGuildId.mockResolvedValue({ nextDecreeChannelId: "ch-built" });
		await refreshNextUp(harness().client, "guild-1");
		expect(mocks.ensureOnDemandChannel).not.toHaveBeenCalled();
	});
});
