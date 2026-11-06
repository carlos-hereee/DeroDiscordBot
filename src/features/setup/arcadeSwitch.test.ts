import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client, Guild } from "discord.js";

// ── arcadeSwitch (post-launch plan item 14) ───────────────────────────────
// Off writes the opt out BEFORE any delete and tears the arcade down through
// selfDestruct's helpers; on lifts the opt out and runs the boot sweep.

const m = vi.hoisted(() => ({
	findByGuildId: vi.fn(),
	update: vi.fn(),
	demolishChannels: vi.fn(),
	demolishCategory: vi.fn(),
	ensureHomebase: vi.fn(),
	refreshIntroEmbeds: vi.fn(),
}));

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: m.findByGuildId, update: m.update } }));
vi.mock("./selfDestruct.js", () => ({ demolishChannels: m.demolishChannels, demolishCategory: m.demolishCategory }));
vi.mock("./GuildSetupManager.js", () => ({
	GuildSetupManager: {
		CHANNEL_SPECS: [
			{ configField: "introChannelId", categoryField: "categoryId" },
			{ configField: "arcadeRulesChannelId", categoryField: "gamesCategoryId" },
			{ configField: "arcadeGamesChannelId", categoryField: "gamesCategoryId" },
		],
		ensureHomebase: m.ensureHomebase,
		refreshIntroEmbeds: m.refreshIntroEmbeds,
	},
}));

import { turnArcadeOff, turnArcadeOn } from "./arcadeSwitch.js";

const guild = { id: "g1" } as unknown as Guild;
const client = {} as Client;
const LIVE = { guildId: "g1", gamesCategoryId: "cat-games", arcadeRulesChannelId: "ch-rules", arcadeGamesChannelId: "ch-games", userRemovedChannels: ["leaderboardChannelId"], adoptedChannelIds: [] };
const OFF = { guildId: "g1", gamesCategoryId: null, arcadeRulesChannelId: null, arcadeGamesChannelId: null, userRemovedChannels: ["arcadeRulesChannelId", "arcadeGamesChannelId"] };

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	m.update.mockResolvedValue(undefined);
});

describe("turnArcadeOff", () => {
	it("opts every arcade slot out and nulls its ids in one write, then deletes the channels and the category", async () => {
		m.findByGuildId.mockResolvedValue(LIVE);

		expect(await turnArcadeOff(guild)).toBe("off");

		expect(m.update).toHaveBeenCalledOnce();
		const write = m.update.mock.calls[0]![1] as Record<string, unknown>;
		expect(write.userRemovedChannels).toEqual(["leaderboardChannelId", "arcadeRulesChannelId", "arcadeGamesChannelId"]);
		expect(write).toMatchObject({ gamesCategoryId: null, arcadeRulesChannelId: null, arcadeGamesChannelId: null, "introMessageIds.arcadeGamesBoardId": null });
		expect(write).not.toHaveProperty("introChannelId");

		expect(m.demolishChannels).toHaveBeenCalledWith(guild, ["ch-rules", "ch-games"], new Set(), "arcade-off");
		expect(m.demolishCategory).toHaveBeenCalledWith(guild, "cat-games", "gamesCategoryId", new Set(), "arcade-off");
		expect(m.update.mock.invocationCallOrder[0]!).toBeLessThan(m.demolishChannels.mock.invocationCallOrder[0]!);
	});

	it("does nothing to an arcade that is already off", async () => {
		m.findByGuildId.mockResolvedValue(OFF);

		expect(await turnArcadeOff(guild)).toBe("already-off");
		expect(m.update).not.toHaveBeenCalled();
		expect(m.demolishCategory).not.toHaveBeenCalled();
	});
});

describe("turnArcadeOn", () => {
	it("lifts the opt out for the arcade slots only, then runs the boot sweep and the intro refresh", async () => {
		m.findByGuildId.mockResolvedValueOnce({ ...OFF, userRemovedChannels: [...OFF.userRemovedChannels, "leaderboardChannelId"] }).mockResolvedValueOnce(LIVE);

		expect(await turnArcadeOn(client, guild)).toBe("on");
		// The rebuilt arcade also starts with its switches on (2026-10 item 257, owner item 11).
		expect(m.update).toHaveBeenCalledWith("g1", { userRemovedChannels: ["leaderboardChannelId"], chipEconomyEnabled: true, arcadeMonthlyPost: true, botOpponentsEnabled: true });
		// Naming the arcade is what gets a press past auto heal off.
		expect(m.ensureHomebase).toHaveBeenCalledWith(client, guild, { requestedCategory: "gamesCategoryId" });
		expect(m.refreshIntroEmbeds).toHaveBeenCalledWith(client, guild);
	});

	it("keeps a switch this server turned off: a stored false stays false", async () => {
		m.findByGuildId.mockResolvedValueOnce({ ...OFF, chipEconomyEnabled: false }).mockResolvedValueOnce(LIVE);

		await turnArcadeOn(client, guild);
		const write = m.update.mock.calls[0]![1] as Record<string, unknown>;
		expect(write).not.toHaveProperty("chipEconomyEnabled");
		expect(write).toMatchObject({ arcadeMonthlyPost: true, botOpponentsEnabled: true });
	});

	it("reports pending when the sweep did not build the channels", async () => {
		m.findByGuildId.mockResolvedValueOnce(OFF).mockResolvedValueOnce({ ...OFF, userRemovedChannels: [] });

		expect(await turnArcadeOn(client, guild)).toBe("pending");
	});

	it("answers on with auto heal off and never writes the stored switch", async () => {
		m.findByGuildId.mockResolvedValueOnce({ ...OFF, autoHealEnabled: false }).mockResolvedValueOnce({ ...LIVE, autoHealEnabled: false });

		expect(await turnArcadeOn(client, guild)).toBe("on");
		expect(m.update.mock.calls[0]![1]).not.toHaveProperty("autoHealEnabled");
	});

	it("sweeps again for a press that built the category but not every channel", async () => {
		const partlyBuilt = { ...LIVE, arcadeGamesChannelId: null, userRemovedChannels: [] };
		m.findByGuildId.mockResolvedValueOnce(partlyBuilt).mockResolvedValueOnce(LIVE);

		expect(await turnArcadeOn(client, guild)).toBe("on");
		expect(m.ensureHomebase).toHaveBeenCalledOnce();
	});

	it("does nothing to an arcade that is already on", async () => {
		m.findByGuildId.mockResolvedValue(LIVE);

		expect(await turnArcadeOn(client, guild)).toBe("already-on");
		expect(m.ensureHomebase).not.toHaveBeenCalled();
	});
});
