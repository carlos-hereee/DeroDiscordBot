import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@db/stores/gameResultCountStore.js", () => ({ gameResultCountStore: { increment: vi.fn() } }));

import {
	holdemHandLabel,
	parseHoldemHandLabel,
	phraseHoldemHandLabel,
	recordShowdownHand,
	winningShowdownHand,
} from "./gameResultCounts.js";
import { gameResultCountStore } from "@db/stores/gameResultCountStore.js";
import { evaluateHand, HAND_CATEGORIES, type Card, type HandCategory } from "@features/games/holdemHand.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { generalEventsCopy } from "@base/copy/packs/general-events.pack.js";

// ── gameResultCounts ─────────────────────────────────────────────────────
// The Hold'em hand count of 2026-10 item 244: the winning hand at a showdown,
// stored as a stable key and phrased from the copy pack on read. Every category is
// phrased here so a pack edit that drops one fails loudly.

const storeMock = gameResultCountStore as unknown as { increment: ReturnType<typeof vi.fn> };
const words = rokCommanderCopy.holdemHands;
const NOW = new Date("2026-11-01T00:00:00.000Z");

const card = (text: string): Card => {
	const rankText = text.slice(0, -1);
	const ranks: Record<string, number> = { J: 11, Q: 12, K: 13, A: 14 };
	return { rank: ranks[rankText] ?? Number(rankText), suit: text.slice(-1) as Card["suit"] };
};
const cards = (text: string): Card[] => text.split(" ").map(card);

beforeEach(() => {
	vi.clearAllMocks();
	storeMock.increment.mockResolvedValue(undefined);
});

describe("holdemHandLabel", () => {
	it("keys a hand by its category and its top rank's label", () => {
		expect(holdemHandLabel(evaluateHand(cards("As Ad 7c 4h 2s 9d 10c")))).toBe("pair:A");
		expect(holdemHandLabel(evaluateHand(cards("Ks Kd Kc 4h 4s 9d 2c")))).toBe("full house:K");
		expect(holdemHandLabel(evaluateHand(cards("As 3d 2c 4h 5s 9d Jc")))).toBe("straight:5");
	});

	it("round trips through the parser", () => {
		expect(parseHoldemHandLabel("full house:K")).toEqual({ category: "full house", rankLabel: "K" });
		expect(parseHoldemHandLabel("two pair:10")).toEqual({ category: "two pair", rankLabel: "10" });
		expect(parseHoldemHandLabel("nonsense")).toBeNull();
		expect(parseHoldemHandLabel("five of a kind:A")).toBeNull();
	});
});

describe("phraseHoldemHandLabel", () => {
	const expected: Record<HandCategory, [string, string]> = {
		"high card": ["high card:A", "ace high"],
		pair: ["pair:A", "pair of aces"],
		"two pair": ["two pair:K", "kings up"],
		"three of a kind": ["three of a kind:6", "three sixes"],
		straight: ["straight:10", "ten high straight"],
		flush: ["flush:A", "ace high flush"],
		"full house": ["full house:A", "aces full"],
		"four of a kind": ["four of a kind:J", "four jacks"],
		"straight flush": ["straight flush:9", "nine high straight flush"],
	};

	it.each(HAND_CATEGORIES.map((category) => [category, ...expected[category]]))("phrases %s", (_category, label, phrase) => {
		expect(phraseHoldemHandLabel(label, words)).toBe(phrase);
	});

	it("names the ace high straight flush a royal flush", () => {
		expect(phraseHoldemHandLabel("straight flush:A", words)).toBe("royal flush");
	});

	it("has a word for every rank label", () => {
		for (const rankLabel of ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"]) {
			expect(phraseHoldemHandLabel(`pair:${rankLabel}`, words)).toMatch(/^pair of [a-z]+$/);
		}
	});

	it("answers null for a key it cannot phrase, rather than printing the raw key", () => {
		expect(phraseHoldemHandLabel("pair:1", words)).toBeNull();
		expect(phraseHoldemHandLabel("garbage", words)).toBeNull();
	});

	it("reads the same words in the general-events pack", () => {
		expect(generalEventsCopy.holdemHands).toBe(rokCommanderCopy.holdemHands);
	});
});

describe("winningShowdownHand", () => {
	const board = cards("Ah Kd 7c 7h 2s");

	it("picks the best hand among the shown players", () => {
		const table = { board, holeCards: { a: cards("Ac 3d"), b: cards("7d 7s"), c: cards("Kc Qd") } };
		expect(winningShowdownHand(table, ["a", "b", "c"])?.category).toBe("four of a kind");
	});

	it("skips a seat whose hole cards are missing", () => {
		const table = { board, holeCards: { a: cards("Ac 3d") } };
		expect(holdemHandLabel(winningShowdownHand(table, ["a", "ghost"])!)).toBe("two pair:A");
		expect(winningShowdownHand(table, ["ghost"])).toBeNull();
	});
});

describe("recordShowdownHand", () => {
	it("counts the winning hand under the guild, game and UTC month", async () => {
		const table = { board: cards("Ah Kd 7c 7h 2s"), holeCards: { a: cards("Ac 3d"), b: cards("Kc Qd") } };

		await recordShowdownHand({ guildId: "guild-1", table, shownUserIds: ["a", "b"], now: NOW });

		expect(storeMock.increment).toHaveBeenCalledOnce();
		expect(storeMock.increment).toHaveBeenCalledWith({ guildId: "guild-1", game: "holdem", month: "2026-11", label: "two pair:A" });
	});

	it("never rejects when the write fails", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		storeMock.increment.mockRejectedValue(new Error("atlas down"));
		const table = { board: cards("Ah Kd 7c 7h 2s"), holeCards: { a: cards("Ac 3d") } };

		await expect(recordShowdownHand({ guildId: "guild-1", table, shownUserIds: ["a"], now: NOW })).resolves.toBeUndefined();
		expect(errorSpy).toHaveBeenCalledOnce();
		errorSpy.mockRestore();
	});
});
