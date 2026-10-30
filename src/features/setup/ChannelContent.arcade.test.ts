import { describe, it, expect } from "vitest";
import { ChannelContent } from "./ChannelContent.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { generalEventsCopy } from "@base/copy/packs/general-events.pack.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { CHALLENGE_GAMES } from "@features/game-rooms/challengeBoardEmbeds.js";
import { LUCK_GAMES, RATED_GAMES, type LuckGame, type RatedGame } from "@features/ratings/ratingEngine.js";
import { CUT_CARD_PENETRATION } from "@features/games/blackjackState.js";
import { chips as chipAmount } from "@features/economy/economyCopy.js";

// ── the 🎮 ARCADE GAMES cards ──────────────────────────────────────────────
// Since 2026-10 item 245 Phase 4a the arcade has three cards with three jobs:
// 📋arcade-rules holds the rules and nothing else, 🕹️games lists every game and
// carries every host button, and ⚔️challenges says in one line that challenges land
// there. These tests pin the structure rather than the prose: wording is the owner's
// to change freely, but a roster creeping back onto the rules card, or a game
// missing from the games list, is a regression.

const fields = (embed: { data: { fields?: Array<{ name: string; value: string }> } }) => embed.data.fields ?? [];

describe("arcadeRulesIntro", () => {
	const embed = ChannelContent.arcadeRulesIntro();
	const c = rokCommanderCopy.channelContent.arcadeRules;

	it("holds exactly the eight rules, in the order a newcomer meets them", () => {
		// What a room is, how many a host may hold, what closes one, what follows one,
		// what any of it earns, which games are rated, where chips ride (2026-10 item 276,
		// decision D1), and the house rules where the arcade departs from the printed ones.
		expect(fields(embed).map((f) => f.name)).toEqual([c.roomTitle, c.slotTitle, c.idleTitle, c.rematchTitle, c.xpTitle, c.ratingsTitle, c.chipsTitle, c.houseRulesTitle]);
	});

	it("fits Discord's limits: every field under 1024 and the whole card under 6000", () => {
		for (const field of fields(embed)) expect(field.value.length, field.name).toBeLessThanOrEqual(1024);
		const total = (embed.data.title ?? "").length + (embed.data.description ?? "").length + fields(embed).reduce((sum, f) => sum + f.name.length + f.value.length, 0);
		expect(total).toBeLessThanOrEqual(6000);
	});

	it("carries no game roster, because the roster lives in 🕹️games", () => {
		const text = [embed.data.description ?? "", ...fields(embed).map((f) => `${f.name} ${f.value}`)].join("\n");
		for (const game of rokCommanderCopy.channelContent.arcadeGames.roster) expect(text).not.toContain(game.name);
	});

	it("states the clocks and the amounts the code actually runs", () => {
		// The numbers come from BOT_CONSTANTS, so moving one there moves the card too.
		const idle = fields(embed).find((f) => f.name === c.idleTitle)?.value ?? "";
		expect(idle).toContain(`${BOT_CONSTANTS.GAME_ROOM_IDLE_ABANDON_MS / 60_000} minutes`);
		expect(idle).toContain(`${BOT_CONSTANTS.GAME_ROOM_MONOPOLY_IDLE_MS / 3_600_000} hours`);

		const xp = fields(embed).find((f) => f.name === c.xpTitle)?.value ?? "";
		expect(xp).toContain(`earns ${BOT_CONSTANTS.LEVELING.MESSAGE_XP} renown`);
		expect(xp).toContain(`pays ${BOT_CONSTANTS.LEVELING.SOLO_LUCK_WIN_XP} for a win`);
		expect(xp).toContain(`${BOT_CONSTANTS.LEVELING.DAILY_XP_CAP} renown a day`);
	});

});

describe("the rules card's ratings field", () => {
	// The field names its games in prose, so these pins keep it honest: every game
	// ratingEngine rates and every luck game must be named, and each threshold must be
	// the one the ratings code runs. Matched by each game's own words, the stable part.
	const gameWords: Record<RatedGame | LuckGame, string> = {
		holdem: "hold'em",
		battleship: "battleship",
		monopoly: "monopoly",
		blackjack: "blackjack",
		coinflip: "coin flip",
		diceroll: "dice roll",
		rps: "rock paper scissors",
	};
	const { RATINGS } = BOT_CONSTANTS;
	const packs = [
		{ name: "rok-commander", config: null, pack: rokCommanderCopy },
		{ name: "general-events", config: { pluginId: "general-events" } as never, pack: generalEventsCopy },
	];

	for (const { name, config, pack } of packs) {
		const card = fields(ChannelContent.arcadeRulesIntro(config));
		const chips = card.find((f) => f.name === pack.channelContent.arcadeRules.chipsTitle)?.value ?? "";
		const houseRules = card.find((f) => f.name === pack.channelContent.arcadeRules.houseRulesTitle)?.value ?? "";

		it(`says chips ride only on a Rated match and a Casual one plays free (${name})`, () => {
			expect(chips).toContain("**Rated** Hold'em or Blackjack table plays for a chip buy in");
			expect(chips).toContain("**Casual** match never takes or pays a single chip");
			expect(chips).toContain("Leaving a Blackjack table cashes out your stack");
		});

		// 2026-10 item 276, owner decisions D3, D4, D7, D10 and D12, inside Discord's 1024 character field.
		it(`names the Monopoly buy in and pot, the Battleship wager and the ranked forfeit (${name})`, () => {
			expect(chips).toContain(`**Rated** Monopoly match costs each player ${chipAmount(BOT_CONSTANTS.ECONOMY.MONOPOLY_RANKED_BUY_IN)}`);
			expect(chips).toContain("never becomes chips");
			expect(chips).toContain("chip wager both captains pay");
			expect(chips).toContain("forfeits their chips to the winner");
			expect(chips.length).toBeLessThanOrEqual(1024);
		});

		it(`states every house rule, the cut card at the share the engine runs (${name})`, () => {
			for (const game of ["**Monopoly:**", "**Battleship:**", "**Hangman:**", "**Coin flip:**", "**Blackjack:**"]) expect(houseRules).toContain(game);
			expect(houseRules).toContain(`about ${Math.round(CUT_CARD_PENETRATION * 100)} percent`);
			expect(houseRules).toContain("peeks for blackjack");
		});

		const ratings = fields(ChannelContent.arcadeRulesIntro(config)).find((f) => f.name === pack.channelContent.arcadeRules.ratingsTitle)?.value ?? "";

		it(`names every rated game and every luck game (${name})`, () => {
			const text = ratings.toLowerCase();
			for (const game of [...RATED_GAMES, ...LUCK_GAMES]) expect(text, game).toContain(gameWords[game]);
		});

		it(`states the thresholds the ratings code runs (${name})`, () => {
			expect(ratings).toContain(`${RATINGS.PROVISIONAL_GAMES} rated matches`);
			expect(ratings).toContain(`${RATINGS.HOLDEM_MIN_RATED_HANDS} hands`);
			expect(ratings).toContain(`${RATINGS.LUCK_MIN_DECIDED} decided games`);
		});

		it(`calls the number a rating, points at /rating, and fits one field (${name})`, () => {
			expect(ratings).toContain("**rating**");
			expect(ratings).toContain("`/rating me`");
			expect(ratings).not.toMatch(/\belo\b/i);
			expect(ratings.length).toBeLessThanOrEqual(1024);
		});
	}
});

describe("arcadeGamesIntro", () => {
	const embed = ChannelContent.arcadeGamesIntro();
	const c = rokCommanderCopy.channelContent.arcadeGames;

	it("lists every game once, one line each", () => {
		const roster = fields(embed).find((f) => f.name === c.rosterTitle);
		expect(roster).toBeDefined();
		const lines = (roster?.value ?? "").split("\n");
		expect(lines).toHaveLength(c.roster.length);
		c.roster.forEach((game, index) => expect(lines[index]).toContain(game.name));
		expect(new Set(c.roster.map((game) => game.name)).size).toBe(c.roster.length);
	});

	it("covers every game the Challenge Board can start, and blackjack, which only the host row starts", () => {
		// Each board slug has its own roster line, so a member never meets a start
		// button for a game the list does not explain. Matched by the board's own label
		// word, which is the stable part of each line.
		const names = c.roster.map((game) => game.name.toLowerCase()).join("\n");
		const labelWord: Record<(typeof CHALLENGE_GAMES)[number], string> = {
			coinflip: "coin flip",
			diceroll: "dice roll",
			rps: "rock paper scissors",
			hangman: "hangman",
			battleship: "battleship",
			holdem: "hold em",
			monopoly: "monopoly",
			"solo-hangman": "hangman",
			"solo-blackjack": "blackjack",
		};
		for (const game of CHALLENGE_GAMES) expect(names, game).toContain(labelWord[game]);
		expect(names).toContain("blackjack");
	});

	it("keeps the roster inside one field's ceiling", () => {
		const roster = fields(embed).find((f) => f.name === c.rosterTitle);
		expect((roster?.value ?? "").length).toBeLessThanOrEqual(1024);
	});

	it("titles its second message, the Challenge Board", () => {
		const board = ChannelContent.arcadeGamesBoard();
		expect(board.data.title).toBe(c.boardTitle);
		expect(board.data.description).toBe(c.boardDescription);
	});
});

describe("arcadeChallengesIntro", () => {
	it("is one short line that points at 🕹️games", () => {
		const embed = ChannelContent.arcadeChallengesIntro();
		const description = embed.data.description ?? "";
		expect(description.split("\n")).toHaveLength(1);
		expect(description).toContain(rokCommanderCopy.setup.channels.arcadeGames);
		expect(fields(embed)).toHaveLength(0);
	});
});

describe("both packs describe the same arcade", () => {
	it("declares the same keys on every arcade card and the same roster length", () => {
		// The two packs differ in VOICE, never in structure. A key present in one and
		// missing from the other means a general-events guild silently loses a section.
		for (const card of ["arcadeRules", "arcadeChallenges", "arcadeGames"] as const) {
			expect(Object.keys(generalEventsCopy.channelContent[card]).sort(), card).toEqual(Object.keys(rokCommanderCopy.channelContent[card]).sort());
		}
		expect(generalEventsCopy.channelContent.arcadeGames.roster).toHaveLength(rokCommanderCopy.channelContent.arcadeGames.roster.length);
		expect(Object.keys(generalEventsCopy.gameRequests).sort()).toEqual(Object.keys(rokCommanderCopy.gameRequests).sort());
	});

	it("renders every card in the neutral voice too", () => {
		const neutral = { pluginId: "general-events" } as never;
		expect(ChannelContent.arcadeRulesIntro(neutral).data.title).toBe(generalEventsCopy.channelContent.arcadeRules.title);
		expect(fields(ChannelContent.arcadeRulesIntro(neutral))).toHaveLength(8);
		expect(ChannelContent.arcadeGamesIntro(neutral).data.title).toBe(generalEventsCopy.channelContent.arcadeGames.title);
		expect(ChannelContent.arcadeGamesBoard(neutral).data.title).toBe(generalEventsCopy.channelContent.arcadeGames.boardTitle);
		expect(ChannelContent.arcadeChallengesIntro(neutral).data.title).toBe(generalEventsCopy.channelContent.arcadeChallenges.title);
	});
});
