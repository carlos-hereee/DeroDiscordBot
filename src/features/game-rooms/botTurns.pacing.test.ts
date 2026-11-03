import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "discord.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── the bots' pace (owner decision of 2026-10-29: the bots raced the game) ─────
// A bot never steps while Dero is talking in the match's call, waits a beat after he stops, and
// never steps twice in one room inside the move gap.

const voice = vi.hoisted(() => ({ inCall: true, talking: false, refereeBusy: false }));
vi.mock("./roomAnnouncer.js", () => ({ isDeroInMatchCall: () => voice.inCall }));
vi.mock("@features/voice/callAnnouncer.js", async (importOriginal) => ({ ...(await importOriginal<object>()), isDeroTalking: () => voice.talking }));
vi.mock("./roomMonopolyReferee.js", () => ({ isRefereeSpeaking: () => voice.refereeBusy }));

import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { botMayStep } from "./botTurns.js";

const client = {} as Client;
const PACING = BOT_CONSTANTS.BOT_TURNS;
let roomCounter = 0;
const freshRoom = (): IGameRoom => ({ roomId: `room-${++roomCounter}`, guildId: "g1" }) as unknown as IGameRoom;

beforeEach(() => {
	voice.inCall = true;
	voice.talking = false;
	voice.refereeBusy = false;
});

describe("botMayStep", () => {
	it("waits while Dero is talking, then a beat of quiet, before a bot moves", () => {
		const room = freshRoom();
		const start = 1_000_000;
		voice.talking = true;
		expect(botMayStep(client, room, start)).toBe(false);
		voice.talking = false;
		expect(botMayStep(client, room, start + PACING.QUIET_BEFORE_MOVE_MS - 1)).toBe(false);
		expect(botMayStep(client, room, start + PACING.QUIET_BEFORE_MOVE_MS)).toBe(true);
	});

	it("waits on the Monopoly referee's clips still queued for the room", () => {
		const room = freshRoom();
		voice.refereeBusy = true;
		expect(botMayStep(client, room, 2_000_000)).toBe(false);
	});

	it("ignores Dero's voice for a match he is not in the call of", () => {
		voice.inCall = false;
		voice.talking = true;
		expect(botMayStep(client, freshRoom(), 3_000_000)).toBe(true);
	});
});
