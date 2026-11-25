import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drainWithin } from "./drainWithin.js";

// drainWithin (2026-11 item 420, L4): shutdown and a wipe wait for work, and never past a bound.

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("drainWithin", () => {
	it("L4: returns at its bound with work still pending, and says it did not drain", async () => {
		const drained = drainWithin([new Promise(() => undefined)], 8000);
		await vi.advanceTimersByTimeAsync(7999);
		let settled = false;
		void drained.then(() => (settled = true));
		await vi.advanceTimersByTimeAsync(0);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(await drained).toBe(false);
	});

	it("L4: returns as soon as all the work ended, a rejection included, and leaves no timer", async () => {
		expect(await drainWithin([Promise.resolve(1), Promise.reject(new Error("failed")), undefined], 8000)).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("returns at once for nothing", async () => {
		expect(await drainWithin([], 8000)).toBe(true);
	});
});
