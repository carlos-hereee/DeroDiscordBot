import { describe, expect, it } from "vitest";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { mentionBatches } from "./mentions.js";

// mentionBatches (2026-11 item 420): the ids of one ping split so each message fits Discord's
// length and its cap on mentioned ids, every id once and in order.

const { MAX_MESSAGE_LENGTH, MAX_MENTIONED_IDS } = BOT_CONSTANTS.DISCORD_LIMITS;
const ids = (count: number): string[] => Array.from({ length: count }, (_unused, index) => String(1_000_000_000_000_000_000n + BigInt(index)));
const lengthOf = (batch: readonly string[]): number => batch.map((id) => `<@${id}>`).join(" ").length;

describe("mentionBatches", () => {
	it("gives no batch for nobody", () => {
		expect(mentionBatches([], 0)).toEqual([]);
	});

	it("keeps a ping that fits in one message", () => {
		expect(mentionBatches(["1", "2"], 0)).toEqual([["1", "2"]]);
	});

	it.each([85, 90, 250])("L3 L14: splits %i ids inside both limits, each id once and in order", (count) => {
		const reserved = 300;
		const batches = mentionBatches(ids(count), reserved);
		expect(batches.flat()).toEqual(ids(count));
		for (const batch of batches) {
			expect(lengthOf(batch) + reserved).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
			expect(batch.length).toBeLessThanOrEqual(MAX_MENTIONED_IDS);
		}
	});

	it("caps a batch of short ids at the id limit, not the length", () => {
		const short = Array.from({ length: MAX_MENTIONED_IDS + 1 }, (_unused, index) => String(index));
		expect(mentionBatches(short, 0).map((batch) => batch.length)).toEqual([MAX_MENTIONED_IDS, 1]);
	});

	it("gives each id its own batch when the reserve leaves no room, rather than dropping one", () => {
		expect(mentionBatches(["1", "2"], MAX_MESSAGE_LENGTH)).toEqual([["1"], ["2"]]);
	});
});
