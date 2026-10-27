import { describe, it, expect } from "vitest";
import {
	boardStartRows,
	challengeBadge,
	CHALLENGE_GAMES,
	isCooperativeGame,
	openerCardEmbed,
	openerCardRows,
	type DraftHostControls,
	type OpenerCardState,
} from "./challengeBoardEmbeds.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
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

	it("shows neither before the visibility step, nor on a game with no voice lines, nor once the match has started", () => {
		for (const state of [card({ visibility: null }), card({ game: "rps" }), card({ game: "battleship" }), card({ startedChannelId: "ch-1" })]) {
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
			label: gameRoomsCopy.board.refereeToggleLabel(false),
		});
		expect(buttonsOf(card({ referee: true }))).toContainEqual({
			id: `${GAME_ROOM_PREFIX}:referee:room-1:off`,
			label: gameRoomsCopy.board.refereeToggleLabel(true),
		});
	});

	it("says on the card whether Dero referees, and that being in a voice channel brings Dero in", () => {
		expect(openerCardEmbed(card()).data.description).toContain(gameRoomsCopy.board.cardReferee(false));
		const on = openerCardEmbed(card({ referee: true })).data.description ?? "";
		expect(on).toContain(gameRoomsCopy.board.cardReferee(true));
		expect(on).toContain("voice channel");
	});

	// ── the referee on Hold'em (2026-10 item 257 Phase 4b, owner item 9) ──
	it("offers Hold'em the referee too, on a row of Gather, Start, the buy in, Referee and Cancel", () => {
		const holdem = card({ game: "holdem", referee: true });
		expect(buttonsOf(holdem).map((button) => button.id?.split(":")[1])).toEqual(["join", "start", "hbuyin", "referee", "cancel"]);
		expect(openerCardEmbed(holdem).data.description).toContain(gameRoomsCopy.board.cardReferee(true));
		// No auctions on a Hold'em card: that setting is Monopoly's alone.
		expect(openerCardEmbed(holdem).data.description ?? "").not.toContain("Auctions are");
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

// ── Play Dero instead and the closed card (post-launch plan items 13 and 21) ──
describe("the opener card's Play Dero button and its closed state", () => {
	const card = (overrides: Partial<OpenerCardState> = {}): OpenerCardState => ({
		game: "coinflip",
		hostId: "host-1",
		visibility: null,
		pool: [],
		...overrides,
	});
	const ids = (state: OpenerCardState): string[] =>
		openerCardRows("room-1", state).flatMap((row) => row.toJSON().components.map((button) => ("custom_id" in button ? button.custom_id : "")));

	it.each(["coinflip", "diceroll", "rps"] as const)("offers %s's host Play Dero at both steps", (game) => {
		expect(ids(card({ game }))).toContain(`${GAME_ROOM_PREFIX}:dero:room-1`);
		expect(ids(card({ game, visibility: "public" }))).toContain(`${GAME_ROOM_PREFIX}:dero:room-1`);
	});

	it.each(["hangman", "battleship", "holdem", "monopoly"] as const)("never offers it on %s, which has no solo round", (game) => {
		expect(ids(card({ game }))).not.toContain(`${GAME_ROOM_PREFIX}:dero:room-1`);
	});

	it("keeps the first step inside Discord's five per row with every choice offered", () => {
		const rows = openerCardRows("room-1", card({ allowNetwork: true }));
		for (const row of rows) expect(row.toJSON().components.length).toBeLessThanOrEqual(DISCORD_COMPONENTS_PER_ROW);
	});

	it("closes with its result line and no controls", () => {
		const closed = card({ visibility: "public", startedChannelId: "ch-9", resultLine: "👑 **<@p2>** won. A clean sweep." });
		expect(openerCardRows("room-1", closed)).toEqual([]);
		const description = openerCardEmbed(closed).toJSON().description ?? "";
		expect(description).toContain("A clean sweep.");
		expect(description).not.toContain(gameRoomsCopy.board.cardStarted("ch-9"));
	});
});

// ── the rated or casual badge (2026-10 item 254, Arcade 5) ──────────────
describe("challengeBadge", () => {
	it("is RATED for a rated game with no bot seated", () => {
		for (const game of ["holdem", "battleship", "monopoly"] as const) expect(challengeBadge(game, 0)).toBe("rated");
	});

	it("is CASUAL once a Dero bot is seated, since a match with a bot is never rated", () => {
		expect(challengeBadge("holdem", 1)).toBe("casual");
		expect(challengeBadge("battleship", 1)).toBe("casual");
	});

	it("is CASUAL for every game that is not rated", () => {
		for (const game of ["coinflip", "diceroll", "rps", "hangman", "blackjack"] as const) expect(challengeBadge(game, 0)).toBe("casual");
	});

	// 2026-10 item 254, Arcade 6: the host's Casual choice, even once people took every bot's seat.
	it("is CASUAL when the host chose Casual, with or without a bot left", () => {
		expect(challengeBadge("holdem", 0, true)).toBe("casual");
		expect(challengeBadge("monopoly", 2, true)).toBe("casual");
		expect(challengeBadge("monopoly", 0, false)).toBe("rated");
	});
});

// ── Rated or Casual on the card (2026-10 item 254, Arcade 6) ─────────────
describe("the Rated or Casual toggle", () => {
	const controls: DraftHostControls = { ratingBand: "any", requireApproval: false, pendingJoinCount: 0, spectatorMode: "open" };
	const base: OpenerCardState = { game: "monopoly", hostId: "host-1", visibility: "public", pool: [], hostControls: controls, bots: { count: 0 } };
	const customIds = (state: OpenerCardState): string[] =>
		openerCardRows("room-1", state).flatMap((row) => row.toJSON().components.map((component) => ("custom_id" in component ? component.custom_id : "")));

	it("offers Casual on a Rated card and Rated on a Casual one, beside Play vs bots", () => {
		expect(customIds(base)).toContain(`${GAME_ROOM_PREFIX}:casual:room-1:on`);
		expect(customIds({ ...base, casual: true, bots: { count: 3 } })).toContain(`${GAME_ROOM_PREFIX}:casual:room-1:off`);
		// A bot seated by hand already makes the card casual, so the toggle offers Rated.
		expect(customIds({ ...base, bots: { count: 1 } })).toContain(`${GAME_ROOM_PREFIX}:casual:room-1:off`);
	});

	it("is not offered where Play vs bots is not: a card without bots or a network table", () => {
		expect(customIds({ ...base, bots: undefined }).some((id) => id.includes(":casual:"))).toBe(false);
		expect(customIds({ ...base, network: true }).some((id) => id.includes(":casual:"))).toBe(false);
	});

	it("keeps the host row inside Discord's five buttons with every control showing", () => {
		const busy: OpenerCardState = { ...base, hostControls: { ...controls, requireApproval: true, pendingJoinCount: 2 }, pool: ["p1"] };
		for (const row of openerCardRows("room-1", busy)) expect(row.toJSON().components.length).toBeLessThanOrEqual(DISCORD_COMPONENTS_PER_ROW);
	});

	it("reads CASUAL on the card with its line while the draft gathers", () => {
		const description = openerCardEmbed({ ...base, casual: true }).data.description ?? "";
		expect(description.split("\n")[0]).toBe(gameRoomsCopy.board.badgeLine("casual", "monopoly"));
		expect(description).toContain(gameRoomsCopy.board.casual.cardLine);
	});
});

describe("the opener card's badge line", () => {
	const base: OpenerCardState = { game: "battleship", hostId: "host-1", visibility: "public", pool: [] };
	const firstLine = (state: OpenerCardState): string => (openerCardEmbed(state).data.description ?? "").split("\n")[0];

	it("leads a rated card with RATED and a casual one with CASUAL, from the one helper", () => {
		expect(firstLine(base)).toBe(gameRoomsCopy.board.badgeLine("rated", "battleship"));
		expect(firstLine({ ...base, game: "rps" })).toBe(gameRoomsCopy.board.badgeLine("casual", "rps"));
		// A bot seated turns the same card CASUAL; it does not move (that is the channel's call).
		expect(firstLine({ ...base, bots: { count: 1 } })).toBe(gameRoomsCopy.board.badgeLine("casual", "battleship"));
	});

	it("says a Hold'em card counts from the hands a table must play to be rated", () => {
		const line = firstLine({ ...base, game: "holdem" });
		expect(line).toContain("RATED");
		expect(line).toContain(`${BOT_CONSTANTS.RATINGS.HOLDEM_MIN_RATED_HANDS} hands`);
	});

	it("keeps the badge on a closed card too", () => {
		expect(firstLine({ ...base, resultLine: "done" })).toBe(gameRoomsCopy.board.badgeLine("rated", "battleship"));
	});
});

// ── who may watch (2026-10 item 254, Arcade 11) ─────────────────────────
describe("the opener card's spectator setting", () => {
	const controls = (spectatorMode: DraftHostControls["spectatorMode"]): DraftHostControls => ({ ratingBand: "any", requireApproval: false, pendingJoinCount: 0, spectatorMode });
	const base: OpenerCardState = { game: "rps", hostId: "host-1", visibility: "invite", pool: [], hostControls: controls("invite") };
	const spectatorSelectOf = (state: OpenerCardState) =>
		openerCardRows("room-1", state)
			.map((row) => row.toJSON().components[0] as { custom_id?: string; options?: Array<{ value: string; default?: boolean }> })
			.find((component) => component.custom_id === "gameroomSelect:spectators:room-1");

	it("offers the three settings once the host chose who can see it, with the one in force as default", () => {
		const select = spectatorSelectOf({ ...base, hostControls: controls("none") });
		expect(select?.options?.map((option) => option.value)).toEqual(["open", "invite", "none"]);
		expect(select?.options?.find((option) => option.default)?.value).toBe("none");
		expect(openerCardEmbed({ ...base, hostControls: controls("none") }).data.description).toContain(gameRoomsCopy.board.spectators.cardLine("none"));
	});

	it("is not offered on a network table or on a closed card", () => {
		expect(spectatorSelectOf({ ...base, visibility: "public", network: true })).toBeUndefined();
		expect(spectatorSelectOf({ ...base, startedChannelId: "room-ch-1" })).toBeUndefined();
	});

	// From the first step on every game (2026-10 item 257 Phase 4b, owner item 24). Its default is
	// only the host's own choice there: the resolved default waits on a visibility not chosen yet.
	it("is offered at the visibility step, defaulting only to a choice the host already made, with no line yet", () => {
		const unchosen = spectatorSelectOf({ ...base, visibility: null });
		expect(unchosen?.options?.map((option) => option.value)).toEqual(["open", "invite", "none"]);
		expect(unchosen?.options?.some((option) => option.default)).toBe(false);
		const chosen = spectatorSelectOf({ ...base, visibility: null, hostControls: { ...controls("invite"), spectatorChoice: "none" } });
		expect(chosen?.options?.find((option) => option.default)?.value).toBe("none");
		expect(openerCardEmbed({ ...base, visibility: null }).data.description ?? "").not.toContain("👀");
	});

	it("keeps a rated public card inside Discord's five rows with every control showing", () => {
		const rows = openerCardRows("room-1", { ...base, game: "holdem", visibility: "public", hostControls: controls("open") });
		expect(rows.length).toBeLessThanOrEqual(5);
		expect(spectatorSelectOf({ ...base, game: "holdem", visibility: "public", hostControls: controls("open") })).toBeDefined();
	});
});
