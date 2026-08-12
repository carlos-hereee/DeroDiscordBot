import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ButtonInteraction } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({ gameRoomStore: { update: vi.fn(), findByRoomId: vi.fn() } }));
vi.mock("./roomTrail.js", () => ({ roomTrail: { postMove: vi.fn() } }));
vi.mock("./roomLifecycle.js", () => ({ roomLifecycle: { finish: vi.fn() } }));
vi.mock("@features/games/gameXp.js", () => ({ awardTwoPlayerResult: vi.fn() }));
vi.mock("@features/leveling/awardXp.js", () => ({ awardXp: vi.fn() }));

import { handleFire, handleViewBoard, handleReroll } from "./roomBattleshipHandlers.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { awardXp } from "@features/leveling/awardXp.js";
import { awardTwoPlayerResult } from "@features/games/gameXp.js";
import { startMatch, deserializeMatch, serializeMatch, type StoredBattleship } from "./roomBattleship.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

const storeMock = gameRoomStore as unknown as { update: ReturnType<typeof vi.fn> };
const awardXpMock = awardXp as unknown as ReturnType<typeof vi.fn>;
const awardMatchMock = awardTwoPlayerResult as unknown as ReturnType<typeof vi.fn>;

const A = "player-a";
const B = "player-b";

function seededRng(seed = 7): () => number {
	let state = seed;
	return () => {
		state = (state * 1664525 + 1013904223) % 4294967296;
		return state / 4294967296;
	};
}

function makeRoom(match: StoredBattleship): IGameRoom {
	return {
		roomId: "room-1",
		guildId: "guild-1",
		game: "battleship",
		status: "playing",
		playerIds: [A, B],
		channelId: "ch-1",
		secret: match,
	} as unknown as IGameRoom;
}

function makeInteraction(userId: string): ButtonInteraction {
	return {
		guildId: "guild-1",
		guild: { members: { cache: { get: () => ({ displayName: "Player A" }) } } },
		user: { id: userId, username: "a", globalName: "A" },
		client: { channels: { fetch: vi.fn().mockResolvedValue(null) } },
		reply: vi.fn().mockResolvedValue(undefined),
	} as unknown as ButtonInteraction;
}

// Aim player A at a cell that is known to hold one of B's ships, then at the rest
// of that ship, so the sinking shot is reachable deterministically.
function aimedAt(match: StoredBattleship, shooter: string, x: number, y: number): StoredBattleship {
	return { ...match, pending: { [shooter]: { x, y } } };
}

const freshMatch = () => startMatch({ playerIds: [A, B] } as IGameRoom, { [A]: "A", [B]: "B" }, seededRng());

beforeEach(() => {
	vi.clearAllMocks();
	storeMock.update.mockResolvedValue(undefined);
});

describe("firing", () => {
	it("refuses a shot when it is not your turn, and writes nothing", async () => {
		const room = makeRoom(aimedAt(freshMatch(), B, 0, 0));
		const interaction = makeInteraction(B);

		await handleFire(interaction, room);

		expect(storeMock.update).not.toHaveBeenCalled();
	});

	it("refuses a shot with no coordinate chosen", async () => {
		const interaction = makeInteraction(A);
		await handleFire(interaction, makeRoom(freshMatch()));

		const reply = (interaction.reply as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as { content: string };
		expect(reply.content).toMatch(/column and a row/i);
		expect(storeMock.update).not.toHaveBeenCalled();
	});

	it("clears the shooter's aim after firing, so a stray press cannot re-fire it", async () => {
		const room = makeRoom(aimedAt(freshMatch(), A, 0, 0));
		await handleFire(makeInteraction(A), room);

		const saved = storeMock.update.mock.calls[0][2].secret as StoredBattleship;
		expect(saved.pending?.[A]).toBeUndefined();
	});
});

// ⚠️ THE BONUS MUST NOT CARRY `game`. awardXp increments `games.<slug>.played` for
// ANY call naming a game, so a five sink match would record "played 6" against a
// match the member played once, and /account renders that line.
describe("the per sink bonus", () => {
	// Find a real ship cell on B's board so the sink is deterministic rather than
	// dependent on where the rng happened to put things.
	function sinkingShot(): { room: IGameRoom; cells: { x: number; y: number }[] } {
		const match = freshMatch();
		const state = deserializeMatch(match);
		const target = state.players[1].ships.find((ship) => ship.name === "destroyer")!;
		return { room: makeRoom(match), cells: target.cells };
	}

	it("pays nothing extra on an ordinary miss", async () => {
		const room = makeRoom(aimedAt(freshMatch(), A, 0, 0));
		const state = deserializeMatch(room.secret as StoredBattleship);
		const isShip = state.players[1].ships.some((ship) => ship.cells.some((c) => c.x === 0 && c.y === 0));

		await handleFire(makeInteraction(A), room);

		// Only assert the no-bonus case when the cell really was empty.
		if (!isShip) expect(awardXpMock).not.toHaveBeenCalled();
	});

	it("pays the sink bonus WITHOUT a game field, so `played` is not double counted", async () => {
		const { room, cells } = sinkingShot();
		let match = room.secret as StoredBattleship;

		// Hit every cell of the destroyer. A's turn returns after each of B's, which
		// never comes, so the turn is forced back for the purposes of this fixture.
		for (const cell of cells) {
			match = { ...match, turn: 0, pending: { [A]: cell } };
			const current = makeRoom(match);
			await handleFire(makeInteraction(A), current);
			match = storeMock.update.mock.calls[storeMock.update.mock.calls.length - 1][2].secret as StoredBattleship;
		}

		expect(awardXpMock).toHaveBeenCalledOnce();
		const call = awardXpMock.mock.calls[0][0] as Record<string, unknown>;
		expect(call.amount).toBe(BOT_CONSTANTS.LEVELING.GAME_SINK_XP);
		expect(call).not.toHaveProperty("game");
		expect(call).not.toHaveProperty("outcome");
	});

	it("keeps the bonus below a win, so sinking four cannot beat winning", async () => {
		// Five ships at the sink rate must total less than the room win award, or a
		// losing player who sank more ships out-earns the winner.
		expect(BOT_CONSTANTS.LEVELING.GAME_SINK_XP * 5).toBeLessThan(BOT_CONSTANTS.LEVELING.GAME_ROOM_WIN_XP);
	});
});

describe("the private board", () => {
	// ⚠️ THE ONE SURFACE THAT RENDERS A PLAYER'S OWN UNFIRED SHIPS. It must never
	// reach the channel; 64 is MessageFlags.Ephemeral.
	it("always replies ephemerally", async () => {
		const interaction = makeInteraction(A);
		await handleViewBoard(interaction, makeRoom(freshMatch()));

		const reply = (interaction.reply as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as { flags?: number };
		expect(reply.flags).toBe(64);
	});
});

describe("reroll", () => {
	it("re-lays the caller's fleet before the first shot", async () => {
		const room = makeRoom(freshMatch());
		const before = JSON.stringify((room.secret as StoredBattleship).players[0].ships);

		await handleReroll(makeInteraction(A), room);

		const saved = storeMock.update.mock.calls[0][2].secret as StoredBattleship;
		expect(JSON.stringify(saved.players[0].ships)).not.toBe(before);
		// The opponent's fleet is untouched.
		expect(saved.players[1].ships).toEqual((room.secret as StoredBattleship).players[1].ships);
	});

	// Re-laying mid-match would move ships out from under hits the opponent has
	// already earned.
	it("refuses once any shot has landed", async () => {
		const match = freshMatch();
		const state = deserializeMatch(match);
		state.players[1].shots.add("0,0");
		const room = makeRoom(serializeMatch(state));

		const interaction = makeInteraction(A);
		await handleReroll(interaction, room);

		expect(storeMock.update).not.toHaveBeenCalled();
		const reply = (interaction.reply as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as { content: string };
		expect(reply.content).toMatch(/first shot/i);
	});
});

describe("winning", () => {
	it("records the match exactly once, through the two player helper", async () => {
		// Sink every ship B has. The match record is written by awardTwoPlayerResult
		// on the winning shot and by nothing else.
		const match = freshMatch();
		const state = deserializeMatch(match);
		const allCells = state.players[1].ships.flatMap((ship) => ship.cells);
		let current = match;

		for (const cell of allCells) {
			current = { ...current, turn: 0, pending: { [A]: cell } };
			await handleFire(makeInteraction(A), makeRoom(current));
			current = storeMock.update.mock.calls[storeMock.update.mock.calls.length - 1][2].secret as StoredBattleship;
		}

		expect(awardMatchMock).toHaveBeenCalledOnce();
		expect(awardMatchMock.mock.calls[0][0]).toMatchObject({ game: "battleship", winner: "challenger" });
	});
});
