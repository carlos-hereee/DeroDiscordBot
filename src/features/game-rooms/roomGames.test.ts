import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ButtonInteraction, StringSelectMenuInteraction } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: { findByRoomId: vi.fn(), update: vi.fn(), claimSecretField: vi.fn() },
}));
vi.mock("./roomTrail.js", () => ({ roomTrail: { postMove: vi.fn() } }));
vi.mock("./roomLifecycle.js", () => ({ roomLifecycle: { finish: vi.fn() } }));
vi.mock("@features/games/gameXp.js", () => ({ awardTwoPlayerResult: vi.fn() }));
// The rps reveal card, mocked so each test chooses whether it draws (2026-10 item 254 Phase
// 5a). Resolving null by default sends every other rps test through the fallback art.
vi.mock("@features/games/rpsRenderer.js", () => ({ renderRpsCard: vi.fn() }));

import { runRoomMove, handleRpsSelect } from "./roomGames.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { roomTrail } from "./roomTrail.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { awardTwoPlayerResult } from "@features/games/gameXp.js";
import { renderRpsCard } from "@features/games/rpsRenderer.js";
import { AttachmentBuilder } from "discord.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

const storeMock = gameRoomStore as unknown as {
	findByRoomId: ReturnType<typeof vi.fn>;
	update: ReturnType<typeof vi.fn>;
	claimSecretField: ReturnType<typeof vi.fn>;
};
const trailMock = roomTrail as unknown as { postMove: ReturnType<typeof vi.fn> };
const lifecycleMock = roomLifecycle as unknown as { finish: ReturnType<typeof vi.fn> };
const awardMock = awardTwoPlayerResult as unknown as ReturnType<typeof vi.fn>;
const rpsCardMock = renderRpsCard as unknown as ReturnType<typeof vi.fn>;

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
		isModalSubmit: () => false,
		client: {},
		reply: vi.fn().mockResolvedValue(undefined),
	} as unknown as StringSelectMenuInteraction;
}

const publicTrailText = (): string[] => trailMock.postMove.mock.calls.map((call) => (call[2] as { text: string }).text);

// Stands in for the real dotted claim: it refuses a slot that is already taken and otherwise
// returns the row with EVERY pick on it, the other player's included. Modelling that return is
// the point, because the handler now decides `bothIn` from it rather than from the row it read.
function claimAgainst(room: IGameRoom | null) {
	return async (_guildId: string, _roomId: string, path: string, value: unknown) => {
		const existing = ((room?.secret as { picks?: Record<string, unknown> } | null)?.picks ?? {}) as Record<
			string,
			unknown
		>;
		const slot = path.replace(/^picks\./, "");
		if (existing[slot]) return null;
		return { ...(room as IGameRoom), secret: { picks: { ...existing, [slot]: value } } } as IGameRoom;
	};
}

// findByRoomId and the claim must describe the SAME room, or a test proves nothing about either.
function seedRoom(room: IGameRoom) {
	storeMock.findByRoomId.mockResolvedValue(room);
	storeMock.claimSecretField.mockImplementation(claimAgainst(room));
	return room;
}

beforeEach(() => {
	vi.clearAllMocks();
	storeMock.update.mockResolvedValue(undefined);
	storeMock.claimSecretField.mockImplementation(claimAgainst(null));
	trailMock.postMove.mockResolvedValue(true);
	// TRUE, not undefined. finish returns whether THIS call claimed the transition, and the
	// versus award is gated on it. Resolving a falsy default here would silently make every
	// versus test exercise the losing-press path.
	lifecycleMock.finish.mockResolvedValue(true);
	rpsCardMock.mockResolvedValue(null);
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
		seedRoom(makeRoom());

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
		seedRoom(makeRoom());

		await handleRpsSelect(makeSelect(HOST, "scissors"));

		const move = trailMock.postMove.mock.calls[0][2] as { text: string; meta?: unknown };
		expect(JSON.stringify(move)).not.toMatch(/scissors/i);
	});

	it("does not finish the match on the first pick", async () => {
		seedRoom(makeRoom());
		await handleRpsSelect(makeSelect(HOST, "rock"));
		expect(lifecycleMock.finish).not.toHaveBeenCalled();
	});

	it("reveals BOTH throws only once the second pick lands", async () => {
		seedRoom(makeRoom({ secret: { picks: { [HOST]: "rock" } } as never }));

		await handleRpsSelect(makeSelect(OPPONENT, "paper"));

		const revealed = publicTrailText().join(" ");
		expect(revealed).toMatch(/rock/i);
		expect(revealed).toMatch(/paper/i);
	});

	it("scores the reveal and finishes with the right winner", async () => {
		// paper beats rock, and the opponent threw paper.
		seedRoom(makeRoom({ secret: { picks: { [HOST]: "rock" } } as never }));

		await handleRpsSelect(makeSelect(OPPONENT, "paper"));

		expect(lifecycleMock.finish).toHaveBeenCalledOnce();
		// toMatchObject, not toEqual: the payload also carries the payoff art, which
		// is a separate concern from who won.
		expect(lifecycleMock.finish.mock.calls[0][2]).toMatchObject({ winnerId: OPPONENT });
	});

	it("reports a tie as no winner rather than inventing one", async () => {
		seedRoom(makeRoom({ secret: { picks: { [HOST]: "rock" } } as never }));
		await handleRpsSelect(makeSelect(OPPONENT, "rock"));
		expect(lifecycleMock.finish.mock.calls[0][2]).toMatchObject({ winnerId: null });
	});

	// ⚠️ ART RIDES THE RESULT CARD ONLY (R8). The move trail must stay text and
	// embed: a room can carry thirty move posts and re-uploading a PNG per move is
	// bandwidth and a rate limit for nothing.
	it("hands the payoff art to the result card and never to a move", async () => {
		seedRoom(makeRoom({ secret: { picks: { [HOST]: "rock" } } as never }));

		await handleRpsSelect(makeSelect(OPPONENT, "paper"));

		expect(lifecycleMock.finish.mock.calls[0][2]).toHaveProperty("art");
		for (const call of trailMock.postMove.mock.calls) {
			expect(call[2]).not.toHaveProperty("files");
		}
	});

	// 2026-10 item 254 Phase 5a: the reveal is drawn as the rps card, and the result card
	// falls back to the winning hand whenever the card does not draw.
	it("draws the reveal as the rps card on the result card, challenger on the left", async () => {
		const card = { attachment: new AttachmentBuilder(Buffer.from("png"), { name: "rps-1.png" }), ref: "attachment://rps-1.png" };
		rpsCardMock.mockResolvedValue(card);
		seedRoom(makeRoom({ secret: { picks: { [HOST]: "rock" } } as never }));

		await handleRpsSelect(makeSelect(OPPONENT, "paper"));

		expect(rpsCardMock).toHaveBeenCalledWith({
			left: { name: expect.any(String), choice: "rock", isDero: false },
			right: { name: expect.any(String), choice: "paper", isDero: false },
			winner: "right",
		});
		expect(lifecycleMock.finish.mock.calls[0][2]).toMatchObject({ art: card });
	});

	it("falls back to the winning hand when the rps card throws", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		rpsCardMock.mockRejectedValue(new Error("canvas exploded"));
		seedRoom(makeRoom({ secret: { picks: { [HOST]: "rock" } } as never }));

		await handleRpsSelect(makeSelect(OPPONENT, "paper"));

		const { art } = lifecycleMock.finish.mock.calls[0][2] as { art: { ref: string } };
		expect(art.ref).toBe("attachment://paper.png");
		warnSpy.mockRestore();
	});

	it("refuses a second pick from the same player", async () => {
		seedRoom(makeRoom({ secret: { picks: { [HOST]: "rock" } } as never }));
		const interaction = makeSelect(HOST, "paper");

		await handleRpsSelect(interaction);

		// Re-picking would let a player change their throw after seeing the public
		// "locked in" line from the other, which is the cheapest possible cheat. The
		// refusal is now the CLAIM's null return rather than a read-then-check, so the
		// assertion is that nothing downstream ran: no public line, no finish.
		expect(trailMock.postMove).not.toHaveBeenCalled();
		expect(lifecycleMock.finish).not.toHaveBeenCalled();
	});

	// ⚠️ THE RACE THIS HANDLER USED TO LOSE. Both players submitting in the same tick each
	// read a row without the other's pick; the old code wrote `{ picks }` built from that read,
	// so the Mixed blob was replaced wholesale, one pick vanished, `bothIn` was false for BOTH,
	// and the room sat at "playing" forever holding its host's one-room slot with nothing to
	// sweep an rps room. The fix has two halves and this pins the second: the claim is a dotted
	// write on one slot, and the handler reads the result off the RETURNED row.
	it("reveals from the returned row when the other pick landed after this handler read", async () => {
		// The stale read: no picks at all. The claim comes back carrying both, which is what
		// the server would return once the other player's dotted write had landed.
		storeMock.findByRoomId.mockResolvedValue(makeRoom());
		storeMock.claimSecretField.mockResolvedValue(
			makeRoom({ secret: { picks: { [HOST]: "rock", [OPPONENT]: "paper" } } as never })
		);

		await handleRpsSelect(makeSelect(OPPONENT, "paper"));

		expect(publicTrailText().join(" ")).toMatch(/rock/i);
		expect(lifecycleMock.finish).toHaveBeenCalledOnce();
		expect(lifecycleMock.finish.mock.calls[0][2]).toMatchObject({ winnerId: OPPONENT });
	});

	it("claims only this player's own slot, so a concurrent pick cannot be erased", async () => {
		seedRoom(makeRoom());

		await handleRpsSelect(makeSelect(OPPONENT, "paper"));

		// A whole-blob write is what lost the other player's pick. The path must name one slot.
		expect(storeMock.update).not.toHaveBeenCalled();
		expect(storeMock.claimSecretField).toHaveBeenCalledWith("guild-1", "room-1", `picks.${OPPONENT}`, "paper");
	});

	// The select handler is reachable directly; its customId and values are user
	// input whoever built the menu. Gating only the button that opens it would be a
	// gate on the suggestion rather than on the action.
	// claimSecretField, not update: the claim IS the write now, so asserting on `update`
	// would pass whatever the gate did.
	it("refuses a pick from somebody who is not a player", async () => {
		seedRoom(makeRoom());
		await handleRpsSelect(makeSelect("spectator-9", "rock"));

		expect(storeMock.claimSecretField).not.toHaveBeenCalled();
		expect(trailMock.postMove).not.toHaveBeenCalled();
	});

	it("refuses a pick once the room is no longer playing", async () => {
		seedRoom(makeRoom({ status: "finished" }));
		await handleRpsSelect(makeSelect(HOST, "rock"));
		expect(storeMock.claimSecretField).not.toHaveBeenCalled();
	});
});

describe("coin flip and dice roll in a room", () => {
	// The handler re-reads the row before posting anything (the double-press narrowing),
	// so every versus test seeds findByRoomId with the same playing room it passes in.
	it("resolves, posts the result to the trail, and finishes in one press", async () => {
		const room = seedRoom(makeRoom({ game: "coinflip" }));
		await runRoomMove(makeButton(HOST), room);

		expect(trailMock.postMove).toHaveBeenCalledOnce();
		expect(publicTrailText()[0]).toMatch(/heads|tails/i);
		expect(lifecycleMock.finish).toHaveBeenCalledOnce();
	});

	it("names a real player as the winner, never the raw resolver token", async () => {
		await runRoomMove(makeButton(HOST), seedRoom(makeRoom({ game: "coinflip" })));

		const { winnerId } = lifecycleMock.finish.mock.calls[0][2] as { winnerId: string | null };
		// A coin cannot tie, so one of the two players always wins. Passing
		// "challenger" straight through would write a token where a user id belongs.
		expect([HOST, OPPONENT]).toContain(winnerId);
	});

	// ⚠️ THE DOUBLE-PRESS GUARD. Nothing stops both players pressing in the same tick: each
	// resolves its own flip and each reaches finish, whose conditional write lets exactly one
	// through. The game's own award sits OUTSIDE that write, so the loser's press would pay
	// the base XP a second time and record `games.coinflip.played` twice on both members.
	// The losing press ALSO posted a contradictory flip line before its claim lost, so it now
	// follows up with the append-only superseded correction instead of leaving two results.
	it("pays no award on the losing press and posts the superseded correction", async () => {
		lifecycleMock.finish.mockResolvedValue(false);

		await runRoomMove(makeButton(OPPONENT), seedRoom(makeRoom({ game: "coinflip" })));

		expect(lifecycleMock.finish).toHaveBeenCalledOnce();
		expect(awardMock).not.toHaveBeenCalled();
		// Two trail posts: the flip it composed before losing the race, then the correction
		// naming which result stands. Append-only on purpose; editing the posted row would
		// break the send-first-then-append invariant.
		expect(trailMock.postMove).toHaveBeenCalledTimes(2);
		expect(publicTrailText()[1]).toMatch(/already decided/i);
		const meta = trailMock.postMove.mock.calls[1][2] as { meta?: { superseded?: boolean } };
		expect(meta.meta?.superseded).toBe(true);
	});

	it("pays the game award once when the press does end the match", async () => {
		await runRoomMove(makeButton(HOST), seedRoom(makeRoom({ game: "coinflip" })));

		expect(awardMock).toHaveBeenCalledOnce();
	});

	// The fresh re-read: a press whose room already went terminal between the button load and
	// this handler posts NOTHING, because the first press's outcome is already on screen and a
	// second flip line would only contradict it. This is the common double-press case; the
	// superseded correction above covers the narrower race that slips past this read.
	it("drops a press whose room went terminal since the button loaded, posting nothing", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom({ game: "coinflip", status: "finished" }));

		await runRoomMove(makeButton(OPPONENT), makeRoom({ game: "coinflip" }));

		expect(trailMock.postMove).not.toHaveBeenCalled();
		expect(lifecycleMock.finish).not.toHaveBeenCalled();
		expect(awardMock).not.toHaveBeenCalled();
	});

	it("refuses a move in a room that is not playing", async () => {
		const interaction = makeButton(HOST);
		await runRoomMove(interaction, makeRoom({ game: "coinflip", status: "finished" }));

		expect(trailMock.postMove).not.toHaveBeenCalled();
		expect(lifecycleMock.finish).not.toHaveBeenCalled();
	});
});
