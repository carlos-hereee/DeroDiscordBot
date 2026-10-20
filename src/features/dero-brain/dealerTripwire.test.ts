import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { createTable, joinTable, dealHand, act, actionsFor, whoActs, handInProgress, type HoldemTable } from "@features/games/holdemTable.js";
import { formatCard, freshDeck, type Card } from "@features/games/holdemHand.js";
import { narrate, toPublicResult, toPublicView, type DealerLine } from "./dealerNarration.js";
import { deroBrainCopy } from "./deroBrainCopy.js";

// ── the dealer tripwire ───────────────────────────────────────────────────
// What:  two mechanical checks that a player's private cards cannot leak through
//        Dero's dealer: ① the private card field's name appears in no file this
//        phase created, so none of them can even reach for it; ② across many
//        seeded hands, folds, raises and all in run outs, no narration line names
//        a card that is not on the board, in text or in speech.
// Who:   runs with the suite, against the SOURCE and the real engine.
// Where: the field's name is built from two halves below, so this file passes
//        its own scan.

const PRIVATE_CARDS_FIELD = "hole" + "Cards";
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Every file Phase 4 created. A new file in this feature belongs on this list.
const PHASE_FOUR_FILES = [
	"commands/utility/dero.holdem.test.ts",
	"features/dero-brain/dealerNarration.ts",
	"features/dero-brain/dealerNarration.test.ts",
	"features/dero-brain/dealerTripwire.test.ts",
	"features/dero-brain/holdemRequests.ts",
	"features/dero-brain/holdemRulesCard.ts",
	"features/dero-brain/holdemRulesCard.test.ts",
	"features/dero-brain/holdemTerms.ts",
	"features/dero-brain/holdemTerms.test.ts",
	"features/game-rooms/RoomProvisioner.holdem.test.ts",
	"features/game-rooms/invitePicker.ts",
	"features/game-rooms/roomHoldemHandlers.dealer.test.ts",
	"features/games/holdemTable.terms.test.ts",
	"features/voice/turnLoop.holdem.test.ts",
	"utils/secureRng.ts",
	"utils/secureRng.test.ts",
];

describe("① the private card field never appears in a Phase 4 file", () => {
	it.each(PHASE_FOUR_FILES)("%s", (file) => {
		expect(readFileSync(join(SRC, file), "utf8")).not.toContain(PRIVATE_CARDS_FIELD);
	});

	it("and the scan has teeth: the engine file it guards against does name the field", () => {
		expect(readFileSync(join(SRC, "features/games/holdemTable.ts"), "utf8")).toContain(PRIVATE_CARDS_FIELD);
	});

	it("and the public view carries no such key, at any depth", () => {
		const table = createTable(5);
		joinTable(table, "a", "A");
		joinTable(table, "b", "B");
		table.status = "playing";
		dealHand(table, Math.random);
		expect(JSON.stringify(toPublicView(table))).not.toContain(PRIVATE_CARDS_FIELD);
	});
});

// ── ② every narration fixture names only board cards ──

function seededRng(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state * 1664525 + 1013904223) % 4294967296;
		return state / 4294967296;
	};
}

const sameCard = (a: Card, b: Card) => a.rank === b.rank && a.suit === b.suit;
const spokenName = (card: Card) => deroBrainCopy.dealer.spokenCard(card.rank, card.suit);

// Play hands with a mix of folds, calls, raises and all ins, narrating every
// change, and check each batch of lines against the board AT THAT MOMENT: a
// card that is only in somebody's hand, or still in the deck, must never be said.
function checkHands(seed: number, seats: number, hands: number): number {
	const rng = seededRng(seed);
	const table: HoldemTable = createTable(5, { maxSeats: seats, startingStack: 2000, smallBlind: 50, bigBlind: 100 });
	for (let index = 0; index < seats; index++) joinTable(table, `p${index}`, `Player ${index}`);
	table.status = "playing";
	let checked = 0;

	const check = (lines: DealerLine[], board: Card[]) => {
		const said = lines.flatMap((line) => [line.text, line.spoken]).join("\n");
		for (const line of lines) for (const card of line.cards) expect(board.some((shown) => sameCard(shown, card))).toBe(true);
		for (const card of freshDeck()) {
			if (board.some((shown) => sameCard(shown, card))) continue;
			expect(said).not.toContain(formatCard(card));
			expect(said).not.toContain(spokenName(card));
		}
		checked += lines.length;
	};

	for (let hand = 0; hand < hands && table.status === "playing"; hand++) {
		const beforeDeal = toPublicView(table);
		dealHand(table, rng);
		const dealt = toPublicView(table);
		check(narrate(beforeDeal, dealt, null), dealt.board);

		let guard = 0;
		while (handInProgress(table) && guard++ < 200) {
			const actor = whoActs(table)!;
			const legal = actionsFor(table, actor);
			const roll = rng();
			const pick =
				(roll < 0.15 && legal.find((entry) => entry.action === "fold")) ||
				(roll < 0.3 && legal.find((entry) => entry.action === "allIn")) ||
				(roll < 0.45 && legal.find((entry) => entry.action === "raise" || entry.action === "bet")) ||
				legal.find((entry) => entry.action === "check" || entry.action === "call") ||
				legal[0];
			const before = toPublicView(table);
			const outcome = act(table, actor, pick.action, pick.min ?? 0, rng);
			const after = toPublicView(table);
			check(narrate(before, after, toPublicResult(outcome)), after.board);
		}
	}
	return checked;
}

describe("② no narration line names a card that is not on the board", () => {
	it.each([
		[1, 6],
		[2, 6],
		[3, 4],
		[4, 2],
		[5, 3],
	])("seed %i, %i seats, twenty hands", (seed, seats) => {
		expect(checkHands(seed, seats, 20)).toBeGreaterThan(0);
	});
});
