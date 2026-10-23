import { describe, it, expect } from "vitest";
import { ChannelContent } from "./ChannelContent.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { generalEventsCopy } from "@base/copy/packs/general-events.pack.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { CHALLENGE_GAMES } from "@features/game-rooms/challengeBoardEmbeds.js";

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

	it("holds exactly the five rules, in the order a newcomer meets them", () => {
		// What a room is, how many a host may hold, what closes one, what follows one,
		// and what any of it earns. Ratings join in Phase 5, once they are shown.
		expect(fields(embed).map((f) => f.name)).toEqual([c.roomTitle, c.slotTitle, c.idleTitle, c.rematchTitle, c.xpTitle]);
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

	it("does not mention ratings yet", () => {
		const text = fields(embed).map((f) => f.value).join("\n").toLowerCase();
		expect(text).not.toContain("rating");
	});
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
		expect(fields(ChannelContent.arcadeRulesIntro(neutral))).toHaveLength(5);
		expect(ChannelContent.arcadeGamesIntro(neutral).data.title).toBe(generalEventsCopy.channelContent.arcadeGames.title);
		expect(ChannelContent.arcadeGamesBoard(neutral).data.title).toBe(generalEventsCopy.channelContent.arcadeGames.boardTitle);
		expect(ChannelContent.arcadeChallengesIntro(neutral).data.title).toBe(generalEventsCopy.channelContent.arcadeChallenges.title);
	});
});
