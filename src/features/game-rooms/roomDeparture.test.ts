import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "discord.js";

vi.mock("@features/games/blackjackHandler.js", () => ({ leaveBlackjackRoomSeat: vi.fn() }));
vi.mock("./roomTrail.js", () => ({ roomTrail: { postMove: vi.fn() } }));
vi.mock("./roomLifecycle.js", () => ({ roomLifecycle: { finish: vi.fn() } }));
vi.mock("./roomMonopolySurrender.js", () => ({ surrenderMonopolySeat: vi.fn() }));
vi.mock("./roomHoldemHandlers.js", () => ({ removeFromTable: vi.fn() }));
vi.mock("./roomBattleshipHandlers.js", () => ({ forfeitBattleship: vi.fn() }));
vi.mock("./roomHangman.js", () => ({
	giveUpHangmanRound: vi.fn(),
	leaveHangmanRound: vi.fn(),
	isHangmanRoom: (room: { game: string }) => room.game === "hangman" || room.game === "solo-hangman",
}));

import { departMatch } from "./roomDeparture.js";
import { leaveBlackjackRoomSeat } from "@features/games/blackjackHandler.js";
import { roomTrail } from "./roomTrail.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { surrenderMonopolySeat } from "./roomMonopolySurrender.js";
import { removeFromTable } from "./roomHoldemHandlers.js";
import { forfeitBattleship } from "./roomBattleshipHandlers.js";
import { giveUpHangmanRound, leaveHangmanRound } from "./roomHangman.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

const mocked = (fn: unknown) => fn as ReturnType<typeof vi.fn>;
const postMove = mocked(roomTrail.postMove);
const finish = mocked(roomLifecycle.finish);

const client = { user: { id: "bot-1" } } as unknown as Client;
const LEFT_LINE = gameRoomsCopy.trail.playerLeftGuild("leaver-1");

function makeRoom(game: string, overrides: Partial<IGameRoom> = {}): IGameRoom {
	return {
		roomId: "room-1",
		guildId: "guild-1",
		game,
		hostId: "host-1",
		playerIds: ["host-1", "leaver-1", "p3", "p4"],
		visibility: "public",
		status: "playing",
		channelId: "chan-1",
		...overrides,
	} as unknown as IGameRoom;
}

beforeEach(() => {
	vi.clearAllMocks();
	postMove.mockResolvedValue(true);
	finish.mockResolvedValue(true);
	mocked(surrenderMonopolySeat).mockResolvedValue("surrendered");
	mocked(removeFromTable).mockResolvedValue("removed");
});

describe("departMatch (2026-10 item 276, audit P1-4)", () => {
	it("surrenders a Monopoly seat with the server leave line on the turn's board, and the match goes on", async () => {
		const room = makeRoom("monopoly");

		await departMatch(client, room, "leaver-1", "leftServer");

		expect(surrenderMonopolySeat).toHaveBeenCalledWith(client, room, "leaver-1", LEFT_LINE);
		// The line rides the board with the forfeit, so it is not posted a second time.
		expect(postMove).not.toHaveBeenCalled();
		expect(finish).not.toHaveBeenCalled();
	});

	it("posts the Monopoly leave line on its own when no seat was left to take out", async () => {
		mocked(surrenderMonopolySeat).mockResolvedValue("notInMatch");

		await departMatch(client, makeRoom("monopoly"), "leaver-1", "leftServer");

		expect(postMove).toHaveBeenCalledWith(client, expect.anything(), expect.objectContaining({ actorId: "leaver-1", text: LEFT_LINE }));
	});

	it("takes a Hold'em seat off the table as its own leave, never finishing the table for the rest", async () => {
		const room = makeRoom("holdem");

		await departMatch(client, room, "leaver-1", "leftServer");

		expect(postMove).toHaveBeenCalledWith(client, room, expect.objectContaining({ kind: "system", text: LEFT_LINE }));
		expect(removeFromTable).toHaveBeenCalledWith(client, room, "leaver-1", "leaver-1");
		expect(finish).not.toHaveBeenCalled();
	});

	it("leaves a Blackjack seat through the table's own Leave", async () => {
		await departMatch(client, makeRoom("blackjack"), "leaver-1", "leftServer");

		expect(leaveBlackjackRoomSeat).toHaveBeenCalledWith("chan-1", "leaver-1");
		expect(finish).not.toHaveBeenCalled();
	});

	it.each(["forfeit", "leftServer"] as const)("ends Battleship through its rated forfeit on a %s", async (cause) => {
		const room = makeRoom("battleship", { playerIds: ["host-1", "leaver-1"] });

		await departMatch(client, room, "leaver-1", cause);

		expect(forfeitBattleship).toHaveBeenCalledWith(client, room, "leaver-1");
		expect(finish).not.toHaveBeenCalled();
		const expectedLine = cause === "forfeit" ? gameRoomsCopy.trail.forfeited("leaver-1") : LEFT_LINE;
		expect(postMove).toHaveBeenCalledWith(client, room, expect.objectContaining({ text: expectedLine }));
	});

	it("gives a Hangman round up on the host's forfeit, with no forfeit line of its own", async () => {
		const room = makeRoom("hangman");

		await departMatch(client, room, "host-1", "forfeit");

		expect(giveUpHangmanRound).toHaveBeenCalledWith(client, room);
		expect(postMove).not.toHaveBeenCalled();
		expect(finish).not.toHaveBeenCalled();
	});

	it("lets the Hangman round decide whether a departure ends it", async () => {
		const room = makeRoom("hangman");

		await departMatch(client, room, "leaver-1", "leftServer");

		expect(postMove).toHaveBeenCalledWith(client, room, expect.objectContaining({ text: LEFT_LINE }));
		expect(leaveHangmanRound).toHaveBeenCalledWith(client, room, "leaver-1");
		expect(giveUpHangmanRound).not.toHaveBeenCalled();
	});

	it("hands a one press game to the one player left", async () => {
		const room = makeRoom("rps", { playerIds: ["host-1", "leaver-1"] });

		await departMatch(client, room, "leaver-1", "forfeit");

		expect(finish).toHaveBeenCalledWith(client, room, { winnerId: "host-1", outcome: { bucket: "forfeit" } });
	});
});
