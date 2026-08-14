import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ButtonInteraction, StringSelectMenuInteraction } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: { findByRoomId: vi.fn(), update: vi.fn() },
}));
vi.mock("./roomTrail.js", () => ({ roomTrail: { postMove: vi.fn() } }));
vi.mock("./roomLifecycle.js", () => ({ roomLifecycle: { finish: vi.fn() } }));
vi.mock("@features/games/gameXp.js", () => ({ awardTwoPlayerResult: vi.fn() }));

import { runRoomMove, handleRpsSelect } from "./roomGames.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { roomTrail } from "./roomTrail.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { awardTwoPlayerResult } from "@features/games/gameXp.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

const storeMock = gameRoomStore as unknown as {
	findByRoomId: ReturnType<typeof vi.fn>;
	update: ReturnType<typeof vi.fn>;
};
const trailMock = roomTrail as unknown as { postMove: ReturnType<typeof vi.fn> };
const lifecycleMock = roomLifecycle as unknown as { finish: ReturnType<typeof vi.fn> };
const awardMock = awardTwoPlayerResult as unknown as ReturnType<typeof vi.fn>;

const HOST = "host-1";
const OPPONENT = "player-2";

function makeRoom(overrides: Partial<IGameRoom> = {}): IGameRoom {
	return {
		roomId: "room-1",
		guildId: "guild-1",
		game: "rps",
		hostId: HOST,
		playerIds: [HOST, OPPONENT],
		spectatorIds: [],
		visibility: "public",
		channelId: "ch-room",
		status: "playing",
		secret: null,
		moves: [],
		winnerId: null,
		...overrides,
	} as unknown as IGameRoom;
}

function makeButton(userId: string): ButtonInteraction {
	return {
		customId: "gameroom:move:room-1",
		guildId: "guild-1",
		user: { id: userId },
		client: {},
		reply: vi.fn().mockResolvedValue(undefined),
		deferUpdate: vi.fn().mockResolvedValue(undefined),
	} as unknown as ButtonInteraction;
}

function makeSelect(userId: string, value: string): StringSelectMenuInteraction {
	return {
		customId: "gameroomSelect:rps:room-1",
		guildId: "guild-1",
		user: { id: userId },
		values: [value],
		client: {},
		reply: vi.fn().mockResolvedValue(undefined),
	} as unknown as StringSelectMenuInteraction;
}

const publicTrailText = (): string[] => trailMock.postMove.mock.calls.map((call) => (call[2] as { text: string }).text);

beforeEach(() => {
	vi.clearAllMocks();
	storeMock.update.mockResolvedValue(undefined);
	trailMock.postMove.mockResolvedValue(true);
	// TRUE, not undefined. finish returns whether THIS call claimed the transition, and the
	// versus award is gated on it. Resolving a falsy default here would silently make every
	// versus test exercise the losing-press path.
	lifecycleMock.finish.mockResolvedValue(true);
});

// ⚠️ THE ONE REGRESSION THE PLAN CALLS UNFORGIVABLE. A spectator must not learn
// either throw before the reveal. Everything in this block exists to make that
// property fail loudly rather than quietly.
describe("rock paper scissors secrecy", () => {
	it("prompts for a pick EPHEMERALLY, so the prompt itself tells the channel nothing", async () => {
		const interaction = makeButton(HOST);
		await runRoomMove(interaction, makeRoom());

		const payload = (interaction.reply as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as { flags?: number };
		// 64 is MessageFlags.Ephemeral.
		expect(payload.flags).toBe(64);
	});

	it("posts NOTHING public naming the choice when the first player picks", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom());

		await handleRpsSelect(makeSelect(HOST, "rock"));

		// One public line, and it must not contain the throw. The other player needs
		// to know it is their turn; that needs no information about the pick.
		expect(publicTrailText()).toHaveLength(1);
		expect(publicTrailText()[0]).not.toMatch(/rock|paper|scissors/i);
		expect(publicTrailText()[0]).toContain(HOST);
	});

	it("keeps the first pick out of the trail's persisted text as well as its wording", async () => {
		// The transcript is read back by the future dashboard, so a leak into `meta`
		// or `text` on the interim move would leak to a second surface later even if
		// Discord never showed it.
		storeMock.findByRoomId.mockResolvedValue(makeRoom());

		await handleRpsSelect(makeSelect(HOST, "scissors"));

		const move = trailMock.postMove.mock.calls[0][2] as { text: string; meta?: unknown };
		expect(JSON.stringify(move)).not.toMatch(/scissors/i);
	});

	it("does not finish the match on the first pick", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom());
		await handleRpsSelect(makeSelect(HOST, "rock"));
		expect(lifecycleMock.finish).not.toHaveBeenCalled();
	});

	it("reveals BOTH throws only once the second pick lands", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom({ secret: { picks: { [HOST]: "rock" } } as never }));

		await handleRpsSelect(makeSelect(OPPONENT, "paper"));

		const revealed = publicTrailText().join(" ");
		expect(revealed).toMatch(/rock/i);
		expect(revealed).toMatch(/paper/i);
	});

	it("scores the reveal and finishes with the right winner", async () => {
		// paper beats rock, and the opponent threw paper.
		storeMock.findByRoomId.mockResolvedValue(makeRoom({ secret: { picks: { [HOST]: "rock" } } as never }));

		await handleRpsSelect(makeSelect(OPPONENT, "paper"));

		expect(lifecycleMock.finish).toHaveBeenCalledOnce();
		// toMatchObject, not toEqual: the payload also carries the payoff art, which
		// is a separate concern from who won.
		expect(lifecycleMock.finish.mock.calls[0][2]).toMatchObject({ winnerId: OPPONENT });
	});

	it("reports a tie as no winner rather than inventing one", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom({ secret: { picks: { [HOST]: "rock" } } as never }));
		await handleRpsSelect(makeSelect(OPPONENT, "rock"));
		expect(lifecycleMock.finish.mock.calls[0][2]).toMatchObject({ winnerId: null });
	});

	// ⚠️ ART RIDES THE RESULT CARD ONLY (R8). The move trail must stay text and
	// embed: a room can carry thirty move posts and re-uploading a PNG per move is
	// bandwidth and a rate limit for nothing.
	it("hands the payoff art to the result card and never to a move", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom({ secret: { picks: { [HOST]: "rock" } } as never }));

		await handleRpsSelect(makeSelect(OPPONENT, "paper"));

		expect(lifecycleMock.finish.mock.calls[0][2]).toHaveProperty("art");
		for (const call of trailMock.postMove.mock.calls) {
			expect(call[2]).not.toHaveProperty("files");
		}
	});

	it("refuses a second pick from the same player", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom({ secret: { picks: { [HOST]: "rock" } } as never }));
		const interaction = makeSelect(HOST, "paper");

		await handleRpsSelect(interaction);

		// Re-picking would let a player change their throw after seeing the public
		// "locked in" line from the other, which is the cheapest possible cheat.
		expect(storeMock.update).not.toHaveBeenCalled();
		expect(lifecycleMock.finish).not.toHaveBeenCalled();
	});

	// The select handler is reachable directly; its customId and values are user
	// input whoever built the menu. Gating only the button that opens it would be a
	// gate on the suggestion rather than on the action.
	it("refuses a pick from somebody who is not a player", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom());
		await handleRpsSelect(makeSelect("spectator-9", "rock"));

		expect(storeMock.update).not.toHaveBeenCalled();
		expect(trailMock.postMove).not.toHaveBeenCalled();
	});

	it("refuses a pick once the room is no longer playing", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom({ status: "finished" }));
		await handleRpsSelect(makeSelect(HOST, "rock"));
		expect(storeMock.update).not.toHaveBeenCalled();
	});
});

describe("coin flip and dice roll in a room", () => {
	it("resolves, posts the result to the trail, and finishes in one press", async () => {
		const room = makeRoom({ game: "coinflip" });
		await runRoomMove(makeButton(HOST), room);

		expect(trailMock.postMove).toHaveBeenCalledOnce();
		expect(publicTrailText()[0]).toMatch(/heads|tails/i);
		expect(lifecycleMock.finish).toHaveBeenCalledOnce();
	});

	it("names a real player as the winner, never the raw resolver token", async () => {
		await runRoomMove(makeButton(HOST), makeRoom({ game: "coinflip" }));

		const { winnerId } = lifecycleMock.finish.mock.calls[0][2] as { winnerId: string | null };
		// A coin cannot tie, so one of the two players always wins. Passing
		// "challenger" straight through would write a token where a user id belongs.
		expect([HOST, OPPONENT]).toContain(winnerId);
	});

	// ⚠️ THE DOUBLE-PRESS GUARD. Nothing stops both players pressing in the same tick: each
	// resolves its own flip and each reaches finish, whose conditional write lets exactly one
	// through. The game's own award sits OUTSIDE that write, so the loser's press would pay
	// the base XP a second time and record `games.coinflip.played` twice on both members.
	it("pays the game award only on the press that actually ended the match", async () => {
		lifecycleMock.finish.mockResolvedValue(false);

		await runRoomMove(makeButton(OPPONENT), makeRoom({ game: "coinflip" }));

		expect(lifecycleMock.finish).toHaveBeenCalledOnce();
		expect(awardMock).not.toHaveBeenCalled();
	});

	it("pays the game award once when the press does end the match", async () => {
		await runRoomMove(makeButton(HOST), makeRoom({ game: "coinflip" }));

		expect(awardMock).toHaveBeenCalledOnce();
	});

	it("refuses a move in a room that is not playing", async () => {
		const interaction = makeButton(HOST);
		await runRoomMove(interaction, makeRoom({ game: "coinflip", status: "finished" }));

		expect(trailMock.postMove).not.toHaveBeenCalled();
		expect(lifecycleMock.finish).not.toHaveBeenCalled();
	});
});
