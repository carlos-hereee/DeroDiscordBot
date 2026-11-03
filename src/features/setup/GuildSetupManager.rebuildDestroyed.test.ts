import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Guild } from "discord.js";

// ── rebuildDestroyedHomebase (2026-11 item 285 debug pass) ──────────────────────
// The one rebuild of a self destructed server, shared by /setup's rebuild branch and
// both self destruct teardowns. autoSetup swallows a missing permissions failure, so
// the rebuilt category is fetched to prove it: the notice board's when the row stores
// one, Headquarters' otherwise, since a self destructed row rebuilds Headquarters alone.

const mocks = vi.hoisted(() => ({ findByGuildId: vi.fn() }));

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findByGuildId, update: vi.fn() } }));

import { GuildSetupManager } from "./GuildSetupManager.js";

const OWNER = "owner-1";

function makeGuild(liveChannelIds: string[]): Guild {
	return {
		id: "g1",
		ownerId: OWNER,
		channels: { fetch: vi.fn(async (id: string) => (liveChannelIds.includes(id) ? { id } : null)) },
	} as unknown as Guild;
}

beforeEach(() => {
	vi.restoreAllMocks();
	mocks.findByGuildId.mockReset();
	vi.spyOn(GuildSetupManager, "autoSetup").mockResolvedValue(undefined);
});

describe("GuildSetupManager.rebuildDestroyedHomebase", () => {
	it("forces the build, then proves a Headquarters only rebuild by its Headquarters category", async () => {
		mocks.findByGuildId.mockResolvedValue({ guildId: "g1", categoryId: null, headquartersCategoryId: "hq-cat" });
		const guild = makeGuild(["hq-cat"]);

		await expect(GuildSetupManager.rebuildDestroyedHomebase(guild)).resolves.toBe(true);
		expect(GuildSetupManager.autoSetup).toHaveBeenCalledWith(guild, { guildId: "g1", ownerId: OWNER }, { force: true });
	});

	it("proves a rebuild that stores a notice board by the notice board", async () => {
		mocks.findByGuildId.mockResolvedValue({ guildId: "g1", categoryId: "board-cat", headquartersCategoryId: "hq-cat" });

		await expect(GuildSetupManager.rebuildDestroyedHomebase(makeGuild(["board-cat"]))).resolves.toBe(true);
	});

	it("answers false when the stored category is not in Discord, as after a swallowed 50013", async () => {
		mocks.findByGuildId.mockResolvedValue({ guildId: "g1", categoryId: null, headquartersCategoryId: "hq-cat" });

		await expect(GuildSetupManager.rebuildDestroyedHomebase(makeGuild([]))).resolves.toBe(false);
	});

	it("answers false when the row stores no category at all", async () => {
		mocks.findByGuildId.mockResolvedValue({ guildId: "g1", categoryId: null, headquartersCategoryId: null });
		const guild = makeGuild(["hq-cat"]);

		await expect(GuildSetupManager.rebuildDestroyedHomebase(guild)).resolves.toBe(false);
		expect(guild.channels.fetch).not.toHaveBeenCalled();
	});
});
