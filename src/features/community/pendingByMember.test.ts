import { describe, it, expect, vi, afterEach } from "vitest";
import { createPendingByMember } from "./pendingByMember.js";

// ── pendingByMember (2026-11 item 367, D2) ──────────────────────────────
// The shared keyed store: per member, read leaves the value, take removes it,
// the window expires it, and a refused Confirm can put picks back on their old deadline.

const TTL_MS = 1000;

afterEach(() => {
	vi.useRealTimers();
});

describe("createPendingByMember", () => {
	it("keeps each member's value apart and reads without taking", () => {
		const store = createPendingByMember<string>(TTL_MS);
		store.remember("g1", "a", "picks of a");
		store.remember("g1", "b", "picks of b");
		expect(store.read("g1", "a")).toBe("picks of a");
		expect(store.read("g1", "a")).toBe("picks of a");
		expect(store.read("g1", "b")).toBe("picks of b");
		expect(store.read("g2", "a")).toBeNull();
	});

	it("takes once, so a double Confirm finds nothing the second time", () => {
		const store = createPendingByMember<number>(TTL_MS);
		store.remember("g1", "a", 7);
		expect(store.take("g1", "a")?.value).toBe(7);
		expect(store.take("g1", "a")).toBeNull();
	});

	it("expires an entry after its window, and keeps a given deadline when picks go back", () => {
		vi.useFakeTimers();
		const store = createPendingByMember<number>(TTL_MS);
		store.remember("g1", "a", 1);
		const taken = store.take("g1", "a");
		vi.advanceTimersByTime(TTL_MS - 10);
		store.remember("g1", "a", 1, taken!.expiresAt);
		vi.advanceTimersByTime(20);
		expect(store.read("g1", "a")).toBeNull();
		expect(store.take("g1", "a")).toBeNull();
	});

	it("forgets on Cancel", () => {
		const store = createPendingByMember<number>(TTL_MS);
		store.remember("g1", "a", 1);
		store.forget("g1", "a");
		expect(store.read("g1", "a")).toBeNull();
	});
});
