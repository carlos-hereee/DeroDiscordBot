import { describe, it, expect, vi, beforeEach } from "vitest";

// ── serverReset (post-launch plan item 10) ────────────────────────────────
// The reset writes the whole defaults table and switches the voice off; the wipe runs
// every step even past a failure, retires events through eventStore, and names what failed.

const m = vi.hoisted(() => {
	const deleter = () => vi.fn().mockResolvedValue({ deletedCount: 0 });
	return {
		resetSettings: vi.fn(),
		deleteVoiceConfig: vi.fn(),
		leave: vi.fn(),
		invalidate: vi.fn(),
		memberLevels: deleter(),
		xpPeriods: deleter(),
		xpDaily: deleter(),
		luck: deleter(),
		tallies: deleter(),
		rooms: deleter(),
		requests: deleter(),
		partyGames: deleter(),
		polls: deleter(),
		overrides: deleter(),
		pairing: deleter(),
		attendance: deleter(),
		findEvents: vi.fn(),
		retireEvent: vi.fn(),
	};
});

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { resetSettings: m.resetSettings } }));
vi.mock("@db/stores/deroVoiceConfigStore.js", () => ({ deroVoiceConfigStore: { deleteByGuildId: m.deleteVoiceConfig } }));
vi.mock("@features/voice/voiceSessions.js", () => ({ voiceSessions: { leave: m.leave } }));
vi.mock("@features/leveling/levelingConfig.js", () => ({ invalidateLevelingConfig: m.invalidate }));
vi.mock("@db/stores/memberLevelStore.js", () => ({ memberLevelStore: { deleteGuild: m.memberLevels } }));
vi.mock("@db/stores/xpPeriodStore.js", () => ({ xpPeriodStore: { deleteGuild: m.xpPeriods } }));
vi.mock("@db/stores/xpDailyStore.js", () => ({ xpDailyStore: { deleteGuild: m.xpDaily } }));
vi.mock("@db/stores/luckStatStore.js", () => ({ luckStatStore: { deleteGuild: m.luck } }));
vi.mock("@db/stores/gameResultCountStore.js", () => ({ gameResultCountStore: { deleteGuild: m.tallies } }));
vi.mock("@db/stores/gameRoomStore.js", () => ({ gameRoomStore: { deleteGuild: m.rooms } }));
vi.mock("@db/stores/gameRequestStore.js", () => ({ gameRequestStore: { deleteGuild: m.requests } }));
vi.mock("@db/stores/partyGameStore.js", () => ({ partyGameStore: { deleteGuild: m.partyGames } }));
vi.mock("@db/stores/pollResultStore.js", () => ({ pollResultStore: { deleteGuild: m.polls } }));
vi.mock("@db/stores/eventOverrideStore.js", () => ({ eventOverrideStore: { deleteGuild: m.overrides } }));
vi.mock("@db/stores/pendingPairingStore.js", () => ({ pendingPairingStore: { deleteUnclaimedForGuild: m.pairing } }));
vi.mock("@db/stores/activityStore.js", () => ({ activityStore: { deleteByEvents: m.attendance } }));
vi.mock("@db/stores/eventStore.js", () => ({ eventStore: { findByGuildId: m.findEvents, deleteInGuild: m.retireEvent } }));

import { CONFIG_DEFAULTS, resetConfigsToDefault, wipeServerData } from "./serverReset.js";

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	m.findEvents.mockResolvedValue([{ eventId: "evt-1" }, { eventId: "evt-2" }]);
	m.retireEvent.mockResolvedValue(null);
});

describe("resetConfigsToDefault", () => {
	it("ends a live call, drops the voice config and writes the whole defaults table", async () => {
		await resetConfigsToDefault("g1");

		expect(m.leave).toHaveBeenCalledWith("g1", "switched_off");
		expect(m.deleteVoiceConfig).toHaveBeenCalledWith("g1");
		expect(m.resetSettings).toHaveBeenCalledWith("g1", CONFIG_DEFAULTS);
		expect(m.invalidate).toHaveBeenCalledWith("g1");
	});

	it("never touches ids, roles or setup state", () => {
		for (const key of Object.keys(CONFIG_DEFAULTS)) {
			expect(key).not.toMatch(/ChannelId$|CategoryId$|RoleId$|^setupComplete$|^homebaseDestroyed$|^pluginId$/);
		}
	});
});

describe("wipeServerData", () => {
	it("deletes every guild owned collection and retires each event after clearing its attendance", async () => {
		const result = await wipeServerData("g1");

		expect(result).toEqual({ failed: [] });
		for (const fn of [m.memberLevels, m.xpPeriods, m.xpDaily, m.luck, m.tallies, m.rooms, m.requests, m.partyGames, m.polls, m.overrides, m.pairing]) {
			expect(fn).toHaveBeenCalledWith("g1");
		}
		expect(m.attendance).toHaveBeenCalledWith(["evt-1", "evt-2"]);
		expect(m.retireEvent).toHaveBeenCalledWith("evt-1", "g1");
		expect(m.retireEvent).toHaveBeenCalledWith("evt-2", "g1");
	});

	it("keeps going past a failed step and names it", async () => {
		m.luck.mockRejectedValueOnce(new Error("mongo down"));

		const result = await wipeServerData("g1");

		expect(result).toEqual({ failed: ["luck"] });
		expect(m.pairing).toHaveBeenCalledWith("g1");
	});
});
