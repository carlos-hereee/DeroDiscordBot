import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	EmbedBuilder,
	MessageFlags,
	StringSelectMenuBuilder,
	type ColorResolvable,
} from "discord.js";
import { infoEmbed } from "@utils/embedBuilder.js";
import { COLORS } from "@base/copy/brand.js";
import {
	COLUMNS,
	GRID_SIZE,
	FLEET,
	createMatch,
	applyShot,
	opponentView,
	ownView,
	shipsRemaining,
	formatCoord,
	type BattleshipState,
	type Coord,
	type PlayerBoard,
	type Ship,
} from "@features/games/battleshipState.js";
import { GAME_ROOM_PREFIX, GAME_ROOM_SELECT_PREFIX } from "./gameRoomActions.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── roomBattleship ───────────────────────────────────────────────────
// What:  the Discord half of a battleship match: how the match is stored on the
//        room row, how the two boards are drawn, and what the controls are.
// Who:   the `gameroom:` battleship controls and the room's own board message.
// When:  from the moment the room provisions to the last ship sunk.
// Where: the match lives on `room.secret`, so it survives the Railway deploy that
//        would have killed a Map. Sets do not survive JSON, so everything is
//        serialised on the way in and rehydrated on the way out; see below.
// How:   the pure engine decides everything. This file serialises, renders, and
//        routes, and makes no rule of its own.
//
// ⚠️ THE LEAK IS THE RISK, NOT THE ARITHMETIC, and the defense stays structural.
// `opponentView` is built from the shots that were FIRED and never reads a ship's
// cells, so an unfired position has no route into the public board. This file must
// keep it that way: the public embed renders `opponentView` ONLY, and `ownView` is
// reachable exclusively through an ephemeral reply to the viewer's own click.
// Do not render `ownView` into anything the channel can see.

// ── persistence ───────────────────────────────────────────────────────
// `Ship.hits` and `PlayerBoard.shots` are Sets, which JSON.stringify turns into
// `{}` and Mongo stores as an empty object. Serialising explicitly is what stops a
// match silently losing every hit it had recorded the moment it round-trips.

interface StoredShip {
	name: string;
	cells: Coord[];
	hits: string[];
}
interface StoredBoard {
	userId: string;
	username: string;
	ships: StoredShip[];
	shots: string[];
}
export interface StoredBattleship {
	players: [StoredBoard, StoredBoard];
	turn: 0 | 1;
	status: "playing" | "finished";
	winnerId: string | null;
	missedTurns: [number, number];
	// The half-entered coordinate each player has selected but not yet fired. Kept
	// on the ROW rather than in a Map so a deploy mid-aim costs a re-click at worst,
	// and so two players aiming at once cannot collide on one shared slot.
	pending?: Record<string, { x?: number; y?: number }>;
	// The public board message, edited every turn rather than reposted. A 10x10 grid
	// per shot would be thirty unreadable walls in a row; the append-only trail
	// carries the NARRATION and this carries the state.
	boardMessageId?: string | null;
}

export function serializeMatch(state: BattleshipState, extra: Partial<StoredBattleship> = {}): StoredBattleship {
	const board = (player: PlayerBoard): StoredBoard => ({
		userId: player.userId,
		username: player.username,
		ships: player.ships.map((ship) => ({ name: ship.name, cells: ship.cells, hits: [...ship.hits] })),
		shots: [...player.shots],
	});
	return {
		players: [board(state.players[0]), board(state.players[1])],
		turn: state.turn,
		status: state.status,
		winnerId: state.winnerId,
		missedTurns: state.missedTurns,
		...extra,
	};
}

export function deserializeMatch(stored: StoredBattleship): BattleshipState {
	const board = (raw: StoredBoard): PlayerBoard => ({
		userId: raw.userId,
		username: raw.username,
		ships: raw.ships.map((ship) => ({ name: ship.name, cells: ship.cells, hits: new Set(ship.hits) }) as Ship),
		shots: new Set(raw.shots),
	});
	return {
		players: [board(stored.players[0]), board(stored.players[1])],
		turn: stored.turn,
		status: stored.status,
		winnerId: stored.winnerId,
		missedTurns: stored.missedTurns,
	};
}

// Start a match for a provisioned room. Placement is automatic with a Reroll
// button; manual placement is deferred by decision, being a second full coordinate
// UI for a fraction of the value.
export function startMatch(room: IGameRoom, usernames: Record<string, string>, rng: () => number = Math.random): StoredBattleship {
	// createMatch places both fleets itself from the injected rng, so this passes
	// identities only. Rerolling later replaces one player's ships in place.
	const [a, b] = room.playerIds;
	const state = createMatch(
		[
			{ userId: a, username: usernames[a] ?? a },
			{ userId: b, username: usernames[b] ?? b },
		],
		rng
	);
	return serializeMatch(state);
}

// ── rendering ─────────────────────────────────────────────────────────
// ⚠️ THE GRID GOES IN AN EMBED DESCRIPTION, NEVER IN MESSAGE CONTENT (C13/T20).
// Discord renders emoji in message content at a larger size and with different
// line spacing, which breaks a fixed-width grid into a ragged mess; inside an
// embed description the rows stay aligned.
const CELL: Record<string, string> = { unknown: "🌊", miss: "⬜", hit: "💥", sunk: "🔥", ship: "🚢" };
const COLUMN_HEADER = `⬛${COLUMNS.map((_, index) => ["🇦", "🇧", "🇨", "🇩", "🇪", "🇫", "🇬", "🇭", "🇮", "🇯"][index]).join("")}`;
const ROW_LABELS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

function renderGrid(rows: string[][]): string {
	return [COLUMN_HEADER, ...rows.map((row, y) => `${ROW_LABELS[y]}${row.join("")}`)].join("\n");
}

// The PUBLIC board: what the room may see. Built from opponentView for BOTH
// players, so neither player's unfired ships are readable by anyone, including the
// opponent and including a spectator scrolling back.
export function publicBoardEmbed(state: BattleshipState): EmbedBuilder {
	const [first, second] = state.players;
	const section = (viewer: PlayerBoard, target: PlayerBoard): string => {
		const grid = opponentView(state, viewer.userId).map((row) => row.map((cell) => CELL[cell]));
		return [
			`**${viewer.username}** firing on **${target.username}** (${shipsRemaining(state, target.userId)} ships left)`,
			renderGrid(grid),
		].join("\n");
	};

	const turnLine =
		state.status === "finished"
			? gameRoomsCopy.battleship.finished(state.winnerId)
			: gameRoomsCopy.battleship.turnLine(state.players[state.turn].userId);

	return infoEmbed(
		gameRoomsCopy.battleship.boardTitle,
		[turnLine, "", section(first, second), "", section(second, first)].join("\n"),
		COLORS.ARCADE as ColorResolvable
	);
}

// The PRIVATE board: the viewer's own fleet, with their opponent's shots on it.
// Reachable ONLY as an ephemeral reply to the viewer's own click (T16, R20, Q8).
// No private channels and no DMs: a channel per player costs two channels per match
// against a 500 channel server cap, on top of the room's own.
export function privateBoardEmbed(state: BattleshipState, viewerId: string): EmbedBuilder {
	const grid = ownView(state, viewerId).map((row) =>
		row.map((cell) => (cell.hit ? CELL.hit : cell.ship ? CELL.ship : cell.miss ? CELL.miss : CELL.unknown))
	);
	const afloat = FLEET.filter((ship) => {
		const board = state.players.find((player) => player.userId === viewerId);
		const own = board?.ships.find((candidate) => candidate.name === ship.name);
		return own ? own.hits.size < own.cells.length : false;
	});

	return infoEmbed(
		gameRoomsCopy.battleship.ownBoardTitle,
		[renderGrid(grid), "", gameRoomsCopy.battleship.fleetLine(afloat.map((ship) => ship.name))].join("\n"),
		COLORS.ARCADE as ColorResolvable
	);
}

// ── controls ──────────────────────────────────────────────────────────
// ⚠️ TWO SELECTS, NEVER A BUTTON GRID (T17). A 10x10 grid of buttons is 100
// components against Discord's hard cap of 25 (5 rows of 5), so the obvious
// implementation is not merely ugly, it is impossible.
export function battleshipRows(roomId: string, state: BattleshipState): ActionRowBuilder<never>[] {
	const columnSelect = new StringSelectMenuBuilder()
		.setCustomId(`${GAME_ROOM_SELECT_PREFIX}:bscol:${roomId}`)
		.setPlaceholder(gameRoomsCopy.battleship.columnPlaceholder)
		.addOptions(COLUMNS.map((label, index) => ({ label, value: String(index) })));

	const rowSelect = new StringSelectMenuBuilder()
		.setCustomId(`${GAME_ROOM_SELECT_PREFIX}:bsrow:${roomId}`)
		.setPlaceholder(gameRoomsCopy.battleship.rowPlaceholder)
		.addOptions(Array.from({ length: GRID_SIZE }, (_, index) => ({ label: String(index + 1), value: String(index) })));

	const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder()
			.setCustomId(`${GAME_ROOM_PREFIX}:move:${roomId}`)
			.setLabel(gameRoomsCopy.battleship.fireLabel)
			.setEmoji("🎯")
			.setStyle(ButtonStyle.Danger)
			.setDisabled(state.status === "finished"),
		new ButtonBuilder()
			.setCustomId(`${GAME_ROOM_PREFIX}:board:${roomId}`)
			.setLabel(gameRoomsCopy.battleship.viewLabel)
			.setEmoji("🗺️")
			.setStyle(ButtonStyle.Secondary),
		new ButtonBuilder()
			.setCustomId(`${GAME_ROOM_PREFIX}:forfeit:${roomId}`)
			.setLabel(gameRoomsCopy.battleship.forfeitLabel)
			.setStyle(ButtonStyle.Secondary)
	);

	return [
		new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(columnSelect) as unknown as ActionRowBuilder<never>,
		new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(rowSelect) as unknown as ActionRowBuilder<never>,
		buttons as unknown as ActionRowBuilder<never>,
	];
}

// The Reroll row, offered once before the first shot. Auto placement with a reroll
// is the whole of placement by decision: manual placement is a second full
// coordinate UI for a fraction of the value.
export function rerollRow(roomId: string): ActionRowBuilder<ButtonBuilder> {
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder()
			.setCustomId(`${GAME_ROOM_PREFIX}:reroll:${roomId}`)
			.setLabel(gameRoomsCopy.battleship.rerollLabel)
			.setEmoji("🎲")
			.setStyle(ButtonStyle.Secondary)
	);
}

// ── the shot ──────────────────────────────────────────────────────────
export interface FireOutcome {
	ok: boolean;
	message: string;
	state?: BattleshipState;
	sunk?: string;
	won?: boolean;
}

// Resolve a fire press against the stored match. Returns what to say and, when the
// shot landed, the new state for the caller to persist and render.
export function fire(stored: StoredBattleship, shooterId: string): FireOutcome {
	const state = deserializeMatch(stored);

	if (state.status !== "playing") return { ok: false, message: gameRoomsCopy.battleship.matchOver };
	if (state.players[state.turn].userId !== shooterId) return { ok: false, message: gameRoomsCopy.battleship.notYourTurn };

	const aim = stored.pending?.[shooterId];
	if (aim?.x === undefined || aim?.y === undefined) return { ok: false, message: gameRoomsCopy.battleship.noTarget };

	const coord: Coord = { x: aim.x, y: aim.y };
	const result = applyShot(state, shooterId, coord);

	// The four refusals cost NOTHING, not even the turn. A repeat in particular:
	// a select menu makes a double submit easy, and spending somebody's turn on
	// their own double click is the kind of unfairness a player never forgives.
	switch (result.status) {
		case "not-your-turn":
			return { ok: false, message: gameRoomsCopy.battleship.notYourTurn };
		case "repeat":
			return { ok: false, message: gameRoomsCopy.battleship.alreadyFired(formatCoord(result.coord)) };
		case "invalid":
			return { ok: false, message: gameRoomsCopy.battleship.offGrid };
		case "finished":
			return { ok: false, message: gameRoomsCopy.battleship.matchOver };
		case "miss":
			return { ok: true, state, message: gameRoomsCopy.battleship.miss(shooterId, formatCoord(result.coord)) };
		case "hit":
			return { ok: true, state, message: gameRoomsCopy.battleship.hit(shooterId, formatCoord(result.coord)) };
		case "sunk":
			return {
				ok: true,
				state,
				sunk: result.ship,
				won: result.fleetDestroyed,
				message: gameRoomsCopy.battleship.sank(shooterId, formatCoord(result.coord), result.ship),
			};
	}
}

// The ephemeral reply flags, named once so every private surface in this file
// cannot accidentally ship a public one.
export const PRIVATE = { flags: MessageFlags.Ephemeral } as const;
