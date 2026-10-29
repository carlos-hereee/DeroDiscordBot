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

// ── the admin controls (2026-10 item 267, decision 12) ──
// A stable id per request; Move up and Move down pin an explicit order ahead of the category
// ranking; Remove takes one out; every change reaches the listeners, a request as queued only
// while it really waits.
describe("voiceQueue admin controls", () => {
	const idOf = (queue: ReturnType<typeof setup>["queue"], requesterId: string): string => {
		const found = queue.list("g1", ORDER).find((request) => request.requesterId === requesterId);
		if (!found) throw new Error(`no request from ${requesterId}`);
		return found.id;
	};
	const names = (queue: ReturnType<typeof setup>["queue"]) => queue.list("g1", ORDER).map((request) => request.requesterId);

	it("gives every request its own id, kept while it waits", () => {
		const { add, queue } = setup();
		add("a", "other");
		const first = idOf(queue, "a");
		add("b", "meeting-hall");
		expect(idOf(queue, "a")).toBe(first);
		expect(idOf(queue, "b")).not.toBe(first);
	});

	it("moves a request up past a better category and keeps that order for the next arrival", async () => {
		const { add, queue } = setup();
		add("hall", "meeting-hall");
		add("other", "other");
		await expect(queue.moveUp("g1", idOf(queue, "other"))).resolves.toEqual({ ok: true, place: { place: 1, total: 2 } });
		expect(names(queue)).toEqual(["other", "hall"]);
		add("hall-2", "meeting-hall");
		expect(names(queue)).toEqual(["other", "hall", "hall-2"]);
	});

	it("moves a request down, and refuses a move past either end or for a request that is gone", async () => {
		const { add, queue } = setup();
		add("a", "meeting-hall");
		add("b", "meeting-hall");
		await expect(queue.moveDown("g1", idOf(queue, "a"))).resolves.toEqual({ ok: true, place: { place: 2, total: 2 } });
		expect(names(queue)).toEqual(["b", "a"]);
		await expect(queue.moveDown("g1", idOf(queue, "a"))).resolves.toEqual({ ok: false, reason: "edge" });
		await expect(queue.moveUp("g1", idOf(queue, "b"))).resolves.toEqual({ ok: false, reason: "edge" });
		await expect(queue.moveUp("g1", "no-such-id")).resolves.toEqual({ ok: false, reason: "gone" });
	});

	it("removes one request by its id, once", () => {
		const { add, queue } = setup();
		add("a", "other");
		add("b", "other");
		const id = idOf(queue, "a");
		expect(queue.remove("g1", id)?.requesterId).toBe("a");
		expect(queue.remove("g1", id)).toBeNull();
		expect(names(queue)).toEqual(["b"]);
	});

	it("tells its listeners: queued while Dero is busy, moved, and left with the reason", async () => {
		const { add, queue, free } = setup();
		const changes: string[] = [];
		queue.onChange((change) => changes.push(change.kind === "left" ? `left:${change.request.requesterId}:${change.exit}` : `${change.kind}:${change.request.requesterId}`));
		add("a", "other");
		add("b", "other");
		await queue.moveUp("g1", idOf(queue, "b"));
		queue.remove("g1", idOf(queue, "a"));
		free();
		await queue.drain("g1");
		expect(changes).toEqual(["queued:a", "queued:b", "moved:b", "left:a:removed", "left:b:joined"]);
	});

	it("tells no queued change for a request that runs at once on a free Dero", async () => {
		const { queue, free } = setup();
		const kinds: string[] = [];
		queue.onChange((change) => kinds.push(change.kind));
		free();
		await queue.requestVoice({ guild: GUILD, requesterId: "host", channelId: "vc-host", controlChannelId: "text-1", category: "rated-match" });
		expect(kinds).toEqual(["left"]);
	});

	it("says the place a new request would take, behind pinned requests and its own category", async () => {
		const { add, queue } = setup();
		add("hall", "meeting-hall");
		add("other", "other");
		await expect(queue.placeFor("g1", "rated-match")).resolves.toEqual({ place: 2, total: 3 });
		await queue.moveUp("g1", idOf(queue, "other"));
		await expect(queue.placeFor("g1", "meeting-hall")).resolves.toEqual({ place: 3, total: 3 });
	});
});
