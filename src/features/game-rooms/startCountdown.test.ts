import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// Dero's variant lines always pick the first, so these tests read exact words.
vi.mock("@utils/pickLine.js", () => ({ pickLine: <Line>(lines: readonly Line[]): Line => lines[0] as Line }));
import type { Client } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({ gameRoomStore: { findByRoomId: vi.fn() } }));
vi.mock("@features/voice/voiceSessions.js", () => ({ voiceSessions: { get: vi.fn(() => null) } }));
vi.mock("@features/voice/callAnnouncer.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("@features/voice/callAnnouncer.js")>()), speakInCall: vi.fn(async () => "spoken") }));

import { beginStartCountdown, isCountingDown } from "./startCountdown.js";
import { countdownSeconds, startCountdownState } from "./startCountdownState.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { voiceSessions } from "@features/voice/voiceSessions.js";
import { speakInCall } from "@features/voice/callAnnouncer.js";
import { deroBrainCopy } from "@features/dero-brain/deroBrainCopy.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── startCountdown (2026-10 item 267, owner decision 13) ───────────────────
// The count's own contract: it runs START_COUNTDOWN_MS, opens only a draft still open when it
// ends, opens nothing once the draft was called off, refuses a second count for one draft, and
// Dero says it in the card's call only with Dero voice on. Fake timers from a fixed clock.

const findMock = gameRoomStore.findByRoomId as unknown as ReturnType<typeof vi.fn>;
const sessionMock = voiceSessions.get as unknown as ReturnType<typeof vi.fn>;
const speakMock = speakInCall as unknown as ReturnType<typeof vi.fn>;

const COUNT = BOT_CONSTANTS.START_COUNTDOWN_MS;
const client = { guilds: { cache: new Map() } } as unknown as Client;
const draftOf = (overrides: Partial<IGameRoom> = {}): IGameRoom =>
	({ roomId: "room-1", guildId: "guild-1", hostId: "host", game: "monopoly", status: "draft", deroVoice: false, ...overrides }) as unknown as IGameRoom;

function begin(draft: IGameRoom) {
	const open = vi.fn(async () => undefined);
	const calledOff = vi.fn(async () => undefined);
	const begun = beginStartCountdown({ client, room: draft, open, calledOff });
	return { begun, open, calledOff };
}

beforeEach(() => {
	vi.useFakeTimers({ now: Date.UTC(2026, 9, 29, 12, 0, 0) });
	vi.clearAllMocks();
	startCountdownState._reset();
	sessionMock.mockReturnValue(null);
});

afterEach(() => {
	startCountdownState._reset();
	vi.useRealTimers();
});

it("counts ten seconds, the number the card and Dero say", () => {
	expect(COUNT).toBe(10_000);
	expect(countdownSeconds()).toBe(10);
});

it("opens the draft as it stands once the count ends, and not a moment before", async () => {
	const draft = draftOf();
	const fresh = draftOf({ spectatorIds: ["a", "b"] } as Partial<IGameRoom>);
	findMock.mockResolvedValue(fresh);
	const { begun, open, calledOff } = begin(draft);
	expect(begun).toBe(true);
	expect(isCountingDown(draft)).toBe(true);

	await vi.advanceTimersByTimeAsync(COUNT - 1);
	expect(open).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(1);
	expect(open).toHaveBeenCalledWith(fresh);
	expect(calledOff).not.toHaveBeenCalled();
	expect(isCountingDown(draft)).toBe(false);
});

it("opens nothing once Call it off closed the draft during the count", async () => {
	findMock.mockResolvedValue(draftOf({ status: "archived" } as Partial<IGameRoom>));
	const { open, calledOff } = begin(draftOf());

	await vi.advanceTimersByTimeAsync(COUNT);
	expect(open).not.toHaveBeenCalled();
	expect(calledOff).toHaveBeenCalledOnce();
});

it("refuses a second count for a draft already counting in", async () => {
	findMock.mockResolvedValue(draftOf());
	const first = begin(draftOf());
	const second = begin(draftOf());
	expect(second.begun).toBe(false);

	await vi.advanceTimersByTimeAsync(COUNT);
	expect(first.open).toHaveBeenCalledOnce();
	expect(second.open).not.toHaveBeenCalled();
});

describe("Dero's voice", () => {
	it("says the count in the card's call with Dero voice on", async () => {
		sessionMock.mockReturnValue({ channelId: "vc-1", startedByRoomId: "room-1" });
		begin(draftOf({ deroVoice: true }));
		await vi.waitFor(() => expect(speakMock).toHaveBeenCalledWith("guild-1", deroBrainCopy.dealer.countdown[0](10)));
	});

	it("says nothing with Dero voice off", async () => {
		sessionMock.mockReturnValue({ channelId: "vc-1", startedByRoomId: "room-1" });
		begin(draftOf({ deroVoice: false }));
		await vi.advanceTimersByTimeAsync(0);
		expect(speakMock).not.toHaveBeenCalled();
	});
});
