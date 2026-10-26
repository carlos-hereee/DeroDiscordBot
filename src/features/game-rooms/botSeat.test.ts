import { describe, it, expect } from "vitest";
import {
	botSeatIdsFor,
	botSeatName,
	botsAllowedIn,
	botVariantOf,
	isBotSeatId,
	labelBotMentions,
	maxBotSeats,
	memberIdsOnly,
	takesBots,
} from "./botSeat.js";

// ── botSeat (2026-10 item 250 Phase 5) ──────────────────────────────────────
// A bot seat's id can never be a member's, names itself by its Dero variant, sits on the
// Monopoly token its name says, and every line naming one reads as the bot's name.

describe("bot seat ids", () => {
	it("are never a snowflake, and name their variant", () => {
		expect(isBotSeatId("dero-bot-red")).toBe(true);
		expect(isBotSeatId("123456789012345678")).toBe(false);
		expect(isBotSeatId(null)).toBe(false);
		expect(botVariantOf("dero-bot-gold")?.name).toBe("Gold");
		expect(botVariantOf("dero-bot-pink")).toBeNull();
		expect(botSeatName("dero-bot-blue")).toBe("Dero Blue");
	});

	it("sit a Monopoly bot on the token its seat draws, and start from red elsewhere", () => {
		// Two members take tokens one and two (red, orange), so the bots are gold and green.
		expect(botSeatIdsFor("monopoly", 2, 2)).toEqual(["dero-bot-gold", "dero-bot-green"]);
		expect(botSeatIdsFor("holdem", 1, 3)).toEqual(["dero-bot-red", "dero-bot-orange", "dero-bot-gold"]);
		expect(botSeatIdsFor("battleship", 1, 1)).toEqual(["dero-bot-red"]);
		expect(botSeatIdsFor("holdem", 1, 0)).toEqual([]);
	});

	it("leave the host a seat: five at Hold'em and Monopoly, one at Battleship, none elsewhere", () => {
		expect([maxBotSeats("holdem"), maxBotSeats("monopoly"), maxBotSeats("battleship"), maxBotSeats("hangman")]).toEqual([5, 5, 1, 0]);
		expect(takesBots("coinflip")).toBe(false);
		expect(takesBots("battleship")).toBe(true);
	});
});

describe("naming bots in lines", () => {
	it("turns a bot mention into its name and leaves a member's mention alone", () => {
		expect(labelBotMentions("<@dero-bot-red> calls. <@123> folds.")).toBe("🤖 **Dero Red** calls. <@123> folds.");
	});

	it("keeps only member ids for a Discord call", () => {
		expect(memberIdsOnly(["1", "dero-bot-red", "2"])).toEqual(["1", "2"]);
	});

	it("reads a server that never stored the switch as allowing bots", () => {
		expect(botsAllowedIn(null)).toBe(true);
		expect(botsAllowedIn({ botOpponentsEnabled: false })).toBe(false);
	});
});
