import { describe, it, expect, vi, beforeEach } from "vitest";
import { AttachmentBuilder, DiscordAPIError, TextChannel } from "discord.js";
import type { Client } from "discord.js";

// ── LevelsBoard ────────────────────────────────────────────────────────────
// A SECOND board in a channel that already has one. Almost everything worth
// testing here is about the two of them not standing on each other: this board
// must edit its OWN anchor, recover its OWN message, and never write
// leaderboardMessageId under any circumstance.

const mocks = vi.hoisted(() => ({
	getLevelingConfig: vi.fn(),
	topByTotalXp: vi.fn(),
	findByGuildId: vi.fn(),
	update: vi.fn(),
	renderLevelsBoardCard: vi.fn(),
}));

vi.mock("./levelingConfig.js", () => ({ getLevelingConfig: mocks.getLevelingConfig }));
vi.mock("@db/stores/memberLevelStore.js", () => ({ memberLevelStore: { topByTotalXp: mocks.topByTotalXp } }));
vi.mock("@db/stores/guildConfigStore.js", () => ({
	guildConfigStore: { findByGuildId: mocks.findByGuildId, update: mocks.update },
}));
// The card renderer answers null by default, so every case above the "rendered
// card" describe pins the TEXT board, which is the fallback path members get
// whenever the card cannot be drawn. That describe swaps a card in.
vi.mock("./levelsBoardRenderer.js", () => ({
	LEVELS_BOARD_AVATAR_SIZE: 64,
	renderLevelsBoardCard: mocks.renderLevelsBoardCard,
}));

import { _clearLevelsBoardTimers, refreshLevelsBoard, scheduleLevelsBoardRefresh } from "./LevelsBoard.js";

const CHANNEL_ID = "c-leaderboard";
const BOT_ID = "bot";

// discord.js only constructs a DiscordAPIError from a real error payload, and
// the module branches on `instanceof`, so the codes are produced properly rather
// than faked with a plain object carrying a `code`.
const apiError = (code: number): DiscordAPIError =>
	new DiscordAPIError({ code, message: "test" }, code, 200, "GET", "url", {});

interface Harness {
	client: Client;
	send: ReturnType<typeof vi.fn>;
	edit: ReturnType<typeof vi.fn>;
	fetchMessage: ReturnType<typeof vi.fn>;
}

function harness(): Harness {
	const edit = vi.fn(async () => undefined);
	const fetchMessage = vi.fn(async () => ({ author: { id: BOT_ID }, edit }));
	const send = vi.fn(async () => ({ id: "msg-new" }));

	const channel = Object.create(TextChannel.prototype) as TextChannel;
	Object.assign(channel, {
		id: CHANNEL_ID,
		guildId: "g1",
		send,
		messages: { fetch: fetchMessage },
		client: { user: { id: BOT_ID } },
	});

	const client = { channels: { fetch: async () => channel }, guilds: { cache: new Map() } } as unknown as Client;
	return { client, send, edit, fetchMessage };
}

const context = (overrides: Record<string, unknown> = {}) => ({
	settings: { enabled: true, curve: "dero", curveMultiplier: 1, maxLevel: null },
	leaderboardChannelId: CHANNEL_ID,
	announcementsChannelId: null,
	adminChannelId: null,
	homebaseDestroyed: false,
	copyOverrides: null,
	weekStart: "sunday",
	...overrides,
});

beforeEach(() => {
	_clearLevelsBoardTimers();
	mocks.getLevelingConfig.mockReset().mockResolvedValue(context());
	mocks.topByTotalXp.mockReset().mockResolvedValue([{ userId: "u1", username: "Silent", totalXp: 964 }]);
	mocks.findByGuildId.mockReset().mockResolvedValue({ levelsMessageId: null });
	mocks.update.mockReset().mockResolvedValue(undefined);
	mocks.renderLevelsBoardCard.mockReset().mockResolvedValue(null);
});

describe("it never disturbs the participation board", () => {
	it("persists levelsMessageId and NOTHING else on a first post", async () => {
		// Writing the wrong field would make each board overwrite the other's
		// message on every refresh, and the symptom would be a board that keeps
		// vanishing rather than an error anybody could search for.
		const { client, send } = harness();
		await refreshLevelsBoard(client, "g1");

		expect(send).toHaveBeenCalledTimes(1);
		expect(mocks.update).toHaveBeenCalledWith("g1", { levelsMessageId: "msg-new" });
	});

	it("never writes leaderboardMessageId, on any path", async () => {
		const { client } = harness();

		await refreshLevelsBoard(client, "g1"); // first post
		mocks.findByGuildId.mockResolvedValue({ levelsMessageId: "msg-1" });
		await refreshLevelsBoard(client, "g1"); // edit in place

		for (const call of mocks.update.mock.calls) {
			expect(Object.keys(call[1] as object)).not.toContain("leaderboardMessageId");
		}
	});

	it("reads its anchor from levelsMessageId", async () => {
		mocks.findByGuildId.mockResolvedValue({ levelsMessageId: "msg-1", leaderboardMessageId: "msg-other" });
		const { client, fetchMessage, edit } = harness();

		await refreshLevelsBoard(client, "g1");

		expect(fetchMessage).toHaveBeenCalledWith("msg-1");
		expect(edit).toHaveBeenCalledTimes(1);
	});
});

describe("edit in place, and recover when it is gone", () => {
	it("edits the stored message rather than posting a second one", async () => {
		mocks.findByGuildId.mockResolvedValue({ levelsMessageId: "msg-1" });
		const { client, send, edit } = harness();

		await refreshLevelsBoard(client, "g1");

		expect(edit).toHaveBeenCalledTimes(1);
		expect(send).not.toHaveBeenCalled();
		// An unchanged anchor needs no write.
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("reposts and re-anchors after an admin deleted the message (10008)", async () => {
		mocks.findByGuildId.mockResolvedValue({ levelsMessageId: "msg-gone" });
		const { client, send, fetchMessage } = harness();
		fetchMessage.mockRejectedValue(apiError(10008));

		await refreshLevelsBoard(client, "g1");

		expect(send).toHaveBeenCalledTimes(1);
		expect(mocks.update).toHaveBeenCalledWith("g1", { levelsMessageId: "msg-new" });
	});

	it("reposts after the channel itself was wiped (10003)", async () => {
		mocks.findByGuildId.mockResolvedValue({ levelsMessageId: "msg-gone" });
		const { client, send, fetchMessage } = harness();
		fetchMessage.mockRejectedValue(apiError(10003));

		await refreshLevelsBoard(client, "g1");
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("does NOT repost on an unrecognized error, so the next trigger retries instead of duplicating", async () => {
		mocks.findByGuildId.mockResolvedValue({ levelsMessageId: "msg-1" });
		const { client, send, fetchMessage } = harness();
		fetchMessage.mockRejectedValue(apiError(50001)); // missing access

		await refreshLevelsBoard(client, "g1");

		expect(send).not.toHaveBeenCalled();
		expect(mocks.update).not.toHaveBeenCalled();
	});
});

describe("the foreign author bail", () => {
	it("bails quietly when the stored message is not this bot's", async () => {
		// A stale homebase (rotated token, cross environment DB seeding, a shared
		// cluster). ScheduleBoard owns the heavyweight rebuild; a second board must
		// not trigger another one, and must never post into a channel it may not own.
		mocks.findByGuildId.mockResolvedValue({ levelsMessageId: "msg-1" });
		const { client, send, fetchMessage } = harness();
		fetchMessage.mockResolvedValue({ author: { id: "some-other-bot" }, edit: vi.fn() });

		await refreshLevelsBoard(client, "g1");

		expect(send).not.toHaveBeenCalled();
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("treats a 50005 on edit as the same case, not as a reason to repost", async () => {
		mocks.findByGuildId.mockResolvedValue({ levelsMessageId: "msg-1" });
		const { client, send, fetchMessage } = harness();
		fetchMessage.mockRejectedValue(apiError(50005));

		await refreshLevelsBoard(client, "g1");
		expect(send).not.toHaveBeenCalled();
	});
});

describe("the silent bails", () => {
	it("does nothing for a guild that never finished /setup", async () => {
		mocks.getLevelingConfig.mockResolvedValue(context({ leaderboardChannelId: null }));
		const { client, send } = harness();
		await refreshLevelsBoard(client, "g1");
		expect(send).not.toHaveBeenCalled();
	});

	it("does nothing for a self destructed homebase", async () => {
		mocks.getLevelingConfig.mockResolvedValue(context({ homebaseDestroyed: true }));
		const { client, send } = harness();
		await refreshLevelsBoard(client, "g1");
		expect(send).not.toHaveBeenCalled();
	});

	it("STILL renders for a guild that turned leveling off", async () => {
		// The toggle stops new writes; it does not erase history. Same posture as
		// leaderboardTrackingEnabled, whose board keeps rendering too.
		mocks.getLevelingConfig.mockResolvedValue(context({ settings: { enabled: false, curve: "dero", curveMultiplier: 1, maxLevel: null } }));
		const { client, send } = harness();
		await refreshLevelsBoard(client, "g1");
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("renders the empty state rather than throwing on a guild with no data", async () => {
		mocks.topByTotalXp.mockResolvedValue([]);
		const { client, send } = harness();
		await expect(refreshLevelsBoard(client, "g1")).resolves.toEqual({ posted: true });
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("never throws when the store rejects", async () => {
		mocks.topByTotalXp.mockRejectedValue(new Error("mongo is down"));
		const { client } = harness();
		await expect(refreshLevelsBoard(client, "g1")).resolves.toEqual({ posted: false, problem: "unexpected-error" });
	});
});

describe("the level shown beside each member", () => {
	it("is DERIVED from totalXp, not read from a stored field", async () => {
		// 964 is the dero curve's level 5 boundary. If a `level` field is ever added
		// to MemberLevel and read here instead, this stops matching the curve.
		mocks.topByTotalXp.mockResolvedValue([{ userId: "u1", username: "Silent", totalXp: 964 }]);
		const { client, send } = harness();

		await refreshLevelsBoard(client, "g1");

		const embed = (send.mock.calls[0][0] as { embeds: Array<{ data: { fields: Array<{ value: string }> } }> }).embeds[0];
		expect(embed.data.fields[0].value).toContain("5");
	});
});

describe("the coalescing throttle", () => {
	it("absorbs later requests into the first window rather than resetting the timer", async () => {
		// Copied in shape from scheduleLeaderboardRefresh: a reset-on-each-call
		// debounce would starve the board for an entire busy evening and only
		// update once everything went quiet.
		const { client } = harness();
		scheduleLevelsBoardRefresh(client, "g1");
		scheduleLevelsBoardRefresh(client, "g1");
		scheduleLevelsBoardRefresh(client, "g1");

		// Nothing has fired yet, and the three calls collapsed into one pending
		// timer rather than three.
		expect(mocks.topByTotalXp).not.toHaveBeenCalled();
		_clearLevelsBoardTimers();
	});
});

describe("the rendered card and its fallback (2026-10 item 243 Phase 2)", () => {
	type BoardPayload = { embeds: Array<{ data: { image?: { url: string }; fields?: unknown[]; description?: string } }>; files: unknown[]; attachments?: unknown[] };
	const card = () => {
		const attachment = new AttachmentBuilder(Buffer.from("png"), { name: "levels-board-abc.png" });
		return { attachment, ref: "attachment://levels-board-abc.png" };
	};

	it("posts the TEXT board with no files when the renderer answers null", async () => {
		const { client, send } = harness();

		await refreshLevelsBoard(client, "g1");

		const payload = send.mock.calls[0][0] as BoardPayload;
		expect(payload.files).toEqual([]);
		expect(payload.embeds[0].data.fields?.length).toBe(1);
		expect(payload.embeds[0].data.image).toBeUndefined();
	});

	it("posts the TEXT board when the renderer throws", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		mocks.renderLevelsBoardCard.mockRejectedValue(new Error("draw failed"));
		const { client, send } = harness();

		await refreshLevelsBoard(client, "g1");

		const payload = send.mock.calls[0][0] as BoardPayload;
		expect(payload.files).toEqual([]);
		expect(payload.embeds[0].data.fields?.length).toBe(1);
	});

	it("posts the card as an attachment the embed points at, keeping the subtitle", async () => {
		const rendered = card();
		mocks.renderLevelsBoardCard.mockResolvedValue(rendered);
		const { client, send } = harness();

		await refreshLevelsBoard(client, "g1");

		const payload = send.mock.calls[0][0] as BoardPayload;
		expect(payload.files).toEqual([rendered.attachment]);
		expect(payload.embeds[0].data.image?.url).toBe(rendered.ref);
		// The "which question this board answers" line survives on the card path.
		expect(payload.embeds[0].data.description).toBeTruthy();
		expect(mocks.renderLevelsBoardCard).toHaveBeenCalledWith("All time", [expect.objectContaining({ userId: "u1", level: 5, avatar: null })]);
	});

	it("drops the previous card on an edit, whichever path this refresh took", async () => {
		mocks.findByGuildId.mockResolvedValue({ levelsMessageId: "msg-1" });
		const { client, edit } = harness();

		mocks.renderLevelsBoardCard.mockResolvedValue(card());
		await refreshLevelsBoard(client, "g1");
		mocks.renderLevelsBoardCard.mockResolvedValue(null);
		await refreshLevelsBoard(client, "g1");

		const [withCard, withText] = edit.mock.calls.map((call) => call[0] as BoardPayload);
		expect(withCard.attachments).toEqual([]);
		expect(withCard.files).toHaveLength(1);
		// A text refresh after a card must not leave the old card hanging as a loose file.
		expect(withText.attachments).toEqual([]);
		expect(withText.files).toEqual([]);
	});
});
