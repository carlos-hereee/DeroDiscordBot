import { describe, it, expect, vi, beforeEach } from "vitest";
import { AttachmentBuilder, DiscordAPIError, type Client } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { weeklyDigestSentEvent } from "@base/constants/BOT_LOG_EVENTS.js";

// ── weeklyDigest ───────────────────────────────────────────────────────────
// The digest DMs people who did not ask for a message, so the cases that matter
// most are the ones that stop it: a week already claimed, a guild that switched
// announcements off, a member who closed DMs. Then the card and its fallback
// embed, and the Monday 9 am Central schedule.

const mocks = vi.hoisted(() => ({
	getLevelingConfig: vi.fn(),
	botLogHas: vi.fn(),
	botLogLog: vi.fn(),
	topInPeriod: vi.fn(),
	statsForPeriod: vi.fn(),
	rankInPeriod: vi.fn(),
	findManyInGuild: vi.fn(),
	renderWeeklyDigestCard: vi.fn(),
	schedule: vi.fn(),
}));

vi.mock("./levelingConfig.js", () => ({ getLevelingConfig: mocks.getLevelingConfig }));
vi.mock("@db/stores/botLogStore.js", () => ({ botLogStore: { has: mocks.botLogHas, log: mocks.botLogLog } }));
vi.mock("@db/stores/xpPeriodStore.js", () => ({
	xpPeriodStore: { topInPeriod: mocks.topInPeriod, statsForPeriod: mocks.statsForPeriod, rankInPeriod: mocks.rankInPeriod },
}));
vi.mock("@db/stores/memberLevelStore.js", () => ({ memberLevelStore: { findManyInGuild: mocks.findManyInGuild } }));
vi.mock("./weeklyDigestRenderer.js", () => ({ WEEKLY_DIGEST_AVATAR_SIZE: 128, renderWeeklyDigestCard: mocks.renderWeeklyDigestCard }));
vi.mock("node-cron", () => ({ default: { schedule: mocks.schedule } }));

import { runWeeklyDigest, startWeeklyDigest, type WeeklyDigestDeps } from "./weeklyDigest.js";
import { weekKey } from "./levelPeriod.js";

// Monday 26 October 2026, 9 am Central (CDT, UTC minus 5).
const MONDAY_NINE_CENTRAL = new Date("2026-10-26T14:00:00Z");
const RECAPPED_WEEK = weekKey(new Date("2026-10-19T14:00:00Z"), "sunday");

const context = (overrides: Record<string, unknown> = {}) => ({
	settings: { enabled: true, curve: "dero", curveMultiplier: 1, maxLevel: null, announceMode: "announcements", ...overrides },
	weekStart: "sunday",
	homebaseDestroyed: false,
});

type DmPayload = { embeds: Array<{ data: { image?: { url: string }; title?: string; description?: string } }>; files?: AttachmentBuilder[] };

function member(id: string, options: { bot?: boolean; send?: ReturnType<typeof vi.fn> } = {}) {
	return {
		id,
		displayName: `Member ${id}`,
		user: { id, bot: options.bot ?? false, avatar: null, displayAvatarURL: () => "https://cdn.discordapp.com/embed/avatars/0.png" },
		send: options.send ?? vi.fn(async () => undefined),
	};
}

function rig(members: ReturnType<typeof member>[]) {
	const cache = new Map(members.map((entry) => [entry.id, entry]));
	const guild = { id: "g1", name: "Kingdom 1234", members: { cache, fetch: vi.fn(async () => null) } };
	const client = { guilds: { cache: new Map([["g1", guild]]) } } as unknown as Client;
	const sleep = vi.fn(async () => undefined);
	const deps: WeeklyDigestDeps = { sleep, now: () => MONDAY_NINE_CENTRAL };
	return { client, deps, sleep };
}

const dmOf = (entry: ReturnType<typeof member>): DmPayload => (entry.send.mock.calls[0] as unknown as [DmPayload])[0];

beforeEach(() => {
	mocks.getLevelingConfig.mockReset().mockResolvedValue(context());
	mocks.botLogHas.mockReset().mockResolvedValue(false);
	mocks.botLogLog.mockReset().mockResolvedValue(undefined);
	mocks.topInPeriod.mockReset().mockResolvedValue([
		{ userId: "u1", xp: 900 },
		{ userId: "u2", xp: 400 },
	]);
	mocks.statsForPeriod.mockReset().mockResolvedValue({ activeMembers: 40, totalXp: 5000 });
	mocks.rankInPeriod.mockReset().mockImplementation(async (_guildId: string, _period: string, xp: number) => (xp === 900 ? 1 : 2));
	mocks.findManyInGuild.mockReset().mockResolvedValue([
		{ userId: "u1", totalXp: 630 },
		{ userId: "u2", totalXp: 151 },
	]);
	mocks.renderWeeklyDigestCard.mockReset().mockResolvedValue(null);
	mocks.schedule.mockReset().mockReturnValue({ stop: vi.fn() });
});

describe("runWeeklyDigest", () => {
	it("recaps the week that just ended, claiming it before the first DM", async () => {
		const u1 = member("u1");
		const u2 = member("u2");
		const { client, deps } = rig([u1, u2]);

		const [outcome] = await runWeeklyDigest(client, deps);

		expect(mocks.botLogLog).toHaveBeenCalledWith("g1", weeklyDigestSentEvent(RECAPPED_WEEK), { period: RECAPPED_WEEK });
		expect(mocks.botLogLog.mock.invocationCallOrder[0]).toBeLessThan(u1.send.mock.invocationCallOrder[0]);
		expect(mocks.topInPeriod).toHaveBeenCalledWith("g1", RECAPPED_WEEK, BOT_CONSTANTS.LEVELING.WEEKLY_DIGEST_MAX_MEMBERS);
		expect(outcome).toEqual({ guildId: "g1", status: "sent", sent: 2, closedDms: 0 });
	});

	it("sends each member their own numbers as the digest embed when the card does not draw", async () => {
		const u1 = member("u1");
		const { client, deps } = rig([u1, member("u2")]);

		await runWeeklyDigest(client, deps);

		const dm = dmOf(u1);
		expect(dm.files).toBeUndefined();
		expect(dm.embeds[0].data.title).toBe("Your week in Kingdom 1234");
		expect(dm.embeds[0].data.description).toContain("900 XP");
		expect(dm.embeds[0].data.description).toContain("#1");
		expect(dm.embeds[0].data.description).toContain("40 active members");
		// dero curve: 630 total xp is level 4.
		expect(mocks.renderWeeklyDigestCard).toHaveBeenCalledWith(
			expect.objectContaining({ weekXp: 900, weekRank: 1, activeMembers: 40, level: 4, guildName: "Kingdom 1234" })
		);
	});

	it("sends the card as the embed's image when it draws", async () => {
		const attachment = new AttachmentBuilder(Buffer.from("png"), { name: "weekly-digest-abc.png" });
		mocks.renderWeeklyDigestCard.mockResolvedValue({ attachment, ref: "attachment://weekly-digest-abc.png" });
		const u1 = member("u1");
		const { client, deps } = rig([u1, member("u2")]);

		await runWeeklyDigest(client, deps);

		expect(dmOf(u1).files).toEqual([attachment]);
		expect(dmOf(u1).embeds[0].data.image?.url).toBe("attachment://weekly-digest-abc.png");
	});

	it("paces the DMs, one pause after each", async () => {
		const { client, deps, sleep } = rig([member("u1"), member("u2")]);
		await runWeeklyDigest(client, deps);
		expect(sleep).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledWith(BOT_CONSTANTS.LEVELING.WEEKLY_DIGEST_DM_SPACING_MS);
	});

	it("never DMs a week twice: a claimed week sends nothing", async () => {
		mocks.botLogHas.mockResolvedValue(true);
		const u1 = member("u1");
		const { client, deps } = rig([u1]);

		const [outcome] = await runWeeklyDigest(client, deps);

		expect(outcome.status).toBe("alreadySent");
		expect(u1.send).not.toHaveBeenCalled();
		expect(mocks.botLogLog).not.toHaveBeenCalled();
	});

	it.each([
		["announcements are switched off", { announceMode: "off" }],
		["leveling is switched off", { enabled: false }],
	])("sends nothing and claims nothing when %s", async (_label, overrides) => {
		mocks.getLevelingConfig.mockResolvedValue(context(overrides));
		const u1 = member("u1");
		const { client, deps } = rig([u1]);

		const [outcome] = await runWeeklyDigest(client, deps);

		expect(outcome.status).toBe("skipped");
		expect(u1.send).not.toHaveBeenCalled();
		expect(mocks.botLogLog).not.toHaveBeenCalled();
	});

	it("counts a member with closed DMs and carries on to the next", async () => {
		const closed = Object.assign(Object.create(DiscordAPIError.prototype) as DiscordAPIError, { code: 50007 });
		const u1 = member("u1", { send: vi.fn(async () => Promise.reject(closed)) });
		const u2 = member("u2");
		const { client, deps } = rig([u1, u2]);

		const [outcome] = await runWeeklyDigest(client, deps);

		expect(outcome).toEqual({ guildId: "g1", status: "sent", sent: 1, closedDms: 1 });
		expect(u2.send).toHaveBeenCalledTimes(1);
	});

	it("skips a member who left and a bot, and anyone with no XP that week", async () => {
		mocks.topInPeriod.mockResolvedValue([
			{ userId: "u1", xp: 900 },
			{ userId: "bot", xp: 300 },
			{ userId: "gone", xp: 200 },
			{ userId: "u2", xp: 0 },
		]);
		const u1 = member("u1");
		const bot = member("bot", { bot: true });
		const u2 = member("u2");
		const { client, deps } = rig([u1, bot, u2]);

		const [outcome] = await runWeeklyDigest(client, deps);

		expect(outcome.sent).toBe(1);
		expect(bot.send).not.toHaveBeenCalled();
		expect(u2.send).not.toHaveBeenCalled();
	});

	it("logs and moves on when one guild's pass throws", async () => {
		mocks.getLevelingConfig.mockRejectedValue(new Error("simulated config read failure"));
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const { client, deps } = rig([member("u1")]);

		await expect(runWeeklyDigest(client, deps)).resolves.toEqual([{ guildId: "g1", status: "failed", sent: 0, closedDms: 0 }]);
	});
});

describe("startWeeklyDigest", () => {
	it("schedules Monday at 9 am in Central time, never overlapping itself", () => {
		const { client } = rig([]);
		const handle = startWeeklyDigest(client);

		expect(mocks.schedule).toHaveBeenCalledWith("0 9 * * 1", expect.any(Function), expect.objectContaining({ timezone: "America/Chicago", noOverlap: true }));
		handle.stop();
		const task = mocks.schedule.mock.results[0].value as { stop: ReturnType<typeof vi.fn> };
		expect(task.stop).toHaveBeenCalledTimes(1);
	});
});
