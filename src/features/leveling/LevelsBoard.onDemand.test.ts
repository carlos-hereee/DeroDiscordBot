import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TextChannel } from "discord.js";
import type { Client } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";

// ── the leaderboard, built on its first level up (2026-11 item 285 Phase 3) ──
// A Headquarters only server has no leaderboard channel. Its first level up builds one
// through onDemandChannel before the stored id is read; the boot sweep and the hourly
// tick, which reach every guild, never do.

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

const BUILT_ID = "c-leaderboard-built";
const guild = { id: "g1" };

function harness(): { client: Client; send: ReturnType<typeof vi.fn>; fetchChannel: ReturnType<typeof vi.fn> } {
	const send = vi.fn(async () => ({ id: "msg-new" }));
	const channel = Object.create(TextChannel.prototype) as TextChannel;
	Object.assign(channel, { id: BUILT_ID, guildId: "g1", send, messages: { fetch: vi.fn() }, client: { user: { id: "bot" } } });
	const fetchChannel = vi.fn(async () => channel);
	const client = { channels: { fetch: fetchChannel }, guilds: { cache: new Map([["g1", guild]]) } } as unknown as Client;
	return { client, send, fetchChannel };
}

const context = (overrides: Record<string, unknown> = {}) => ({
	settings: { enabled: true, curve: "dero", curveMultiplier: 1, maxLevel: null, milestoneMode: "prime", milestoneEveryN: 5, announceMode: "announcements", announceChannelId: null },
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
	mocks.ensureOnDemandChannel.mockReset().mockResolvedValue({ id: BUILT_ID });
	mocks.claimAnnouncement.mockReset().mockResolvedValue(true);
	mocks.reconcileRewards.mockReset().mockResolvedValue(null);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("refreshLevelsBoard with ensureChannel", () => {
	it("builds the leaderboard before reading the channel, then posts the board there", async () => {
		const { client, send, fetchChannel } = harness();
		const result = await refreshLevelsBoard(client, "g1", { ensureChannel: true });

		expect(mocks.ensureOnDemandChannel).toHaveBeenCalledWith(guild, "leaderboardChannelId");
		expect(mocks.ensureOnDemandChannel.mock.invocationCallOrder[0]!).toBeLessThan(fetchChannel.mock.invocationCallOrder[0]!);
		expect(fetchChannel).toHaveBeenCalledWith(BUILT_ID);
		expect(send).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ posted: true });
	});

	it("does not build when the leaderboard already exists", async () => {
		mocks.getLevelingConfig.mockResolvedValue(context({ leaderboardChannelId: BUILT_ID }));
		await refreshLevelsBoard(harness().client, "g1", { ensureChannel: true });
		expect(mocks.ensureOnDemandChannel).not.toHaveBeenCalled();
	});

	it("bails as before when nothing could be built (an admin removed the leaderboard)", async () => {
		mocks.ensureOnDemandChannel.mockResolvedValue(null);
		await expect(refreshLevelsBoard(harness().client, "g1", { ensureChannel: true })).resolves.toEqual({ posted: false, problem: "not-set-up" });
	});
});

describe("refreshLevelsBoard without ensureChannel (the boot sweep and the hourly tick)", () => {
	it("never builds a channel", async () => {
		await expect(refreshLevelsBoard(harness().client, "g1")).resolves.toEqual({ posted: false, problem: "not-set-up" });
		expect(mocks.ensureOnDemandChannel).not.toHaveBeenCalled();
	});
});

describe("a level up on a Headquarters only server", () => {
	it("still nudges the board, which builds the leaderboard, though it has no announcements channel to post in", async () => {
		vi.useFakeTimers();
		const { client, send } = harness();
		// dero curve: level 3 at 358, level 4 at 630.
		await handleLevelCrossing({ client, guildId: "g1", userId: "u1", username: "Silent", oldTotalXp: 358, newTotalXp: 630 });
		expect(send).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(BOT_CONSTANTS.LEADERBOARD_REFRESH_DEBOUNCE_MS);

		expect(mocks.ensureOnDemandChannel).toHaveBeenCalledWith(guild, "leaderboardChannelId");
		expect(send).toHaveBeenCalledTimes(1);
	});
});
