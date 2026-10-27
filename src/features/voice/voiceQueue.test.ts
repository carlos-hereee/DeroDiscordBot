import { describe, it, expect, vi } from "vitest";
import type { Guild } from "discord.js";

// voiceQueue's default deps reach the voice stack and the store; every test here
// injects its own, so these mocks only keep the imports from loading them.
vi.mock("./voiceSessions.js", () => ({ voiceSessions: { get: vi.fn(() => null) } }));
vi.mock("@db/stores/deroVoiceConfigStore.js", () => ({ deroVoiceConfigStore: { findByGuildId: vi.fn() } }));

import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { createVoiceQueue, type QueuedJoinOutcome, type VoiceQueueRequest } from "./voiceQueue.js";
import { DEFAULT_VOICE_PRIORITY_ORDER, type VoicePriorityCategory } from "./voicePriority.js";

// ── voiceQueue (2026-10 item 257 Phase 2b, owner item 22) ──
// Ranked by the admin's order then first come; one place per member; the head runs
// when a call ends, skipping stale and expired requests; never on a shutdown.

const GUILD = { id: "g1" } as unknown as Guild;
const ORDER = [...DEFAULT_VOICE_PRIORITY_ORDER];

function setup(options: { order?: VoicePriorityCategory[] } = {}) {
	let now = 1_000;
	let busyIn: string | null = "vc-busy";
	const deps = {
		now: () => now,
		sessionChannelId: () => busyIn,
		loadOrder: vi.fn(async () => options.order ?? ORDER),
	};
	const queue = createVoiceQueue(deps);
	const ran: string[] = [];
	const outcomes = new Map<string, QueuedJoinOutcome>();
	queue.useRunner(async (request: VoiceQueueRequest) => {
		ran.push(request.requesterId);
		const outcome = outcomes.get(request.requesterId) ?? "joined";
		if (outcome === "joined") busyIn = request.channelId;
		return outcome;
	});
	const add = (requesterId: string, category: VoicePriorityCategory, order = options.order ?? ORDER) => {
		const place = queue.enqueue({ guild: GUILD, requesterId, channelId: `vc-${requesterId}`, controlChannelId: "text-1", category }, order);
		now += 1;
		return place;
	};
	return {
		queue,
		add,
		ran,
		outcomes,
		advance: (ms: number) => (now += ms),
		free: () => (busyIn = null),
		busyIn: () => busyIn,
	};
}

describe("voiceQueue ordering", () => {
	it("ranks by the stored order first and arrival second, and says each place", () => {
		const { add, queue } = setup();
		expect(add("a", "other")).toEqual({ place: 1, total: 1 });
		expect(add("b", "arcade-lounge")).toEqual({ place: 1, total: 2 });
		expect(add("c", "meeting-hall")).toEqual({ place: 1, total: 3 });
		expect(add("d", "arcade-lounge")).toEqual({ place: 3, total: 4 });
		expect(queue.list("g1", ORDER).map((request) => request.requesterId)).toEqual(["c", "b", "d", "a"]);
	});

	it("follows an admin's own order", () => {
		const order: VoicePriorityCategory[] = ["arcade-lounge", "meeting-hall", "rated-match", "casual-match", "other"];
		const { add, queue } = setup({ order });
		add("hall", "meeting-hall");
		add("lounge", "arcade-lounge");
		expect(queue.list("g1", order).map((request) => request.requesterId)).toEqual(["lounge", "hall"]);
	});

	it("keeps one place per member: a second request replaces the first", () => {
		const { add, queue } = setup();
		add("a", "other");
		add("b", "other");
		expect(add("a", "meeting-hall")).toEqual({ place: 1, total: 2 });
		expect(queue.list("g1", ORDER)).toHaveLength(2);
	});

	it("drops a request once it is DERO_VOICE_QUEUE_EXPIRY_MS old", () => {
		const { add, queue, advance } = setup();
		add("old", "meeting-hall");
		advance(BOT_CONSTANTS.DERO_VOICE_QUEUE_EXPIRY_MS);
		add("fresh", "other");
		expect(queue.list("g1", ORDER).map((request) => request.requesterId)).toEqual(["fresh"]);
	});
});

describe("voiceQueue draining", () => {
	it("runs the head when the call ends and stops once Dero joined it", async () => {
		const { add, queue, ran, free } = setup();
		add("low", "other");
		add("high", "meeting-hall");
		free();
		await queue.drain("g1");
		expect(ran).toEqual(["high"]);
		expect(queue.list("g1", ORDER).map((request) => request.requesterId)).toEqual(["low"]);
	});

	it("skips a stale request and runs the next one", async () => {
		const { add, queue, ran, outcomes, free } = setup();
		add("left", "meeting-hall");
		add("still-here", "other");
		outcomes.set("left", "skipped");
		free();
		await queue.drain("g1");
		expect(ran).toEqual(["left", "still-here"]);
		expect(queue.list("g1", ORDER)).toHaveLength(0);
	});

	it("never runs an expired request", async () => {
		const { add, queue, ran, advance, free } = setup();
		add("expired", "meeting-hall");
		advance(BOT_CONSTANTS.DERO_VOICE_QUEUE_EXPIRY_MS + 1);
		add("fresh", "other");
		free();
		await queue.drain("g1");
		expect(ran).toEqual(["fresh"]);
	});

	it("puts a busy request back in its place", async () => {
		const { add, queue, outcomes, free } = setup();
		add("a", "meeting-hall");
		outcomes.set("a", "busy");
		free();
		await queue.drain("g1");
		expect(queue.list("g1", ORDER).map((request) => request.requesterId)).toEqual(["a"]);
	});

	it("does nothing while Dero is still in a call: waiting never moves him", async () => {
		const { add, queue, ran } = setup();
		add("a", "meeting-hall");
		await queue.drain("g1");
		expect(ran).toEqual([]);
	});

	it("drains after a call ends, but not after a shutdown", async () => {
		const shutdown = setup();
		shutdown.add("a", "other");
		shutdown.free();
		shutdown.queue.afterCallEnded({ guildId: "g1", reason: "shutdown" });
		await Promise.resolve();
		expect(shutdown.ran).toEqual([]);

		const left = setup();
		left.add("a", "other");
		left.free();
		left.queue.afterCallEnded({ guildId: "g1", reason: "left" });
		await vi.waitFor(() => expect(left.ran).toEqual(["a"]));
	});
});

describe("voiceQueue.requestVoice, the entry point for match requests", () => {
	it("runs at once when Dero is free", async () => {
		const { queue, ran, free } = setup();
		free();
		const place = await queue.requestVoice({ guild: GUILD, requesterId: "host", channelId: "vc-host", controlChannelId: "text-1", category: "rated-match" });
		expect(place).toBeNull();
		expect(ran).toEqual(["host"]);
	});

	it("waits in its category's place when Dero is busy", async () => {
		const { queue, add } = setup();
		add("casual", "casual-match");
		const place = await queue.requestVoice({ guild: GUILD, requesterId: "host", channelId: "vc-host", controlChannelId: "text-1", category: "rated-match" });
		expect(place).toEqual({ place: 1, total: 2 });
	});
});
