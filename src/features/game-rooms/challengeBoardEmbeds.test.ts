import { describe, it, expect } from "vitest";
import { boardStartRows, CHALLENGE_GAMES } from "./challengeBoardEmbeds.js";
import { GAME_ROOM_PREFIX } from "./gameRoomActions.js";

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
});
