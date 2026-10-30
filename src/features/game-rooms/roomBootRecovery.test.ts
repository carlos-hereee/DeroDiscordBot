import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: { findNonTerminal: vi.fn() },
}));
vi.mock("./roomLifecycle.js", () => ({ finish: vi.fn() }));
vi.mock("./roomArchiveSweep.js", () => ({ sweepExpiredRooms: vi.fn() }));
vi.mock("./roomTrail.js", () => ({ roomTrail: { postMove: vi.fn() } }));
vi.mock("@features/dero-brain/dealerNarration.js", () => ({ registerDealerTable: vi.fn() }));
vi.mock("@features/games/blackjackHandler.js", () => ({
	hasLiveBlackjackTable: vi.fn(),
	disarmStaleBlackjackBoard: vi.fn(),
}));

import { recoverGameRoomsOnBoot } from "./roomBootRecovery.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { finish } from "./roomLifecycle.js";
import { sweepExpiredRooms } from "./roomArchiveSweep.js";
import { roomTrail } from "./roomTrail.js";
import { disarmStaleBlackjackBoard, hasLiveBlackjackTable } from "@features/games/blackjackHandler.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { registerDealerTable } from "@features/dero-brain/dealerNarration.js";

const storeMock = gameRoomStore as unknown as { findNonTerminal: ReturnType<typeof vi.fn> };
const finishMock = finish as unknown as ReturnType<typeof vi.fn>;
const sweepMock = sweepExpiredRooms as unknown as ReturnType<typeof vi.fn>;
const postMoveMock = roomTrail.postMove as unknown as ReturnType<typeof vi.fn>;
const hasTableMock = hasLiveBlackjackTable as unknown as ReturnType<typeof vi.fn>;
const disarmMock = disarmStaleBlackjackBoard as unknown as ReturnType<typeof vi.fn>;
const registerMock = registerDealerTable as unknown as ReturnType<typeof vi.fn>;

const makeRoom = (roomId: string, channelId: string | null, game = "hangman") => ({
	roomId,
	guildId: "guild-1",
	hostId: "host-1",
	channelId,
	game,
	status: "playing",
});

function makeClient(liveChannelIds: string[]): Client {
	return {
		user: { id: "bot-1" },
		channels: {
			fetch: vi.fn(async (id: string) => (liveChannelIds.includes(id) ? { id } : null)),
		},
	} as unknown as Client;
}

beforeEach(() => {
	vi.clearAllMocks();
	storeMock.findNonTerminal.mockResolvedValue([]);
	finishMock.mockResolvedValue(undefined);
	sweepMock.mockResolvedValue({ archived: 0, failed: 0 });
	postMoveMock.mockResolvedValue(true);
	hasTableMock.mockReturnValue(false);
	disarmMock.mockResolvedValue(undefined);
});

describe("recoverGameRoomsOnBoot", () => {
	// ⚠️ THE CASE THIS EXISTS FOR. While the process was down, an admin deleted a room
	// channel and nothing was listening. The row still says "playing", and because the
	// partial unique index counts non-terminal statuses it holds that host's ONE room
	// slot forever: that member can never start another game, everyone else is fine,
	// and no error is ever raised.
	it("closes a room whose channel no longer exists, as abandoned", async () => {
		storeMock.findNonTerminal.mockResolvedValue([makeRoom("ghost", "ch-gone")]);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

		const summary = await recoverGameRoomsOnBoot(makeClient([]));

		expect(summary.abandoned).toBe(1);
		expect(finishMock).toHaveBeenCalledOnce();
		expect(finishMock.mock.calls[0][2]).toEqual({ abandoned: true });
		logSpy.mockRestore();
	});

	it("leaves a room whose channel is still there completely alone", async () => {
		// The overwhelmingly common case: a deploy restarted the bot mid match. The
		// room must come back fully playable, which means nothing touches it.
		storeMock.findNonTerminal.mockResolvedValue([makeRoom("live", "ch-live")]);

		const summary = await recoverGameRoomsOnBoot(makeClient(["ch-live"]));

		expect(summary.abandoned).toBe(0);
		expect(finishMock).not.toHaveBeenCalled();
	});

	// ⚠️ A DRAFT HAS NO CHANNEL BY DEFINITION, so "no channel" says nothing about it.
	// Reaping drafts here would finish every room a host was still configuring at the
	// moment of a deploy. The idle sweep closes one nobody touches (GAME_ROOM_IDLE_ABANDON_MS).
	it("never reaps a draft, which legitimately has no channel yet", async () => {
		storeMock.findNonTerminal.mockResolvedValue([makeRoom("draft", null)]);

		const summary = await recoverGameRoomsOnBoot(makeClient([]));

		expect(summary.abandoned).toBe(0);
		expect(finishMock).not.toHaveBeenCalled();
	});

	it("keeps going when one room fails to close", async () => {
		storeMock.findNonTerminal.mockResolvedValue([makeRoom("a", "gone-a"), makeRoom("b", "gone-b")]);
		finishMock.mockRejectedValueOnce(new Error("unknown guild"));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

		const summary = await recoverGameRoomsOnBoot(makeClient([]));

		expect(finishMock).toHaveBeenCalledTimes(2);
		expect(summary.abandoned).toBe(1);
		errorSpy.mockRestore();
		logSpy.mockRestore();
	});

	// A bot that was down for six hours has rooms that passed archiveAt while nothing
	// was sweeping. Waiting for the first cron tick would leave them visible for five
	// more minutes for no reason.
	it("runs the expiry sweep immediately rather than waiting for the first cron tick", async () => {
		sweepMock.mockResolvedValue({ archived: 3, failed: 0 });
		const summary = await recoverGameRoomsOnBoot(makeClient([]));

		expect(sweepMock).toHaveBeenCalledOnce();
		expect(summary.archived).toBe(3);
	});

	it("still sweeps when the recovery scan itself fails", async () => {
		// The two halves are independent. A Mongo blip on the scan must not skip the
		// archiving, which is the half that deletes channels members can see.
		storeMock.findNonTerminal.mockRejectedValue(new Error("mongo down"));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

		const summary = await recoverGameRoomsOnBoot(makeClient([]));

		expect(sweepMock).toHaveBeenCalledOnce();
		expect(summary.abandoned).toBe(0);
		errorSpy.mockRestore();
	});

	it("never throws into the boot sequence when the sweep fails", async () => {
		// This runs inside main.ts's ready handler. A rejection here would surface as a
		// startup failure in a feature that is not on the critical path.
		sweepMock.mockRejectedValue(new Error("discord down"));
		await expect(recoverGameRoomsOnBoot(makeClient([]))).resolves.toEqual({ abandoned: 0, lostTables: 0, dealersRestored: 0, clocksRebuilt: 0, archived: 0 });
	});

	// ── ①ᶜ the Hold'em dealer a restart silenced (2026-10 item 263 R3-28) ──
	// The dealer registry is memory only, so a playing table whose referee is on is registered
	// again at boot, voice on; a table whose host turned the referee off never is (risk R15).
	describe("a playing Hold'em table's dealer", () => {
		const holdem = (roomId: string, extra: Record<string, unknown> = {}) => ({ ...makeRoom(roomId, `ch-${roomId}`, "holdem"), ...extra });

		it("registers a table with no stored referee, which reads as on, voice on", async () => {
			vi.spyOn(console, "log").mockImplementation(() => undefined);
			storeMock.findNonTerminal.mockResolvedValue([holdem("t1", { referee: null })]);

			const summary = await recoverGameRoomsOnBoot(makeClient(["ch-t1"]));

			expect(registerMock).toHaveBeenCalledWith({ roomId: "t1", guildId: "guild-1", channelId: "ch-t1", voice: true });
			expect(summary.dealersRestored).toBe(1);
			expect(finishMock).not.toHaveBeenCalled();
		});

		it("never registers a table whose host turned the referee off", async () => {
			storeMock.findNonTerminal.mockResolvedValue([holdem("t1", { referee: false })]);

			await recoverGameRoomsOnBoot(makeClient(["ch-t1"]));

			expect(registerMock).not.toHaveBeenCalled();
		});

		it("registers nothing for a draft, another game, or a table whose channel is gone", async () => {
			vi.spyOn(console, "log").mockImplementation(() => undefined);
			storeMock.findNonTerminal.mockResolvedValue([holdem("draft", { status: "draft" }), makeRoom("m1", "ch-m1", "monopoly"), holdem("gone")]);

			await recoverGameRoomsOnBoot(makeClient(["ch-draft", "ch-m1"]));

			expect(registerMock).not.toHaveBeenCalled();
		});
	});

	// ── ①ᵇ the solo blackjack table that did not survive the redeploy ──
	// The hand lives only in blackjackHandler's process-scoped Map, which every boot
	// starts empty. A "playing" solo blackjack row with a live channel is therefore a
	// match SIGTERM already ended: its board's buttons reach nothing and nothing will
	// ever finish it, so the host's one room slot is held by a dead hand.
	describe("a solo blackjack room whose table was lost to the restart", () => {
		it("says so in the room, disarms the dead board, and closes the room as abandoned", async () => {
			const room = makeRoom("solo", "ch-live", "solo-blackjack");
			storeMock.findNonTerminal.mockResolvedValue([room]);
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

			const summary = await recoverGameRoomsOnBoot(makeClient(["ch-live"]));

			expect(summary).toMatchObject({ abandoned: 0, lostTables: 1 });
			expect(postMoveMock).toHaveBeenCalledOnce();
			expect(postMoveMock.mock.calls[0][2]).toMatchObject({
				actorId: "bot-1",
				kind: "system",
				text: gameRoomsCopy.trail.tableLostToRestart,
			});
			expect(disarmMock).toHaveBeenCalledWith({ id: "ch-live" });
			// Abandoned, not a loss: no hand was settled, and abandoned pays nothing, so a
			// redeploy can never be farmed for room xp.
			expect(finishMock).toHaveBeenCalledOnce();
			expect(finishMock.mock.calls[0][2]).toEqual({ abandoned: true });
			// The line lands BEFORE the result card, so the scroll reads as an explanation
			// followed by the close rather than a close followed by an excuse.
			expect(postMoveMock.mock.invocationCallOrder[0]).toBeLessThan(finishMock.mock.invocationCallOrder[0]);
			logSpy.mockRestore();
		});

		it("leaves the room alone when this process holds its table", async () => {
			// Defensive rather than expected: the sweep runs in the ready handler, so a
			// table opened by a click that raced the sweep must not be closed underneath it.
			hasTableMock.mockReturnValue(true);
			storeMock.findNonTerminal.mockResolvedValue([makeRoom("solo", "ch-live", "solo-blackjack")]);

			const summary = await recoverGameRoomsOnBoot(makeClient(["ch-live"]));

			expect(summary.lostTables).toBe(0);
			expect(finishMock).not.toHaveBeenCalled();
			expect(postMoveMock).not.toHaveBeenCalled();
		});

		it("never treats another game's live room as a lost table, whatever the Map says", async () => {
			// Every other room keeps its state on the row and comes back playable. The
			// Map check is asked only for solo blackjack.
			storeMock.findNonTerminal.mockResolvedValue([makeRoom("hang", "ch-live", "solo-hangman"), makeRoom("bs", "ch-live", "battleship")]);

			const summary = await recoverGameRoomsOnBoot(makeClient(["ch-live"]));

			expect(summary.lostTables).toBe(0);
			expect(hasTableMock).not.toHaveBeenCalled();
			expect(finishMock).not.toHaveBeenCalled();
		});

		it("takes the ordinary channel-gone path when the channel is missing too", async () => {
			// A solo blackjack room whose channel was deleted while the bot was down is
			// the ① case, not ①ᵇ: no channel to post into, no board to disarm.
			storeMock.findNonTerminal.mockResolvedValue([makeRoom("solo", "ch-gone", "solo-blackjack")]);
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

			const summary = await recoverGameRoomsOnBoot(makeClient([]));

			expect(summary).toMatchObject({ abandoned: 1, lostTables: 0 });
			expect(postMoveMock).not.toHaveBeenCalled();
			expect(disarmMock).not.toHaveBeenCalled();
			logSpy.mockRestore();
		});
	});
});
