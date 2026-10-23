// ── monopolyBoard ───────────────────────────────────────────────────────────
// What:  the Dero Arcade Monopoly board as pure data. The 40 tiles in play
//        order, the eight color groups, every price, rent table, house cost and
//        mortgage value, plus the fixed rule numbers (starting chips, GO salary,
//        bail, the bank's building stock) the engine reads.
// Who:   monopolyState and its split modules (landing, jail, forfeit), and the
//        Phase 4 board embed. Nothing here imports discord.js or the engine.
// When:  read on every action; never written. The board is the same for every
//        match, so it lives here rather than on the persisted GameRoom row.
// Where: src/features/games, beside the other pure engines (battleshipState,
//        holdemTable). A match's MUTABLE ownership lives in MonopolyState.
// How:   one array in standard Monopoly order with standard US values. Names are
//        generic Dero world nouns rather than any trademarked street name, which
//        is an owner decision (2026-10 item 241): it must not read as the
//        Hasbro board.

// ── rules ────────────────────────────────────────────────────────────────────
// Standard US ruleset numbers, named so the engine never carries a loose number.

export const BOARD_SIZE = 40;
export const GO_INDEX = 0;
export const JAIL_INDEX = 10;
export const FREE_PARKING_INDEX = 20;
export const GO_TO_JAIL_INDEX = 30;

export const STARTING_CHIPS = 1500;
export const GO_SALARY = 200;
export const JAIL_BAIL = 50;
// Attempts a jailed player gets to roll doubles; the third failure forces bail.
export const JAIL_SENTENCE_TURNS = 3;
// The third doubles in one turn sends the roller to jail instead of moving.
export const DOUBLES_TO_JAIL = 3;
export const DICE_SIDES = 6;
export const BANK_HOUSES = 32;
export const BANK_HOTELS = 12;
export const MIN_SEATS = 2;
export const MAX_SEATS = 6;
// Owning a whole color group doubles the base rent on its unimproved lots.
export const COMPLETE_GROUP_RENT_MULTIPLIER = 2;
// rents[0] is the bare lot, rents[1..4] are one to four houses, rents[5] the hotel.
export const HOTEL_RENT_INDEX = 5;
// A lot takes up to four houses; the next build is a hotel that hands all four
// houses back to the bank.
export const MAX_HOUSES_PER_LOT = 4;
// Transport rent by how many of the four transports the owner holds: one, two,
// three or four.
export const RAILROAD_RENTS: readonly number[] = [25, 50, 100, 200];
// Utility rent is the dice total times this, by how many of the two utilities
// the owner holds: one or two.
export const UTILITY_DICE_MULTIPLIERS: readonly number[] = [4, 10];
// The Chance cards that send a player to the nearest transport or utility charge
// more than a plain landing: twice the transport rent, or ten times the dice
// whatever the owner holds.
export const CARD_RAILROAD_RENT_MULTIPLIER = 2;
export const CARD_UTILITY_DICE_MULTIPLIER = 10;
// Lifting a mortgage costs the mortgage value plus this much interest, in whole
// percent so the math stays in integers (30 * 0.1 is not exactly 3 in floats).
export const UNMORTGAGE_INTEREST_PERCENT = 10;

// ── types ────────────────────────────────────────────────────────────────────

export type TileId = string;

export type ColorGroup = "brown" | "light-blue" | "pink" | "orange" | "red" | "yellow" | "green" | "dark-blue";

export type SpecialTileKind = "go" | "jail" | "free-parking" | "go-to-jail" | "chance" | "chest" | "tax";

export type RentTable = [number, number, number, number, number, number];

export interface SpecialTile {
	kind: SpecialTileKind;
	// Only tax tiles carry an amount, which is what the landing charges.
	amount?: number;
}

export interface PropertyTile {
	kind: "property";
	id: TileId;
	name: string;
	group: ColorGroup;
	price: number;
	rents: RentTable;
	houseCost: number;
	mortgage: number;
}

export interface RailroadTile {
	kind: "railroad";
	id: TileId;
	name: string;
	price: number;
	mortgage: number;
}

export interface UtilityTile {
	kind: "utility";
	id: TileId;
	name: string;
	price: number;
	mortgage: number;
}

export type OwnableTile = PropertyTile | RailroadTile | UtilityTile;

export type MonopolyTile = SpecialTile | OwnableTile;

// ── tile builders ────────────────────────────────────────────────────────────
// Every ownable tile mortgages for half its price under the standard rules, so
// the builders derive it rather than letting 28 hand typed values drift.

const MORTGAGE_RATIO = 0.5;

function property(id: TileId, name: string, group: ColorGroup, price: number, houseCost: number, rents: RentTable): PropertyTile {
	return { kind: "property", id, name, group, price, rents, houseCost, mortgage: price * MORTGAGE_RATIO };
}

const TRANSPORT_PRICE = 200;
const UTILITY_PRICE = 150;

function railroad(id: TileId, name: string): RailroadTile {
	return { kind: "railroad", id, name, price: TRANSPORT_PRICE, mortgage: TRANSPORT_PRICE * MORTGAGE_RATIO };
}

function utility(id: TileId, name: string): UtilityTile {
	return { kind: "utility", id, name, price: UTILITY_PRICE, mortgage: UTILITY_PRICE * MORTGAGE_RATIO };
}

const INCOME_TAX = 200;
const LUXURY_TAX = 100;

// ── the board ────────────────────────────────────────────────────────────────
// Index is the board position. The six special lanes (three chance, three
// chest) sit where the standard board puts them, so a player who knows the real
// game reads the odds of each stretch correctly.

export const BOARD: readonly MonopolyTile[] = [
	{ kind: "go" },
	property("mudlark-lane", "Mudlark Lane", "brown", 60, 50, [2, 10, 30, 90, 160, 250]),
	{ kind: "chest" },
	property("cinder-row", "Cinder Row", "brown", 60, 50, [4, 20, 60, 180, 320, 450]),
	{ kind: "tax", amount: INCOME_TAX },
	railroad("skyrail-station", "Skyrail Station"),
	property("teal-ridge", "Teal Ridge", "light-blue", 100, 50, [6, 30, 90, 270, 400, 550]),
	{ kind: "chance" },
	property("frost-hollow", "Frost Hollow", "light-blue", 100, 50, [6, 30, 90, 270, 400, 550]),
	property("skyglass-terrace", "Skyglass Terrace", "light-blue", 120, 50, [8, 40, 100, 300, 450, 600]),
	{ kind: "jail" },
	property("rosequartz-court", "Rosequartz Court", "pink", 140, 100, [10, 50, 150, 450, 625, 750]),
	utility("lumen-works", "Lumen Works"),
	property("lantern-market", "Lantern Market", "pink", 140, 100, [10, 50, 150, 450, 625, 750]),
	property("velvet-arcade", "Velvet Arcade", "pink", 160, 100, [12, 60, 180, 500, 700, 900]),
	railroad("ferry-landing", "Ferry Landing"),
	property("amber-walk", "Amber Walk", "orange", 180, 100, [14, 70, 200, 550, 750, 950]),
	{ kind: "chest" },
	property("ember-square", "Ember Square", "orange", 180, 100, [14, 70, 200, 550, 750, 950]),
	property("copper-wharf", "Copper Wharf", "orange", 200, 100, [16, 80, 220, 600, 800, 1000]),
	{ kind: "free-parking" },
	property("vermillion-alley", "Vermillion Alley", "red", 220, 150, [18, 90, 250, 700, 875, 1050]),
	{ kind: "chance" },
	property("scarlet-forge", "Scarlet Forge", "red", 220, 150, [18, 90, 250, 700, 875, 1050]),
	property("crimson-gate", "Crimson Gate", "red", 240, 150, [20, 100, 300, 750, 925, 1100]),
	railroad("caravan-depot", "Caravan Depot"),
	property("saffron-fields", "Saffron Fields", "yellow", 260, 150, [22, 110, 330, 800, 975, 1150]),
	property("gilded-quay", "Gilded Quay", "yellow", 260, 150, [22, 110, 330, 800, 975, 1150]),
	utility("aqueduct-works", "Aqueduct Works"),
	property("sunstone-plaza", "Sunstone Plaza", "yellow", 280, 150, [24, 120, 360, 850, 1025, 1200]),
	{ kind: "go-to-jail" },
	property("jade-terrace", "Jade Terrace", "green", 300, 200, [26, 130, 390, 900, 1100, 1275]),
	property("mossgate", "Mossgate", "green", 300, 200, [26, 130, 390, 900, 1100, 1275]),
	{ kind: "chest" },
	property("emerald-spire", "Emerald Spire", "green", 320, 200, [28, 150, 450, 1000, 1200, 1400]),
	railroad("airship-dock", "Airship Dock"),
	{ kind: "chance" },
	property("midnight-crown", "Midnight Crown", "dark-blue", 350, 200, [35, 175, 500, 1100, 1300, 1500]),
	{ kind: "tax", amount: LUXURY_TAX },
	property("sapphire-keep", "Sapphire Keep", "dark-blue", 400, 200, [50, 200, 600, 1400, 1700, 2000]),
];

// ── lookups ──────────────────────────────────────────────────────────────────

export const isOwnableTile = (tile: MonopolyTile): tile is OwnableTile =>
	tile.kind === "property" || tile.kind === "railroad" || tile.kind === "utility";

export const OWNABLE_TILES: readonly OwnableTile[] = BOARD.filter(isOwnableTile);

const OWNABLE_BY_ID = new Map<TileId, OwnableTile>(OWNABLE_TILES.map((tile) => [tile.id, tile]));

/** The ownable tile with this id, or undefined for an id the board does not have. */
export const findOwnableTile = (tileId: TileId): OwnableTile | undefined => OWNABLE_BY_ID.get(tileId);

/**
 * The board position of an ownable tile. The card decks resolve their advance
 * destinations through this at load, so a card can never point at a position
 * that drifted from the tile it names. Throws on an unknown id, which is a typo
 * in a card definition, not a move a player can make.
 */
export function boardIndexOf(tileId: TileId): number {
	const index = BOARD.findIndex((tile) => isOwnableTile(tile) && tile.id === tileId);
	if (index === -1) throw new Error(`The Monopoly board has no tile ${tileId}`);
	return index;
}

/** Every board position holding a tile of this kind, in board order. */
export const boardIndicesOfKind = (kind: MonopolyTile["kind"]): number[] =>
	BOARD.flatMap((tile, index) => (tile.kind === kind ? [index] : []));

// Built from the board rather than typed out, so a group can never list a tile
// the board does not hold or miss one it does.
function collectColorGroups(): Record<ColorGroup, TileId[]> {
	const groups: Record<ColorGroup, TileId[]> = {
		brown: [],
		"light-blue": [],
		pink: [],
		orange: [],
		red: [],
		yellow: [],
		green: [],
		"dark-blue": [],
	};
	for (const tile of OWNABLE_TILES) {
		if (tile.kind === "property") groups[tile.group].push(tile.id);
	}
	return groups;
}

export const COLOR_GROUPS: Record<ColorGroup, TileId[]> = collectColorGroups();

// Special tiles carry no name in the union, so their trail label comes from this
// one map rather than from strings scattered through the engine.
const SPECIAL_TILE_NAMES: Record<SpecialTileKind, string> = {
	go: "GO",
	jail: "Jail",
	"free-parking": "Free Parking",
	"go-to-jail": "Go To Jail",
	chance: "Chance",
	chest: "Community Chest",
	tax: "Tax",
};

/** The display name of any tile, ownable or special. */
export const describeTile = (tile: MonopolyTile): string => (isOwnableTile(tile) ? tile.name : SPECIAL_TILE_NAMES[tile.kind]);
