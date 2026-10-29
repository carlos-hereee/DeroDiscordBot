import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client, TextChannel } from "discord.js";

// ── roomReferee (2026-10 item 257 Phase 4b, owner item 9) ───────────────────
// The referee at match start, on the games with voice lines. What is pinned: a game without
// lines or a match without the referee does nothing; a card opened Hold'em table registers
// with the dealer narration as a VOICE table (the real registry, not a mock); with voice off,
// or the host in no call, the one silent notice posts with its fix; with the host in a call,
// Dero is asked for that call through the voice queue at the match's rated or casual priority,
// and a request that has to wait tells the room its place. Also the flag's fallback to the
// stored Monopoly field a row from before the referee field carries.
// Partial: the dealer narration reads the announcer's other exports as it loads.
vi.mock("@features/voice/callAnnouncer.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("@features/voice/callAnnouncer.js")>()),
	isVoiceEnabled: vi.fn(),
}));
vi.mock("@features/voice/voiceQueue.js", () => ({ voiceQueue: { requestVoice: vi.fn() } }));
vi.mock("@features/voice/voiceSessions.js", () => ({ voiceSessions: { get: vi.fn() } }));
vi.mock("./roomMonopolyRefereeNotice.js", () => ({ postRefereeNotice: vi.fn(), postRefereeLine: vi.fn() }));
vi.mock("./roomMonopolyBoard.js", () => ({ postBelowMonopolyBoard: vi.fn() }));

import { startRoomReferee } from "./roomReferee.js";
import { refereeOn } from "./roomTypes.js";
import { _clearDealerTables, dealerTableOf } from "@features/dero-brain/dealerNarration.js";
import { isVoiceEnabled } from "@features/voice/callAnnouncer.js";
import { voiceQueue } from "@features/voice/voiceQueue.js";
import { voiceSessions } from "@features/voice/voiceSessions.js";
import { postRefereeLine, postRefereeNotice } from "./roomMonopolyRefereeNotice.js";
import { postBelowMonopolyBoard } from "./roomMonopolyBoard.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { cardVoiceState } from "./cardVoiceState.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

type Mock = ReturnType<typeof vi.fn>;
const voiceOnMock = isVoiceEnabled as unknown as Mock;
const requestMock = voiceQueue.requestVoice as unknown as Mock;
const sessionMock = voiceSessions.get as unknown as Mock;
const noticeMock = postRefereeNotice as unknown as Mock;
const lineMock = postRefereeLine as unknown as Mock;
const belowMock = postBelowMonopolyBoard as unknown as Mock;

const HOST = "host-1";
const HOST_CALL = "voice-ch-1";
const client = {} as Client;

const makeRoom = (overrides: Partial<IGameRoom> = {}): IGameRoom =>
	({ roomId: "room-1", guildId: "guild-1", channelId: "room-ch-1", game: "holdem", hostId: HOST, referee: true, monopolyReferee: false, botSeats: 0, casual: false, ...overrides }) as unknown as IGameRoom;

// The room's channel, whose guild knows which voice channel each member is in.
function makeChannel(hostCall: string | null): TextChannel {
	const voiceStates = new Map(hostCall ? [[HOST, { channelId: hostCall }]] : []);
	return { id: "room-ch-1", guild: { id: "guild-1", voiceStates: { cache: voiceStates } } } as unknown as TextChannel;
}

beforeEach(() => {
	vi.clearAllMocks();
	_clearDealerTables();
	voiceOnMock.mockResolvedValue(true);
	sessionMock.mockReturnValue(null);
	requestMock.mockResolvedValue(null);
});

describe("refereeOn", () => {
	it("reads the referee field, and falls back to Monopoly's stored flag on a row from before it", () => {
		expect(refereeOn({ referee: true, monopolyReferee: false })).toBe(true);
		expect(refereeOn({ referee: false, monopolyReferee: true })).toBe(false);
		expect(refereeOn({ referee: null, monopolyReferee: true })).toBe(true);
		expect(refereeOn({})).toBe(false);
	});

	// 2026-10 item 263 R3-28, owner decision 5: Hold'em narrates unless its host turned it off.
	it("reads a Hold'em row with no stored choice as on, and keeps a host's off", () => {
		expect(refereeOn({ game: "holdem", referee: null, monopolyReferee: false })).toBe(true);
		expect(refereeOn({ game: "holdem" })).toBe(true);
		expect(refereeOn({ game: "holdem", referee: false })).toBe(false);
		expect(refereeOn({ game: "monopoly", referee: null, monopolyReferee: false })).toBe(false);
	});

	// 2026-10 item 267, decision 10: Dero voice is read first, and a row written before it keeps
	// the choice its older referee fields hold.
	it("reads Dero voice first, then a row's old referee choice, then the game's default", () => {
		expect(refereeOn({ game: "holdem", deroVoice: false, referee: true })).toBe(false);
		expect(refereeOn({ game: "coinflip", deroVoice: true })).toBe(true);
		expect(refereeOn({ game: "holdem", deroVoice: null, referee: false })).toBe(false);
		expect(refereeOn({ game: "monopoly", deroVoice: null, referee: null, monopolyReferee: true })).toBe(true);
		expect(refereeOn({ game: "battleship", deroVoice: null })).toBe(false);
	});

	it("registers a Hold'em table with no stored referee as its dealer, voice on", async () => {
		await startRoomReferee(client, makeRoom({ referee: null }), makeChannel(null));
		expect(dealerTableOf("room-1")).toEqual({ voice: true });
	});
});

describe("startRoomReferee", () => {
	it("does nothing for a game with no voice lines, or with the referee off", async () => {
		await startRoomReferee(client, makeRoom({ game: "battleship" }), makeChannel(HOST_CALL));
		await startRoomReferee(client, makeRoom({ referee: false }), makeChannel(HOST_CALL));

		expect(dealerTableOf("room-1")).toBeNull();
		expect(requestMock).not.toHaveBeenCalled();
		expect(noticeMock).not.toHaveBeenCalled();
	});

	it("registers a card opened Hold'em table with the dealer narration as a voice table", async () => {
		await startRoomReferee(client, makeRoom(), makeChannel(HOST_CALL));

		expect(dealerTableOf("room-1")).toEqual({ voice: true });
	});

	it("asks the voice queue for the host's call at the rated match priority", async () => {
		const channel = makeChannel(HOST_CALL);

		await startRoomReferee(client, makeRoom(), channel);

		// A game request (2026-10 item 267): the runner skips the speaker list and says on the room why a join failed.
		expect(requestMock).toHaveBeenCalledWith({ guild: channel.guild, requesterId: HOST, channelId: HOST_CALL, controlChannelId: "room-ch-1", category: "rated-match", gameVoice: expect.objectContaining({ roomId: expect.any(String), followsHost: true }) });
		expect(noticeMock).not.toHaveBeenCalled();
	});

	// One call per card (2026-10 item 267 decision 11): the card already asked for Dero, so the
	// room it opens does not ask again, though a Hold'em table still registers its dealer.
	it("does not ask again for a room whose card already asked for Dero", async () => {
		cardVoiceState.markRequested("room-1");
		await startRoomReferee(client, makeRoom(), makeChannel(HOST_CALL));
		cardVoiceState._reset();

		expect(requestMock).not.toHaveBeenCalled();
		expect(noticeMock).not.toHaveBeenCalled();
		expect(dealerTableOf("room-1")).toEqual({ voice: true });
	});

	it("asks at the casual match priority for a casual match or one with a Dero bot seat", async () => {
		await startRoomReferee(client, makeRoom({ casual: true }), makeChannel(HOST_CALL));
		await startRoomReferee(client, makeRoom({ botSeats: 1 }), makeChannel(HOST_CALL));

		expect(requestMock.mock.calls.map((call) => (call[0] as { category: string }).category)).toEqual(["casual-match", "casual-match"]);
	});

	it("tells the room its place when the request has to wait for another call", async () => {
		requestMock.mockResolvedValue({ place: 2, total: 3 });
		const room = makeRoom();

		await startRoomReferee(client, room, makeChannel(HOST_CALL));

		expect(lineMock).toHaveBeenCalledWith(client, room, { content: gameRoomsCopy.monopoly.refereeQueued(2, 3), allowedMentions: { parse: [] } });
	});

	// A turn keeps ONE board (2026-10 item 263 owner decision 4): Dero's join notice posts below it.
	it("posts no second Monopoly board once Dero joins", async () => {
		const room = makeRoom({ game: "monopoly" });

		await startRoomReferee(client, room, makeChannel(HOST_CALL));

		expect(belowMock).not.toHaveBeenCalled();
		expect(lineMock).not.toHaveBeenCalled();
		expect(dealerTableOf("room-1")).toBeNull();
	});

	it("asks nothing when Dero is already in the host's call", async () => {
		sessionMock.mockReturnValue({ channelId: HOST_CALL });

		await startRoomReferee(client, makeRoom(), makeChannel(HOST_CALL));

		expect(requestMock).not.toHaveBeenCalled();
	});

	it("posts the voice off notice when the server's voice is switched off, still narrating in text", async () => {
		voiceOnMock.mockResolvedValue(false);
		const room = makeRoom();

		await startRoomReferee(client, room, makeChannel(HOST_CALL));

		expect(noticeMock).toHaveBeenCalledWith(client, room, "voiceOff");
		expect(requestMock).not.toHaveBeenCalled();
		expect(dealerTableOf("room-1")).toEqual({ voice: true });
	});

	it("posts the no call notice, with Bring Dero into the call, when the host is in no voice channel", async () => {
		const room = makeRoom({ game: "monopoly" });

		await startRoomReferee(client, room, makeChannel(null));

		expect(noticeMock).toHaveBeenCalledWith(client, room, "noCall");
		expect(requestMock).not.toHaveBeenCalled();
	});

	it("posts no notice when the host is in no call but Dero is already in one a player can join", async () => {
		sessionMock.mockReturnValue({ channelId: "voice-ch-9" });

		await startRoomReferee(client, makeRoom(), makeChannel(null));

		expect(noticeMock).not.toHaveBeenCalled();
		expect(requestMock).not.toHaveBeenCalled();
	});

	it("never throws when the queue fails, since nothing waits for it", async () => {
		requestMock.mockRejectedValue(new Error("voice down"));
		vi.spyOn(console, "error").mockImplementation(() => undefined);

		await expect(startRoomReferee(client, makeRoom(), makeChannel(HOST_CALL))).resolves.toBeUndefined();
	});
});
