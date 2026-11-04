import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TextChannel } from "discord.js";
import type { Client } from "discord.js";

// ── no decree builds a channel (2026-11 item 289) ──
// A server with no upcoming events channel stays without one until an admin adds it from its
// step card, however close a decree is. The onDemandChannel fake stays here to fail these tests
// if a build ever comes back.

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
	Object.assign(channel, { id: "ch-stored", send, messages: { fetch: vi.fn().mockResolvedValue(new Map()) } });
	const fetchChannel = vi.fn(async () => channel);
	const client = { channels: { fetch: fetchChannel }, guilds: { cache: new Map([["guild-1", guild]]) } } as unknown as Client;
	return { client, send, fetchChannel };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	_resetNextUpDedupForTest();
	mocks.findByGuildId.mockReset().mockResolvedValue({ nextDecreeChannelId: null });
	// Six hours out, well inside the 24 hour horizon.
	mocks.findEvents.mockReset().mockResolvedValue([eventAt(new Date("2030-01-01T06:00:00Z"))]);
	mocks.ensureOnDemandChannel.mockReset();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("refreshNextUp on a server with no upcoming events channel", () => {
	it("builds nothing and posts nothing, even with a decree due", async () => {
		const { client, send, fetchChannel } = harness();

		await refreshNextUp(client, "guild-1");

		expect(mocks.ensureOnDemandChannel).not.toHaveBeenCalled();
		expect(fetchChannel).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
	});
});

describe("refreshNextUp on a server with one", () => {
	it("posts a due decree there and builds nothing", async () => {
		mocks.findByGuildId.mockResolvedValue({ nextDecreeChannelId: "ch-stored" });
		const { client, send, fetchChannel } = harness();

		await refreshNextUp(client, "guild-1");

		expect(fetchChannel).toHaveBeenCalledWith("ch-stored");
		expect(send).toHaveBeenCalledTimes(1);
		expect(mocks.ensureOnDemandChannel).not.toHaveBeenCalled();
	});
});
