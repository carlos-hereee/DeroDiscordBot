import { describe, it, expect, vi, beforeEach } from "vitest";
import { AttachmentBuilder, type RepliableInteraction } from "discord.js";

// ── the Levels view, card and fallback (2026-10 item 254) ───────────────────
// The command center's Levels button and /account view:levels answer with the
// pinned board's own card, and with the text board whenever the card cannot draw.
// The stores and the renderer are mocked, so this pins the wire and nothing below.

const mocks = vi.hoisted(() => ({
	getLevelingConfig: vi.fn(),
	topByTotalXp: vi.fn(),
	renderLevelsBoardCard: vi.fn(),
	beginChannelAnswer: vi.fn(),
	send: vi.fn(async (_payload: unknown) => ({ channelId: "c-commands" })),
}));

// Every /account view posts in 💬dero-commands (2026-10 item 257 Phase 5): the helper is
// mocked, so the payload is read off its send and the audience off its call.
vi.mock("@utils/answerInChannel.js", () => ({ beginChannelAnswer: mocks.beginChannelAnswer }));
vi.mock("@features/leveling/levelingConfig.js", () => ({ getLevelingConfig: mocks.getLevelingConfig }));
vi.mock("@db/stores/memberLevelStore.js", () => ({ memberLevelStore: { topByTotalXp: mocks.topByTotalXp } }));
vi.mock("@db/stores/xpPeriodStore.js", () => ({ xpPeriodStore: {} }));
vi.mock("@features/leveling/levelsBoardRenderer.js", () => ({ LEVELS_BOARD_AVATAR_SIZE: 64, renderLevelsBoardCard: mocks.renderLevelsBoardCard }));

import { showLevelsStandings } from "./levelsStandings.js";
import { levelingCopy } from "./levelingCopy.js";

type ReplyPayload = { embeds: Array<{ data: { title?: string; image?: { url: string }; fields?: unknown[] } }>; files?: AttachmentBuilder[] };

function press() {
	const member = { user: { id: "u1", avatar: "a1", displayAvatarURL: () => "https://cdn.discordapp.com/avatars/u1/a1.png" } };
	const interaction = {
		guildId: "g1",
		guild: { members: { cache: new Map([["u1", member]]) } },
		deferReply: vi.fn(async () => undefined),
		reply: vi.fn(async () => undefined),
	};
	return { interaction: interaction as unknown as RepliableInteraction, editReply: mocks.send };
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.beginChannelAnswer.mockResolvedValue({ channelId: "c-commands", send: mocks.send });
	mocks.getLevelingConfig.mockResolvedValue({ settings: { curve: "dero", curveMultiplier: 1, maxLevel: null }, weekStart: "sunday" });
	mocks.topByTotalXp.mockResolvedValue([
		{ userId: "u1", username: "Silent", totalXp: 964 },
		{ userId: "u2", username: "Gone", totalXp: 120 },
	]);
});

describe("the Levels view", () => {
	it("answers with the board card, drawing the faces of cached members, and no standings left in text", async () => {
		const attachment = new AttachmentBuilder(Buffer.from("png"), { name: "levels-board-abc.png" });
		mocks.renderLevelsBoardCard.mockResolvedValue({ attachment, ref: "attachment://levels-board-abc.png" });
		const { interaction, editReply } = press();

		await showLevelsStandings(interaction, { window: "alltime" });

		const [label, entries] = mocks.renderLevelsBoardCard.mock.calls[0] as [string, Array<{ userId: string; avatar: unknown }>];
		expect(label).toBe(levelingCopy.board.allTime);
		expect(entries.map((entry) => entry.avatar === null)).toEqual([false, true]);
		expect(mocks.beginChannelAnswer).toHaveBeenCalledWith(interaction, "member");
		const payload = editReply.mock.calls[0]![0] as ReplyPayload;
		expect(payload.files).toEqual([attachment]);
		expect(payload.embeds[0]!.data.image?.url).toBe("attachment://levels-board-abc.png");
		expect(payload.embeds[0]!.data.fields ?? []).toEqual([]);
	});

	it("answers with the text board when the card cannot draw", async () => {
		mocks.renderLevelsBoardCard.mockResolvedValue(null);
		const { interaction, editReply } = press();

		await showLevelsStandings(interaction, { window: "alltime" });

		const payload = editReply.mock.calls[0]![0] as ReplyPayload;
		expect(payload.files).toBeUndefined();
		expect(payload.embeds[0]!.data.fields?.length).toBeGreaterThan(0);
	});
});
