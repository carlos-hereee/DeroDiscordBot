import { describe, it, expect } from "vitest";
import { createGuildQueue } from "./guildQueue.js";

// ── guildQueue (2026-11 item 289) ───────────────────────────────────────────
// One guild's tasks run in order and a rejected task never stops the next one; two guilds,
// and two queues, never wait for each other.

/** A task the test finishes by hand, so an ordering is pinned rather than timed. */
function deferredTask<T>(log: string[], name: string, value: T): { task: () => Promise<T>; finish: () => void } {
	let finish: () => void = () => undefined;
	const gate = new Promise<void>((resolve) => {
		finish = resolve;
	});
	return {
		task: async () => {
			log.push(`${name} started`);
			await gate;
			log.push(`${name} ended`);
			return value;
		},
		finish: () => finish(),
	};
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createGuildQueue", () => {
	it("runs one guild's tasks in order, each waiting for the last", async () => {
		const queue = createGuildQueue();
		const log: string[] = [];
		const first = deferredTask(log, "first", 1);
		const second = deferredTask(log, "second", 2);

		const results = Promise.all([queue.run("g1", first.task), queue.run("g1", second.task)]);
		await flush();
		expect(log).toEqual(["first started"]);

		first.finish();
		await flush();
		expect(log).toEqual(["first started", "first ended", "second started"]);

		second.finish();
		await expect(results).resolves.toEqual([1, 2]);
	});

	it("hands a rejection to its own caller and still runs the next task", async () => {
		const queue = createGuildQueue();
		const failing = queue.run("g1", async () => {
			throw new Error("first failed");
		});
		const next = queue.run("g1", async () => "second ran");

		await expect(failing).rejects.toThrow("first failed");
		await expect(next).resolves.toBe("second ran");
	});

	it("keeps working after an empty chain was dropped", async () => {
		const queue = createGuildQueue();
		await queue.run("g1", async () => "first");
		await expect(queue.run("g1", async () => "second")).resolves.toBe("second");
	});

	it("never makes two guilds wait for each other", async () => {
		const queue = createGuildQueue();
		const log: string[] = [];
		const slow = deferredTask(log, "slow", "g1");

		const pending = queue.run("g1", slow.task);
		await expect(queue.run("g2", async () => "g2 done")).resolves.toBe("g2 done");

		slow.finish();
		await pending;
	});

	it("gives each queue its own chains, so a task on one can await a task on the other", async () => {
		const builds = createGuildQueue();
		const syncs = createGuildQueue();
		const result = builds.run("g1", () => syncs.run("g1", async () => "reached"));
		await expect(result).resolves.toBe("reached");
	});
});
