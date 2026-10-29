import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// Dero's variant lines always pick the first, so these tests read exact words.
vi.mock("@utils/pickLine.js", () => ({ pickLine: <Line>(lines: readonly Line[]): Line => lines[0] as Line }));
import type { Client } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({ gameRoomStore: { findByRoomId: vi.fn() } }));
vi.mock("./roomTrail.js", () => ({ roomTrail: { postTurnPrompt: vi.fn(async () => null) } }));
vi.mock("@features/voice/voiceSessions.js", () => ({ voiceSessions: { get: vi.fn(() => null) } }));
vi.mock("@features/voice/callAnnouncer.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("@features/voice/callAnnouncer.js")>()), speakInCall: vi.fn(async () => "spoken") }));

import { _armedTurnClocks, _resetTurnClocks, armTurnClock, rebuildTurnClocks, syncTurnClocks, type ClockedTurn, type TurnClockGame } from "./turnClock.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { roomTrail } from "./roomTrail.js";
import { voiceSessions } from "@features/voice/voiceSessions.js";
import { speakInCall } from "@features/voice/callAnnouncer.js";
import { deroBrainCopy } from "@features/dero-brain/deroBrainCopy.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { cardVoiceState } from "./cardVoiceState.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── turnClock (2026-10 item 267, owner decision 15, risks R6 and R7) ──────────────────
// The shared per turn timer over a stub game whose turn is whatever the row says: one warning
// TURN_WARNING_LEAD_MS before the deadline pinging only the member on the clock, the game's own
// timeout function at the deadline, nothing at all for a turn that passed first, Dero's voice only
// when he is in the match's call, and the clocks armed again from the row after a restart. Every
// case runs on fake timers from a fixed clock.

const findMock = gameRoomStore.findByRoomId as unknown as ReturnType<typeof vi.fn>;
const promptMock = roomTrail.postTurnPrompt as unknown as ReturnType<typeof vi.fn>;
const sessionMock = voiceSessions.get as unknown as ReturnType<typeof vi.fn>;
const speakMock = speakInCall as unknown as ReturnType<typeof vi.fn>;

const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);
const LEAD = BOT_CONSTANTS.TURN_WARNING_LEAD_MS;
const SECONDS = LEAD / 1000;
const TURN_MS = 180_000;
const ALICE = "alice";
const BOB = "bob";

const turnFor = (memberId: string, fingerprint: string, deadline = NOW + TURN_MS): ClockedTurn => ({ memberId, fingerprint, deadline });

function rowWith(turn: ClockedTurn | null, overrides: Partial<IGameRoom> = {}): IGameRoom {
	return { roomId: "room-1", guildId: "guild-1", hostId: "host", game: "holdem", status: "playing", channelId: "ch-1", deroVoice: false, secret: { turn }, ...overrides } as unknown as IGameRoom;
}

// The row the clock reads at every firing; a case moves it to pass or change the turn.
let row: IGameRoom = rowWith(turnFor(ALICE, "t1"));

const expire = vi.fn(async (): Promise<boolean> => true);
const roomEnded = vi.fn();
const game: TurnClockGame = {
	kind: "holdem",
	current: (room) => (room.secret as { turn: ClockedTurn | null }).turn,
	expire,
	roomEnded,
};

const members = new Map([[ALICE, { displayName: "Alice" }]]);
const client = {
	guilds: { cache: new Map([["guild-1", { voiceStates: { cache: new Map() }, members: { cache: members, fetch: vi.fn(async () => null) } }]]) },
} as unknown as Client;

const warnings = () => promptMock.mock.calls.filter((call) => (call[2] as { text: string }).text === gameRoomsCopy.turnClock.warningLine[0](ALICE, SECONDS));

beforeEach(() => {
	vi.useFakeTimers({ now: NOW });
	vi.clearAllMocks();
	_resetTurnClocks();
	cardVoiceState._reset();
	row = rowWith(turnFor(ALICE, "t1"));
	findMock.mockImplementation(async () => row);
	expire.mockResolvedValue(true);
	sessionMock.mockReturnValue(null);
});

afterEach(() => {
	_resetTurnClocks();
	vi.useRealTimers();
});

describe("the warning", () => {
	it("fires once, at the deadline minus ten seconds, pinging only the member on the clock", async () => {
		await syncTurnClocks(client, row, [game]);

		await vi.advanceTimersByTimeAsync(TURN_MS - LEAD - 1);
		expect(promptMock).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(promptMock).toHaveBeenCalledOnce();
		// The turn prompt's own sender: its mention allowlist names this one id, and it writes no move.
		expect(promptMock.mock.calls[0][2]).toEqual({ playerId: ALICE, text: gameRoomsCopy.turnClock.warningLine[0](ALICE, SECONDS), components: [] });

		// Armed again for the same turn after a redraw: still one warning.
		await syncTurnClocks(client, row, [game]);
		await vi.advanceTimersByTimeAsync(LEAD - 1);
		expect(warnings()).toHaveLength(1);
	});

	it("follows a deadline that moved later, and still warns once", async () => {
		await syncTurnClocks(client, row, [game]);
		// A board draw held the clock for a minute while the turn stood.
		row = rowWith(turnFor(ALICE, "t1", NOW + TURN_MS + 60_000));

		await vi.advanceTimersByTimeAsync(TURN_MS - LEAD);
		expect(promptMock).not.toHaveBeenCalled();
		expect(expire).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(warnings()).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(LEAD);
		expect(expire).toHaveBeenCalledOnce();
		expect(warnings()).toHaveLength(1);
	});
});

describe("the deadline", () => {
	it("ends the turn at the deadline through the game's own timeout function, and posts nothing of its own", async () => {
		await syncTurnClocks(client, row, [game]);

		await vi.advanceTimersByTimeAsync(TURN_MS - 1);
		expect(expire).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(expire).toHaveBeenCalledOnce();
		expect(expire.mock.calls[0][1]).toBe(row);
		expect((expire.mock.calls[0][2] as Date).getTime()).toBe(NOW + TURN_MS);
		// The game's own timeout line is the turn over line: the clock adds only its one warning.
		expect(promptMock).toHaveBeenCalledOnce();
		expect(_armedTurnClocks()).toEqual([]);
	});

	it("looks again a few times when the timeout function ended nothing, then leaves the turn to the sweep", async () => {
		expire.mockResolvedValue(false);
		await syncTurnClocks(client, row, [game]);

		await vi.advanceTimersByTimeAsync(TURN_MS + BOT_CONSTANTS.TURN_CLOCK_RETRY_MS * (BOT_CONSTANTS.TURN_CLOCK_RETRIES + 5));
		expect(expire).toHaveBeenCalledTimes(1 + BOT_CONSTANTS.TURN_CLOCK_RETRIES);
		expect(_armedTurnClocks()).toEqual([]);
	});
});

// ⚠️ RISK R6: a turn that passed before its warning or its deadline is never warned and never ended.
describe("a turn that passed first", () => {
	it("is neither warned nor ended when the next turn holds the clock", async () => {
		await syncTurnClocks(client, row, [game]);
		// Alice played; Bob's turn is on the row, and his redraw has not armed the clock yet.
		row = rowWith(turnFor(BOB, "t2", NOW + 2 * TURN_MS));

		await vi.advanceTimersByTimeAsync(TURN_MS);
		expect(promptMock).not.toHaveBeenCalled();
		expect(expire).not.toHaveBeenCalled();
		expect(_armedTurnClocks()).toEqual([]);
	});

	it("is not ended for the member whose turn passed when the same fingerprint moves to another member", async () => {
		await syncTurnClocks(client, row, [game]);
		// A Battleship expiry passes the turn without a shot, so the fingerprint stays and the captain changes.
		row = rowWith(turnFor(BOB, "t1"));

		await vi.advanceTimersByTimeAsync(TURN_MS);
		expect(promptMock).not.toHaveBeenCalled();
		expect(expire).not.toHaveBeenCalled();
	});

	it("is dropped when a redraw arms the next turn, which keeps its own clock", async () => {
		await syncTurnClocks(client, row, [game]);
		await vi.advanceTimersByTimeAsync(60_000);
		row = rowWith(turnFor(BOB, "t2", NOW + 60_000 + TURN_MS));
		await syncTurnClocks(client, row, [game]);

		await vi.advanceTimersByTimeAsync(TURN_MS - 60_000);
		expect(promptMock).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(60_000 - LEAD);
		expect(promptMock).toHaveBeenCalledOnce();
		expect((promptMock.mock.calls[0][2] as { playerId: string }).playerId).toBe(BOB);
	});

	it("tells the game when a firing finds the room ended another way, and ends nothing", async () => {
		await syncTurnClocks(client, row, [game]);
		row = rowWith(turnFor(ALICE, "t1"), { status: "finished" });

		await vi.advanceTimersByTimeAsync(TURN_MS);
		expect(roomEnded).toHaveBeenCalledWith(row);
		expect(expire).not.toHaveBeenCalled();
		expect(promptMock).not.toHaveBeenCalled();
	});
});

describe("who is armed", () => {
	it("arms no Dero bot seat, and disarms a room with nobody on the clock", async () => {
		row = rowWith(turnFor("dero-bot-red", "t1"));
		await syncTurnClocks(client, row, [game]);
		expect(_armedTurnClocks()).toEqual([]);

		row = rowWith(turnFor(ALICE, "t1"));
		await syncTurnClocks(client, row, [game]);
		expect(_armedTurnClocks()).toHaveLength(1);
		row = rowWith(null);
		await syncTurnClocks(client, row, [game]);
		expect(_armedTurnClocks()).toEqual([]);
	});

	it("never warns a network table, whose members sit in other servers, and still ends its turn on time", async () => {
		row = rowWith(turnFor(ALICE, "t1"), { network: true });
		await syncTurnClocks(client, row, [game]);

		await vi.advanceTimersByTimeAsync(TURN_MS);
		expect(promptMock).not.toHaveBeenCalled();
		expect(expire).toHaveBeenCalledOnce();
	});
});

describe("Dero's voice", () => {
	const wordsFor = () => speakMock.mock.calls.map((call) => call[1] as string);

	it("says nothing with Dero voice off, even with Dero in a call", async () => {
		sessionMock.mockReturnValue({ channelId: "vc-1", startedByRoomId: "room-1" });
		await syncTurnClocks(client, row, [game]);

		await vi.advanceTimersByTimeAsync(TURN_MS);
		expect(speakMock).not.toHaveBeenCalled();
	});

	it("says nothing with Dero voice on while Dero is in another match's call", async () => {
		row = rowWith(turnFor(ALICE, "t1"), { deroVoice: true });
		sessionMock.mockReturnValue({ channelId: "vc-2", startedByRoomId: "room-9" });
		await syncTurnClocks(client, row, [game]);

		await vi.advanceTimersByTimeAsync(TURN_MS);
		expect(speakMock).not.toHaveBeenCalled();
	});

	it("speaks the warning and the turn over in the match's call with Dero voice on", async () => {
		row = rowWith(turnFor(ALICE, "t1"), { deroVoice: true });
		sessionMock.mockReturnValue({ channelId: "vc-1", startedByRoomId: "room-1" });
		await syncTurnClocks(client, row, [game]);

		await vi.advanceTimersByTimeAsync(TURN_MS - LEAD);
		expect(wordsFor()).toEqual([deroBrainCopy.dealer.turnWarning[0]("Alice", SECONDS)]);
		await vi.advanceTimersByTimeAsync(LEAD);
		expect(wordsFor()).toEqual([deroBrainCopy.dealer.turnWarning[0]("Alice", SECONDS), deroBrainCopy.dealer.turnOver[0]("Alice")]);
		expect(speakMock.mock.calls.every((call) => call[0] === "guild-1")).toBe(true);
	});
});

// ⚠️ RISK R7: the clocks are memory only, so a restart arms them again from the row.
describe("a restart", () => {
	it("rebuilds a playing room's clock from the row, warning once and ending the turn on time", async () => {
		armTurnClock(client, row, game, turnFor(ALICE, "t1"));
		await vi.advanceTimersByTimeAsync(60_000);
		// The process restarts: every timer is gone, and boot recovery reads the row.
		_resetTurnClocks();
		expect(rebuildTurnClocks(client, row, [game])).toBe(1);

		await vi.advanceTimersByTimeAsync(TURN_MS - 60_000 - LEAD);
		expect(warnings()).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(LEAD);
		expect(expire).toHaveBeenCalledOnce();
	});

	it("leaves a deadline already past to the game's sweep", async () => {
		await vi.advanceTimersByTimeAsync(TURN_MS);
		expect(rebuildTurnClocks(client, row, [game])).toBe(0);
		await vi.advanceTimersByTimeAsync(TURN_MS);
		expect(expire).not.toHaveBeenCalled();
	});

	it("skips a warning whose moment passed before the restart, which may already have been given", async () => {
		await vi.advanceTimersByTimeAsync(TURN_MS - LEAD + 1_000);
		expect(rebuildTurnClocks(client, row, [game])).toBe(1);

		await vi.advanceTimersByTimeAsync(LEAD);
		expect(promptMock).not.toHaveBeenCalled();
		expect(expire).toHaveBeenCalledOnce();
	});

	it("rebuilds nothing for a room that is not playing", () => {
		expect(rebuildTurnClocks(client, rowWith(turnFor(ALICE, "t1"), { status: "draft" }), [game])).toBe(0);
	});
});
