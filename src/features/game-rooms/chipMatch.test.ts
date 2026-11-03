import { describe, it, expect } from "vitest";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { hostSetsStake, stakeKindOf, stakeOf } from "./chipMatch.js";

// ── a chip match's stake (2026-10 item 276, owner decisions D4 and D10) ──────
// One reading of what a seat stakes, shared by the card's settings line, its picture, the draft
// ledger and the creation modal: a table's buy in, ranked Monopoly's fixed buy in, or the
// Battleship wager the host may leave unset. Whether chips move at all is movesChips' call.

describe("stakeOf", () => {
	it("reads a table's buy in, falling back to the standard stack", () => {
		expect(stakeOf({ game: "holdem", holdemBuyIn: 2_500 })).toEqual({ kind: "buyIn", amount: 2_500 });
		expect(stakeOf({ game: "blackjack", holdemBuyIn: null })).toEqual({ kind: "buyIn", amount: BOT_CONSTANTS.HOLDEM_STARTING_STACK });
	});

	it("fixes ranked Monopoly's buy in, whatever the row holds", () => {
		expect(stakeOf({ game: "monopoly", holdemBuyIn: 9_999 })).toEqual({ kind: "pot", amount: BOT_CONSTANTS.ECONOMY.MONOPOLY_RANKED_BUY_IN });
	});

	it("reads Battleship's wager only when the host set one, and no stake for any other game", () => {
		expect(stakeOf({ game: "battleship", holdemBuyIn: 250 })).toEqual({ kind: "wager", amount: 250 });
		expect(stakeOf({ game: "battleship", holdemBuyIn: null })).toBeNull();
		expect(stakeOf({ game: "hangman" })).toBeNull();
	});
});

describe("stakeKindOf and hostSetsStake", () => {
	it("names each chip game's stake, and leaves Monopoly's fixed buy in out of the host's hands", () => {
		expect(stakeKindOf("holdem")).toBe("buyIn");
		expect(stakeKindOf("monopoly")).toBe("pot");
		expect(stakeKindOf("battleship")).toBe("wager");
		expect(stakeKindOf("rps")).toBeNull();
		expect(hostSetsStake("battleship")).toBe(true);
		expect(hostSetsStake("monopoly")).toBe(false);
	});
});
