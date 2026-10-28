import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ findByGuildId: vi.fn() }));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findByGuildId } }));

import { readTaskChannelIds, taskChannelIds } from "./taskChannel.js";

// ── taskChannel (2026-10 item 263 Phase 4b, owner decision 15) ─────────────
// A Dero task posts in 💬dero-commands for everyone; a guild with no channel stored, or a
// read that fails, offers none, so a task's post is refused rather than sent elsewhere.

beforeEach(() => {
	mocks.findByGuildId.mockReset();
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("taskChannelIds", () => {
	it("is the command channel alone, or nothing when none is stored", () => {
		expect(taskChannelIds("commands")).toEqual(["commands"]);
		expect(taskChannelIds(null)).toEqual([]);
		expect(taskChannelIds(undefined)).toEqual([]);
	});
});

describe("readTaskChannelIds", () => {
	it("reads 💬dero-commands off the guild's row", async () => {
		mocks.findByGuildId.mockResolvedValue({ commandOutputChannelId: "commands", allowedChannelIds: ["general"] });
		expect(await readTaskChannelIds("g1")).toEqual(["commands"]);
		expect(mocks.findByGuildId).toHaveBeenCalledWith("g1");
	});

	it("offers no channel for a guild that never stored one, or when the read fails", async () => {
		mocks.findByGuildId.mockResolvedValueOnce({ commandOutputChannelId: null });
		expect(await readTaskChannelIds("g1")).toEqual([]);
		mocks.findByGuildId.mockResolvedValueOnce(null);
		expect(await readTaskChannelIds("g1")).toEqual([]);
		mocks.findByGuildId.mockRejectedValueOnce(new Error("connection lost"));
		expect(await readTaskChannelIds("g1")).toEqual([]);
	});
});
