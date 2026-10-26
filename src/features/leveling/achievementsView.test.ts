import { describe, it, expect, vi, beforeEach } from "vitest";
import { AttachmentBuilder, type RepliableInteraction, type User } from "discord.js";

// ── the Achievements view, card and fallback (2026-10 item 254) ─────────────
// The command center's Achievements button and /account view:achievements answer
// with a drawn card, and with the text view whenever the card cannot draw. The
// store and the renderer are mocked, so this pins the wire and the hidden filter.

const mocks = vi.hoisted(() => ({
	getLevelingConfig: vi.fn(),
	findOne: vi.fn(),
	renderAchievementsCard: vi.fn(),
}));

vi.mock("@features/leveling/levelingConfig.js", () => ({ getLevelingConfig: mocks.getLevelingConfig }));
vi.mock("@db/stores/memberLevelStore.js", () => ({ memberLevelStore: { findOne: mocks.findOne } }));
vi.mock("@features/leveling/achievementsRenderer.js", () => ({ ACHIEVEMENTS_AVATAR_SIZE: 128, renderAchievementsCard: mocks.renderAchievementsCard }));

import { showAchievements } from "./achievementsView.js";
import { ACHIEVEMENTS } from "./achievements.js";

type ReplyPayload = { embeds: Array<{ data: { title?: string; image?: { url: string }; fields?: unknown[] } }>; files?: AttachmentBuilder[] };

const TARGET = { id: "u1", bot: false, avatar: "a1", username: "silent", globalName: "Silent", displayAvatarURL: () => "https://cdn.discordapp.com/avatars/u1/a1.png" } as unknown as User;
const VISIBLE_TRACK = ACHIEVEMENTS.find((track) => !track.hidden)!;

function press() {
	const editReply = vi.fn(async (_payload: unknown) => undefined);
	const interaction = {
		guildId: "g1",
		user: TARGET,
		guild: { members: { cache: new Map([["u1", { displayName: "Silent Warrior" }]]) } },
		deferReply: vi.fn(async () => undefined),
		reply: vi.fn(async () => undefined),
		editReply,
	};
	return { interaction: interaction as unknown as RepliableInteraction, editReply };
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getLevelingConfig.mockResolvedValue({ settings: { curve: "dero", curveMultiplier: 1, maxLevel: null } });
	mocks.findOne.mockResolvedValue({
		totalXp: 964,
		messages: 60,
		reactionsGiven: 0,
		voiceMinutes: 0,
		unlocked: [{ id: VISIBLE_TRACK.id, tier: "bronze", at: new Date("2026-10-01T00:00:00Z"), earnedBy: "did the thing" }],
	});
});

describe("the Achievements view", () => {
	it("answers with the drawn card, handing it the held achievements and no hidden track in progress", async () => {
		const attachment = new AttachmentBuilder(Buffer.from("png"), { name: "achievements-abc.png" });
		mocks.renderAchievementsCard.mockResolvedValue({ attachment, ref: "attachment://achievements-abc.png" });
		const { interaction, editReply } = press();

		await showAchievements(interaction, { target: TARGET, isPrivate: true });

		const view = mocks.renderAchievementsCard.mock.calls[0]![0] as { displayName: string; unlocked: Array<{ id: string }>; inProgress: Array<{ id: string }> };
		expect(view.displayName).toBe("Silent Warrior");
		expect(view.unlocked.map((unlock) => unlock.id)).toEqual([VISIBLE_TRACK.id]);
		const hiddenIds = new Set(ACHIEVEMENTS.filter((track) => track.hidden).map((track) => track.id));
		expect(view.inProgress.some((row) => hiddenIds.has(row.id))).toBe(false);

		const payload = editReply.mock.calls[0]![0] as ReplyPayload;
		expect(payload.files).toEqual([attachment]);
		expect(payload.embeds[0]!.data.image?.url).toBe("attachment://achievements-abc.png");
		expect(payload.embeds[0]!.data.fields ?? []).toEqual([]);
	});

	it("answers with the text view when the card cannot draw", async () => {
		mocks.renderAchievementsCard.mockResolvedValue(null);
		const { interaction, editReply } = press();

		await showAchievements(interaction, { target: TARGET, isPrivate: true });

		const payload = editReply.mock.calls[0]![0] as ReplyPayload;
		expect(payload.files).toBeUndefined();
		expect(payload.embeds[0]!.data.fields?.length).toBeGreaterThan(0);
	});
});
