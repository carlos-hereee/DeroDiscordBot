import { describe, it, expect, vi, beforeEach } from "vitest";
import { AttachmentBuilder, type ChatInputCommandInteraction } from "discord.js";

// ── /account, the card and its fallback ────────────────────────────────────
// 2026-10 item 243 Phase 2 puts a rendered card in front of the text profile.
// What is pinned here is the wire: the card posts as an attachment the reply's
// embed points at, and whenever the renderer answers null or throws, the reply
// is exactly the text profile it always was, with no files. The stores and the
// renderer are mocked, so this exercises the command and nothing below it.

const mocks = vi.hoisted(() => ({
	getLevelingConfig: vi.fn(),
	findOne: vi.fn(),
	countInGuild: vi.fn(),
	rankOf: vi.fn(),
	periodFindOne: vi.fn(),
	rankInPeriod: vi.fn(),
	reconcileRewards: vi.fn(),
	renderAccountCard: vi.fn(),
}));

vi.mock("@features/leveling/levelingConfig.js", () => ({ getLevelingConfig: mocks.getLevelingConfig }));
vi.mock("@db/stores/memberLevelStore.js", () => ({
	memberLevelStore: { findOne: mocks.findOne, countInGuild: mocks.countInGuild, rankOf: mocks.rankOf },
}));
vi.mock("@db/stores/xpPeriodStore.js", () => ({
	xpPeriodStore: { findOne: mocks.periodFindOne, rankInPeriod: mocks.rankInPeriod },
}));
vi.mock("@features/leveling/roleRewards.js", () => ({ reconcileRewards: mocks.reconcileRewards }));
vi.mock("@features/leveling/accountRenderer.js", () => ({ ACCOUNT_AVATAR_SIZE: 256, renderAccountCard: mocks.renderAccountCard }));

import { execute } from "./account.js";

type ReplyPayload = { embeds: Array<{ data: { title?: string; image?: { url: string }; fields?: unknown[] } }>; files?: AttachmentBuilder[] };

const USER = {
	id: "u1",
	bot: false,
	avatar: "a1",
	username: "silent",
	globalName: "Silent",
	displayAvatarURL: (options?: { size?: number }) => `https://cdn.discordapp.com/avatars/1/a1.png?size=${options?.size ?? 128}`,
};

function interaction(): { interaction: ChatInputCommandInteraction; editReply: ReturnType<typeof vi.fn> } {
	const editReply = vi.fn(async () => undefined);
	const fake = {
		guildId: "g1",
		user: USER,
		options: { getUser: () => null },
		guild: { members: { cache: new Map([["u1", { displayName: "Silent Warrior" }]]) } },
		client: {},
		deferReply: vi.fn(async () => undefined),
		reply: vi.fn(async () => undefined),
		editReply,
	};
	return { interaction: fake as unknown as ChatInputCommandInteraction, editReply };
}

beforeEach(() => {
	mocks.getLevelingConfig.mockReset().mockResolvedValue({
		settings: { curve: "dero", curveMultiplier: 1, maxLevel: null, milestoneMode: "prime" },
		weekStart: "sunday",
	});
	mocks.findOne.mockReset().mockResolvedValue({ totalXp: 964, messages: 10, reactionsGiven: 2, voiceMinutes: 5, games: undefined, unlocked: [] });
	mocks.countInGuild.mockReset().mockResolvedValue(12);
	mocks.rankOf.mockReset().mockResolvedValue(3);
	mocks.periodFindOne.mockReset().mockResolvedValue(null);
	mocks.rankInPeriod.mockReset().mockResolvedValue(1);
	mocks.reconcileRewards.mockReset().mockResolvedValue(null);
	mocks.renderAccountCard.mockReset().mockResolvedValue(null);
});

describe("/account", () => {
	it("replies with the TEXT profile and no files when the renderer answers null", async () => {
		const { interaction: command, editReply } = interaction();

		await execute(command);

		const payload = editReply.mock.calls[0][0] as ReplyPayload;
		expect(payload.files).toBeUndefined();
		expect(payload.embeds[0].data.title).toBe("Silent Warrior");
		expect(payload.embeds[0].data.fields?.length).toBeGreaterThan(0);
	});

	it("replies with the TEXT profile when the renderer throws", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		mocks.renderAccountCard.mockRejectedValue(new Error("draw failed"));
		const { interaction: command, editReply } = interaction();

		await execute(command);

		const payload = editReply.mock.calls[0][0] as ReplyPayload;
		expect(payload.files).toBeUndefined();
		expect(payload.embeds[0].data.fields?.length).toBeGreaterThan(0);
	});

	it("replies with the card as an attachment the embed points at", async () => {
		const attachment = new AttachmentBuilder(Buffer.from("png"), { name: "account-abc.png" });
		mocks.renderAccountCard.mockResolvedValue({ attachment, ref: "attachment://account-abc.png" });
		const { interaction: command, editReply } = interaction();

		await execute(command);

		const payload = editReply.mock.calls[0][0] as ReplyPayload;
		expect(payload.files).toEqual([attachment]);
		expect(payload.embeds[0].data.image?.url).toBe("attachment://account-abc.png");
		expect(payload.embeds[0].data.title).toBe("Silent Warrior");
	});

	it("hands the renderer the member's avatar request at the card's size", async () => {
		const { interaction: command } = interaction();

		await execute(command);

		expect(mocks.renderAccountCard).toHaveBeenCalledWith(
			expect.objectContaining({
				level: 5,
				guildRank: 3,
				avatar: { userId: "u1", avatarHash: "a1", size: 256, url: "https://cdn.discordapp.com/avatars/1/a1.png?size=256" },
			})
		);
	});

	it("still reconciles reward roles after the reply, whichever path it took", async () => {
		const { interaction: command } = interaction();
		await execute(command);
		expect(mocks.reconcileRewards).toHaveBeenCalledWith(expect.anything(), "g1", "u1", 5);
	});
});
