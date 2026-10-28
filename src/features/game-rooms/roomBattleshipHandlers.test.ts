import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client, ButtonInteraction } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: { update: vi.fn(), findByRoomId: vi.fn(), setSecretField: vi.fn(), updateSecretIf: vi.fn() },
}));
vi.mock("./roomTrail.js", () => ({ roomTrail: { postMove: vi.fn() } }));
vi.mock("./roomLifecycle.js", () => ({ roomLifecycle: { finish: vi.fn() } }));
vi.mock("@features/games/gameXp.js", () => ({ awardTwoPlayerResult: vi.fn() }));
vi.mock("@features/leveling/awardXp.js", () => ({ awardXp: vi.fn() }));

import { battleshipTurnAdapter, handleFire, handleViewBoard, handleReroll, handleReady } from "./roomBattleshipHandlers.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { awardXp } from "@features/leveling/awardXp.js";
import { awardTwoPlayerResult } from "@features/games/gameXp.js";
import { roomTrail } from "./roomTrail.js";
import { startMatch, deserializeMatch, serializeMatch, type StoredBattleship } from "./roomBattleship.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

const storeMock = gameRoomStore as unknown as {
	update: ReturnType<typeof vi.fn>;
	findByRoomId: ReturnType<typeof vi.fn>;
	setSecretField: ReturnType<typeof vi.fn>;
	updateSecretIf: ReturnType<typeof vi.fn>;
};
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
		deferUpdate: vi.fn().mockResolvedValue(undefined),
		showModal: vi.fn().mockResolvedValue(undefined),
	} as unknown as ButtonInteraction;
}

// Fire through the turn modal's Submit, the path every member's shot takes since item 257
// Phase 4a: the adapter plays the file and rank the two selects carried.
const modalClient = { channels: { fetch: vi.fn().mockResolvedValue(null) } } as unknown as Client;
const fireAtCell = (room: IGameRoom, userId: string, x: number, y: number, acknowledge: () => Promise<unknown> = async () => undefined) =>
	battleshipTurnAdapter.apply(modalClient, room, userId, { file: String(x), rank: String(y) }, acknowledge);

// A match in setup, as the provisioner stores it (post-launch plan item 17), and the
// same match past setup, which is what every firing case starts from.
const setupMatch = () => startMatch({ playerIds: [A, B] } as IGameRoom, { [A]: "A", [B]: "B" }, seededRng());
const freshMatch = (): StoredBattleship => ({ ...setupMatch(), status: "playing", ready: [true, true] });

// The modals a press opened, and the text of its notice: a refusal or a short answer now
// opens a notice modal instead of a private reply (2026-10 item 254 Phase 5b).
const shownModals = (interaction: { showModal: unknown }) =>
	(interaction.showModal as ReturnType<typeof vi.fn>).mock.calls.map((call) => (call[0] as { toJSON(): { custom_id: string; components: { content?: string }[] } }).toJSON());
const noticeText = (interaction: { showModal: unknown }): string =>
	shownModals(interaction)
		.filter((modal) => modal.custom_id.startsWith("notice:"))
		.flatMap((modal) => modal.components.map((component) => component.content ?? ""))
		.join("\n");

beforeEach(() => {
	vi.clearAllMocks();
	storeMock.update.mockResolvedValue(undefined);
});

describe("firing", () => {
	it("refuses the Fire button when it is not your turn, and writes nothing", async () => {
		const interaction = makeInteraction(B);

		await handleFire(interaction, makeRoom(freshMatch()));

		expect(storeMock.update).not.toHaveBeenCalled();
		expect(noticeText(interaction)).toBe(gameRoomsCopy.turnPrompt.notYourTurn);
	});

	it("opens ONE modal from Fire: the target grid, a file select A to J and a rank select 1 to 10", async () => {
		const interaction = makeInteraction(A);

		await handleFire(interaction, makeRoom(freshMatch()));

		const [modal] = shownModals(interaction);
		expect(modal.custom_id).toBe("gameroomModal:turn:room-1:b0");
		const json = JSON.stringify(modal.components);
		expect(json).toContain("Column (A to J)");
		expect(json).toContain("Row (1 to 10)");
		expect((json.match(/"custom_id":"file"/g) ?? []).length).toBe(1);
		expect((json.match(/"custom_id":"rank"/g) ?? []).length).toBe(1);
		expect(storeMock.update).not.toHaveBeenCalled();
	});

	// The shot rides its own board's This turn block (2026-10 item 263 R3-29), recorded once that
	// board posts (roomBattleshipHandlers.turnBoard.test.ts), so it is never a line of its own.
	it("fires with one Submit: the shooter is acknowledged without a private copy, and the shot posts no line of its own", async () => {
		const acknowledge = vi.fn().mockResolvedValue(undefined);

		const result = await fireAtCell(makeRoom(freshMatch()), A, 0, 0, acknowledge);

		expect(result).toEqual({ ok: true });
		expect(acknowledge).toHaveBeenCalledOnce();
		expect(roomTrail.postMove).not.toHaveBeenCalled();
	});

	it("refuses a Submit from the captain who is not on the clock, and writes nothing", async () => {
		const result = await fireAtCell(makeRoom(freshMatch()), B, 0, 0);

		expect(result).toEqual({ ok: false, reason: gameRoomsCopy.battleship.notYourTurn });
		expect(storeMock.update).not.toHaveBeenCalled();
	});

	it("refuses a repeat target without spending the turn", async () => {
		const match = freshMatch();
		const state = deserializeMatch(match);
		// Shots are recorded on the board they landed on, so A's earlier shot sits on B's board.
		state.players[1].shots.add("0,0");

		const result = await fireAtCell(makeRoom(serializeMatch(state, { boardMessageId: null })), A, 0, 0);

		expect(result.ok).toBe(false);
		expect(storeMock.update).not.toHaveBeenCalled();
	});

	it("refuses a coordinate that is not on the grid", async () => {
		const result = await battleshipTurnAdapter.apply(modalClient, makeRoom(freshMatch()), A, { file: "x", rank: "" }, async () => undefined);

		expect(result).toEqual({ ok: false, reason: gameRoomsCopy.battleship.offGrid });
	});

	it("keeps no half finished aim on the row any more", async () => {
		await fireAtCell(makeRoom(freshMatch()), A, 0, 0);

		const saved = storeMock.update.mock.calls[0][2].secret as StoredBattleship & { pending?: unknown };
		expect(saved.pending).toBeUndefined();
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
		const room = makeRoom(freshMatch());
		const state = deserializeMatch(room.secret as StoredBattleship);
		const isShip = state.players[1].ships.some((ship) => ship.cells.some((c) => c.x === 0 && c.y === 0));

		await fireAtCell(room, A, 0, 0);

		// Only assert the no-bonus case when the cell really was empty.
		if (!isShip) expect(awardXpMock).not.toHaveBeenCalled();
	});

	it("pays the sink bonus WITHOUT a game field, so `played` is not double counted", async () => {
		const { room, cells } = sinkingShot();
		let match = room.secret as StoredBattleship;

		// Hit every cell of the destroyer. A's turn returns after each of B's, which
		// never comes, so the turn is forced back for the purposes of this fixture.
		for (const cell of cells) {
			match = { ...match, turn: 0 };
			await fireAtCell(makeRoom(match), A, cell.x, cell.y);
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
	// reach the channel: a modal only the presser sees (post-launch plan item 16).
	it("opens the presser's own board as a modal, and posts nothing", async () => {
		const interaction = makeInteraction(A);
		await handleViewBoard(interaction, makeRoom(freshMatch()));

		expect(interaction.showModal).toHaveBeenCalledOnce();
		expect(interaction.reply).not.toHaveBeenCalled();
	});

	// When Discord refuses the modal the old answer stands, still private; 64 is
	// MessageFlags.Ephemeral.
	it("falls back to an ephemeral reply when the modal is refused", async () => {
		const interaction = makeInteraction(A);
		(interaction.showModal as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Invalid Form Body"));
		await handleViewBoard(interaction, makeRoom(freshMatch()));

		const reply = (interaction.reply as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as { flags?: number };
		expect(reply.flags).toBe(64);
	});
});

describe("the setup modal", () => {
	it("shows the captain's own fleet and one select, Randomize again or I am ready", async () => {
		const interaction = makeInteraction(A);

		await handleFire(interaction, makeRoom(setupMatch()));

		const [modal] = shownModals(interaction);
		expect(modal.custom_id).toBe("gameroomModal:turn:room-1:setup");
		const json = JSON.stringify(modal.components);
		expect(json).toContain("I am ready");
		expect(json).toContain("Randomize again");
		expect(json).toContain("Still afloat");
	});

	it("lays the fleet again on a Randomize Submit, writing only this captain's own slot", async () => {
		const room = makeRoom(setupMatch());
		const acknowledge = vi.fn().mockResolvedValue(undefined);

		const result = await battleshipTurnAdapter.apply(modalClient, room, A, { setup: "reroll" }, acknowledge);

		expect(result).toEqual({ ok: true });
		expect(storeMock.setSecretField.mock.calls[0][2]).toBe("players.0");
		expect(acknowledge).toHaveBeenCalledOnce();
	});

	it("readies in ONE Submit: choosing I am ready locks the captain in", async () => {
		storeMock.setSecretField.mockResolvedValue({ secret: { ...setupMatch(), ready: [true, false] } });
		const acknowledge = vi.fn().mockResolvedValue(undefined);

		const result = await battleshipTurnAdapter.apply(modalClient, makeRoom(setupMatch()), A, { setup: "ready" }, acknowledge);

		expect(result).toEqual({ ok: true });
		expect(storeMock.setSecretField).toHaveBeenCalledWith("guild-1", "room-1", "ready.0", true);
		expect(acknowledge).toHaveBeenCalledOnce();
	});

	it("refuses a second Ready from the same captain with the words the button used", async () => {
		const result = await battleshipTurnAdapter.apply(modalClient, makeRoom({ ...setupMatch(), ready: [true, false] }), A, { setup: "ready" }, async () => undefined);

		expect(result).toEqual({ ok: false, reason: gameRoomsCopy.battleship.alreadyReady });
	});

	it("has no turn to prompt while the fleets are being laid", () => {
		const room = makeRoom(setupMatch());

		expect(battleshipTurnAdapter.whoseTurn(room)).toBeNull();
		expect(battleshipTurnAdapter.view(makeRoom({ ...setupMatch(), ready: [true, false] }), A)).toBeNull();
	});
});

describe("reroll", () => {
	it("re-lays the caller's fleet during setup and shows the new layout privately", async () => {
		const room = makeRoom(setupMatch());
		const before = JSON.stringify((room.secret as StoredBattleship).players[0].ships);
		const interaction = makeInteraction(A);

		await handleReroll(interaction, room);

		const [, , path, value] = storeMock.setSecretField.mock.calls[0];
		// ⚠️ THE PATH IS THE ASSERTION. A whole-secret write here reverted whatever the opponent
		// did between this handler's read and its write; a dotted $set on ONE player's slot
		// cannot touch the other's, so "the opponent's fleet is untouched" stops being a fact
		// about this code path and becomes a fact about the query.
		expect(path).toBe("players.0");
		expect(JSON.stringify((value as StoredBattleship["players"][number]).ships)).not.toBe(before);
		expect(storeMock.update).not.toHaveBeenCalled();
		// The answer is the private view of the fleet just laid, never a channel message.
		expect(interaction.showModal).toHaveBeenCalledOnce();
		expect(interaction.reply).not.toHaveBeenCalled();
	});

	it("refuses a captain who is already ready, and writes nothing", async () => {
		const room = makeRoom({ ...setupMatch(), ready: [true, false] });
		const interaction = makeInteraction(A);

		await handleReroll(interaction, room);

		expect(storeMock.setSecretField).not.toHaveBeenCalled();
		expect(noticeText(interaction)).toBe(gameRoomsCopy.battleship.alreadyReady);
	});

	// Re-laying mid-match would move ships out from under hits the opponent has
	// already earned. A board posted before setup existed keeps its old words.
	it("refuses once the battle is under way", async () => {
		const match = freshMatch();
		const state = deserializeMatch(match);
		state.players[1].shots.add("0,0");
		const room = makeRoom({ ...serializeMatch(state), ready: undefined });

		const interaction = makeInteraction(A);
		await handleReroll(interaction, room);

		expect(storeMock.setSecretField).not.toHaveBeenCalled();
		expect(noticeText(interaction)).toMatch(/first shot/i);
	});
});

describe("ready (post-launch plan item 17)", () => {
	it("locks only this captain's slot, and does not start the battle on the first Ready", async () => {
		const room = makeRoom(setupMatch());
		storeMock.setSecretField.mockResolvedValue({ secret: { ...setupMatch(), ready: [true, false] } });
		const interaction = makeInteraction(A);

		await handleReady(interaction, room);

		expect(storeMock.setSecretField).toHaveBeenCalledWith("guild-1", "room-1", "ready.0", true);
		expect(storeMock.updateSecretIf).not.toHaveBeenCalled();
		expect(interaction.deferUpdate).toHaveBeenCalledOnce();
	});

	it("starts the battle on the second Ready, through a compare and swap on setup", async () => {
		const room = makeRoom({ ...setupMatch(), ready: [true, false] });
		const both = { ...setupMatch(), ready: [true, true] };
		storeMock.setSecretField.mockResolvedValue({ secret: both });
		storeMock.updateSecretIf.mockResolvedValue({ secret: { ...both, status: "playing" } });

		await handleReady(makeInteraction(B), room);

		const [, , expected, saved] = storeMock.updateSecretIf.mock.calls[0] as [string, string, Record<string, unknown>, StoredBattleship];
		expect(expected).toEqual({ "secret.status": "setup" });
		expect(saved.status).toBe("playing");
		const lines = (roomTrail.postMove as unknown as ReturnType<typeof vi.fn>).mock.calls.map((call) => (call[2] as { text: string }).text);
		expect(lines).toContain(gameRoomsCopy.battleship.battleBegins(A));
	});

	it("does not announce a battle another press already started", async () => {
		const room = makeRoom({ ...setupMatch(), ready: [true, false] });
		storeMock.setSecretField.mockResolvedValue({ secret: { ...setupMatch(), ready: [true, true] } });
		storeMock.updateSecretIf.mockResolvedValue(null);

		await handleReady(makeInteraction(B), room);

		const lines = (roomTrail.postMove as unknown as ReturnType<typeof vi.fn>).mock.calls.map((call) => (call[2] as { text: string }).text);
		expect(lines).not.toContain(gameRoomsCopy.battleship.battleBegins(A));
	});

	it("refuses a second Ready from the same captain", async () => {
		const interaction = makeInteraction(A);
		await handleReady(interaction, makeRoom({ ...setupMatch(), ready: [true, false] }));

		expect(storeMock.setSecretField).not.toHaveBeenCalled();
		expect(noticeText(interaction)).toBe(gameRoomsCopy.battleship.alreadyReady);
	});

	it("offers no firing modal while the fleets are being laid: the same press opens the setup one", async () => {
		const interaction = makeInteraction(A);
		await handleFire(interaction, makeRoom(setupMatch()));

		expect(storeMock.update).not.toHaveBeenCalled();
		expect(shownModals(interaction)[0].custom_id).toBe("gameroomModal:turn:room-1:setup");
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
			current = { ...current, turn: 0 };
			await fireAtCell(makeRoom(current), A, cell.x, cell.y);
			current = storeMock.update.mock.calls[storeMock.update.mock.calls.length - 1][2].secret as StoredBattleship;
		}

		expect(awardMatchMock).toHaveBeenCalledOnce();
		expect(awardMatchMock.mock.calls[0][0]).toMatchObject({ game: "battleship", winner: "challenger" });
	});
});
