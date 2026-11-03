import { describe, it, expect, vi, beforeEach } from "vitest";
import { AttachmentBuilder, TextChannel, type Client } from "discord.js";
import { arcadeMonthlyPostEvent } from "@base/constants/BOT_LOG_EVENTS.js";

// ── monthlyArcadePost ──────────────────────────────────────────────────────
// The post goes to a channel nobody asked to hear from today, so the cases that
// matter most are the ones that stop it: the admin's off switch, a month already
// claimed, a month with nothing to show, a channel that is gone. Then the card and
// its text fallback, and the claim landing before the send.

const mocks = vi.hoisted(() => ({
	findByGuildId: vi.fn(),
	botLogHas: vi.fn(),
	botLogLog: vi.fn(),
	topWinningHands: vi.fn(),
	topRatedInGuild: vi.fn(),
	luckBoardInGuild: vi.fn(),
	renderCard: vi.fn(),
}));

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findByGuildId } }));
vi.mock("@db/stores/botLogStore.js", () => ({ botLogStore: { has: mocks.botLogHas, log: mocks.botLogLog } }));
vi.mock("./ratingBoards.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./ratingBoards.js")>()),
	topWinningHands: mocks.topWinningHands,
	topRatedInGuild: mocks.topRatedInGuild,
	luckBoardInGuild: mocks.luckBoardInGuild,
}));
vi.mock("./arcadeMonthlyRenderer.js", () => ({ renderArcadeMonthlyCard: mocks.renderCard }));
vi.mock("./memberNames.js", () => ({ memberNameResolver: () => async () => new Map() }));

import { runMonthlyArcadePost } from "./monthlyArcadePost.js";

// 1 November 2026, 9:05 am Central (CDT, UTC minus 5): the run that posts October.
const FIRST_OF_NOVEMBER = new Date("2026-11-01T14:05:00Z");
const OCTOBER = arcadeMonthlyPostEvent("2026-10");

type SentPayload = {
	embeds: Array<{ data: { title?: string; description?: string; image?: { url: string }; fields?: Array<{ name: string; value: string }> } }>;
	files?: AttachmentBuilder[];
};

const config = (overrides: Record<string, unknown> = {}) => ({
	guildId: "g1",
	leaderboardChannelId: "lb-1",
	homebaseDestroyed: false,
	arcadeMonthlyPost: true,
	pluginId: "rok-commander",
	...overrides,
});

const player = (userId: string, displayRating: number, provisional: boolean) => ({
	userId,
	displayName: `Name ${userId}`,
	displayRating,
	ratedGames: provisional ? 3 : 14,
	provisional,
});

// A real TextChannel prototype, so the module's instanceof check passes, with a fake send.
function leaderboardChannel() {
	const channel = Object.create(TextChannel.prototype) as TextChannel & { send: ReturnType<typeof vi.fn> };
	Object.defineProperty(channel, "send", { value: vi.fn(async () => undefined) });
	return channel;
}

function rig(guildIds: string[] = ["g1"]) {
	const channel = leaderboardChannel();
	const guilds = new Map(guildIds.map((id) => [id, { id, name: `Kingdom ${id}` }]));
	const fetchChannel = vi.fn(async () => channel);
	const client = { guilds: { cache: guilds }, channels: { fetch: fetchChannel } } as unknown as Client;
	return { client, channel, fetchChannel };
}

const sentPayload = (channel: ReturnType<typeof leaderboardChannel>): SentPayload => (channel.send.mock.calls[0] as unknown as [SentPayload])[0];

beforeEach(() => {
	mocks.findByGuildId.mockReset().mockResolvedValue(config());
	mocks.botLogHas.mockReset().mockResolvedValue(false);
	mocks.botLogLog.mockReset().mockResolvedValue(undefined);
	mocks.topWinningHands.mockReset().mockResolvedValue([
		{ phrase: "pair of aces", count: 6 },
		{ phrase: "kings full", count: 2 },
	]);
	mocks.topRatedInGuild.mockReset().mockImplementation(async ({ game }: { game: string }) => {
		if (game === "holdem") return [player("h1", 1180, false)];
		if (game === "battleship") return [player("b1", 1095, true)];
		return [];
	});
	mocks.luckBoardInGuild.mockReset().mockResolvedValue([{ userId: "l1", displayName: "Name l1", decided: 24, wins: 18, score: 6 }]);
	mocks.renderCard.mockReset().mockResolvedValue(null);
});

describe("runMonthlyArcadePost", () => {
	it("posts last month's card in the leaderboard channel, claiming the month before it sends", async () => {
		const attachment = new AttachmentBuilder(Buffer.from("png"), { name: "arcade-monthly.png" });
		mocks.renderCard.mockResolvedValue({ attachment, ref: "attachment://arcade-monthly.png" });
		const { client, channel, fetchChannel } = rig();

		const outcomes = await runMonthlyArcadePost(client, FIRST_OF_NOVEMBER);

		expect(outcomes).toEqual([{ guildId: "g1", status: "posted", usedCard: true }]);
		expect(fetchChannel).toHaveBeenCalledWith("lb-1");
		expect(mocks.topWinningHands).toHaveBeenCalledWith(expect.objectContaining({ guildId: "g1", month: "2026-10", limit: 3 }));
		// Every rated game is read for October's players only.
		expect(mocks.topRatedInGuild).toHaveBeenCalledTimes(4);
		expect(mocks.topRatedInGuild).toHaveBeenCalledWith(
			expect.objectContaining({ finishedBetween: { start: new Date("2026-10-01T00:00:00Z"), end: new Date("2026-11-01T00:00:00Z") } })
		);
		expect(mocks.botLogLog).toHaveBeenCalledWith("g1", OCTOBER, { month: "2026-10" });
		expect(mocks.botLogLog.mock.invocationCallOrder[0]).toBeLessThan(channel.send.mock.invocationCallOrder[0]);

		const sent = sentPayload(channel);
		expect(sent.files).toEqual([attachment]);
		expect(sent.embeds[0].data.image?.url).toBe("attachment://arcade-monthly.png");
		expect(sent.embeds[0].data.title).toBe("📜 The arcade in October 2026");
		// The card carries the board; the embed beside it does not repeat it.
		expect(sent.embeds[0].data.fields).toBeUndefined();
	});

	it("hands the card the guild's words: hands, the top rated with the provisional mark, and the luckiest", async () => {
		const { client } = rig();
		await runMonthlyArcadePost(client, FIRST_OF_NOVEMBER);

		const view = mocks.renderCard.mock.calls[0][0];
		expect(view.guildName).toBe("Kingdom g1");
		expect(view.sections.map((section: { heading: string }) => section.heading)).toEqual(["Top winning hands", "Top rated", "Luckiest"]);
		expect(view.sections[0].rows).toEqual([
			{ lead: "pair of aces", detail: "won 6 showdowns" },
			{ lead: "kings full", detail: "won 2 showdowns" },
		]);
		expect(view.sections[1].rows).toEqual([
			{ lead: "Name h1", detail: "Texas hold em, rated 1180" },
			{ lead: "Name b1", detail: "Battleship, rated 1095?" },
		]);
		expect(view.sections[2].rows).toEqual([{ lead: "Name l1", detail: "+6 above even, 18 of 24 won" }]);
		expect(view.note).toContain("fewer than 10 rated games");
	});

	it("posts the text embed when the card does not draw", async () => {
		const { client, channel } = rig();

		const outcomes = await runMonthlyArcadePost(client, FIRST_OF_NOVEMBER);

		expect(outcomes).toEqual([{ guildId: "g1", status: "posted", usedCard: false }]);
		const sent = sentPayload(channel);
		expect(sent.files).toBeUndefined();
		expect(sent.embeds[0].data.image).toBeUndefined();
		const fields = sent.embeds[0].data.fields ?? [];
		expect(fields.map((field) => field.name)).toEqual(["Top winning hands", "Top rated", "Luckiest"]);
		expect(fields[0].value).toBe("**pair of aces**, won 6 showdowns\n**kings full**, won 2 showdowns");
		expect(fields[1].value).toContain("**Name b1**, Battleship, rated 1095?");
		expect(sent.embeds[0].data.description).toContain("fewer than 10 rated games");
	});

	it("shows a section's empty line rather than dropping the section", async () => {
		mocks.topWinningHands.mockResolvedValue([]);
		mocks.luckBoardInGuild.mockResolvedValue([]);
		const { client, channel } = rig();

		await runMonthlyArcadePost(client, FIRST_OF_NOVEMBER);

		const fields = sentPayload(channel).embeds[0].data.fields ?? [];
		expect(fields[0].value).toBe("No Hold'em hand reached a showdown.");
		expect(fields[2].value).toBe("Nobody reached 20 decided games of chance.");
	});

	it("is skipped, with nothing read, claimed or sent, when the admin switched it off", async () => {
		mocks.findByGuildId.mockResolvedValue(config({ arcadeMonthlyPost: false }));
		const { client, channel } = rig();

		expect(await runMonthlyArcadePost(client, FIRST_OF_NOVEMBER)).toEqual([{ guildId: "g1", status: "off", usedCard: undefined }]);
		expect(mocks.topWinningHands).not.toHaveBeenCalled();
		expect(mocks.botLogLog).not.toHaveBeenCalled();
		expect(channel.send).not.toHaveBeenCalled();
	});

	it("never posts a month twice", async () => {
		mocks.botLogHas.mockResolvedValue(true);
		const { client, channel } = rig();

		expect((await runMonthlyArcadePost(client, FIRST_OF_NOVEMBER))[0].status).toBe("already-posted");
		expect(mocks.botLogHas).toHaveBeenCalledWith("g1", OCTOBER);
		expect(channel.send).not.toHaveBeenCalled();
	});

	it("stays quiet, and claims nothing, for a month with nothing to show", async () => {
		mocks.topWinningHands.mockResolvedValue([]);
		mocks.topRatedInGuild.mockResolvedValue([]);
		mocks.luckBoardInGuild.mockResolvedValue([]);
		const { client, channel } = rig();

		expect((await runMonthlyArcadePost(client, FIRST_OF_NOVEMBER))[0].status).toBe("nothing-to-show");
		expect(mocks.botLogLog).not.toHaveBeenCalled();
		expect(channel.send).not.toHaveBeenCalled();
	});

	it("skips a guild with no config, a destroyed homebase, or an unreachable channel, without claiming", async () => {
		const { client, fetchChannel } = rig(["a", "b", "c"]);
		mocks.findByGuildId.mockImplementation(async (guildId: string) => {
			if (guildId === "a") return null;
			if (guildId === "b") return config({ homebaseDestroyed: true });
			return config();
		});
		fetchChannel.mockResolvedValue(null as unknown as TextChannel);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		const statuses = (await runMonthlyArcadePost(client, FIRST_OF_NOVEMBER)).map((outcome) => outcome.status);

		expect(statuses).toEqual(["no-config", "no-config", "no-channel"]);
		expect(mocks.botLogLog).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	it("logs a failed send and moves on to the next guild", async () => {
		const { client, channel } = rig(["g1", "g2"]);
		channel.send.mockRejectedValueOnce(new Error("Missing Access"));
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

		const statuses = (await runMonthlyArcadePost(client, FIRST_OF_NOVEMBER)).map((outcome) => outcome.status);

		expect(statuses).toEqual(["failed", "posted"]);
		error.mockRestore();
	});

	it("posts December on the 1st of January", async () => {
		const { client } = rig();
		await runMonthlyArcadePost(client, new Date("2027-01-01T15:05:00Z"));
		expect(mocks.botLogHas).toHaveBeenCalledWith("g1", arcadeMonthlyPostEvent("2026-12"));
		expect(mocks.renderCard.mock.calls[0][0].title).toBe("📜 The arcade in December 2026");
	});
});

describe("the hand triggered preview (ARCADE_MONTHLY_POST_RUN_ON_BOOT)", () => {
	// 23 October 2026: a test guild wants to see the post now, with October so far.
	const MID_OCTOBER = new Date("2026-10-23T17:00:00Z");

	it("posts the current month so far, titled as such, and never reads or writes the claim", async () => {
		const { client, channel } = rig();

		const outcomes = await runMonthlyArcadePost(client, MID_OCTOBER, { preview: true });

		expect(outcomes).toEqual([{ guildId: "g1", status: "posted", usedCard: false }]);
		expect(mocks.topWinningHands).toHaveBeenCalledWith(expect.objectContaining({ month: "2026-10" }));
		expect(mocks.topRatedInGuild).toHaveBeenCalledWith(
			expect.objectContaining({ finishedBetween: { start: new Date("2026-10-01T00:00:00Z"), end: new Date("2026-11-01T00:00:00Z") } })
		);
		expect(sentPayload(channel).embeds[0].data.title).toBe("📜 The arcade in October 2026, so far");
		// No claim either way, so the real post on 1 November still goes out.
		expect(mocks.botLogHas).not.toHaveBeenCalled();
		expect(mocks.botLogLog).not.toHaveBeenCalled();
	});

	it("posts again on a second boot, because it claims nothing", async () => {
		const { client, channel } = rig();
		await runMonthlyArcadePost(client, MID_OCTOBER, { preview: true });
		await runMonthlyArcadePost(client, MID_OCTOBER, { preview: true });
		expect(channel.send).toHaveBeenCalledTimes(2);
	});

	it("still honors the admin's off switch and a month with nothing to show", async () => {
		const { client, channel } = rig(["off", "empty"]);
		mocks.findByGuildId.mockImplementation(async (guildId: string) => config({ arcadeMonthlyPost: guildId !== "off" }));
		mocks.topWinningHands.mockResolvedValue([]);
		mocks.topRatedInGuild.mockResolvedValue([]);
		mocks.luckBoardInGuild.mockResolvedValue([]);

		const statuses = (await runMonthlyArcadePost(client, MID_OCTOBER, { preview: true })).map((outcome) => outcome.status);

		expect(statuses).toEqual(["off", "nothing-to-show"]);
		expect(channel.send).not.toHaveBeenCalled();
	});
});
