import { describe, it, expect, vi, beforeEach } from "vitest";
import { AttachmentBuilder } from "discord.js";

// The board picture. Mocked so these cases pin the embed with and without one,
// whatever art happens to be on disk where the suite runs.
vi.mock("@features/games/monopolyRenderer.js", () => ({ renderBoard: vi.fn() }));

import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { createInitialState, type MonopolyState } from "@features/games/monopolyState.js";
import { renderBoard } from "@features/games/monopolyRenderer.js";
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

const renderMock = renderBoard as unknown as ReturnType<typeof vi.fn>;
const PICTURE_REF = "attachment://monopoly-board-1.png";

const descriptionOf = async (state: MonopolyState): Promise<string> => (await monopolyBoardEmbed(state)).embed.data.description ?? "";

beforeEach(() => {
	renderMock.mockReset();
	// No picture unless a case asks for one: the text board is the default.
	renderMock.mockResolvedValue(null);
});

const rowsJson = (state: MonopolyState, viewerId: string) =>
	monopolyControlsRow(state, viewerId, ROOM).map((row) => row.toJSON().components as Array<{ custom_id?: string; label?: string; disabled?: boolean }>);

describe("monopolyBoardEmbed", () => {
	it("renders a fresh match: whose turn, the prompt, every seat and the token map", async () => {
		const description = await descriptionOf(freshMatch());

		expect((await monopolyBoardEmbed(freshMatch())).embed.data.title).toBe(gameRoomsCopy.monopoly.boardTitle);
		expect(description).toContain(gameRoomsCopy.monopoly.onTheClock(A));
		expect(description).toContain(gameRoomsCopy.monopoly.rollPrompt);
		expect(description).toContain(`<@${A}> · $1500 · 0 lots · on GO`);
		expect(description).toContain(`<@${B}> · $1500 · 0 lots · on GO`);
		// Both tokens start on GO, so tile 0 shows "+" and the rest of the side is empty.
		expect(description).toContain(" 0  + · · · · · · · · ·");
		expect(description).toContain(`**${gameRoomsCopy.monopoly.lastMoveLabel}** ${gameRoomsCopy.monopoly.noMovesYet}`);
	});

	it("puts a lone token's seat number on its tile and counts owned lots", async () => {
		const state = freshMatch();
		state.seats[1].position = 3;
		state.properties["burnt-umber-row"].ownerId = B;

		const description = await descriptionOf(state);
		expect(description).toContain(" 0  1 · · 2 · · · · · ·");
		expect(description).toContain(`<@${B}> · $1500 · 1 lot · on Burnt Umber Row`);
	});

	it("shows the last trail line and tags jailed and bankrupt seats", async () => {
		const state = freshMatch();
		state.log.push({ userId: A, text: `<@${A}> rolled 1 and 2.` });
		state.seats[0].inJail = true;
		state.seats[1].bankrupt = true;

		const description = await descriptionOf(state);
		expect(description).toContain(`<@${A}> rolled 1 and 2.`);
		expect(description).toContain(`(${gameRoomsCopy.monopoly.inJailTag})`);
		expect(description).toContain(`(${gameRoomsCopy.monopoly.outTag})`);
		expect(description).toContain(gameRoomsCopy.monopoly.jailPrompt);
	});

	it("names the winner once the match is finished", async () => {
		const state = freshMatch();
		state.phase = "finished";
		state.winnerId = B;
		expect(await descriptionOf(state)).toContain(gameRoomsCopy.monopoly.finishedLine(B));
	});

	it("names the lot up for auction and when its round closes", async () => {
		const state = freshMatch();
		state.phase = "in-auction";
		state.pendingAuction = { tileId: "burnt-umber-row", bids: {}, roundOpenedAt: 1_000_000, skippedBy: A };
		expect(await descriptionOf(state)).toContain(
			gameRoomsCopy.monopoly.auctionPrompt("Burnt Umber Row", 1_000_000 + BOT_CONSTANTS.MONOPOLY_AUCTION_ROUND_MS)
		);
	});

	it("returns no attachment and keeps the token map when there is no board picture", async () => {
		const board = await monopolyBoardEmbed(freshMatch());
		expect(board.attachment).toBeNull();
		expect(board.embed.data.image).toBeUndefined();
		expect(board.embed.data.description).toContain(gameRoomsCopy.monopoly.boardMapLabel);
	});

	it("shows the rendered picture in place of the token map, and keeps every seat line", async () => {
		const attachment = new AttachmentBuilder(Buffer.from("png"), { name: "monopoly-board-1.png" });
		renderMock.mockResolvedValue({ attachment, ref: PICTURE_REF });
		const state = freshMatch();

		const board = await monopolyBoardEmbed(state);

		expect(renderMock).toHaveBeenCalledWith(state);
		expect(board.attachment).toBe(attachment);
		expect(board.embed.data.image?.url).toBe(PICTURE_REF);
		const description = board.embed.data.description ?? "";
		expect(description).not.toContain(gameRoomsCopy.monopoly.boardMapLabel);
		expect(description).not.toContain("```");
		// The seat lines name every tile in words, so the picture is never the only
		// place a position can be read.
		expect(description).toContain(`<@${A}> · $1500 · 0 lots · on GO`);
		expect(description).toContain(gameRoomsCopy.monopoly.onTheClock(A));
	});
});

describe("monopolyControlsRow", () => {
	const idsByRow = (state: MonopolyState, viewerId: string) => rowsJson(state, viewerId).map((row) => row.map((button) => button.custom_id));
	const ANY_TIME = [`gameroom:mtrade:${ROOM}`, `gameroom:minventory:${ROOM}`];

	// A owns the whole brown group, unimproved, so a house is legal on either lot.
	const brownOwner = (): MonopolyState => {
		const state = freshMatch();
		state.properties["vermillion-alley"].ownerId = A;
		state.properties["burnt-umber-row"].ownerId = A;
		return state;
	};

	it("offers the active seat Roll, then Trade and Inventory, before the roll", () => {
		expect(idsByRow(freshMatch(), A)).toEqual([[`gameroom:mroll:${ROOM}`], ANY_TIME]);
	});

	it("offers a viewer who is not on the clock Trade and Inventory only", () => {
		expect(idsByRow(freshMatch(), B)).toEqual([ANY_TIME]);
	});

	it("offers a jailed seat the three ways out, greying the card it does not hold", () => {
		const state = freshMatch();
		state.seats[0].inJail = true;
		state.seats[0].jailTurnsRemaining = 3;

		const [row, anyTime] = rowsJson(state, A);
		expect(row.map((button) => button.custom_id)).toEqual([`gameroom:mjail:${ROOM}:bail`, `gameroom:mjail:${ROOM}:card`, `gameroom:mjail:${ROOM}:roll`]);
		expect(row[0]).toMatchObject({ label: gameRoomsCopy.monopoly.bailLabel(50), disabled: false });
		expect(row[1]).toMatchObject({ label: gameRoomsCopy.monopoly.useCardLabel, disabled: true });
		expect(anyTime.map((button) => button.custom_id)).toEqual(ANY_TIME);
	});

	it("offers Buy with the lot and price on it, and Skip, on a lot for sale", () => {
		const state = freshMatch();
		state.phase = "awaiting-buy-or-skip";
		state.seats[0].position = 3;

		const [row] = rowsJson(state, A);
		expect(row.map((button) => button.custom_id)).toEqual([`gameroom:mbuy:${ROOM}:burnt-umber-row`, `gameroom:mskip:${ROOM}`]);
		expect(row[0]).toMatchObject({ label: "Buy Burnt Umber Row for $60", disabled: false });
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
		expect(idsByRow(state, A)).toEqual([[`gameroom:mend:${ROOM}`], ANY_TIME]);
	});

	it("offers nothing once the match is finished", () => {
		const state = freshMatch();
		state.phase = "finished";
		expect(monopolyControlsRow(state, A, ROOM)).toEqual([]);
	});

	it("offers Build to the seat on the clock before its roll when a build would go through, and nowhere else", () => {
		const state = brownOwner();
		expect(idsByRow(state, A)[1]).toEqual([`gameroom:mbuild:${ROOM}`, ...ANY_TIME]);
		// Off turn, and after the roll, the engine would refuse, so the button is absent.
		expect(idsByRow(state, B)).toEqual([ANY_TIME]);
		state.phase = "post-roll";
		expect(idsByRow(state, A)[1]).toEqual(ANY_TIME);
	});

	it("leaves Build off when the seat owns only part of a color group", () => {
		const state = freshMatch();
		state.properties["vermillion-alley"].ownerId = A;
		expect(idsByRow(state, A)[1]).toEqual(ANY_TIME);
	});

	it("labels Trade as an open offer while one waits", () => {
		const state = freshMatch();
		state.pendingTrade = {
			initiatorId: A,
			counterpartyId: B,
			offer: { properties: [], chips: 10, gojf: 0 },
			request: { properties: [], chips: 0, gojf: 0 },
			openedAt: 5,
		};
		const anyTime = rowsJson(state, B)[0];
		expect(anyTime[0]).toMatchObject({ custom_id: `gameroom:mtrade:${ROOM}`, label: gameRoomsCopy.monopoly.tradeOpenLabel });
	});

	it("offers EVERY seat the bid button during an auction, with the round it belongs to", () => {
		const state = freshMatch();
		state.phase = "in-auction";
		state.pendingAuction = { tileId: "burnt-umber-row", bids: {}, roundOpenedAt: 1_234, skippedBy: A };

		for (const viewer of [A, B]) {
			const [turn] = rowsJson(state, viewer);
			expect(turn).toEqual([expect.objectContaining({ custom_id: `gameroom:mauction:${ROOM}:1234`, label: gameRoomsCopy.monopoly.bidLabel("Burnt Umber Row") })]);
		}
	});

	it("offers no turn control in an auction phase with no auction recorded", () => {
		const state = freshMatch();
		state.phase = "in-auction";
		expect(idsByRow(state, A)).toEqual([ANY_TIME]);
	});

	it("stays inside Discord's caps and emits only Monopoly actions, in every phase", () => {
		const phases: MonopolyState["phase"][] = ["pre-roll", "awaiting-buy-or-skip", "post-roll", "in-auction", "in-trade"];
		for (const phase of phases) {
			for (const inJail of [false, true]) {
				// The widest board there is: Build on offer AND in jail AND an auction recorded.
				const state = brownOwner();
				state.phase = phase;
				state.seats[0].inJail = inJail;
				state.seats[0].position = 3;
				state.pendingAuction = phase === "in-auction" ? { tileId: "reader-dock", bids: {}, roundOpenedAt: 1, skippedBy: A } : null;
				const rows = rowsJson(state, A);
				expect(rows.length).toBeLessThanOrEqual(MAX_ROWS);
				for (const row of rows) expect(row.length).toBeLessThanOrEqual(DISCORD_COMPONENTS_PER_ROW);
				for (const id of rows.flat().map((button) => button.custom_id ?? "")) {
					expect(id).toMatch(/^gameroom:(mroll|mbuy|mskip|mend|mjail|minventory|mbuild|mtrade|mauction):/);
				}
			}
		}
	});
});

describe("monopolyInventoryEmbed", () => {
	it("shows the viewer their own chips, jail cards and lots by name", () => {
		const state = freshMatch();
		state.properties["burnt-umber-row"].ownerId = A;
		state.properties["vermillion-alley"].ownerId = A;
		state.properties["reader-dock"].ownerId = B;
		state.seats[0].gojfCards = 1;

		const description = monopolyInventoryEmbed(state, A).data.description ?? "";
		expect(description).toContain(gameRoomsCopy.monopoly.inventoryChips(1500));
		expect(description).toContain(gameRoomsCopy.monopoly.inventoryJailCards(1));
		expect(description).toContain("Lots: Vermillion Alley, Burnt Umber Row");
		expect(description).not.toContain("Reader Dock");
	});

	it("says so for a viewer with no seat, and for a seat that is out", () => {
		const state = freshMatch();
		expect(monopolyInventoryEmbed(state, "stranger").data.description).toBe(gameRoomsCopy.monopoly.notSeated);
		state.seats[1].bankrupt = true;
		expect(monopolyInventoryEmbed(state, B).data.description).toBe(gameRoomsCopy.monopoly.inventoryOut);
	});
});
