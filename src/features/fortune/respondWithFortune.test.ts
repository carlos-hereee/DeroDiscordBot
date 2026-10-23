import { describe, it, expect, vi, beforeEach } from "vitest";
import { AttachmentBuilder, type ButtonInteraction, type ChatInputCommandInteraction } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";

// ── respondWithFortune, the leveling award ─────────────────────────────────
// This file exists for ONE trap. The `powerup:member:fortune` button in
// PowerUps.ts calls respondWithFortune DIRECTLY, bypassing the slash command
// handler, so an xp award placed in fortuneHandler.ts would leave the button
// path silently earning nothing. Both entry points are exercised here so that
// stays true. The scene card's two paths (2026-10 item 243 Phase 4) ride the
// same harness at the bottom.

const mocks = vi.hoisted(() => ({
	awardXp: vi.fn(),
	stateFor: vi.fn(),
	recordRoll: vi.fn(),
	rollFortune: vi.fn(),
	existsSync: vi.fn(),
	renderFortuneScene: vi.fn(),
}));

vi.mock("@features/leveling/awardXp.js", () => ({ awardXp: mocks.awardXp }));
vi.mock("@db/stores/fortuneBuffStore.js", () => ({
	fortuneBuffStore: { stateFor: mocks.stateFor, recordRoll: mocks.recordRoll },
}));
vi.mock("./rollFortune.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./rollFortune.js")>();
	return { ...actual, rollFortune: mocks.rollFortune };
});
vi.mock("node:fs", () => ({ existsSync: mocks.existsSync }));
// The scene card (2026-10 item 243 Phase 4). Null by default, so the reading
// falls back to the orb path every case above the scene describe was written for.
vi.mock("./fortuneSceneRenderer.js", () => ({ FORTUNE_SCENE_AVATAR_SIZE: 128, renderFortuneScene: mocks.renderFortuneScene }));

import { respondWithFortune } from "./respondWithFortune.js";

// The cooldown is module scope and keyed per user, so every case uses a fresh
// reader rather than reaching into it.
let seq = 0;
const nextUserId = (): string => `reader-${seq++}`;

function harness(overrides: { guildId?: string | null } = {}) {
	const userId = nextUserId();
	return {
		userId,
		interaction: {
			user: {
				id: userId,
				username: "silent",
				globalName: "Silent",
				avatar: null,
				displayAvatarURL: () => "https://cdn.discordapp.com/embed/avatars/0.png",
			},
			guildId: overrides.guildId === undefined ? "g1" : overrides.guildId,
			channelId: "c-general",
			client: {},
			reply: vi.fn(async () => undefined),
			deferReply: vi.fn(async () => undefined),
			editReply: vi.fn(async () => undefined),
		} as unknown as ChatInputCommandInteraction,
	};
}

beforeEach(() => {
	mocks.awardXp.mockReset().mockResolvedValue(undefined);
	mocks.stateFor.mockReset().mockResolvedValue({ weight: 0.03, dryStreak: 0 });
	mocks.recordRoll.mockReset().mockResolvedValue(undefined);
	mocks.rollFortune.mockReset().mockReturnValue({ tier: "common", verdict: "yes", flavor: "Dero nods." });
	mocks.existsSync.mockReset().mockReturnValue(false);
	mocks.renderFortuneScene.mockReset().mockResolvedValue(null);
});

describe("the award fires from BOTH entry points", () => {
	it("awards on the slash command path", async () => {
		const { interaction, userId } = harness();
		await respondWithFortune(interaction, { question: "will it rain" });

		expect(mocks.awardXp).toHaveBeenCalledTimes(1);
		expect(mocks.awardXp.mock.calls[0][0]).toMatchObject({ userId, guildId: "g1" });
	});

	it("awards on the BUTTON path, which is the whole reason this lives here", async () => {
		// PowerUps calls respondWithFortune directly with no question and always
		// private. If the award had gone into fortuneHandler.ts this case would fail
		// and nobody would notice in production, because the button still works.
		const { interaction, userId } = harness();
		await respondWithFortune(interaction as unknown as ButtonInteraction, { isPrivate: true });

		expect(mocks.awardXp).toHaveBeenCalledTimes(1);
		expect(mocks.awardXp.mock.calls[0][0]).toMatchObject({ userId });
	});
});

describe("the award itself", () => {
	it("is small, flat, and has no outcome to chase", async () => {
		// Fortune is the most farmable award in the feature: a 10 second cooldown,
		// no opponent, and no way to lose.
		const { interaction } = harness();
		await respondWithFortune(interaction);

		const award = mocks.awardXp.mock.calls[0][0] as Record<string, unknown>;
		expect(award.amount).toBe(BOT_CONSTANTS.LEVELING.FORTUNE_XP);
		expect(award.outcome).toBeUndefined();
		expect(award.game).toBeUndefined();
	});

	it("carries the fortuneReadings counter, which nothing else increments", async () => {
		// The hidden dero-knows achievement reads this counter and only this one.
		const { interaction } = harness();
		await respondWithFortune(interaction);
		expect((mocks.awardXp.mock.calls[0][0] as { counters: unknown }).counters).toEqual({ fortuneReadings: 1 });
	});

	it("awards nothing in a DM, where there is no guild to be ranked in", async () => {
		const { interaction } = harness({ guildId: null });
		await respondWithFortune(interaction);
		expect(mocks.awardXp).not.toHaveBeenCalled();
	});
});

describe("the award cannot break a reading", () => {
	it("still delivers the fortune when the reading is on cooldown, and awards nothing", async () => {
		const { interaction } = harness();
		await respondWithFortune(interaction);
		mocks.awardXp.mockClear();

		// Same user immediately again: the cooldown replies and returns before any
		// roll, so no second award.
		await respondWithFortune(interaction);
		expect(mocks.awardXp).not.toHaveBeenCalled();
	});

	it("fires after the reply, so the member sees their reading either way", async () => {
		const { interaction } = harness();
		await respondWithFortune(interaction);

		expect(interaction.editReply).toHaveBeenCalledTimes(1);
		expect(mocks.awardXp).toHaveBeenCalledTimes(1);
	});
});

describe("respondWithFortune's scene card", () => {
	function editedWith(interaction: ChatInputCommandInteraction): { embeds: Array<{ data: { image?: { url: string } } }>; files?: unknown[] } {
		const call = vi.mocked(interaction.editReply).mock.calls[0]?.[0];
		return call as unknown as { embeds: Array<{ data: { image?: { url: string } } }>; files?: unknown[] };
	}

	it("draws the rolled verdict and tier for the asker, and the scene takes the image slot instead of the orb", async () => {
		const attachment = new AttachmentBuilder(Buffer.from("png"), { name: "fortune-scene.png" });
		mocks.renderFortuneScene.mockResolvedValue({ attachment, ref: "attachment://fortune-scene.png" });
		mocks.existsSync.mockReturnValue(true);
		const { interaction } = harness();

		await respondWithFortune(interaction);

		expect(mocks.renderFortuneScene).toHaveBeenCalledWith(
			expect.objectContaining({ tier: "common", verdict: "yes", displayName: "Silent" })
		);
		const edited = editedWith(interaction);
		expect(edited.embeds[0].data.image?.url).toBe("attachment://fortune-scene.png");
		expect(edited.files).toEqual([attachment]);
	});

	it("falls back to the orb animation when the scene does not draw", async () => {
		mocks.renderFortuneScene.mockRejectedValue(new Error("simulated renderer failure"));
		mocks.existsSync.mockReturnValue(true);
		const { interaction } = harness();

		await respondWithFortune(interaction);

		const edited = editedWith(interaction);
		expect(edited.embeds[0].data.image?.url).toBe("attachment://orb.gif");
		expect(edited.files).toHaveLength(1);
	});
});
