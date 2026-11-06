import { beforeEach, describe, expect, it, vi } from "vitest";

// ── the production database guard ───────────────────────────────────────────
// A dev boot on production's cluster must stop before it connects, and a production boot must
// never be stopped by this: the guard reads NODE_ENV's development value and nothing else.

const mocks = vi.hoisted(() => ({ config: { uri: "", isDev: true }, connect: vi.fn(async () => undefined) }));

vi.mock("@utils/config.js", () => ({
	get uri() {
		return mocks.config.uri;
	},
	get isDev() {
		return mocks.config.isDev;
	},
}));
vi.mock("mongoose", () => ({ default: { connect: mocks.connect, connection: { on: vi.fn() } } }));

import { connectMongoose } from "./db.js";
import { reachesProductionDatabase } from "./productionDatabaseGuard.js";

const PRODUCTION = "mongodb+srv://user:secret@cluster0.3p9glw9.mongodb.net/?appName=Cluster0";
const DEV = "mongodb+srv://user:secret@cluster0.3oxb4k0.mongodb.net/?appName=Cluster0";

describe("reachesProductionDatabase", () => {
	it("knows the production cluster, by its short host and its shard hosts", () => {
		expect(reachesProductionDatabase(PRODUCTION)).toBe(true);
		expect(reachesProductionDatabase("mongodb://u:p@ac-j75fane-shard-00-00.3p9glw9.mongodb.net:27017,ac-j75fane-shard-00-01.3P9GLW9.mongodb.net:27017/test")).toBe(true);
	});

	it("passes another cluster, even with the production id in its password", () => {
		expect(reachesProductionDatabase(DEV)).toBe(false);
		expect(reachesProductionDatabase("mongodb+srv://user:3p9glw9.mongodb.net@cluster0.3oxb4k0.mongodb.net/")).toBe(false);
	});
});

describe("connectMongoose", () => {
	const exit = vi.spyOn(process, "exit").mockImplementation((() => {
		throw new Error("exited");
	}) as never);

	beforeEach(() => {
		mocks.connect.mockClear();
		exit.mockClear();
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		vi.spyOn(console, "log").mockImplementation(() => undefined);
	});

	it("refuses a dev boot on production's cluster before it connects", async () => {
		mocks.config = { uri: PRODUCTION, isDev: true };

		await expect(connectMongoose()).rejects.toThrow("exited");

		expect(exit).toHaveBeenCalledWith(1);
		expect(mocks.connect).not.toHaveBeenCalled();
	});

	it("connects a dev boot on its own cluster", async () => {
		mocks.config = { uri: DEV, isDev: true };

		await connectMongoose();

		expect(mocks.connect).toHaveBeenCalledOnce();
	});

	it("never stops a production boot", async () => {
		mocks.config = { uri: PRODUCTION, isDev: false };

		await connectMongoose();

		expect(exit).not.toHaveBeenCalled();
		expect(mocks.connect).toHaveBeenCalledOnce();
	});
});
