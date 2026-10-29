import { describe, it, expect, vi, beforeEach } from "vitest";
import { AttachmentBuilder } from "discord.js";

// The board picture. Mocked so these cases pin the embed with and without one,
// whatever art happens to be on disk where the suite runs.
vi.mock("@features/games/monopolyRenderer.js", () => ({ renderBoard: vi.fn() }));

import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { createInitialState, type MonopolyState } from "@features/games/monopolyState.js";
import { renderBoard } from "@features/games/monopolyRenderer.js";
import { monopolyBoardEmbed, monopolyControlsRow, monopolyInventoryEmbed, monopolyInventoryReply, monopolyPromptButtons } from "./roomMonopoly.js";
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

	// The block moved to turnLog.ts for every game (2026-10 item 263 R3-29) and must read exactly as
	// the owner saw it on Monopoly's board: the bold header, then the turn's lines, at the bottom.
	it("ends with the turn's This turn block, exactly as before the block was shared", async () => {
		const state = { ...freshMatch(), turnLog: [`<@${A}> rolled 1 and 2.`, `<@${A}> landed on Burnt Umber Row.`] };
		expect(await descriptionOf(state)).toMatch(new RegExp(`\\n\\n\\*\\*This turn:\\*\\*\\n<@${A}> rolled 1 and 2\\.\\n<@${A}> landed on Burnt Umber Row\\.$`));
		const longTurn = { ...freshMatch(), turnLog: Array.from({ length: 40 }, (_, index) => `${index} ${"x".repeat(90)}`) };
		expect(await descriptionOf(longTurn)).toMatch(/\*\*This turn:\*\*\n\(\d+ earlier lines this turn\)\n/);
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

		expect(renderMock).toHaveBeenCalledWith(state, expect.any(Number), expect.any(Map));
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
	// What the turn line carries beside Take your turn (2026-10 item 263 R3-22), which the board
	// shows only while a Dero bot is on the clock, since a bot gets no turn line.
	const LINE = [`gameroom:mtrade:${ROOM}`, `gameroom:minventory:${ROOM}`, `gameroom:msurrender:${ROOM}`];
	// A Dero bot seat on the clock: seat one.
	const BOT = "dero-bot-red";
	const botMatch = (): MonopolyState => createInitialState([BOT, A], { auctionsEnabled: false }, 0, 1);

	// A owns the whole brown group, unimproved, so a house is legal on either lot.
	const brownOwner = (): MonopolyState => {
		const state = freshMatch();
		state.properties["vermillion-alley"].ownerId = A;
		state.properties["burnt-umber-row"].ownerId = A;
		return state;
	};

	it("leaves a member's turn moves, Trade, Inventory and Surrender to the turn line, so the board shows none of them", () => {
		for (const phase of ["pre-roll", "awaiting-buy-or-skip", "post-roll"] as const) {
			const state = freshMatch();
			state.phase = phase;
			state.seats[0].position = 3;
			expect(idsByRow(state, A)).toEqual([]);
		}
		const jailed = freshMatch();
		jailed.seats[0].inJail = true;
		jailed.seats[0].jailTurnsRemaining = 3;
		expect(idsByRow(jailed, A)).toEqual([]);
	});

	it("leaves Bid to the turn line during a member's auction", () => {
		const state = freshMatch();
		state.phase = "in-auction";
		state.pendingAuction = { tileId: "burnt-umber-row", bids: {}, roundOpenedAt: 1_234, skippedBy: A };
		expect(idsByRow(state, A)).toEqual([]);
	});

	it("offers nothing once the match is finished", () => {
		const state = freshMatch();
		state.phase = "finished";
		expect(monopolyControlsRow(state, A, ROOM)).toEqual([]);
	});

	it("puts Build on the turn line for the seat on the clock before its roll, and never on the board", () => {
		const state = brownOwner();
		const promptIds = () => monopolyPromptButtons(state, ROOM).map((button) => (button.toJSON() as { custom_id: string }).custom_id);
		expect(promptIds()).toContain(`gameroom:mbuild:${ROOM}`);
		// The board keeps none of the line's buttons while a member is on the clock.
		expect(idsByRow(state, A)).toEqual([]);
		// After the roll the engine would refuse, so the button is absent.
		state.phase = "post-roll";
		expect(promptIds()).not.toContain(`gameroom:mbuild:${ROOM}`);
	});

	it("leaves Build off when the seat owns only part of a color group", () => {
		const state = freshMatch();
		state.properties["vermillion-alley"].ownerId = A;
		expect(idsByRow(state, A)).toEqual([]);
	});

	it("offers EVERY seat the Pay button while the match waits on a debt, priced, and the prompt names the debtor", async () => {
		const state = freshMatch();
		state.phase = "awaiting-debt";
		state.seats[1].chips = 30;
		state.pendingDebt = { debts: [{ debtorId: B, creditorId: "bank", amount: 50 }], resumePhase: "post-roll", moveAfter: null };

		// On the turn line every seat can press it, and the board keeps none of the line's buttons.
		const pay = monopolyPromptButtons(state, ROOM).map((button) => button.toJSON());
		expect(pay).toContainEqual(expect.objectContaining({ custom_id: `gameroom:mpaydebt:${ROOM}`, label: gameRoomsCopy.monopoly.payDebtLabel(50) }));
		for (const viewer of [A, B]) expect(rowsJson(state, viewer)).toEqual([]);
		expect(await descriptionOf(state)).toContain(gameRoomsCopy.monopoly.debtPrompt(B, gameRoomsCopy.monopoly.bankCreditor, 50, 30));
	});

	// A Dero bot on the clock gets a quiet turn line too (turnPrompt), so these ride it, never the card.
	const promptJson = (state: MonopolyState) => monopolyPromptButtons(state, ROOM).map((button) => button.toJSON() as { custom_id: string; label?: string });

	it("puts Trade, Inventory and Surrender on a Dero bot's turn line and leaves the card bare, never its Build", () => {
		const state = botMatch();
		state.properties["vermillion-alley"].ownerId = BOT;
		state.properties["burnt-umber-row"].ownerId = BOT;
		expect(idsByRow(state, BOT)).toEqual([]);
		expect(promptJson(state).map((button) => button.custom_id)).toEqual(LINE);
	});

	it("puts Bid on the turn line during a Dero bot's auction, with the round it belongs to", () => {
		const state = botMatch();
		state.phase = "in-auction";
		state.pendingAuction = { tileId: "burnt-umber-row", bids: {}, roundOpenedAt: 1_234, skippedBy: BOT };
		expect(rowsJson(state, BOT)).toEqual([]);
		expect(promptJson(state)[0]).toEqual(expect.objectContaining({ custom_id: `gameroom:mauction:${ROOM}:1234`, label: gameRoomsCopy.monopoly.bidLabel("Burnt Umber Row") }));
	});

	it("labels Trade as an open offer while one waits", () => {
		const state = botMatch();
		state.pendingTrade = {
			initiatorId: A,
			counterpartyId: BOT,
			offer: { properties: [], chips: 10, gojf: 0 },
			request: { properties: [], chips: 0, gojf: 0 },
			openedAt: 5,
		};
		expect(promptJson(state)[0]).toMatchObject({ custom_id: `gameroom:mtrade:${ROOM}`, label: gameRoomsCopy.monopoly.tradeOpenLabel });
	});

	it("stays inside Discord's caps and emits only Monopoly actions, in every phase, on a member's turn and a bot's", () => {
		const phases: MonopolyState["phase"][] = ["pre-roll", "awaiting-buy-or-skip", "post-roll", "in-auction", "in-trade", "awaiting-debt"];
		for (const phase of phases) {
			for (const onClock of [A, BOT]) {
				// The widest board there is: Build on offer AND an auction or a debt recorded.
				const state = onClock === A ? brownOwner() : botMatch();
				state.phase = phase;
				state.pendingAuction = phase === "in-auction" ? { tileId: "reader-dock", bids: {}, roundOpenedAt: 1, skippedBy: onClock } : null;
				state.pendingDebt = phase === "awaiting-debt" ? { debts: [{ debtorId: B, creditorId: "bank", amount: 50 }], resumePhase: "post-roll", moveAfter: null } : null;
				const rows = rowsJson(state, onClock);
				expect(rows.length).toBeLessThanOrEqual(MAX_ROWS);
				for (const row of rows) expect(row.length).toBeLessThanOrEqual(DISCORD_COMPONENTS_PER_ROW);
				for (const id of rows.flat().map((button) => button.custom_id ?? "")) {
					expect(id).toMatch(/^gameroom:(mbuild|mpaydebt|mauction|mtrade|minventory|msurrender):/);
				}
			}
		}
	});
});

describe("monopolyPromptButtons", () => {
	it("puts Trade, Inventory and Surrender on a member's turn line, and Bid first during an auction, four at most beside Take your turn", () => {
		const ids = (state: MonopolyState) => monopolyPromptButtons(state, ROOM).map((button) => (button.toJSON() as { custom_id: string }).custom_id);
		const state = freshMatch();
		expect(ids(state)).toEqual([`gameroom:mtrade:${ROOM}`, `gameroom:minventory:${ROOM}`, `gameroom:msurrender:${ROOM}`]);
		state.phase = "in-auction";
		state.pendingAuction = { tileId: "burnt-umber-row", bids: {}, roundOpenedAt: 1_234, skippedBy: A };
		expect(ids(state)).toEqual([`gameroom:mauction:${ROOM}:1234`, `gameroom:mtrade:${ROOM}`, `gameroom:minventory:${ROOM}`, `gameroom:msurrender:${ROOM}`]);
		expect(ids(state).length).toBeLessThan(DISCORD_COMPONENTS_PER_ROW);
	});
});

describe("monopolyInventoryEmbed", () => {
	it("shows the viewer their own chips, jail cards and lots by name, in board order", () => {
		const state = freshMatch();
		state.properties["burnt-umber-row"].ownerId = A;
		state.properties["vermillion-alley"].ownerId = A;
		state.properties["reader-dock"].ownerId = B;
		state.seats[0].gojfCards = 1;

		const description = monopolyInventoryEmbed(state, A).data.description ?? "";
		expect(description).toContain(gameRoomsCopy.monopoly.inventoryChips(1500));
		expect(description).toContain(gameRoomsCopy.monopoly.inventoryJailCards(1));
		expect(description).toContain(`${gameRoomsCopy.monopoly.inventoryLotsHeader}\n• Vermillion Alley\n• Burnt Umber Row`);
		expect(description).not.toContain("Reader Dock");
	});

	it("says what is on each lot: its houses, its hotel, or its mortgage and what lifting it costs", () => {
		const state = freshMatch();
		for (const id of ["vermillion-alley", "burnt-umber-row", "reader-dock", "petal-court"]) state.properties[id].ownerId = A;
		state.properties["vermillion-alley"].houses = 2;
		state.properties["burnt-umber-row"].houses = 1;
		state.properties["petal-court"].hotel = true;
		state.properties["reader-dock"].mortgaged = true;

		const description = monopolyInventoryEmbed(state, A).data.description ?? "";
		expect(description).toContain("• Vermillion Alley (2 houses)");
		expect(description).toContain("• Burnt Umber Row (1 house)");
		expect(description).toContain("• Petal Court (hotel)");
		// Reader Dock mortgages for $50; lifting it costs that plus 10 percent.
		expect(description).toContain("• Reader Dock (mortgaged, $55 to lift)");
	});

	it("says so when the viewer owns nothing yet", () => {
		expect(monopolyInventoryEmbed(freshMatch(), A).data.description).toContain(gameRoomsCopy.monopoly.inventoryNoLots);
	});

	it("says so for a viewer with no seat, and for a seat that is out", () => {
		const state = freshMatch();
		expect(monopolyInventoryEmbed(state, "stranger").data.description).toBe(gameRoomsCopy.monopoly.notSeated);
		state.seats[1].bankrupt = true;
		expect(monopolyInventoryEmbed(state, B).data.description).toBe(gameRoomsCopy.monopoly.inventoryOut);
	});
});

describe("monopolyInventoryReply", () => {
	type SelectJson = { custom_id: string; options: { label: string; value: string }[] };
	const selectsOf = (reply: ReturnType<typeof monopolyInventoryReply>): SelectJson[] =>
		reply.components.map((row) => row.toJSON().components[0] as unknown as SelectJson);

	// A owns Reader Dock (mortgaged) and the brown group, unimproved.
	function holdings(): MonopolyState {
		const state = freshMatch();
		for (const id of ["vermillion-alley", "burnt-umber-row", "reader-dock"]) state.properties[id].ownerId = A;
		state.properties["reader-dock"].mortgaged = true;
		return state;
	}

	it("offers a select for each lot the viewer could mortgage and one for each mortgage they could lift", () => {
		const [mortgage, lift] = selectsOf(monopolyInventoryReply(holdings(), A, ROOM));
		expect(mortgage.custom_id).toBe(`gameroomSelect:mmortgage:${ROOM}`);
		expect(mortgage.options).toEqual([
			{ label: gameRoomsCopy.monopoly.mortgageOptionLabel("Vermillion Alley", 30), value: "vermillion-alley" },
			{ label: gameRoomsCopy.monopoly.mortgageOptionLabel("Burnt Umber Row", 30), value: "burnt-umber-row" },
		]);
		expect(lift.custom_id).toBe(`gameroomSelect:munmortgage:${ROOM}`);
		expect(lift.options).toEqual([{ label: gameRoomsCopy.monopoly.unmortgageOptionLabel("Reader Dock", 55), value: "reader-dock" }]);
	});

	it("explains mortgages under the lots when it offers them", () => {
		const reply = monopolyInventoryReply(holdings(), A, ROOM);
		expect(reply.embeds[0].data.description).toContain(gameRoomsCopy.monopoly.inventoryMortgageHint);
	});

	it("leaves out a lot whose group has buildings and a mortgage the viewer cannot afford, and offers the house for sale instead", () => {
		const state = holdings();
		state.properties["vermillion-alley"].houses = 1;
		state.seats[0].chips = 54;
		const selects = selectsOf(monopolyInventoryReply(state, A, ROOM));
		expect(selects.map((select) => select.custom_id)).toEqual([`gameroomSelect:msell:${ROOM}`]);
		expect(selects[0].options).toEqual([{ label: gameRoomsCopy.monopoly.sellOptionLabel("Vermillion Alley", "house", 25), value: "vermillion-alley" }]);
	});

	it("opens the debtor's own peek with what they owe and how much more they need", () => {
		const state = holdings();
		state.seats[0].chips = 20;
		state.phase = "awaiting-debt";
		state.pendingDebt = { debts: [{ debtorId: A, creditorId: B, amount: 100 }], resumePhase: "post-roll", moveAfter: null };

		const description = monopolyInventoryReply(state, A, ROOM).embeds[0].data.description ?? "";
		expect(description.startsWith(gameRoomsCopy.monopoly.inventoryDebtLine(100, `<@${B}>`, 80))).toBe(true);
		// Only the debtor sees it.
		expect(monopolyInventoryReply(state, B, ROOM).embeds[0].data.description).not.toContain("You owe");
	});

	it("offers no controls to a viewer with nothing to mortgage, a seat that is out, or once the match is over", () => {
		expect(monopolyInventoryReply(freshMatch(), A, ROOM).components).toEqual([]);
		const out = holdings();
		out.seats[0].bankrupt = true;
		expect(monopolyInventoryReply(out, A, ROOM).components).toEqual([]);
		const over = holdings();
		over.phase = "finished";
		expect(monopolyInventoryReply(over, A, ROOM).components).toEqual([]);
	});
});
