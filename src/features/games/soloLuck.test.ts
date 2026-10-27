import { describe, it, expect, vi, beforeEach } from "vitest";
import { AttachmentBuilder, type RepliableInteraction, type TextChannel, type User } from "discord.js";

const mocks = vi.hoisted(() => ({ awardXp: vi.fn(), renderRpsCard: vi.fn() }));
vi.mock("@features/leveling/awardXp.js", () => ({ awardXp: mocks.awardXp }));
// The rps reveal card (2026-10 item 254 Phase 5a), mocked so a case chooses whether it draws.
vi.mock("./rpsRenderer.js", () => ({ renderRpsCard: mocks.renderRpsCard }));

import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { buildSoloLuckRow, parseSoloLuckButton, pickDeroThrow, playSoloLuck, playSoloLuckInChannel, resolveSoloLuck } from "./soloLuck.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { gamesCopy } from "./gamesCopy.js";

// ── soloLuck ───────────────────────────────────────────────────────────────
// Coin flip, dice roll and rps against Dero (the 1.7.0 test fixes, item 14). The
// resolver is pinned through an rng stub, the way versusResolve's own suite pins its
// odds, and the entry point through a fake interaction, so each game's outcome and
// its XP are both under test.

// Hands out the given numbers in order, so a case can name each roll it needs.
const rngOf = (...values: number[]) => {
	let index = 0;
	return () => values[index++ % values.length];
};

interface FakeInteraction {
	interaction: RepliableInteraction;
	reply: ReturnType<typeof vi.fn>;
}

function fakeInteraction(inGuild = true): FakeInteraction {
	const reply = vi.fn(async () => undefined);
	const interaction = {
		inGuild: () => inGuild,
		guildId: inGuild ? "guild-1" : null,
		channelId: "games-1",
		client: {},
		user: { id: "member-1", username: "member", globalName: "Member" },
		reply,
	} as unknown as RepliableInteraction;
	return { interaction, reply };
}

const paidAmounts = (): number[] => mocks.awardXp.mock.calls.map((call) => (call[0] as { amount: number }).amount);

beforeEach(() => {
	mocks.awardXp.mockReset().mockResolvedValue(undefined);
	mocks.renderRpsCard.mockReset().mockResolvedValue(null);
});

describe("resolveSoloLuck, with Dero as the second side", () => {
	it("gives the coin's heads to the member and its tails to Dero", () => {
		expect(resolveSoloLuck({ game: "coinflip" }, () => 0.1)).toEqual({ game: "coinflip", face: "heads", outcome: "won" });
		expect(resolveSoloLuck({ game: "coinflip" }, () => 0.9)).toEqual({ game: "coinflip", face: "tails", outcome: "lost" });
	});

	it("rolls a d20 each, member first, and can tie", () => {
		// floor(0.95 * 20) + 1 = 20 and floor(0 * 20) + 1 = 1.
		expect(resolveSoloLuck({ game: "diceroll" }, rngOf(0.95, 0))).toEqual({
			game: "diceroll",
			memberRoll: 20,
			deroRoll: 1,
			outcome: "won",
		});
		expect(resolveSoloLuck({ game: "diceroll" }, rngOf(0, 0.95)).outcome).toBe("lost");
		expect(resolveSoloLuck({ game: "diceroll" }, rngOf(0.5, 0.5)).outcome).toBe("tie");
	});

	it("scores the member's throw against Dero's", () => {
		// RPS_CHOICES is rock, paper, scissors: 0 is rock, 0.5 is paper, 0.9 is scissors.
		expect(resolveSoloLuck({ game: "rps", memberThrow: "paper" }, () => 0)).toMatchObject({ deroThrow: "rock", outcome: "won" });
		expect(resolveSoloLuck({ game: "rps", memberThrow: "paper" }, () => 0.9)).toMatchObject({
			deroThrow: "scissors",
			outcome: "lost",
		});
		expect(resolveSoloLuck({ game: "rps", memberThrow: "paper" }, () => 0.5)).toMatchObject({ deroThrow: "paper", outcome: "tie" });
	});

	it("lets Dero throw anything, and only those three", () => {
		expect([0, 0.34, 0.67, 0.9999].map((value) => pickDeroThrow(() => value))).toEqual(["rock", "paper", "scissors", "scissors"]);
	});
});

describe("playSoloLuck", () => {
	const { SOLO_LUCK_WIN_XP, SOLO_LUCK_OTHER_XP } = BOT_CONSTANTS.LEVELING;

	it("pins the owner's amounts: 3 for a win, 1 for anything else", () => {
		expect(SOLO_LUCK_WIN_XP).toBe(3);
		expect(SOLO_LUCK_OTHER_XP).toBe(1);
	});

	it.each([
		["a coin flip win", { game: "coinflip" } as const, () => 0.1, SOLO_LUCK_WIN_XP],
		["a coin flip loss", { game: "coinflip" } as const, () => 0.9, SOLO_LUCK_OTHER_XP],
		["a dice win", { game: "diceroll" } as const, rngOf(0.95, 0), SOLO_LUCK_WIN_XP],
		["a dice loss", { game: "diceroll" } as const, rngOf(0, 0.95), SOLO_LUCK_OTHER_XP],
		["a dice tie", { game: "diceroll" } as const, rngOf(0.5, 0.5), SOLO_LUCK_OTHER_XP],
		["an rps win", { game: "rps", memberThrow: "rock" } as const, () => 0.9, SOLO_LUCK_WIN_XP],
		["an rps loss", { game: "rps", memberThrow: "rock" } as const, () => 0.5, SOLO_LUCK_OTHER_XP],
		["an rps tie", { game: "rps", memberThrow: "rock" } as const, () => 0, SOLO_LUCK_OTHER_XP],
	])("pays %s as soloLuck, inside the daily cap", async (_label, play, rng, xp) => {
		const { interaction } = fakeInteraction();
		await playSoloLuck(interaction, play, rng);

		expect(paidAmounts()).toEqual([xp]);
		expect(mocks.awardXp.mock.calls[0][0]).toMatchObject({ guildId: "guild-1", userId: "member-1", source: "soloLuck" });
	});

	it("records no per game result, so achievements cannot be farmed past the cap", async () => {
		const { interaction } = fakeInteraction();
		await playSoloLuck(interaction, { game: "coinflip" }, () => 0.1);

		const award = mocks.awardXp.mock.calls[0][0] as { game?: string; outcome?: string };
		expect(award.game).toBeUndefined();
		expect(award.outcome).toBeUndefined();
	});

	it("posts exactly one public message, pinging nobody", async () => {
		const { interaction, reply } = fakeInteraction();
		await playSoloLuck(interaction, { game: "diceroll" }, rngOf(0.95, 0));

		expect(reply).toHaveBeenCalledOnce();
		const sent = reply.mock.calls[0][0] as { flags?: unknown; allowedMentions: unknown; embeds: { toJSON(): { title: string; description: string } }[] };
		expect(sent.flags).toBeUndefined();
		expect(sent.allowedMentions).toEqual({ parse: [] });
		const embed = sent.embeds[0].toJSON();
		expect(embed.title).toBe(gamesCopy.soloLuck.diceTitle);
		expect(embed.description).toContain(gamesCopy.soloLuck.memberWins("member-1"));
	});

	// 2026-10 item 254 Phase 5a: the rps card joins the round in an edit, with Dero on the
	// right and the outcome read from the member's side; the text result stays when it fails.
	describe("the rps reveal card", () => {
		function cardInteraction() {
			const { interaction, reply } = fakeInteraction();
			const editReply = vi.fn(async () => undefined);
			Object.assign(interaction, { inCachedGuild: () => false, editReply });
			return { interaction, reply, editReply };
		}

		it("edits the drawn card into a round against Dero, Dero on the right", async () => {
			const card = { attachment: new AttachmentBuilder(Buffer.from("png"), { name: "rps-1.png" }), ref: "attachment://rps-1.png" };
			mocks.renderRpsCard.mockResolvedValue(card);
			const { interaction, editReply } = cardInteraction();

			// rng 0.5 makes Dero throw paper, which beats the member's rock.
			await playSoloLuck(interaction, { game: "rps", memberThrow: "rock" }, () => 0.5);

			await vi.waitFor(() => expect(editReply).toHaveBeenCalledOnce());
			expect(mocks.renderRpsCard).toHaveBeenCalledWith({
				left: { name: "Member", choice: "rock", isDero: false },
				right: { name: gamesCopy.soloLuck.deroName, choice: "paper", isDero: true },
				winner: "right",
			});
			const edited = editReply.mock.calls[0][0] as { files: unknown[]; embeds: { toJSON(): { image?: { url: string } } }[] };
			expect(edited.files).toEqual([card.attachment]);
			expect(edited.embeds[0].toJSON().image?.url).toBe(card.ref);
		});

		it("leaves the text result as it was when the card throws", async () => {
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
			mocks.renderRpsCard.mockRejectedValue(new Error("canvas exploded"));
			const { interaction, reply, editReply } = cardInteraction();

			await playSoloLuck(interaction, { game: "rps", memberThrow: "rock" }, () => 0.5);
			await new Promise((resolve) => setImmediate(resolve));

			expect(reply).toHaveBeenCalledOnce();
			expect(editReply).not.toHaveBeenCalled();
			warnSpy.mockRestore();
		});

		it("draws no card for a coin flip", async () => {
			const { interaction, editReply } = cardInteraction();
			await playSoloLuck(interaction, { game: "coinflip" }, () => 0.1);
			await new Promise((resolve) => setImmediate(resolve));

			expect(mocks.renderRpsCard).not.toHaveBeenCalled();
			expect(editReply).not.toHaveBeenCalled();
		});
	});

	it("refuses a DM and pays nothing", async () => {
		const { interaction, reply } = fakeInteraction(false);
		await playSoloLuck(interaction, { game: "coinflip" }, () => 0.1);

		expect(reply.mock.calls[0][0]).toMatchObject({ flags: expect.anything() });
		expect(mocks.awardXp).not.toHaveBeenCalled();
	});
});

// ── the 🕹️games row (2026-10 item 245 Phase 4a) ──
// The buttons are the third way into playSoloLuck, after the two /mini-game paths, so
// what is pinned here is the translation: every button the row builds parses back to
// the round it names, and a replayed customId for anything else parses to nothing.
// ── into a solo room (2026-10 item 254, Arcade 1) ──
describe("playSoloLuckInChannel", () => {
	const user = { id: "member-1", username: "member", globalName: "Member" } as unknown as User;

	function fakeRoomChannel(send = vi.fn(async () => ({ edit: vi.fn(async () => undefined) }))) {
		return { channel: { id: "room-1", guildId: "guild-1", client: {}, send } as unknown as TextChannel, send };
	}

	it("posts the round into the room as one message pinging nobody, pays it, and answers the result", async () => {
		const { channel, send } = fakeRoomChannel();
		const result = await playSoloLuckInChannel(channel, { user, displayName: "Member" }, { game: "coinflip" }, () => 0.1);

		expect(result).toEqual({ game: "coinflip", face: "heads", outcome: "won" });
		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0][0]).toMatchObject({ allowedMentions: { parse: [] } });
		// Paid as the same solo luck round, inside the daily cap, in the room's channel.
		await vi.waitFor(() => expect(mocks.awardXp).toHaveBeenCalled());
		expect(mocks.awardXp.mock.calls[0][0]).toMatchObject({ guildId: "guild-1", channelId: "room-1", userId: "member-1" });
	});

	it("answers null and pays nothing when the round cannot be posted", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const { channel } = fakeRoomChannel(vi.fn(async () => Promise.reject(new Error("Missing Access"))));
		const result = await playSoloLuckInChannel(channel, { user, displayName: "Member" }, { game: "rps", memberThrow: "rock" });

		expect(result).toBeNull();
		await new Promise((resolve) => setImmediate(resolve));
		expect(mocks.awardXp).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});
});

describe("the solo luck row on 🕹️games", () => {
	const row = buildSoloLuckRow(rokCommanderCopy.channelContent.arcadeGames.soloLuckLabels).toJSON() as { components: Array<{ custom_id?: string; label?: string }> };

	it("fills one row with the coin, the dice and one button per throw", () => {
		expect(row.components.map((button) => button.custom_id)).toEqual([
			"solo_luck:coinflip",
			"solo_luck:diceroll",
			"solo_luck:rps:rock",
			"solo_luck:rps:paper",
			"solo_luck:rps:scissors",
		]);
		// Five is Discord's ceiling for one row.
		expect(row.components).toHaveLength(5);
	});

	it("parses every button back to the round it names", () => {
		const plays = row.components.map((button) => parseSoloLuckButton(button.custom_id ?? ""));
		expect(plays).toEqual([
			{ game: "coinflip" },
			{ game: "diceroll" },
			{ game: "rps", memberThrow: "rock" },
			{ game: "rps", memberThrow: "paper" },
			{ game: "rps", memberThrow: "scissors" },
		]);
	});

	it("parses a customId this row never builds to nothing", () => {
		for (const customId of ["solo_luck:rps:lizard", "solo_luck:rps", "solo_luck:hangman", "arcade_host:hangman"]) {
			expect(parseSoloLuckButton(customId), customId).toBeNull();
		}
	});
});
