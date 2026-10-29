import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChannelType, type Guild, type TextChannel } from "discord.js";

// ── soloRooms (2026-10 item 254, Arcade 1) ─────────────────────────────────
// The one solo path, widened to a round against Dero, and the table dealing it shares
// with a multi seat blackjack room. What is pinned: a coin or dice round opens a SOLO room
// through the provisioner, plays there, and finishes the room with its winner (or as
// abandoned when the round never posts); a rock paper scissors room opens and waits for its
// throw, which is asked in the room (2026-10 item 257 Phase 4b); a room's table seats every
// player and deals at once; and a table that cannot start closes its room.
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn() } }));
vi.mock("@db/stores/gameRoomStore.js", () => ({ gameRoomStore: { countOpenInGuildByVisibility: vi.fn() } }));
vi.mock("@features/entitlements/gameRoomAccess.js", () => ({ checkGameRoomAccess: vi.fn() }));
vi.mock("@features/games/blackjackHandler.js", () => ({ startBlackjackTable: vi.fn() }));
vi.mock("@features/games/soloLuck.js", () => ({ playSoloLuckInChannel: vi.fn() }));
vi.mock("./RoomProvisioner.js", () => ({ RoomProvisioner: { open: vi.fn() }, describeRoomOpenFailure: () => "nope" }));
vi.mock("./roomLifecycle.js", () => ({ roomLifecycle: { finish: vi.fn() } }));
// The stacks ledger and the direct refund (2026-10 item 267) have their own suites.
vi.mock("./blackjackChips.js", () => ({ openBlackjackLedger: vi.fn(async () => true) }));
vi.mock("./holdemDraftBuyIn.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("./holdemDraftBuyIn.js")>()), refundSeatsDirectly: vi.fn(async () => undefined) }));

import { openSoloRoom, soloLuckSlugFor, startBlackjackRoomBoard } from "./soloRooms.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { startBlackjackTable } from "@features/games/blackjackHandler.js";
import { playSoloLuckInChannel } from "@features/games/soloLuck.js";
import { RoomProvisioner } from "./RoomProvisioner.js";
import { roomLifecycle } from "./roomLifecycle.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { openBlackjackLedger } from "./blackjackChips.js";
import { refundSeatsDirectly } from "./holdemDraftBuyIn.js";

type Mock = ReturnType<typeof vi.fn>;
const configMock = guildConfigStore as unknown as { findByGuildId: Mock };
const openMock = RoomProvisioner.open as unknown as Mock;
const finishMock = roomLifecycle.finish as unknown as Mock;
const playMock = playSoloLuckInChannel as unknown as Mock;
const tableMock = startBlackjackTable as unknown as Mock;

const HOST = { userId: "host-1", displayName: "Host", user: { id: "host-1" } as never };
const ROOM = { roomId: "room-1", hostId: "host-1", playerIds: ["host-1"] } as unknown as IGameRoom;
const CHANNEL = { id: "room-ch-1" } as unknown as TextChannel;
// A solo luck room goes on the short window (owner's choice, 30 minutes), win or abandon.
const SHORT = BOT_CONSTANTS.GAME_ROOM_SOLO_LUCK_ARCHIVE_DELAY_MS;

function makeGuild(): Guild {
	return {
		id: "guild-1",
		client: { users: { fetch: vi.fn() } },
		members: { cache: new Map([["p2", { displayName: "Player Two" }]]) },
		channels: { fetch: vi.fn(async () => ({ id: "arcade-cat", type: ChannelType.GuildCategory })) },
	} as unknown as Guild;
}

beforeEach(() => {
	vi.clearAllMocks();
	configMock.findByGuildId.mockResolvedValue({ gamesCategoryId: "arcade-cat", adminRoleId: null });
	openMock.mockResolvedValue({ ok: true, room: ROOM, channel: CHANNEL });
	finishMock.mockResolvedValue(true);
});

describe("a round against Dero in its own room", () => {
	it("names each luck game's solo room", () => {
		expect(soloLuckSlugFor("coinflip")).toBe("solo-coinflip");
		expect(soloLuckSlugFor("diceroll")).toBe("solo-diceroll");
		expect(soloLuckSlugFor("rps")).toBe("solo-rps");
	});

	it("opens a SOLO room, plays the round in it, and finishes the room with the member as winner", async () => {
		playMock.mockResolvedValue({ game: "coinflip", face: "heads", outcome: "won" });
		const guild = makeGuild();

		const result = await openSoloRoom(guild, "solo-coinflip", HOST);

		expect(result.ok).toBe(true);
		expect(openMock).toHaveBeenCalledWith(expect.objectContaining({ game: "solo-coinflip", visibility: "solo", playerIds: ["host-1"], spectatorIds: [] }));
		expect(playMock).toHaveBeenCalledWith(CHANNEL, { user: HOST.user, displayName: "Host" }, { game: "coinflip" });
		expect(finishMock).toHaveBeenCalledWith(guild.client, ROOM, { winnerId: "host-1", archiveDelayMs: SHORT });
	});

	it("finishes with no winner on a loss or a tie", async () => {
		playMock.mockResolvedValue({ game: "diceroll", memberRoll: 3, deroRoll: 3, outcome: "tie" });

		await openSoloRoom(makeGuild(), "solo-diceroll", HOST);

		expect(playMock).toHaveBeenCalledWith(CHANNEL, expect.anything(), { game: "diceroll" });
		expect(finishMock).toHaveBeenCalledWith(expect.anything(), ROOM, { winnerId: null, archiveDelayMs: SHORT });
	});

	it("opens a rock paper scissors room and plays nothing yet: the throw is asked in the room", async () => {
		const result = await openSoloRoom(makeGuild(), "solo-rps", HOST);

		expect(result.ok).toBe(true);
		expect(openMock).toHaveBeenCalledWith(expect.objectContaining({ game: "solo-rps", visibility: "solo" }));
		expect(playMock).not.toHaveBeenCalled();
		expect(finishMock).not.toHaveBeenCalled();
	});

	it("closes the room as abandoned, paying nothing, when the round could not be posted", async () => {
		playMock.mockResolvedValue(null);

		await openSoloRoom(makeGuild(), "solo-diceroll", HOST);

		expect(finishMock).toHaveBeenCalledWith(expect.anything(), ROOM, { abandoned: true, archiveDelayMs: SHORT });
	});

	it("plays nothing when the room itself was refused", async () => {
		openMock.mockResolvedValue({ ok: false, reason: "alreadyHosting", existingChannelId: null });

		const result = await openSoloRoom(makeGuild(), "solo-coinflip", HOST);

		expect(result.ok).toBe(false);
		expect(playMock).not.toHaveBeenCalled();
		expect(finishMock).not.toHaveBeenCalled();
	});
});

describe("a multi seat blackjack room's table", () => {
	const ledgerMock = openBlackjackLedger as unknown as Mock;
	const refundMock = refundSeatsDirectly as unknown as Mock;
	beforeEach(() => {
		ledgerMock.mockReset().mockResolvedValue(true);
		refundMock.mockClear();
	});

	it("seats every seat the card filled, the host first, and opens at once for what they paid", async () => {
		tableMock.mockResolvedValue("started");
		const room = { ...ROOM, playerIds: ["host-1", "p2", "p3", "p4"] } as unknown as IGameRoom;
		const guild = makeGuild();
		(guild.members.cache as Map<string, unknown>).set("host-1", { displayName: "Host" });
		// p4 is a player who never paid on the card (an invited member who did not accept), so no seat.
		const seats = { buyIn: 2500, userIds: ["host-1", "p2", "p3"], charged: true };

		await expect(startBlackjackRoomBoard(guild, room, CHANNEL, seats)).resolves.toBe(true);

		// The ledger holds every paid seat before a card is dealt (2026-10 item 267, risk R5).
		expect(ledgerMock).toHaveBeenCalledWith(room, seats);
		expect(tableMock).toHaveBeenCalledWith(
			CHANNEL,
			"guild-1",
			{ userId: "host-1", username: "Host" },
			true,
			"room-1",
			[
				{ userId: "p2", username: "Player Two" },
				// A member the cache does not hold is seated by id rather than dropped.
				{ userId: "p3", username: "p3" },
			],
			{ buyIn: 2500, chips: true },
			false
		);
	});

	it("closes the room as abandoned when the table cannot start, leaving the stacks to finish", async () => {
		tableMock.mockResolvedValue("failed");
		const seats = { buyIn: 1000, userIds: ["host-1"], charged: true };

		await expect(startBlackjackRoomBoard(makeGuild(), ROOM, CHANNEL, seats)).resolves.toBe(false);

		expect(finishMock).toHaveBeenCalledWith(expect.anything(), ROOM, { abandoned: true });
		expect(refundMock).not.toHaveBeenCalled();
	});

	it("gives the buy ins straight back when the ledger cannot be written, and deals nothing", async () => {
		ledgerMock.mockResolvedValue(false);
		const seats = { buyIn: 1000, userIds: ["host-1", "p2"], charged: true };

		await expect(startBlackjackRoomBoard(makeGuild(), ROOM, CHANNEL, seats)).resolves.toBe(false);

		expect(refundMock).toHaveBeenCalledWith(seats);
		expect(tableMock).not.toHaveBeenCalled();
		expect(finishMock).toHaveBeenCalledWith(expect.anything(), ROOM, { abandoned: true });
	});
});

describe("a solo blackjack room (2026-10 item 267)", () => {
	const refundMock = refundSeatsDirectly as unknown as Mock;
	beforeEach(() => refundMock.mockClear());

	it("gives a buy in taken at the press back when the room does not open", async () => {
		configMock.findByGuildId.mockResolvedValue(null);
		const seats = { buyIn: 1000, userIds: ["host-1"], charged: true };

		const result = await openSoloRoom(makeGuild(), "solo-blackjack", HOST, { blackjackSeats: seats });

		expect(result.ok).toBe(false);
		expect(refundMock).toHaveBeenCalledWith(seats);
	});
});
