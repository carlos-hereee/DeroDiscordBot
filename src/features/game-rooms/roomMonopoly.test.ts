import { describe, it, expect } from "vitest";
import { createInitialState, type MonopolyState } from "@features/games/monopolyState.js";
import { monopolyBoardEmbed, monopolyControlsRow, monopolyInventoryEmbed } from "./roomMonopoly.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";

// ── roomMonopoly ─────────────────────────────────────────────────────
// Pins what the board message shows and which buttons it offers in each phase.
// The row is the one place a Phase 4 control can go missing without a type error,
// so every phase the active seat can be in has a case here.

const A = "player-a";
const B = "player-b";
const ROOM = "room-1";
// Discord's hard cap per action row, and the plan's cap on rows per message.
const DISCORD_COMPONENTS_PER_ROW = 5;
const MAX_ROWS = 4;

const freshMatch = (): MonopolyState => createInitialState([A, B], { auctionsEnabled: false }, 0, 1);

const rowsJson = (state: MonopolyState, viewerId: string) =>
	monopolyControlsRow(state, viewerId, ROOM).map((row) => row.toJSON().components as Array<{ custom_id?: string; label?: string; disabled?: boolean }>);

const customIdsOf = (state: MonopolyState, viewerId: string) => rowsJson(state, viewerId).flat().map((button) => button.custom_id);

describe("monopolyBoardEmbed", () => {
	it("renders a fresh match: whose turn, the prompt, every seat and the token map", () => {
		const description = monopolyBoardEmbed(freshMatch()).data.description ?? "";

		expect(monopolyBoardEmbed(freshMatch()).data.title).toBe(gameRoomsCopy.monopoly.boardTitle);
		expect(description).toContain(gameRoomsCopy.monopoly.onTheClock(A));
		expect(description).toContain(gameRoomsCopy.monopoly.rollPrompt);
		expect(description).toContain(`<@${A}> · $1500 · 0 lots · on GO`);
		expect(description).toContain(`<@${B}> · $1500 · 0 lots · on GO`);
		// Both tokens start on GO, so tile 0 shows "+" and the rest of the side is empty.
		expect(description).toContain(" 0  + · · · · · · · · ·");
		expect(description).toContain(`**${gameRoomsCopy.monopoly.lastMoveLabel}** ${gameRoomsCopy.monopoly.noMovesYet}`);
	});

	it("puts a lone token's seat number on its tile and counts owned lots", () => {
		const state = freshMatch();
		state.seats[1].position = 3;
		state.properties["cinder-row"].ownerId = B;

		const description = monopolyBoardEmbed(state).data.description ?? "";
		expect(description).toContain(" 0  1 · · 2 · · · · · ·");
		expect(description).toContain(`<@${B}> · $1500 · 1 lot · on Cinder Row`);
	});

	it("shows the last trail line and tags jailed and bankrupt seats", () => {
		const state = freshMatch();
		state.log.push({ userId: A, text: `<@${A}> rolled 1 and 2.` });
		state.seats[0].inJail = true;
		state.seats[1].bankrupt = true;

		const description = monopolyBoardEmbed(state).data.description ?? "";
		expect(description).toContain(`<@${A}> rolled 1 and 2.`);
		expect(description).toContain(`(${gameRoomsCopy.monopoly.inJailTag})`);
		expect(description).toContain(`(${gameRoomsCopy.monopoly.outTag})`);
		expect(description).toContain(gameRoomsCopy.monopoly.jailPrompt);
	});

	it("names the winner once the match is finished", () => {
		const state = freshMatch();
		state.phase = "finished";
		state.winnerId = B;
		expect(monopolyBoardEmbed(state).data.description).toContain(gameRoomsCopy.monopoly.finishedLine(B));
	});
});

describe("monopolyControlsRow", () => {
	it("offers the active seat Roll and Inventory before the roll", () => {
		expect(customIdsOf(freshMatch(), A)).toEqual([`gameroom:mroll:${ROOM}`, `gameroom:minventory:${ROOM}`]);
	});

	it("offers a viewer who is not on the clock Inventory only", () => {
		expect(customIdsOf(freshMatch(), B)).toEqual([`gameroom:minventory:${ROOM}`]);
	});

	it("offers a jailed seat the three ways out, greying the card it does not hold", () => {
		const state = freshMatch();
		state.seats[0].inJail = true;
		state.seats[0].jailTurnsRemaining = 3;

		const [row] = rowsJson(state, A);
		expect(row.map((button) => button.custom_id)).toEqual([
			`gameroom:mjail:${ROOM}:bail`,
			`gameroom:mjail:${ROOM}:card`,
			`gameroom:mjail:${ROOM}:roll`,
			`gameroom:minventory:${ROOM}`,
		]);
		expect(row[0]).toMatchObject({ label: gameRoomsCopy.monopoly.bailLabel(50), disabled: false });
		expect(row[1]).toMatchObject({ label: gameRoomsCopy.monopoly.useCardLabel, disabled: true });
	});

	it("offers Buy with the lot and price on it, and Skip, on a lot for sale", () => {
		const state = freshMatch();
		state.phase = "awaiting-buy-or-skip";
		state.seats[0].position = 3;

		const [row] = rowsJson(state, A);
		expect(row.map((button) => button.custom_id)).toEqual([
			`gameroom:mbuy:${ROOM}:cinder-row`,
			`gameroom:mskip:${ROOM}`,
			`gameroom:minventory:${ROOM}`,
		]);
		expect(row[0]).toMatchObject({ label: "Buy Cinder Row for $60", disabled: false });
	});

	it("greys Buy when the seat cannot afford the lot", () => {
		const state = freshMatch();
		state.phase = "awaiting-buy-or-skip";
		state.seats[0].position = 3;
		state.seats[0].chips = 59;
		expect(rowsJson(state, A)[0][0].disabled).toBe(true);
	});

	it("offers End turn after the roll", () => {
		const state = freshMatch();
		state.phase = "post-roll";
		expect(customIdsOf(state, A)).toEqual([`gameroom:mend:${ROOM}`, `gameroom:minventory:${ROOM}`]);
	});

	it("offers nothing once the match is finished", () => {
		const state = freshMatch();
		state.phase = "finished";
		expect(monopolyControlsRow(state, A, ROOM)).toEqual([]);
	});

	it("falls back to Inventory alone in a phase Phase 4 has no control for", () => {
		const state = freshMatch();
		state.phase = "in-auction";
		expect(customIdsOf(state, A)).toEqual([`gameroom:minventory:${ROOM}`]);
	});

	it("never renders build, trade, mortgage or auction controls, and stays inside Discord's caps", () => {
		const phases: MonopolyState["phase"][] = ["pre-roll", "awaiting-buy-or-skip", "post-roll", "in-auction", "in-trade"];
		for (const phase of phases) {
			for (const inJail of [false, true]) {
				const state = freshMatch();
				state.phase = phase;
				state.seats[0].inJail = inJail;
				state.seats[0].position = 3;
				const rows = rowsJson(state, A);
				expect(rows.length).toBeLessThanOrEqual(MAX_ROWS);
				for (const row of rows) expect(row.length).toBeLessThanOrEqual(DISCORD_COMPONENTS_PER_ROW);
				for (const id of rows.flat().map((button) => button.custom_id ?? "")) {
					expect(id).toMatch(/^gameroom:(mroll|mbuy|mskip|mend|mjail|minventory):/);
				}
			}
		}
	});
});

describe("monopolyInventoryEmbed", () => {
	it("shows the viewer their own chips, jail cards and lots by name", () => {
		const state = freshMatch();
		state.properties["cinder-row"].ownerId = A;
		state.properties["mudlark-lane"].ownerId = A;
		state.properties["teal-ridge"].ownerId = B;
		state.seats[0].gojfCards = 1;

		const description = monopolyInventoryEmbed(state, A).data.description ?? "";
		expect(description).toContain(gameRoomsCopy.monopoly.inventoryChips(1500));
		expect(description).toContain(gameRoomsCopy.monopoly.inventoryJailCards(1));
		expect(description).toContain("Lots: Mudlark Lane, Cinder Row");
		expect(description).not.toContain("Teal Ridge");
	});

	it("says so for a viewer with no seat, and for a seat that is out", () => {
		const state = freshMatch();
		expect(monopolyInventoryEmbed(state, "stranger").data.description).toBe(gameRoomsCopy.monopoly.notSeated);
		state.seats[1].bankrupt = true;
		expect(monopolyInventoryEmbed(state, B).data.description).toBe(gameRoomsCopy.monopoly.inventoryOut);
	});
});
