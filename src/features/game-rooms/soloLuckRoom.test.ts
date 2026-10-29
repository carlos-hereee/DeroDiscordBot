import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client, TextChannel } from "discord.js";

// ── soloLuckRoom (2026-10 item 257 Phase 4b, owner item 14) ─────────────────
// A round against Dero in its solo room, and the rock paper scissors room that asks for its
// throw IN the room. What is pinned: the member is on the clock until they throw, the turn
// modal offers the three throws, the throw is claimed once (a second Submit plays nothing),
// Dero answers through the one solo round, the room finishes on the short window, and the
// spent prompt line is retired; a round that cannot post closes the room as abandoned.
vi.mock("@db/stores/gameRoomStore.js", () => ({ gameRoomStore: { claimSecretField: vi.fn() } }));
vi.mock("@features/games/soloLuck.js", () => ({ playSoloLuckInChannel: vi.fn() }));
vi.mock("./roomLifecycle.js", () => ({ roomLifecycle: { finish: vi.fn() } }));
vi.mock("./roomTrail.js", () => ({ resolveRoomChannel: vi.fn() }));
vi.mock("./turnPrompt.js", () => ({ syncTurnPrompt: vi.fn() }));

import { playSoloLuckRoom, soloRpsTurnAdapter } from "./soloLuckRoom.js";
import { turnAdapterFor } from "./turnAdapters.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { playSoloLuckInChannel } from "@features/games/soloLuck.js";
import { secureRandom } from "@utils/secureRng.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { resolveRoomChannel } from "./roomTrail.js";
import { syncTurnPrompt } from "./turnPrompt.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

type Mock = ReturnType<typeof vi.fn>;
const claimMock = gameRoomStore.claimSecretField as unknown as Mock;
const playMock = playSoloLuckInChannel as unknown as Mock;
const finishMock = roomLifecycle.finish as unknown as Mock;
const channelMock = resolveRoomChannel as unknown as Mock;
const syncMock = syncTurnPrompt as unknown as Mock;

const SHORT = BOT_CONSTANTS.GAME_ROOM_SOLO_LUCK_ARCHIVE_DELAY_MS;
const HOST = "host-1";
const CHANNEL = { id: "room-ch-1" } as unknown as TextChannel;
const MEMBER = { displayName: "Host", user: { id: HOST, username: "host" } };

const makeRoom = (overrides: Partial<IGameRoom> = {}): IGameRoom =>
	({ roomId: "room-1", guildId: "guild-1", channelId: "room-ch-1", game: "solo-rps", hostId: HOST, playerIds: [HOST], status: "playing", secret: null, ...overrides }) as unknown as IGameRoom;

const client = {
	guilds: { cache: new Map([["guild-1", { members: { cache: new Map([[HOST, MEMBER]]), fetch: vi.fn() } }]]) },
	users: { fetch: vi.fn() },
} as unknown as Client;

beforeEach(() => {
	vi.clearAllMocks();
	channelMock.mockResolvedValue(CHANNEL);
	finishMock.mockResolvedValue(true);
});

describe("the rock paper scissors room's turn", () => {
	it("is the room's adapter for solo-rps", () => {
		expect(turnAdapterFor("solo-rps")).toBe(soloRpsTurnAdapter);
	});

	it("puts the member on the clock until they throw, and nobody once they have or the room ended", () => {
		expect(soloRpsTurnAdapter.whoseTurn(makeRoom())).toBe(HOST);
		expect(soloRpsTurnAdapter.fingerprintOf(makeRoom())).toBe("throw");
		expect(soloRpsTurnAdapter.whoseTurn(makeRoom({ secret: { throw: "rock" } as never }))).toBeNull();
		expect(soloRpsTurnAdapter.fingerprintOf(makeRoom({ secret: { throw: "rock" } as never }))).toBeNull();
		expect(soloRpsTurnAdapter.whoseTurn(makeRoom({ status: "finished" }))).toBeNull();
	});

	it("offers the three throws in the modal, saying Dero throws on Submit", () => {
		const view = soloRpsTurnAdapter.view(makeRoom(), HOST);
		expect(view?.title).toBe(gameRoomsCopy.board.deroThrowModalTitle);
		expect(view?.text).toEqual([gameRoomsCopy.board.deroThrowPrompt]);
		expect(view?.fields).toEqual([expect.objectContaining({ kind: "select", id: "throw", options: [expect.objectContaining({ value: "rock" }), expect.objectContaining({ value: "paper" }), expect.objectContaining({ value: "scissors" })] })]);
	});

	it("claims the throw, then Dero answers, the room finishes on the short window and the line is retired", async () => {
		const claimed = makeRoom({ secret: { throw: "paper" } as never });
		claimMock.mockResolvedValue(claimed);
		playMock.mockResolvedValue({ game: "rps", memberThrow: "paper", deroThrow: "rock", outcome: "won" });
		const acknowledge = vi.fn().mockResolvedValue(undefined);

		const result = await soloRpsTurnAdapter.apply(client, makeRoom(), HOST, { throw: "paper" }, acknowledge);

		expect(result).toEqual({ ok: true });
		expect(claimMock).toHaveBeenCalledWith("guild-1", "room-1", "throw", "paper");
		expect(acknowledge).toHaveBeenCalledOnce();
		expect(playMock).toHaveBeenCalledWith(CHANNEL, { user: MEMBER.user, displayName: "Host" }, { game: "rps", memberThrow: "paper" }, secureRandom);
		expect(finishMock).toHaveBeenCalledWith(client, claimed, { winnerId: HOST, archiveDelayMs: SHORT });
		expect(syncMock).toHaveBeenCalledWith(client, claimed, soloRpsTurnAdapter);
		// The claim lands before the round is played, so a racing Submit cannot play a second one.
		expect(claimMock.mock.invocationCallOrder[0]).toBeLessThan(playMock.mock.invocationCallOrder[0]);
	});

	it("plays nothing for a second Submit whose claim was lost, and says the turn has passed", async () => {
		claimMock.mockResolvedValue(null);
		const acknowledge = vi.fn();

		const result = await soloRpsTurnAdapter.apply(client, makeRoom(), HOST, { throw: "rock" }, acknowledge);

		expect(result).toEqual({ ok: false, reason: gameRoomsCopy.turnPrompt.turnPassed });
		expect(acknowledge).not.toHaveBeenCalled();
		expect(playMock).not.toHaveBeenCalled();
		expect(finishMock).not.toHaveBeenCalled();
	});

	it("refuses a throw that is not one of the three, writing nothing", async () => {
		const result = await soloRpsTurnAdapter.apply(client, makeRoom(), HOST, { throw: "lizard" }, vi.fn());

		expect(result).toEqual({ ok: false, reason: gameRoomsCopy.errors.controlRetired });
		expect(claimMock).not.toHaveBeenCalled();
	});
});

describe("playSoloLuckRoom", () => {
	it("closes the room as abandoned, paying nothing, when its channel is gone", async () => {
		await playSoloLuckRoom(client, makeRoom(), null, { userId: HOST, displayName: "Host", user: MEMBER.user as never }, { game: "coinflip" });

		expect(playMock).not.toHaveBeenCalled();
		expect(finishMock).toHaveBeenCalledWith(client, expect.objectContaining({ roomId: "room-1" }), { abandoned: true, archiveDelayMs: SHORT });
	});
});
