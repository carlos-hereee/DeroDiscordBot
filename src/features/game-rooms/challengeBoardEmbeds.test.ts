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

// ── the settings line (2026-10 item 263 Phase 2a) ──
// The card names every setting in force on one line while it gathers, since the creation modal
// chose them and no card control does any more. Read off the card state, which is the row.
describe("the opener card's settings line", () => {
	const controls: DraftHostControls = { ratingBand: "any", requireApproval: false, pendingJoinCount: 0, spectatorMode: "open" };
	const card = (overrides: Partial<OpenerCardState> = {}): OpenerCardState => ({
		game: "monopoly",
		hostId: "host-1",
		visibility: "public",
		pool: [],
		hostControls: controls,
		...overrides,
	});
	const words = gameRoomsCopy.creation.summary;
	const settingsLineOf = (state: OpenerCardState): string | undefined =>
		(openerCardEmbed(state).data.description ?? "").split("\n").find((line) => line.startsWith(words.lead));

	it("names Monopoly's auctions and Dero voice, as the host set them", () => {
		expect(settingsLineOf(card())).toBe(`${words.lead} ${[words.join.public, words.rated, words.watch.open, words.auctions(false), words.voice(false)].join(" · ")}`);
		const on = settingsLineOf(card({ monopolyAuctions: true, deroVoice: true })) ?? "";
		expect(on).toContain(words.auctions(true));
		expect(on).toContain(words.voice(true));
	});

	it("names who can join: Invite only, Open to all, approving each joiner, or the network", () => {
		expect(settingsLineOf(card({ visibility: "invite" }))).toContain(words.join.invite);
		expect(settingsLineOf(card({ hostControls: { ...controls, requireApproval: true } }))).toContain(words.join.approve);
		expect(settingsLineOf(card({ game: "holdem", network: true }))).toContain(words.join.network);
	});

	it("names the band of a rated open card, and no band on an invite card, which has no stranger to band", () => {
		const banded = { ...controls, ratingBand: "close" as const };
		expect(settingsLineOf(card({ hostControls: banded }))).toContain(words.band(BOT_CONSTANTS.RATINGS.BAND_CLOSE));
		expect(settingsLineOf(card({ visibility: "invite", hostControls: banded }))).not.toContain(words.band(BOT_CONSTANTS.RATINGS.BAND_CLOSE));
	});

	it("names a casual match, with its Dero bots when it has some", () => {
		expect(settingsLineOf(card({ casual: true }))).toContain(`${words.casual} · `);
		expect(settingsLineOf(card({ casual: true, bots: { count: 3 } }))).toContain(`${words.casual}, ${words.bots(3)}`);
	});

	it("names who may watch, and nothing about it on a network table", () => {
		expect(settingsLineOf(card({ hostControls: { ...controls, spectatorMode: "none" } }))).toContain(words.watch.none);
		expect(settingsLineOf(card({ game: "holdem", network: true })) ?? "").not.toContain(words.watch.open);
	});

	it("gives a game with no match only who can join, who may watch and Dero voice", () => {
		expect(settingsLineOf(card({ game: "rps" }))).toBe(`${words.lead} ${words.join.public} · ${words.watch.open} · ${words.voice(false)}`);
	});

	it("shows what the host chose that could not apply, under the line", () => {
		const note = gameRoomsCopy.creation.notApplied("Open to the network", "This server is not on the network.");
		expect(openerCardEmbed(card({ settingsNotes: [note] })).data.description).toContain(note);
	});

	// The host's Start counts the match in (2026-10 item 267, decision 13), and the card says so while it gathers.
	it("says the match starts in ten seconds while the Start counts in, and never on a card that started", () => {
		const line = gameRoomsCopy.board.cardCountdown(10);
		expect(openerCardEmbed(card()).data.description).not.toContain(line);
		expect(openerCardEmbed(card({ countingDown: true })).data.description).toContain(line);
		expect(openerCardEmbed(card({ countingDown: true, startedChannelId: "ch-1" })).data.description).not.toContain(line);
	});

	it("shows no settings line on a closed card", () => {
		for (const closed of [card({ startedChannelId: "ch-1" }), card({ cancelled: true }), card({ resultLine: "over" })]) {
			expect(settingsLineOf(closed)).toBeUndefined();
		}
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
// Play Dero is the creation modal's Who you play since 2026-10 item 263 Phase 2a, so no card
// carries its button; its route stays for a card posted before the change.
describe("the opener card's closed state, and no Play Dero button", () => {
	const card = (overrides: Partial<OpenerCardState> = {}): OpenerCardState => ({
		game: "coinflip",
		hostId: "host-1",
		visibility: "public",
		pool: [],
		...overrides,
	});
	const ids = (state: OpenerCardState): string[] =>
		openerCardRows("room-1", state).flatMap((row) => row.toJSON().components.map((button) => ("custom_id" in button ? button.custom_id : "")));

	it.each(["coinflip", "diceroll", "rps", "hangman", "battleship", "holdem", "monopoly"] as const)("never offers Play Dero on %s's card", (game) => {
		expect(ids(card({ game }))).not.toContain(`${GAME_ROOM_PREFIX}:dero:room-1`);
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
		for (const game of ["holdem", "battleship", "monopoly", "blackjack"] as const) expect(challengeBadge(game, 0)).toBe("rated");
	});

	it("is CASUAL once a Dero bot is seated, since a match with a bot is never rated", () => {
		expect(challengeBadge("holdem", 1)).toBe("casual");
		expect(challengeBadge("battleship", 1)).toBe("casual");
	});

	it("is CASUAL for every game that is not rated", () => {
		for (const game of ["coinflip", "diceroll", "rps", "hangman", "solo-blackjack"] as const) expect(challengeBadge(game, 0)).toBe("casual");
	});

	// 2026-10 item 254, Arcade 6: the host's Casual choice, even once people took every bot's seat.
	it("is CASUAL when the host chose Casual, with or without a bot left", () => {
		expect(challengeBadge("holdem", 0, true)).toBe("casual");
		expect(challengeBadge("monopoly", 2, true)).toBe("casual");
		expect(challengeBadge("monopoly", 0, false)).toBe("rated");
	});

	// 2026-10 item 276, owner decisions D2 and D8: Blackjack carries the same Rated or Casual choice.
	it("reads a Blackjack card RATED or CASUAL by the host's choice, and a solo table against Dero never RATED", () => {
		expect(challengeBadge("blackjack", 0, false)).toBe("rated");
		expect(challengeBadge("blackjack", 0, true)).toBe("casual");
		expect(challengeBadge("solo-blackjack", 0, false)).toBe("casual");
	});
});

// ── the buy in on a buy in game's card (2026-10 item 276, owner decision D1) ──
// Chips move only in ranked matches, so a card names its buy in only where its table will charge it.
describe("the buy in line", () => {
	const description = (state: OpenerCardState): string => openerCardEmbed(state).toJSON().description ?? "";
	const ranked: OpenerCardState = { game: "blackjack", hostId: "host-1", visibility: "public", pool: [], holdemBuyIn: 5000 };

	it("names the buy in on a Rated Hold'em or Blackjack card", () => {
		expect(description(ranked)).toContain(gameRoomsCopy.board.cardBuyIn(5000));
		expect(description({ ...ranked, game: "holdem" })).toContain(gameRoomsCopy.board.cardBuyIn(5000));
	});

	it("names none on a Casual card, a network table or a card with a Dero bot, since each plays free", () => {
		for (const state of [{ ...ranked, casual: true }, { ...ranked, game: "holdem" as const, casual: true }, { ...ranked, game: "holdem" as const, network: true }, { ...ranked, game: "holdem" as const, bots: { count: 1 } }]) {
			expect(description(state)).not.toContain(gameRoomsCopy.board.cardBuyIn(5000));
		}
	});
});

// ── Rated or Casual on the card (2026-10 item 254, Arcade 6) ─────────────
// The match is the creation modal's and fixed at creation (2026-10 item 263 Phase 2a), so the
// card offers no Casual toggle; the badge still reads the choice. Add bots is the one setting
// door kept on the card, because a host who cannot find the bot count cannot play a bot.
describe("Rated or Casual on the card", () => {
	const controls: DraftHostControls = { ratingBand: "any", requireApproval: false, pendingJoinCount: 0, spectatorMode: "open" };
	const base: OpenerCardState = { game: "monopoly", hostId: "host-1", visibility: "public", pool: [], hostControls: controls, bots: { count: 0 } };
	const customIds = (state: OpenerCardState): string[] =>
		openerCardRows("room-1", state).flatMap((row) => row.toJSON().components.map((component) => ("custom_id" in component ? component.custom_id : "")));

	it("offers no Casual toggle, rated or casual", () => {
		for (const state of [base, { ...base, casual: true, bots: { count: 3 } }]) {
			expect(customIds(state).some((id) => id.includes(":casual:"))).toBe(false);
		}
	});

	it("offers Add bots on the host's row only on a casual card of a game that takes bots", () => {
		expect(customIds({ ...base, casual: true })).toContain("gameroom:bots:room-1");
		// A rated card lives in 🏆rated-challenges and cannot seat a bot.
		expect(customIds(base).some((id) => id.includes(":bots:"))).toBe(false);
		const { bots: _bots, ...withoutBots } = { ...base, casual: true };
		expect(customIds(withoutBots).some((id) => id.includes(":bots:"))).toBe(false);
		expect(customIds({ ...base, hostControls: undefined }).some((id) => id.includes(":bots:"))).toBe(false);
	});

	it("reads CASUAL on the card while the draft gathers", () => {
		const description = openerCardEmbed({ ...base, casual: true }).data.description ?? "";
		expect(description.split("\n")[0]).toBe(gameRoomsCopy.board.badgeLine("casual", "monopoly"));
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
