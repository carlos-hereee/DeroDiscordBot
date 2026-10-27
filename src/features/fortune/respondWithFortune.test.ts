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
	recordFortuneReading: vi.fn(),
	claimFortuneSlot: vi.fn(),
	releaseFortuneSlot: vi.fn(),
	findByGuildId: vi.fn(),
}));

// A private reading posts in 💬dero-commands (2026-10 item 257 Phase 5). No commands channel
// by default, so a private reading answers privately, the fallback; one case posts in the channel.
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findByGuildId } }));
vi.mock("@features/leveling/awardXp.js", () => ({ awardXp: mocks.awardXp }));
vi.mock("@db/stores/fortuneBuffStore.js", () => ({
	fortuneBuffStore: { stateFor: mocks.stateFor, recordRoll: mocks.recordRoll },
}));
vi.mock("./rollFortune.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./rollFortune.js")>();
	return { ...actual, rollFortune: mocks.rollFortune };
});
vi.mock("node:fs", () => ({ existsSync: mocks.existsSync }));
vi.mock("@features/ratings/luckStats.js", () => ({ recordFortuneReading: mocks.recordFortuneReading }));
// The persisted 22 hour cooldown (2026-10 item 254) has its own tests; here every
// reading claims its slot unless a case says otherwise.
vi.mock("./fortuneCooldown.js", () => ({ claimFortuneSlot: mocks.claimFortuneSlot, releaseFortuneSlot: mocks.releaseFortuneSlot }));
// The scene card (2026-10 item 243 Phase 4). Null by default, so the reading
// falls back to the orb path every case above the scene describe was written for.
vi.mock("./fortuneSceneRenderer.js", () => ({ FORTUNE_SCENE_AVATAR_SIZE: 128, renderFortuneScene: mocks.renderFortuneScene }));

import { respondWithFortune } from "./respondWithFortune.js";

// Every case uses a fresh reader, so no case leans on another's.
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
			id: `int-${userId}`,
			deferred: false,
			replied: false,
			reply: vi.fn(async () => undefined),
			showModal: vi.fn(async () => undefined),
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
	mocks.recordFortuneReading.mockReset().mockResolvedValue(undefined);
	mocks.claimFortuneSlot.mockReset().mockImplementation(async (guildId: string | null, userId: string) => ({
		ok: true,
		slot: { guildKey: guildId ?? "dm", userId, claimedAt: new Date(), previousAt: null },
	}));
	mocks.releaseFortuneSlot.mockReset().mockResolvedValue(undefined);
	mocks.findByGuildId.mockReset().mockResolvedValue(null);
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
		// private (posted in 💬dero-commands). If the award had gone into fortuneHandler.ts this case would fail
		// and nobody would notice in production, because the button still works.
		const { interaction, userId } = harness();
		await respondWithFortune(interaction as unknown as ButtonInteraction, { isPrivate: true });

		expect(mocks.awardXp).toHaveBeenCalledTimes(1);
		expect(mocks.awardXp.mock.calls[0][0]).toMatchObject({ userId });
	});
});

describe("the award itself", () => {
	it("is small, flat, and has no outcome to chase", async () => {
		// Fortune has no opponent and no way to lose, so the award is small and flat.
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

// 2026-10 item 250 Phase 5: every reading in a server counts on the luck board, above the
// average reading, from both entry points.
describe("the luck board", () => {
	it("records the reading's luck above the average on both entry points", async () => {
		mocks.rollFortune.mockReturnValue({ tier: "common", verdict: "IT IS CERTAIN", flavor: "Dero nods." });
		const { interaction, userId } = harness();
		await respondWithFortune(interaction as unknown as ButtonInteraction, { isPrivate: true });

		const reading = mocks.recordFortuneReading.mock.calls[0][0] as { guildId: string; userId: string; luckAboveAverage: number };
		expect(reading).toMatchObject({ guildId: "g1", userId });
		expect(reading.luckAboveAverage).toBeCloseTo(2 - 0.5265, 4);
	});

	it("records nothing in a DM", async () => {
		const { interaction } = harness({ guildId: null });
		await respondWithFortune(interaction);
		expect(mocks.recordFortuneReading).not.toHaveBeenCalled();
	});
});

describe("the award cannot break a reading", () => {
	it("refuses a reading on cooldown before any roll, naming when the next is ready, and awards nothing", async () => {
		const readyAt = new Date("2026-10-27T16:00:00Z");
		mocks.claimFortuneSlot.mockResolvedValue({ ok: false, readyAt });
		const { interaction } = harness();
		await respondWithFortune(interaction);

		expect(mocks.rollFortune).not.toHaveBeenCalled();
		expect(interaction.deferReply).not.toHaveBeenCalled();
		expect(mocks.awardXp).not.toHaveBeenCalled();
		const notice = (vi.mocked(interaction.showModal).mock.calls[0]![0] as unknown as { toJSON(): { components: Array<{ content?: string }> } }).toJSON();
		expect(notice.components.map((component) => component.content).join("\n")).toContain(`<t:${readyAt.getTime() / 1000}:R>`);
	});

	it("gives the slot back when the reading fails to send, and never awards it", async () => {
		const { interaction, userId } = harness();
		vi.mocked(interaction.editReply).mockRejectedValue(new Error("Unknown interaction"));

		await expect(respondWithFortune(interaction)).rejects.toThrow("Unknown interaction");
		expect(mocks.releaseFortuneSlot).toHaveBeenCalledWith(expect.objectContaining({ guildKey: "g1", userId }));
		expect(mocks.awardXp).not.toHaveBeenCalled();
	});

	it("keeps the slot once the reading reached the member, even if the pity write fails", async () => {
		mocks.recordRoll.mockRejectedValue(new Error("mongo down"));
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const { interaction } = harness();

		await respondWithFortune(interaction);
		expect(mocks.releaseFortuneSlot).not.toHaveBeenCalled();
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

describe("where a reading answers", () => {
	it("answers a public reading in place, with a plain defer and its edit", async () => {
		const { interaction } = harness();
		await respondWithFortune(interaction, { question: "will it rain" });
		expect(interaction.deferReply).toHaveBeenCalledWith();
		expect(interaction.editReply).toHaveBeenCalledTimes(1);
	});

	it("posts a private reading in the commands channel after a notice naming it, without a ping", async () => {
		mocks.findByGuildId.mockResolvedValue({ commandOutputChannelId: "c-commands" });
		const send = vi.fn(async (_payload: unknown) => ({ id: "m-1", edit: vi.fn(async () => undefined) }));
		const commands = { id: "c-commands", isSendable: () => true, send };
		const { interaction } = harness();
		const fake = interaction as unknown as Record<string, unknown>;
		fake.client = { channels: { fetch: vi.fn(async () => commands) } };
		fake.isModalSubmit = () => false;
		// As discord.js does: an opened modal is the interaction's one answer.
		fake.showModal = vi.fn(async () => {
			fake.replied = true;
		});

		await respondWithFortune(interaction as unknown as ButtonInteraction, { isPrivate: true });

		expect(fake.showModal).toHaveBeenCalledOnce();
		expect(interaction.deferReply).not.toHaveBeenCalled();
		expect(interaction.editReply).not.toHaveBeenCalled();
		const posted = send.mock.calls[0]![0] as { content: string; embeds: unknown[]; allowedMentions: unknown };
		expect(posted.content).toBe(`<@${interaction.user.id}>`);
		expect(posted.embeds).toHaveLength(1);
		expect(posted.allowedMentions).toEqual({ parse: [] });
		expect(mocks.awardXp).toHaveBeenCalledTimes(1);
	});
});
