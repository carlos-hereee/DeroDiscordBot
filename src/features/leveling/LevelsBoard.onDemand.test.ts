import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TextChannel } from "discord.js";
import type { Client } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";

// ── no level up builds a channel (2026-11 item 289) ──
// A server with no leaderboard channel stays without one until an admin adds it from its step
// card. A level up, the boot sweep and the hourly tick all bail as not set up, and the
// onDemandChannel fake stays here to fail these tests if a build ever comes back.

const mocks = vi.hoisted(() => ({
	getLevelingConfig: vi.fn(),
	topByTotalXp: vi.fn(),
	findByGuildId: vi.fn(),
	update: vi.fn(),
	ensureOnDemandChannel: vi.fn(),
	claimAnnouncement: vi.fn(),
	reconcileRewards: vi.fn(),
}));

vi.mock("./levelingConfig.js", () => ({ getLevelingConfig: mocks.getLevelingConfig }));
vi.mock("@db/stores/memberLevelStore.js", () => ({ memberLevelStore: { topByTotalXp: mocks.topByTotalXp, claimAnnouncement: mocks.claimAnnouncement } }));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findByGuildId, update: mocks.update } }));
vi.mock("./levelsBoardRenderer.js", () => ({ LEVELS_BOARD_AVATAR_SIZE: 64, renderLevelsBoardCard: vi.fn().mockResolvedValue(null) }));
vi.mock("./roleRewards.js", () => ({ reconcileRewards: mocks.reconcileRewards }));
vi.mock("@features/setup/onDemandChannel.js", () => ({ ensureOnDemandChannel: mocks.ensureOnDemandChannel }));

import { _clearLevelsBoardTimers, refreshLevelsBoard } from "./LevelsBoard.js";
import { _clearAnnouncerQueues, handleLevelCrossing } from "./levelUpAnnouncer.js";

const CHANNEL_ID = "c-leaderboard";
const guild = { id: "g1" };

function harness(): { client: Client; send: ReturnType<typeof vi.fn>; fetchChannel: ReturnType<typeof vi.fn> } {
	const send = vi.fn(async () => ({ id: "msg-new" }));
	const channel = Object.create(TextChannel.prototype) as TextChannel;
	Object.assign(channel, { id: CHANNEL_ID, guildId: "g1", send, messages: { fetch: vi.fn() }, client: { user: { id: "bot" } } });
	const fetchChannel = vi.fn(async () => channel);
	const client = { channels: { fetch: fetchChannel }, guilds: { cache: new Map([["g1", guild]]) } } as unknown as Client;
	return { client, send, fetchChannel };
}

const context = (overrides: Record<string, unknown> = {}) => ({
	settings: { enabled: true, curve: "dero", curveMultiplier: 1, maxLevel: null, milestoneMode: "prime", milestoneEveryN: 5, announceMode: "announcements" },
	leaderboardChannelId: null,
	announcementsChannelId: null,
	adminChannelId: null,
	homebaseDestroyed: false,
	copyOverrides: null,
	weekStart: "sunday",
	...overrides,
});

beforeEach(() => {
	_clearLevelsBoardTimers();
	_clearAnnouncerQueues();
	mocks.getLevelingConfig.mockReset().mockResolvedValue(context());
	mocks.topByTotalXp.mockReset().mockResolvedValue([{ userId: "u1", username: "Silent", totalXp: 964 }]);
	mocks.findByGuildId.mockReset().mockResolvedValue({ levelsMessageId: null });
	mocks.update.mockReset().mockResolvedValue(undefined);
	mocks.ensureOnDemandChannel.mockReset();
	mocks.claimAnnouncement.mockReset().mockResolvedValue(true);
	mocks.reconcileRewards.mockReset().mockResolvedValue(null);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("refreshLevelsBoard", () => {
	it("bails as not set up on a server with no leaderboard, building nothing", async () => {
		const { client, send, fetchChannel } = harness();

		await expect(refreshLevelsBoard(client, "g1")).resolves.toEqual({ posted: false, problem: "not-set-up" });

		expect(mocks.ensureOnDemandChannel).not.toHaveBeenCalled();
		expect(fetchChannel).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
	});

	it("still posts the board on a server that has one", async () => {
		mocks.getLevelingConfig.mockResolvedValue(context({ leaderboardChannelId: CHANNEL_ID }));
		const { client, send } = harness();

		await expect(refreshLevelsBoard(client, "g1")).resolves.toEqual({ posted: true });

		expect(send).toHaveBeenCalledTimes(1);
		expect(mocks.ensureOnDemandChannel).not.toHaveBeenCalled();
	});
});

describe("a level up on a server with no leaderboard", () => {
	it("nudges the board, which builds nothing and posts nothing", async () => {
		vi.useFakeTimers();
		const { client, send, fetchChannel } = harness();
		// dero curve: level 3 at 358, level 4 at 630.
		await handleLevelCrossing({ client, guildId: "g1", userId: "u1", username: "Silent", oldTotalXp: 358, newTotalXp: 630 });

		await vi.advanceTimersByTimeAsync(BOT_CONSTANTS.LEADERBOARD_REFRESH_DEBOUNCE_MS);

		expect(mocks.getLevelingConfig).toHaveBeenCalled();
		expect(mocks.ensureOnDemandChannel).not.toHaveBeenCalled();
		expect(fetchChannel).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
	});
});
