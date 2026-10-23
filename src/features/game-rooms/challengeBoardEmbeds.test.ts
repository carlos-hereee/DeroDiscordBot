import { describe, it, expect } from "vitest";
import { boardStartRows, CHALLENGE_GAMES, isCooperativeGame, openerCardEmbed, openerCardRows, type OpenerCardState } from "./challengeBoardEmbeds.js";
import { GAME_ROOM_PREFIX } from "./gameRoomActions.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";

// Discord's hard cap on components per action row. Six buttons in one row is what kept
// this board dark: a send past the cap fails with 50035 and nothing posts, so the
// intro sweep would have thrown on every boot of every guild.
const DISCORD_COMPONENTS_PER_ROW = 5;

describe("boardStartRows", () => {
	const rows = boardStartRows();
	const customIds = rows.flatMap((row) =>
		row.toJSON().components.map((button) => ("custom_id" in button ? button.custom_id : undefined))
	);

	it("never puts more than five buttons in a row", () => {
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) expect(row.toJSON().components.length).toBeLessThanOrEqual(DISCORD_COMPONENTS_PER_ROW);
	});

	it("emits exactly one new-room button per challenge game, in roster order", () => {
		expect(customIds).toEqual(CHALLENGE_GAMES.map((game) => `${GAME_ROOM_PREFIX}:new:${game}`));
	});

	it("reaches battleship and hold em, which no slash command doors", () => {
		expect(customIds).toContain(`${GAME_ROOM_PREFIX}:new:battleship`);
		expect(customIds).toContain(`${GAME_ROOM_PREFIX}:new:holdem`);
	});

	it("reaches monopoly, which seats the whole pool rather than one chosen opponent", () => {
		expect(customIds).toContain(`${GAME_ROOM_PREFIX}:new:monopoly`);
		expect(isCooperativeGame("monopoly")).toBe(true);
	});
});

// ── Monopoly's auction choice on the opener card ──
describe("the opener card's Monopoly auction toggle", () => {
	const card = (overrides: Partial<OpenerCardState> = {}): OpenerCardState => ({
		game: "monopoly",
		hostId: "host-1",
		visibility: "public",
		pool: [],
		...overrides,
	});
	const buttonsOf = (state: OpenerCardState) =>
		openerCardRows("room-1", state).flatMap((row) =>
			row.toJSON().components.map((button) => ({
				id: "custom_id" in button ? button.custom_id : undefined,
				label: "label" in button ? button.label : undefined,
			}))
		);

	it("offers the toggle beside Start, naming the value a press switches to", () => {
		expect(buttonsOf(card())).toContainEqual({
			id: `${GAME_ROOM_PREFIX}:auctions:room-1:on`,
			label: gameRoomsCopy.board.monopolyAuctionsToggleLabel(false),
		});
		expect(buttonsOf(card({ monopolyAuctions: true }))).toContainEqual({
			id: `${GAME_ROOM_PREFIX}:auctions:room-1:off`,
			label: gameRoomsCopy.board.monopolyAuctionsToggleLabel(true),
		});
		for (const row of openerCardRows("room-1", card())) {
			expect(row.toJSON().components.length).toBeLessThanOrEqual(DISCORD_COMPONENTS_PER_ROW);
		}
	});

	it("says on the card what the current choice means", () => {
		expect(openerCardEmbed(card()).data.description).toContain(gameRoomsCopy.board.cardMonopolyAuctions(false));
		expect(openerCardEmbed(card({ monopolyAuctions: true })).data.description).toContain(gameRoomsCopy.board.cardMonopolyAuctions(true));
	});

	it("shows neither before the visibility step, nor on another game's card, nor once the match has started", () => {
		for (const state of [card({ visibility: null }), card({ game: "rps" }), card({ startedChannelId: "ch-1" })]) {
			expect(buttonsOf(state).some((button) => button.id?.includes(":auctions:"))).toBe(false);
			expect(buttonsOf(state).some((button) => button.id?.includes(":referee:"))).toBe(false);
			expect(openerCardEmbed(state).data.description ?? "").not.toContain("Auctions are");
			expect(openerCardEmbed(state).data.description ?? "").not.toContain("Voice referee is");
		}
	});

	// ── the voice referee toggle (Session 5c) ──
	it("lays the row out as Gather, Start, Auctions, Referee, Cancel: exactly Discord's five", () => {
		const rows = openerCardRows("room-1", card());
		expect(rows).toHaveLength(1);
		expect(buttonsOf(card()).map((button) => button.id?.split(":")[1])).toEqual(["join", "start", "auctions", "referee", "cancel"]);
		expect(rows[0].toJSON().components).toHaveLength(DISCORD_COMPONENTS_PER_ROW);
	});

	it("offers the referee toggle naming the value a press switches to", () => {
		expect(buttonsOf(card())).toContainEqual({
			id: `${GAME_ROOM_PREFIX}:referee:room-1:on`,
			label: gameRoomsCopy.board.monopolyRefereeToggleLabel(false),
		});
		expect(buttonsOf(card({ monopolyReferee: true }))).toContainEqual({
			id: `${GAME_ROOM_PREFIX}:referee:room-1:off`,
			label: gameRoomsCopy.board.monopolyRefereeToggleLabel(true),
		});
	});

	it("says on the card whether Dero referees, and how a call starts when it does", () => {
		expect(openerCardEmbed(card()).data.description).toContain(gameRoomsCopy.board.cardMonopolyReferee(false));
		const on = openerCardEmbed(card({ monopolyReferee: true })).data.description ?? "";
		expect(on).toContain(gameRoomsCopy.board.cardMonopolyReferee(true));
		expect(on).toContain("/dero join");
	});
});

// The challenge post's text card leads with the game's logo too (2026-10 item
// 245 Phase 3b), but only while there is no picture, which carries the logo itself.
describe("the opener card's logo thumbnail", () => {
	const state: OpenerCardState = { game: "battleship", hostId: "host-1", visibility: null, pool: [] };
	const logoRef = "attachment://opener-logo.png";

	it("carries the game's logo as the thumbnail while the card has no picture", () => {
		expect(openerCardEmbed(state, undefined, logoRef).data.thumbnail?.url).toBe(logoRef);
	});

	it("drops the thumbnail once the picture is attached, so the logo shows once", () => {
		const pictured = openerCardEmbed(state, "attachment://challenge-abc.png", logoRef).data;
		expect(pictured.image?.url).toBe("attachment://challenge-abc.png");
		expect(pictured.thumbnail).toBeUndefined();
	});
});
