import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StringSelectMenuInteraction } from "discord.js";

const mocks = vi.hoisted(() => ({
	findByRoomId: vi.fn(),
	admitPendingJoin: vi.fn(),
	seatRemote: vi.fn(),
	seatLocal: vi.fn(),
	redrawTable: vi.fn(),
}));

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: { findByRoomId: mocks.findByRoomId, admitPendingJoin: mocks.admitPendingJoin },
}));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn() } }));
vi.mock("@utils/permissions.js", () => ({ gateOwnerOrAdmin: vi.fn() }));
vi.mock("./challengeBoard.js", () => ({ refreshDraftCard: vi.fn(), challengeBoard: {} }));
vi.mock("./roomHoldemHandlers.js", () => ({ redrawTable: mocks.redrawTable, removeFromTable: vi.fn(), seatAcceptedPlayer: mocks.seatLocal }));
vi.mock("./roomMonopolyHandlers.js", () => ({ monopolyStateOf: vi.fn(), removeFromMonopolyMatch: vi.fn() }));
vi.mock("./networkJoin.js", () => ({ seatAcceptedRemotePlayer: mocks.seatRemote }));

import { hostControls } from "./hostControls.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── the host accepting a member of another server (2026-10 item 244 Phase 5b) ──
// A request that came from another server's network board carries the server it came
// from; accepting it seats that member through a satellite there, while a request from
// the host server is still seated in the room as before.

const words = rokCommanderCopy.arcadeHostControls;

const HOST = "host-1";
const REMOTE = "remote-1";
const LOCAL = "local-1";
const FROM_GUILD = "200000000000000002";

const room = (overrides: Partial<IGameRoom> = {}): IGameRoom =>
	({
		roomId: "room-1",
		guildId: "guild-1",
		game: "holdem",
		hostId: HOST,
		status: "playing",
		network: true,
		playerIds: [HOST],
		pendingJoinIds: [REMOTE, LOCAL],
		pendingNetworkJoins: [{ userId: REMOTE, guildId: FROM_GUILD }],
		kickedIds: [],
		...overrides,
	}) as unknown as IGameRoom;

function acceptPress(values: string[]) {
	const editReply = vi.fn().mockResolvedValue(undefined);
	const interaction = {
		customId: "gameroomSelect:accept:room-1",
		guildId: "guild-1",
		guild: { id: "guild-1", members: { cache: { get: (id: string) => ({ id, displayName: `Name ${id}`, user: { username: id } }) }, fetch: vi.fn() } },
		user: { id: HOST },
		values,
		client: {},
		reply: vi.fn().mockResolvedValue(undefined),
		deferUpdate: vi.fn().mockResolvedValue(undefined),
		editReply,
	} as unknown as StringSelectMenuInteraction;
	return { interaction, editReply };
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.findByRoomId.mockResolvedValue(room());
	mocks.admitPendingJoin.mockImplementation(async () => room({ pendingJoinIds: [] }));
	mocks.seatRemote.mockResolvedValue(null);
	mocks.seatLocal.mockResolvedValue(null);
});

describe("accepting requests at a network table", () => {
	it("seats a member of another server through a satellite in the server they asked from", async () => {
		await hostControls.handleJoinRequestSelect(acceptPress([REMOTE]).interaction);
		expect(mocks.seatRemote).toHaveBeenCalledWith(expect.anything(), expect.anything(), REMOTE, FROM_GUILD);
		expect(mocks.seatLocal).not.toHaveBeenCalled();
	});

	it("still seats a member of the host server in the room", async () => {
		await hostControls.handleJoinRequestSelect(acceptPress([LOCAL]).interaction);
		expect(mocks.seatLocal).toHaveBeenCalledWith(expect.anything(), expect.anything(), LOCAL, `Name ${LOCAL}`);
		expect(mocks.seatRemote).not.toHaveBeenCalled();
	});

	it("tells the host when a member from another server could not be seated", async () => {
		mocks.seatRemote.mockResolvedValue("their server is no longer on the network");
		const { interaction, editReply } = acceptPress([REMOTE]);
		await hostControls.handleJoinRequestSelect(interaction);
		const content = (editReply.mock.calls[0][0] as { content: string }).content;
		expect(content).toContain(words.approval.acceptedNotSeated(REMOTE, "their server is no longer on the network"));
	});
});
