import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({ gameRoomStore: { update: vi.fn(), findByRoomId: vi.fn(), setSecretField: vi.fn(), moveBoardMessage: vi.fn() } }));
vi.mock("./roomTrail.js", () => ({ roomTrail: { postMove: vi.fn(), recordCarriedMoves: vi.fn() }, resolveRoomChannel: vi.fn() }));
vi.mock("./roomLifecycle.js", () => ({ roomLifecycle: { finish: vi.fn() } }));
vi.mock("@features/games/gameXp.js", () => ({ awardMultiPlayerResult: vi.fn() }));
vi.mock("@features/games/gamesAssets.js", () => ({ resolveGameAsset: vi.fn(() => null) }));
// The end card's drawing is the renderer's own suite; here only what the round's end does.
vi.mock("@features/renderer/index.js", () => ({ withRenderFallback: vi.fn(async (_render: unknown, fallback: () => unknown) => fallback()) }));

import { giveUpHangmanRound, leaveHangmanRound } from "./roomHangman.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { roomTrail } from "./roomTrail.js";
import { awardMultiPlayerResult } from "@features/games/gameXp.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── Give up and leaving a round (2026-10 item 276, audit P2-6 and P1-4) ──
// The round is cooperative, so giving it up names no winner and pays no win, and the word is
// shown in its result line once the round is over (the old forfeit named the host the winner).

const finish = roomLifecycle.finish as unknown as ReturnType<typeof vi.fn>;
const postMove = roomTrail.postMove as unknown as ReturnType<typeof vi.fn>;
const client = { user: { id: "bot-1" } } as unknown as Client;

const WORD = "planet";
const authored = { word: WORD, hint: "a world", authoredBy: "host-1", guessedLetters: ["p"], wrong: 1 };

function makeRoom(secret: Record<string, unknown> | null, playerIds = ["host-1", "guesser-2", "guesser-3"]): IGameRoom {
	return { roomId: "room-1", guildId: "guild-1", game: "hangman", hostId: "host-1", status: "playing", playerIds, channelId: "ch-1", secret } as unknown as IGameRoom;
}

beforeEach(() => {
	vi.clearAllMocks();
	finish.mockResolvedValue(true);
	postMove.mockResolvedValue(true);
});

describe("giveUpHangmanRound", () => {
	it("finishes with no winner, shows the word and pays no win", async () => {
		const room = makeRoom(authored);

		expect(await giveUpHangmanRound(client, room)).toBe(true);

		expect(finish.mock.calls[0][2]).toMatchObject({ winnerId: null, outcome: { bucket: "forfeit" } });
		expect(postMove).toHaveBeenCalledWith(client, room, expect.objectContaining({ kind: "system", text: gameRoomsCopy.hangman.gaveUpLine(WORD) }));
		expect(awardMultiPlayerResult).not.toHaveBeenCalled();
	});

	it("shows the word only when it won the finish claim", async () => {
		finish.mockResolvedValue(false);

		expect(await giveUpHangmanRound(client, makeRoom(authored))).toBe(false);

		expect(postMove).not.toHaveBeenCalled();
	});

	it("ends a round whose word was never set with no word to show", async () => {
		await giveUpHangmanRound(client, makeRoom(null));

		expect(finish.mock.calls[0][2]).toEqual({ winnerId: null, outcome: { bucket: "forfeit" } });
		expect(postMove).not.toHaveBeenCalled();
	});
});

describe("leaveHangmanRound", () => {
	it("gives the round up when the host leaves", async () => {
		await leaveHangmanRound(client, makeRoom(authored), "host-1");

		expect(finish).toHaveBeenCalledOnce();
	});

	it("plays on while another guesser is left", async () => {
		await leaveHangmanRound(client, makeRoom(authored), "guesser-2");

		expect(finish).not.toHaveBeenCalled();
	});

	it("gives the round up when the last guesser leaves", async () => {
		await leaveHangmanRound(client, makeRoom(authored, ["host-1", "guesser-2"]), "guesser-2");

		expect(finish).toHaveBeenCalledOnce();
	});

	// A word Dero drew has no author, so the host is a guesser like everyone else.
	it("counts the host as a guesser of a word Dero drew", async () => {
		await leaveHangmanRound(client, makeRoom({ ...authored, authoredBy: null }, ["host-1", "guesser-2"]), "guesser-2");

		expect(finish).not.toHaveBeenCalled();
	});
});
