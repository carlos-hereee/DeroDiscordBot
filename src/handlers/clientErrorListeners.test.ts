import { EventEmitter } from "node:events";
import { Events } from "discord.js";
import type { Client } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerClientErrorListeners } from "./clientErrorListeners.js";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("registerClientErrorListeners", () => {
	it("turns an emitted client error into a log line instead of a thrown error", () => {
		const emitter = new EventEmitter();
		// Without a listener Node throws on an "error" emit, which is the crash this guards.
		expect(() => emitter.emit(Events.Error, new Error("gateway hiccup"))).toThrow("gateway hiccup");

		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		registerClientErrorListeners(emitter as unknown as Client);
		expect(() => emitter.emit(Events.Error, new Error("gateway hiccup"))).not.toThrow();
		expect(log).toHaveBeenCalledWith("[discord] client error", expect.any(Error));
	});

	it("logs shard disconnects, reconnects and warnings", () => {
		const emitter = new EventEmitter();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		vi.spyOn(console, "log").mockImplementation(() => undefined);
		registerClientErrorListeners(emitter as unknown as Client);

		emitter.emit(Events.ShardDisconnect, { code: 1006 }, 0);
		emitter.emit(Events.ShardReconnecting, 0);
		emitter.emit(Events.Warn, "rate limit soon");

		expect(warn).toHaveBeenCalledWith("[discord] shard 0 disconnected code=1006");
		expect(warn).toHaveBeenCalledWith("[discord] shard 0 reconnecting");
		expect(warn).toHaveBeenCalledWith("[discord] warning", "rate limit soon");
	});
});
