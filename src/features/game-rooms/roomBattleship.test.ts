import { describe, it, expect } from "vitest";
import type { ButtonBuilder, ActionRowBuilder } from "discord.js";
import { battleshipRows, deserializeMatch, ownFleetText, privateBoardEmbed, publicBoardEmbed, startMatch, targetGridText, type StoredBattleship } from "./roomBattleship.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── the Battleship board's text and controls (2026-10 item 263 R3-2 and R3-3) ──
// Two regional indicator letters side by side that spell a country code render as its flag (C D
// drew the DR Congo, G H Ghana), so no grid any surface shows may hold such a pair. And the
// battle board has no Fire of its own: Take your turn is the one way to shoot.

const A = "captain-a";
const B = "captain-b";

function seededRng(seed = 5): () => number {
	let state = seed;
	return () => {
		state = (state * 1664525 + 1013904223) % 4294967296;
		return state / 4294967296;
	};
}

const laid = (): StoredBattleship => startMatch({ playerIds: [A, B] } as IGameRoom, { [A]: "Captain A", [B]: "Captain B" }, seededRng());
const playing = (): StoredBattleship => ({ ...laid(), status: "playing", ready: [true, true] });

const ADJACENT_REGIONAL_INDICATORS = /[\u{1F1E6}-\u{1F1FF}]{2}/u;
const COLUMN_LETTERS = ["🇦", "🇧", "🇨", "🇩", "🇪", "🇫", "🇬", "🇭", "🇮", "🇯"];

const customIds = (rows: readonly ActionRowBuilder<never>[]): string[] =>
	rows.flatMap((row) => (row.components as unknown as ButtonBuilder[]).map((button) => (button.toJSON() as { custom_id?: string }).custom_id ?? ""));

describe("the grid's column header", () => {
	it("never puts two regional indicators side by side, on any surface that draws a grid", () => {
		const state = deserializeMatch(playing());
		const grids = {
			publicEmbed: publicBoardEmbed(state).data.description ?? "",
			fleetModal: ownFleetText(state, A),
			targetModal: targetGridText(state, A),
			privateEmbed: JSON.stringify(privateBoardEmbed(state, A).toJSON()),
		};

		for (const [surface, text] of Object.entries(grids)) {
			expect(text, surface).toContain(COLUMN_LETTERS[0]);
			expect(ADJACENT_REGIONAL_INDICATORS.test(text), surface).toBe(false);
		}
	});

	it("still reads all ten letters, A to J, in order", () => {
		const header = ownFleetText(deserializeMatch(laid()), A)
			.split("\n")
			.find((line) => line.includes(COLUMN_LETTERS[0]));
		const letters = [...(header ?? "")].filter((glyph) => COLUMN_LETTERS.includes(glyph));

		expect(letters).toEqual(COLUMN_LETTERS);
	});
});

describe("the board's controls", () => {
	it("gives a battle board View board and Surrender, and no Fire", () => {
		const ids = customIds(battleshipRows("room-1", deserializeMatch(playing())));

		expect(ids).toEqual(["gameroom:board:room-1", "gameroom:forfeit:room-1"]);
	});

	it("gives a setup board Set up your fleet, Randomize and Surrender", () => {
		const ids = customIds(battleshipRows("room-1", deserializeMatch(laid())));

		expect(ids).toEqual(["gameroom:turn:room-1:setup", "gameroom:reroll:room-1", "gameroom:forfeit:room-1"]);
	});
});
