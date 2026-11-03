import { describe, it, expect } from "vitest";
import { BOT_CONSTANTS } from "./BOT_CONSTANTS.js";
import { gameRoomsCopy } from "@features/game-rooms/gameRoomsCopy.js";
import { ChannelContent } from "@features/setup/ChannelContent.js";

// ── the turn clocks (2026-10 item 267, owner decision 7) ───────────────────
// What:  pins every turn clock at three times its old value, as numbers, so a change to a
//        constant shows up here rather than passing through the tests that read it, and pins
//        the windows the owner kept (the idle abandon and Blackjack's own clock). Then reads the
//        copy that names a clock, which derives from these constants, for the new duration.
// Where: the sweeps read the constants directly; each game's own tests prove the sweep honours
//        whatever value is set.

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

describe("the turn clocks, three times longer", () => {
	it("gives a Hold'em decision 3 minutes (was 60 seconds)", () => {
		expect(BOT_CONSTANTS.HOLDEM_TURN_TIMEOUT_MS).toBe(3 * MINUTE);
	});

	it("gives a Battleship turn and its setup 30 minutes (was 10)", () => {
		expect(BOT_CONSTANTS.GAME_ROOM_TURN_TIMEOUT_MS).toBe(30 * MINUTE);
	});

	it("gives a Monopoly seat 72 hours on the clock (was 24)", () => {
		expect(BOT_CONSTANTS.GAME_ROOM_MONOPOLY_IDLE_MS).toBe(72 * HOUR);
	});

	it("runs a Monopoly auction round for 3 minutes (was 60 seconds)", () => {
		expect(BOT_CONSTANTS.MONOPOLY_AUCTION_ROUND_MS).toBe(3 * MINUTE);
	});

	it("keeps the windows the owner did not change", () => {
		expect(BOT_CONSTANTS.GAME_ROOM_IDLE_ABANDON_MS).toBe(30 * MINUTE);
		expect(BOT_CONSTANTS.BLACKJACK_TURN_TIMEOUT_MS).toBe(3 * MINUTE);
	});
});

describe("the copy that names a clock", () => {
	it("promises a Monopoly seat its 72 hours on the opener and in the arcade rules", () => {
		expect(gameRoomsCopy.monopoly.openerRules()).toContain("on the clock for 72 hours");
		const rules = ChannelContent.arcadeRulesIntro().data.fields ?? [];
		expect(rules.some((field) => field.value.includes("each seat has 72 hours"))).toBe(true);
	});

	it("names the auction round's 3 minutes in the creation modal's Auctions", () => {
		expect(gameRoomsCopy.creation.fields.auctions.on.description).toContain("3 minutes");
	});

	it("states none of the old durations", () => {
		const copy = [gameRoomsCopy.monopoly.openerRules(), gameRoomsCopy.creation.fields.auctions.on.description, ...(ChannelContent.arcadeRulesIntro().data.fields ?? []).map((field) => field.value)].join("\n");
		for (const old of ["24 hours", "60 second", "10 minutes"]) expect(copy).not.toContain(old);
	});
});
