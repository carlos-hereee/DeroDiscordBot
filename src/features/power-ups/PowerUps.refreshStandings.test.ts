import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { DiscordAPIError, TextChannel, type ButtonInteraction } from "discord.js";

// ── Refresh standings (2026-10 item 254) ──────────────────────────────────────
// The admin guide's Refresh standings rebuilds BOTH boards of the leaderboard
// channel through their own refreshers, and the reply names each board. The two
// refreshers run for real here over one fake channel; only the stores, the levels
// card renderer and the admin log are mocked.

const mocks = vi.hoisted(() => ({
	buttons: new Map<string, (interaction: unknown) => Promise<void>>(),
	findByGuildId: vi.fn(),
	update: vi.fn(),
	findEvents: vi.fn(),
	groupedActivity: vi.fn(),
	getLevelingConfig: vi.fn(),
	topByTotalXp: vi.fn(),
	emitFor: vi.fn(),
}));

vi.mock("@handlers/interactionRegistry.js", () => ({
	registerButton: (prefix: string, handler: (interaction: unknown) => Promise<void>) => mocks.buttons.set(prefix, handler),
}));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findByGuildId, update: mocks.update } }));
vi.mock("@db/stores/eventStore.js", () => ({ eventStore: { findByGuildId: mocks.findEvents } }));
vi.mock("@db/stores/activityStore.js", () => ({ activityStore: { findAllGroupedByPlayerInEvents: mocks.groupedActivity } }));
vi.mock("@db/stores/memberLevelStore.js", () => ({ memberLevelStore: { topByTotalXp: mocks.topByTotalXp } }));
vi.mock("@features/leveling/levelingConfig.js", () => ({ getLevelingConfig: mocks.getLevelingConfig }));
// The levels card answers null, so the levels board posts its text fallback.
vi.mock("@features/leveling/levelsBoardRenderer.js", () => ({ LEVELS_BOARD_AVATAR_SIZE: 64, renderLevelsBoardCard: vi.fn(async () => null) }));
vi.mock("@features/setup/adminLog.js", () => ({ adminLog: { emitFor: mocks.emitFor, emit: vi.fn() } }));

import { registerPowerUpHandlers } from "./PowerUps.js";
import { setupCopy } from "@features/setup/setupCopy.js";

const OWNER = "owner-1";
const BOT_ID = "bot";
const CHANNEL_ID = "c-leaderboard";
const copy = setupCopy.refreshStandings;

const unknownMessage = (): DiscordAPIError => new DiscordAPIError({ code: 10008, message: "Unknown Message" }, 10008, 404, "GET", "url", {});

// One leaderboard channel whose two stored board messages were deleted by hand.
function deletedBoardsChannel() {
	let posted = 0;
	const send = vi.fn(async () => ({ id: `msg-new-${++posted}` }));
	const channel = Object.create(TextChannel.prototype) as TextChannel;
	Object.assign(channel, {
		id: CHANNEL_ID,
		guildId: "g1",
		send,
		messages: { fetch: vi.fn(async () => Promise.reject(unknownMessage())) },
		client: { user: { id: BOT_ID } },
	});
	return { channel, send };
}

function press(channel: TextChannel) {
	return {
		customId: "powerup:admin:refresh",
		guildId: "g1",
		guild: { id: "g1", ownerId: OWNER, members: { cache: new Map() } },
		user: { id: OWNER },
		client: { channels: { fetch: async () => channel }, guilds: { cache: new Map() } },
		deferReply: vi.fn(async () => undefined),
		editReply: vi.fn(async () => undefined),
		reply: vi.fn(async () => undefined),
	};
}

async function pressRefresh(interaction: ReturnType<typeof press>): Promise<string> {
	await mocks.buttons.get("powerup")!(interaction as unknown as ButtonInteraction);
	return (interaction.editReply.mock.calls.at(-1) as unknown as [{ content: string }])[0].content;
}

beforeAll(() => {
	registerPowerUpHandlers();
});

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	mocks.findByGuildId.mockResolvedValue({ guildId: "g1", leaderboardChannelId: CHANNEL_ID, leaderboardMessageId: "old-participation", levelsMessageId: "old-levels" });
	mocks.update.mockResolvedValue(undefined);
	mocks.findEvents.mockResolvedValue([{ eventId: "evt-1" }]);
	mocks.groupedActivity.mockResolvedValue([{ username: "Silent", totalScore: 12, eventsAttended: 2, totalAcknowledged: 2 }]);
	mocks.getLevelingConfig.mockResolvedValue({
		settings: { enabled: true, curve: "dero", curveMultiplier: 1, maxLevel: null },
		leaderboardChannelId: CHANNEL_ID,
		homebaseDestroyed: false,
	});
	mocks.topByTotalXp.mockResolvedValue([{ userId: "u1", username: "Silent", totalXp: 964 }]);
});

describe("Refresh standings", () => {
	it("brings BOTH boards back with one press after both messages were deleted by hand", async () => {
		const { channel, send } = deletedBoardsChannel();
		const content = await pressRefresh(press(channel));

		expect(send).toHaveBeenCalledTimes(2);
		// Each board re-anchors its own field, never the other's.
		const anchors = mocks.update.mock.calls.map((call) => call[1] as Record<string, string>);
		expect(anchors).toContainEqual({ leaderboardMessageId: expect.stringMatching(/^msg-new-/) });
		expect(anchors).toContainEqual({ levelsMessageId: expect.stringMatching(/^msg-new-/) });
		expect(content).toBe([copy.refreshed(copy.boards.participation), copy.refreshed(copy.boards.levels)].join("\n"));
		expect(mocks.emitFor).toHaveBeenCalledWith(expect.anything(), "g1", "powerup.toggle", expect.objectContaining({ detail: copy.auditAllRefreshed }));
	});

	it("names the board that failed and why, rather than claiming success", async () => {
		const { channel, send } = deletedBoardsChannel();
		mocks.getLevelingConfig.mockResolvedValue({ settings: {}, leaderboardChannelId: null, homebaseDestroyed: false });
		const content = await pressRefresh(press(channel));

		expect(send).toHaveBeenCalledTimes(1);
		expect(content).toBe(
			[copy.refreshed(copy.boards.participation), copy.failed(copy.boards.levels, copy.problems["not-set-up"])].join("\n")
		);
		expect(mocks.emitFor).toHaveBeenCalledWith(expect.anything(), "g1", "powerup.toggle", expect.objectContaining({ detail: copy.auditSomeFailed([copy.boards.levels]) }));
	});

	it("reports a refused post on both boards", async () => {
		const { channel, send } = deletedBoardsChannel();
		send.mockRejectedValue(new Error("Missing Permissions"));
		const content = await pressRefresh(press(channel));

		expect(content).toBe(
			[copy.failed(copy.boards.participation, copy.problems["post-failed"]), copy.failed(copy.boards.levels, copy.problems["post-failed"])].join("\n")
		);
	});
});
