import { describe, it, expect } from "vitest";
import {
	BOARD,
	BOARD_SIZE,
	COLOR_GROUPS,
	FREE_PARKING_INDEX,
	GO_INDEX,
	GO_TO_JAIL_INDEX,
	JAIL_INDEX,
	OWNABLE_TILES,
	boardIndexOf,
	boardIndicesOfKind,
	describeTile,
	findOwnableTile,
	isOwnableTile,
	ownableTileName,
	type MonopolyTile,
} from "./monopolyBoard.js";

// The en and em dash, built from code points so this file itself carries none
// and the repo wide dash grep stays empty.
const LONG_DASHES = [String.fromCodePoint(0x2013), String.fromCodePoint(0x2014)];

const countKind = (kind: MonopolyTile["kind"]): number => BOARD.filter((tile) => tile.kind === kind).length;

describe("monopolyBoard, layout", () => {
	it("has forty tiles", () => {
		expect(BOARD).toHaveLength(BOARD_SIZE);
	});

	it("puts the four corners where the standard board does", () => {
		expect(BOARD[GO_INDEX].kind).toBe("go");
		expect(BOARD[JAIL_INDEX].kind).toBe("jail");
		expect(BOARD[FREE_PARKING_INDEX].kind).toBe("free-parking");
		expect(BOARD[GO_TO_JAIL_INDEX].kind).toBe("go-to-jail");
	});

	it("holds 22 color properties, 4 transports, 2 utilities, 2 taxes and 3 of each card lane", () => {
		// The card lanes are 3 and 3, not 2 and 3: 4 corners, 28 ownables and 2
		// taxes leave exactly 6 tiles, which is the standard board.
		expect(countKind("property")).toBe(22);
		expect(countKind("railroad")).toBe(4);
		expect(countKind("utility")).toBe(2);
		expect(countKind("tax")).toBe(2);
		expect(countKind("chance")).toBe(3);
		expect(countKind("chest")).toBe(3);
		for (const corner of ["go", "jail", "free-parking", "go-to-jail"] as const) {
			expect(countKind(corner)).toBe(1);
		}
	});

	it("splits the 22 properties across 8 color groups of 2 or 3", () => {
		const groups = Object.values(COLOR_GROUPS);
		expect(groups).toHaveLength(8);
		expect(groups.flat()).toHaveLength(22);
		expect(COLOR_GROUPS.brown).toHaveLength(2);
		expect(COLOR_GROUPS["dark-blue"]).toHaveLength(2);
		for (const ids of groups) expect([2, 3]).toContain(ids.length);
	});

	it("gives every tax tile an amount and no other special tile one", () => {
		for (const tile of BOARD) {
			if (isOwnableTile(tile)) continue;
			if (tile.kind === "tax") expect(tile.amount).toBeGreaterThan(0);
			else expect(tile.amount).toBeUndefined();
		}
	});
});

describe("monopolyBoard, names and ids", () => {
	it("names every ownable tile uniquely, non empty and without a long dash", () => {
		const names = OWNABLE_TILES.map((tile) => tile.name);
		expect(new Set(names).size).toBe(names.length);
		for (const name of names) {
			expect(name.trim().length).toBeGreaterThan(0);
			for (const dash of LONG_DASHES) expect(name).not.toContain(dash);
		}
	});

	it("keeps ids unique and slug cased", () => {
		const ids = OWNABLE_TILES.map((tile) => tile.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ids) expect(id).toMatch(/^[a-z]+(-[a-z]+)*$/);
	});

	it("borrows no street name from the trademarked board", () => {
		const banned = /boardwalk|park place|marvin|avenue|reading railroad|short line|electric company|water works/i;
		for (const tile of OWNABLE_TILES) expect(tile.name).not.toMatch(banned);
	});
});

describe("monopolyBoard, standard values", () => {
	it("prices each group like the standard board", () => {
		const pricesOf = (group: keyof typeof COLOR_GROUPS) => COLOR_GROUPS[group].map((id) => findOwnableTile(id)?.price);
		expect(pricesOf("brown")).toEqual([60, 60]);
		expect(pricesOf("light-blue")).toEqual([100, 100, 120]);
		expect(pricesOf("pink")).toEqual([140, 140, 160]);
		expect(pricesOf("orange")).toEqual([180, 180, 200]);
		expect(pricesOf("red")).toEqual([220, 220, 240]);
		expect(pricesOf("yellow")).toEqual([260, 260, 280]);
		expect(pricesOf("green")).toEqual([300, 300, 320]);
		expect(pricesOf("dark-blue")).toEqual([350, 400]);
	});

	it("charges the standard house cost per side of the board", () => {
		const houseCostOf = (group: keyof typeof COLOR_GROUPS) => {
			const tile = findOwnableTile(COLOR_GROUPS[group][0]);
			return tile?.kind === "property" ? tile.houseCost : null;
		};
		expect([houseCostOf("brown"), houseCostOf("light-blue")]).toEqual([50, 50]);
		expect([houseCostOf("pink"), houseCostOf("orange")]).toEqual([100, 100]);
		expect([houseCostOf("red"), houseCostOf("yellow")]).toEqual([150, 150]);
		expect([houseCostOf("green"), houseCostOf("dark-blue")]).toEqual([200, 200]);
	});

	it("mortgages every ownable for half its price and keeps rent tables rising", () => {
		for (const tile of OWNABLE_TILES) {
			expect(tile.mortgage).toBe(tile.price / 2);
			if (tile.kind !== "property") continue;
			for (let index = 1; index < tile.rents.length; index++) {
				expect(tile.rents[index]).toBeGreaterThan(tile.rents[index - 1]);
			}
		}
	});

	it("prices transports at 200 and utilities at 150", () => {
		for (const tile of OWNABLE_TILES) {
			if (tile.kind === "railroad") expect(tile.price).toBe(200);
			if (tile.kind === "utility") expect(tile.price).toBe(150);
		}
	});
});

describe("monopolyBoard, lookups", () => {
	it("finds an ownable tile by id and returns undefined for an unknown one", () => {
		expect(findOwnableTile("vermillion-alley")?.name).toBe("Vermillion Alley");
		expect(findOwnableTile("not-a-tile")).toBeUndefined();
	});

	it("finds a tile's board position and throws on an id the board does not have", () => {
		expect(boardIndexOf("sapphire-keep")).toBe(BOARD_SIZE - 1);
		expect(() => boardIndexOf("not-a-tile")).toThrow(/no tile not-a-tile/);
	});

	it("names an ownable tile by id and throws on an id the board does not have", () => {
		expect(ownableTileName("cinder-row")).toBe("Cinder Row");
		expect(() => ownableTileName("not-a-tile")).toThrow(/no tile not-a-tile/);
	});

	it("lists the positions of every tile of a kind, in board order", () => {
		expect(boardIndicesOfKind("railroad")).toEqual([5, 15, 25, 35]);
		expect(boardIndicesOfKind("utility")).toEqual([12, 28]);
		expect(boardIndicesOfKind("chance")).toEqual([7, 22, 36]);
	});

	it("describes ownable tiles by name and special tiles by their label", () => {
		expect(describeTile(BOARD[1])).toBe("Mudlark Lane");
		expect(describeTile(BOARD[GO_INDEX])).toBe("GO");
		expect(describeTile(BOARD[2])).toBe("Community Chest");
		expect(describeTile(BOARD[4])).toBe("Tax");
	});
});
