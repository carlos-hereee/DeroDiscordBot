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
	luckForMember: vi.fn(),
	findConfig: vi.fn(),
	findWallet: vi.fn(),
	findCoinWallet: vi.fn(),
	buffState: vi.fn(),
}));

vi.mock("@features/leveling/levelingConfig.js", () => ({ getLevelingConfig: mocks.getLevelingConfig }));
vi.mock("@db/stores/memberLevelStore.js", () => ({
	memberLevelStore: { findOne: mocks.findOne, countInGuild: mocks.countInGuild, rankOf: mocks.rankOf },
}));
vi.mock("@db/stores/xpPeriodStore.js", () => ({
	xpPeriodStore: { findOne: mocks.periodFindOne, rankInPeriod: mocks.rankInPeriod },
}));
vi.mock("@db/stores/luckStatStore.js", () => ({ luckStatStore: { findForMember: mocks.luckForMember } }));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findConfig } }));
vi.mock("@db/stores/chipWalletStore.js", () => ({ chipWalletStore: { findOne: mocks.findWallet } }));
vi.mock("@db/stores/deroCoinStore.js", () => ({ deroCoinStore: { findWallet: mocks.findCoinWallet } }));
vi.mock("@db/stores/fortuneBuffStore.js", () => ({ fortuneBuffStore: { stateFor: mocks.buffState } }));
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
		// view and window read null, the defaults: the profile, as /account always showed.
		options: { getUser: () => null, getString: () => null },
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
	mocks.luckForMember.mockReset().mockResolvedValue([]);
	mocks.findConfig.mockReset().mockResolvedValue({ chipEconomyEnabled: true });
	mocks.findWallet.mockReset().mockResolvedValue(null);
	mocks.findCoinWallet.mockReset().mockResolvedValue(null);
	mocks.buffState.mockReset().mockResolvedValue({ weight: undefined, dryStreak: 0 });
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

	// 2026-10 item 254: the card draws the per game record, the month's luck and the
	// chips, so its embed carries no data in text; the text profile keeps them all.
	it("hands the record, the luck and the chips to the card, and leaves none of them in the card's embed", async () => {
		mocks.findOne.mockResolvedValue({
			totalXp: 964,
			messages: 10,
			reactionsGiven: 2,
			voiceMinutes: 5,
			games: new Map([["rps", { played: 4, won: 3, lost: 1, drawn: 0, assists: 0 }]]),
			unlocked: [],
		});
		mocks.luckForMember.mockResolvedValue([
			{ guildId: "g1", userId: "u1", game: "coinflip", month: "2026-10", decided: 12, wins: 8 },
			{ guildId: "g1", userId: "u1", game: "rps", month: "2026-10", decided: 10, wins: 6 },
		]);
		mocks.renderAccountCard.mockResolvedValue({ attachment: new AttachmentBuilder(Buffer.from("png"), { name: "a.png" }), ref: "attachment://a.png" });
		const { interaction: command, editReply } = interaction();

		await execute(command);

		expect(mocks.renderAccountCard).toHaveBeenCalledWith(
			expect.objectContaining({
				games: [{ slug: "rps", record: { played: 4, won: 3, lost: 1, drawn: 0, assists: 0 } }],
				luck: expect.objectContaining({ wins: 14, decided: 22 }),
				chips: expect.objectContaining({ balance: 0 }),
				coins: 0,
				luckBoost: null,
			})
		);
		expect((editReply.mock.calls[0][0] as ReplyPayload).embeds[0].data.fields ?? []).toEqual([]);
		expect(mocks.luckForMember).toHaveBeenCalledWith("g1", "u1", expect.stringMatching(/^\d{4}-\d{2}$/));
	});

	// 2026-10 item 250 Phase 5: the magic 8 ball's readings ride the luck line and its score.
	it("names the month's magic 8 ball readings beside the luck games", async () => {
		mocks.luckForMember.mockResolvedValue([
			{ guildId: "g1", userId: "u1", game: "coinflip", month: "2026-10", decided: 20, wins: 10, points: 0 },
			{ guildId: "g1", userId: "u1", game: "fortune", month: "2026-10", decided: 6, wins: 0, points: 2 },
		]);
		const { interaction: command, editReply } = interaction();

		await execute(command);

		const fields = (editReply.mock.calls[0][0] as ReplyPayload).embeds[0].data.fields as Array<{ name: string; value: string }>;
		expect(fields.find((field) => field.name === "Luck this month")?.value).toBe("**10** won of **20** decided and **6** magic 8 ball readings, **2** above an even split.");
	});

	it("says no luck game was decided, and keeps the profile, when the luck read fails", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		mocks.luckForMember.mockRejectedValue(new Error("db down"));
		const { interaction: command, editReply } = interaction();

		await execute(command);

		const fields = (editReply.mock.calls[0][0] as ReplyPayload).embeds[0].data.fields as Array<{ name: string; value: string }>;
		expect(fields.find((field) => field.name === "Luck this month")?.value).toBe("No coin flip, dice or rps decided this month.");
	});

	// 2026-10 item 250 Phase 5: the chips line, beside the luck, completing Phase 4's scaffold.
	it("shows the member's chips and that their claim is ready", async () => {
		mocks.findWallet.mockResolvedValue({ guildId: "g1", userId: "u1", balance: 26_000, lastClaimAt: new Date("2020-01-01T00:00:00Z"), totalClaimed: 26_000 });
		const { interaction: command, editReply } = interaction();

		await execute(command);

		const fields = (editReply.mock.calls[0][0] as ReplyPayload).embeds[0].data.fields as Array<{ name: string; value: string }>;
		expect(fields.find((field) => field.name === "Currencies")?.value).toBe("Hold'em chips: **26,000** chips. Your claim is ready: `/claim`.\nDero coins: **0**");
		expect(mocks.findWallet).toHaveBeenCalledWith({ guildId: "g1", userId: "u1" });
	});

	// 2026-10 item 257 Phase 3a: with chips off the currencies say so, beside the global coins.
	it("says chips are off when the server switched them off, and still shows the Dero coins", async () => {
		mocks.findConfig.mockResolvedValue({ chipEconomyEnabled: false });
		mocks.findCoinWallet.mockResolvedValue({ userId: "u1", balance: 45, totalEarned: 45 });
		const { interaction: command, editReply } = interaction();

		await execute(command);

		const fields = (editReply.mock.calls[0][0] as ReplyPayload).embeds[0].data.fields as Array<{ name: string; value: string }>;
		expect(fields.find((field) => field.name === "Currencies")?.value).toBe("Hold'em chips: off in this server\nDero coins: **45**");
		expect(mocks.findWallet).not.toHaveBeenCalled();
		expect(mocks.findCoinWallet).toHaveBeenCalledWith("u1");
	});

	it("adds the secret code luck boost as its own line under the game luck", async () => {
		mocks.buffState.mockResolvedValue({ weight: 0.19, dryStreak: 0 });
		const { interaction: command, editReply } = interaction();

		await execute(command);

		const fields = (editReply.mock.calls[0][0] as ReplyPayload).embeds[0].data.fields as Array<{ name: string; value: string }>;
		expect(fields.find((field) => field.name === "Luck this month")?.value).toBe("No coin flip, dice or rps decided this month.\nLuck boost: **+16%** gold chance");
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
