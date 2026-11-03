import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { turnAdapterFor } from "./turnAdapters.js";
import { holdemTurnAdapter } from "./roomHoldemHandlers.js";
import { monopolyTurnAdapter } from "./roomMonopolyHandlers.js";
import { battleshipTurnAdapter } from "./roomBattleshipHandlers.js";
import { soloRpsTurnAdapter } from "./soloLuckRoom.js";
import { blackjackTurnAdapter } from "@features/games/blackjackHandler.js";
import { BLACKJACK_ROOM_GAMES, type GameSlug } from "./roomTypes.js";
import type { TurnAdapter } from "./turnPrompt.js";

// ── turnAdapters ─────────────────────────────────────────────────────
// What:  every game whose code posts a turn line (syncTurnPrompt) has an adapter registered for
//        each room game it posts that line in (2026-10 item 263 R3-23). The press on the line
//        looks the adapter up by the ROOM's game, so a line posted for a game the table does not
//        list answers "That turn has passed" to every press, which is how solo blackjack broke.
// How:   ① a scan of src for every syncTurnPrompt call and the adapter it passes, so a new game
//        that starts syncing fails here until SERVED_GAMES says which rooms it posts in; ② every
//        game in SERVED_GAMES resolves to that same adapter through turnAdapterFor.

const SRC = join(__dirname, "..", "..");

// The room games each syncing adapter posts its line in. Blackjack posts for any table in a room
// (blackjackHandler.promptTurn), solo or multi seat, which is the case this test exists for.
const SERVED_GAMES: Record<string, { adapter: TurnAdapter; games: readonly GameSlug[] }> = {
	holdemTurnAdapter: { adapter: holdemTurnAdapter, games: ["holdem"] },
	monopolyTurnAdapter: { adapter: monopolyTurnAdapter, games: ["monopoly"] },
	battleshipTurnAdapter: { adapter: battleshipTurnAdapter, games: ["battleship"] },
	blackjackTurnAdapter: { adapter: blackjackTurnAdapter, games: BLACKJACK_ROOM_GAMES },
	soloRpsTurnAdapter: { adapter: soloRpsTurnAdapter, games: ["solo-rps"] },
};

function sourceFiles(folder: string): string[] {
	return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
		const path = join(folder, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
	});
}

// Every `syncTurnPrompt(client, room, someAdapter)` in the source, as file and adapter name. Read
// once for the whole suite, and only the files that name the function are matched against.
let synced: Array<{ file: string; adapter: string }> | null = null;
function syncedAdapters(): Array<{ file: string; adapter: string }> {
	synced ??= sourceFiles(SRC).flatMap((file) => {
		const source = readFileSync(file, "utf8");
		if (!source.includes("syncTurnPrompt(")) return [];
		return [...source.matchAll(/syncTurnPrompt\(\s*[^,()]+,\s*[^,()]+(?:\([^)]*\))?[^,()]*,\s*(\w+)\s*\)/g)].map((match) => ({
			file: relative(SRC, file),
			adapter: match[1],
		}));
	});
	return synced;
}

describe("turn adapters", () => {
	it("finds the games that sync a turn line", () => {
		const names = new Set(syncedAdapters().map((call) => call.adapter));
		// Guards the scan itself: a regex that matched nothing would pass every check below.
		expect([...names].sort()).toEqual(Object.keys(SERVED_GAMES).sort());
	});

	it("lists every adapter a syncTurnPrompt call passes", () => {
		for (const call of syncedAdapters()) {
			expect(SERVED_GAMES[call.adapter], `${call.file} syncs ${call.adapter}, which SERVED_GAMES does not list`).toBeDefined();
		}
	});

	it("registers each syncing adapter for every room game it posts a line in", () => {
		for (const [name, { adapter, games }] of Object.entries(SERVED_GAMES)) {
			for (const game of games) expect(turnAdapterFor(game), `${name} posts a line in ${game} rooms`).toBe(adapter);
		}
	});

	it("prompts a solo blackjack table through the blackjack adapter (R3-23)", () => {
		expect(turnAdapterFor("solo-blackjack")).toBe(blackjackTurnAdapter);
	});
});
