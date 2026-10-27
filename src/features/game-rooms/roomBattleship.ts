import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	EmbedBuilder,
	MessageFlags,
	type AttachmentBuilder,
	type ColorResolvable,
} from "discord.js";
import { infoEmbed } from "@utils/embedBuilder.js";
import { COLORS } from "@base/copy/brand.js";
import {
	COLUMNS,
	FLEET,
	createMatch,
	applyShot,
	opponentView,
	ownView,
	shipsRemaining,
	sunkShips,
	formatCoord,
	type BattleshipState,
	type Coord,
	type PlayerBoard,
	type Ship,
} from "@features/games/battleshipState.js";
import {
	renderBattleshipBoardCard,
	renderBattleshipFleetCard,
	type BattleshipBoardView,
	type BattleshipFleetView,
} from "@features/games/battleshipRenderer.js";
import { isRenderPayload, withRenderFallback, type RenderPayload } from "@features/renderer/index.js";
import { GAME_ROOM_PREFIX } from "./gameRoomActions.js";
import { turnButtonId } from "./turnPrompt.js";
import type { PrivateViewContent } from "./privateView.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { labelBotMentions } from "./botSeat.js";

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
	status: "setup" | "playing" | "finished";
	winnerId: string | null;
	missedTurns: [number, number];
	// Who pressed Ready during setup (post-launch plan item 17). ABSENT on a match
	// stored before setup existed, which was already past it, so it reads as both.
	ready?: [boolean, boolean];
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
		ready: state.ready,
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
		ready: stored.ready ?? [true, true],
	};
}

// Start a match for a provisioned room, in setup (post-launch plan item 17).
// Placement is automatic with a Randomize button; manual placement is deferred by
// decision, being a second full coordinate UI for a fraction of the value.
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
// opponent and including a spectator scrolling back. With `imageRef` the rendered
// card carries the grids, so the description keeps only the headline lines.
export function publicBoardEmbed(state: BattleshipState, imageRef?: string): EmbedBuilder {
	const [first, second] = state.players;
	const section = (viewer: PlayerBoard, target: PlayerBoard): string => {
		const heading = `**${viewer.username}** firing on **${target.username}** (${shipsRemaining(state, target.userId)} ships left)`;
		if (imageRef) return heading;
		const grid = opponentView(state, viewer.userId).map((row) => row.map((cell) => CELL[cell]));
		return [heading, renderGrid(grid)].join("\n");
	};

	const turnLine = statusLine(state);

	// A Dero bot captain (2026-10 item 250 Phase 5) is named rather than mentioned.
	const embed = infoEmbed(
		gameRoomsCopy.battleship.boardTitle,
		labelBotMentions([turnLine, "", section(first, second), "", section(second, first)].join("\n")),
		COLORS.ARCADE as ColorResolvable
	);
	return imageRef ? embed.setImage(imageRef) : embed;
}

// The line above both grids: setup's ready roll call, whose turn it is, or the end.
function statusLine(state: BattleshipState): string {
	const copy = gameRoomsCopy.battleship;
	if (state.status === "setup") {
		return copy.setupLine(state.players.map((player, index) => ({ userId: player.userId, ready: state.ready[index] })));
	}
	if (state.status === "finished") return copy.finished(state.winnerId);
	return copy.turnLine(state.players[state.turn].userId);
}

/**
 * What the setup modal shows (2026-10 item 257 Phase 4a): the viewer's own fleet as the emoji
 * grid and what is afloat. ⚠️ PRIVATE ONLY, like privateBoardView: it reads ownView, and it
 * reaches a player only inside their own modal.
 */
export function ownFleetText(state: BattleshipState, viewerId: string): string {
	return [ownGridText(state, viewerId), gameRoomsCopy.battleship.fleetLine(afloatShipNames(state, viewerId))].join("\n");
}

/**
 * What the firing modal shows: the viewer's target grid, built from opponentView and so from
 * the shots that were FIRED only, never a ship's unfired cell. Safe to show, and still shown
 * only inside the modal, where it replaces the board's selects.
 */
export function targetGridText(state: BattleshipState, viewerId: string): string {
	const grid = opponentView(state, viewerId).map((row) => row.map((cell) => CELL[cell]));
	const opponent = state.players.find((player) => player.userId !== viewerId);
	const shipsLeft = opponent ? shipsRemaining(state, opponent.userId) : 0;
	return [renderGrid(grid), gameRoomsCopy.battleship.targetLine(shipsLeft)].join("\n");
}

// The viewer's own grid as emoji, their ships and the shots fired at them. One
// builder for the private embed and the private view modal, so the two cannot draw
// a fleet differently.
function ownGridText(state: BattleshipState, viewerId: string): string {
	const grid = ownView(state, viewerId).map((row) =>
		row.map((cell) => (cell.hit ? CELL.hit : cell.ship ? CELL.ship : cell.miss ? CELL.miss : CELL.unknown))
	);
	return renderGrid(grid);
}

/**
 * The private view modal's content (post-launch plan item 16): the viewer's own grid
 * and what is still afloat, plus setup's next step while the fleets are being laid.
 * ⚠️ PRIVATE ONLY, like privateBoardEmbed: it reads ownView.
 */
export function privateBoardView(state: BattleshipState, viewerId: string): PrivateViewContent {
	const copy = gameRoomsCopy.battleship;
	const sections = [ownGridText(state, viewerId), copy.fleetLine(afloatShipNames(state, viewerId))];
	if (state.status === "setup") sections.push(copy.privateSetupHint);
	return { title: copy.privateModalTitle, sections };
}

// The PRIVATE board: the viewer's own fleet, with their opponent's shots on it.
// Reachable ONLY as an ephemeral reply to the viewer's own click (T16, R20, Q8).
// No private channels and no DMs: a channel per player costs two channels per match
// against a 500 channel server cap, on top of the room's own.
export function privateBoardEmbed(state: BattleshipState, viewerId: string, imageRef?: string): EmbedBuilder {
	const fleetLine = gameRoomsCopy.battleship.fleetLine(afloatShipNames(state, viewerId));
	if (imageRef) {
		return infoEmbed(gameRoomsCopy.battleship.ownBoardTitle, fleetLine, COLORS.ARCADE as ColorResolvable).setImage(imageRef);
	}
	return infoEmbed(gameRoomsCopy.battleship.ownBoardTitle, [ownGridText(state, viewerId), "", fleetLine].join("\n"), COLORS.ARCADE as ColorResolvable);
}

// The viewer's ships still afloat, in fleet order. One helper for the private embed
// and the private card, so the two can never list a different fleet.
function afloatShipNames(state: BattleshipState, viewerId: string): string[] {
	const board = state.players.find((player) => player.userId === viewerId);
	return FLEET.filter((ship) => {
		const own = board?.ships.find((candidate) => candidate.name === ship.name);
		return own ? own.hits.size < own.cells.length : false;
	}).map((ship) => ship.name);
}

// ── the cards (2026-10 item 243 Phase 3) ──────────────────────────────
// The rendered board and the rendered private fleet, each behind
// withRenderFallback with the emoji grid embed as its fallback. Views are built
// INSIDE the render function, so a view that throws costs the picture, not the turn.

/** The shot a board redraw follows, when it sank a ship: the sinking reveal. */
export interface BattleshipSinking {
	shooterId: string;
	ship: string;
}

/** The public board card's view: opponentView and sunkShips for both sides, never a ship's unfired cell. */
export function battleshipBoardView(state: BattleshipState, sinking: BattleshipSinking | null = null): BattleshipBoardView {
	const copy = gameRoomsCopy.battleship;
	const [first, second] = state.players;
	const section = (viewer: PlayerBoard, target: PlayerBoard) => ({
		title: copy.cardFiringOn(viewer.username, target.username),
		shipsLeft: copy.cardShipsLeft(shipsRemaining(state, target.userId)),
		grid: opponentView(state, viewer.userId),
		sunk: sunkShips(state, viewer.userId),
	});
	const nameOf = (userId: string | null): string => state.players.find((player) => player.userId === userId)?.username ?? "";
	const shooterIndex = sinking ? state.players.findIndex((player) => player.userId === sinking.shooterId) : -1;
	return {
		headline: boardHeadline(state, nameOf),
		sections: [section(first, second), section(second, first)],
		sinking:
			sinking && shooterIndex >= 0
				? { sectionIndex: shooterIndex, ship: sinking.ship, line: copy.cardSank(nameOf(sinking.shooterId), sinking.ship) }
				: null,
	};
}

function boardHeadline(state: BattleshipState, nameOf: (userId: string | null) => string): string {
	const copy = gameRoomsCopy.battleship;
	if (state.status === "setup") return copy.cardSetup;
	if (state.status !== "finished") return copy.cardTurn(state.players[state.turn].username);
	return state.winnerId ? copy.cardWinner(nameOf(state.winnerId)) : copy.cardOver;
}

function battleshipFleetView(state: BattleshipState, viewerId: string): BattleshipFleetView {
	return {
		title: gameRoomsCopy.battleship.cardOwnTitle,
		fleetLine: gameRoomsCopy.battleship.fleetLine(afloatShipNames(state, viewerId)),
		grid: ownView(state, viewerId),
	};
}

export interface BattleshipBoardMessage {
	embeds: EmbedBuilder[];
	components: ActionRowBuilder<never>[];
	files: AttachmentBuilder[];
}

/**
 * The public board message: the rendered board when it draws, the emoji grid
 * embed when it does not, and the controls either way. Shared by the first post,
 * every redraw after a shot and the turn sweep's redraw. An edit must pass
 * `attachments: []` beside it, or the previous turn's picture stays on the message.
 */
export async function battleshipBoardMessage(
	state: BattleshipState,
	roomId: string,
	sinking: BattleshipSinking | null = null
): Promise<BattleshipBoardMessage> {
	return battleshipBoardMessageWith(state, roomId, await battleshipBoardCard(state, sinking));
}

/**
 * The public board message around a card already drawn, or the emoji grid when
 * `card` is null. For a redraw that drew its card behind the drawing pause.
 */
export function battleshipBoardMessageWith(state: BattleshipState, roomId: string, card: RenderPayload | null): BattleshipBoardMessage {
	return {
		embeds: [publicBoardEmbed(state, card?.ref)],
		components: battleshipRows(roomId, state),
		files: card ? [card.attachment] : [],
	};
}

/**
 * The rendered public board alone, or null when it did not draw. The fallback is
 * null because both callers already hold the text: the board message builds the
 * emoji grid embed itself, and a result card without art is the room's own.
 */
export async function battleshipBoardCard(state: BattleshipState, sinking: BattleshipSinking | null = null): Promise<RenderPayload | null> {
	return withRenderFallback(
		() => renderBattleshipBoardCard(battleshipBoardView(state, sinking)),
		() => null
	);
}

/**
 * The private board reply: the rendered fleet when it draws, the emoji grid when
 * it does not. ⚠️ EPHEMERAL ONLY, like privateBoardEmbed: this is the one picture
 * of a whole fleet, and the renderer never caches it.
 */
export async function privateBoardReply(state: BattleshipState, viewerId: string): Promise<{ embeds: EmbedBuilder[]; files: AttachmentBuilder[] }> {
	const card = await withRenderFallback(
		() => renderBattleshipFleetCard(battleshipFleetView(state, viewerId)),
		() => privateBoardEmbed(state, viewerId)
	);
	if (isRenderPayload(card)) return { embeds: [privateBoardEmbed(state, viewerId, card.ref)], files: [card.attachment] };
	return { embeds: [card], files: [] };
}

// ── controls ──────────────────────────────────────────────────────────
// ⚠️ NEVER A BUTTON GRID (T17), and since item 257 Phase 4a no aim selects either. A 10x10 grid
// of buttons is 100 components against Discord's hard cap of 25 (5 rows of 5); the file and the
// rank are two selects inside the firing modal, opened by Fire or by the turn prompt's Take your
// turn, so the board carries one row of buttons.
export function battleshipRows(roomId: string, state: BattleshipState): ActionRowBuilder<never>[] {
	if (state.status === "setup") return [setupRow(roomId) as unknown as ActionRowBuilder<never>];

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

	return [buttons as unknown as ActionRowBuilder<never>];
}

// The setup row (post-launch plan item 17, one modal since item 257 Phase 4a), the board's only
// row until both captains are ready: one button opens the modal that shows your fleet and takes
// either choice, Randomize again or I am ready, and one Submit does it. It is the turn prompt's
// own press with the "setup" fingerprint (battleshipTurnAdapter). The old Randomize and Ready
// buttons on a board posted before this still route (`reroll`, `bready`).
function setupRow(roomId: string): ActionRowBuilder<ButtonBuilder> {
	const copy = gameRoomsCopy.battleship;
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder().setCustomId(turnButtonId(roomId, "setup")).setLabel(copy.setupLabel).setEmoji("⚓").setStyle(ButtonStyle.Primary),
		new ButtonBuilder().setCustomId(`${GAME_ROOM_PREFIX}:forfeit:${roomId}`).setLabel(copy.forfeitLabel).setStyle(ButtonStyle.Secondary)
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

// Resolve a shot at `aim` against the stored match. Returns what to say and, when the
// shot landed, the new state for the caller to persist and render.
export function fire(stored: StoredBattleship, shooterId: string, aim: Coord): FireOutcome {
	const state = deserializeMatch(stored);

	if (state.status === "setup") return { ok: false, message: gameRoomsCopy.battleship.setupFirst };
	if (state.status !== "playing") return { ok: false, message: gameRoomsCopy.battleship.matchOver };
	if (state.players[state.turn].userId !== shooterId) return { ok: false, message: gameRoomsCopy.battleship.notYourTurn };

	const result = applyShot(state, shooterId, aim);

	// The four refusals cost NOTHING, not even the turn. A repeat in particular:
	// a select menu makes a double submit easy, and spending somebody's turn on
	// their own double click is the kind of unfairness a player never forgives.
	switch (result.status) {
		case "setup":
			return { ok: false, message: gameRoomsCopy.battleship.setupFirst };
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
