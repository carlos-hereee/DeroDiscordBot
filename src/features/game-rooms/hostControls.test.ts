import { describe, it, expect, vi, beforeEach } from "vitest";
import { PermissionFlagsBits, TextChannel, type ButtonInteraction, type StringSelectMenuInteraction } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: {
		findByRoomId: vi.fn(),
		update: vi.fn(),
		updateSecretIf: vi.fn(),
		removeMember: vi.fn(),
		addPendingJoin: vi.fn(),
		admitPendingJoin: vi.fn(),
		declinePendingJoins: vi.fn(),
	},
}));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn() } }));
vi.mock("@utils/permissions.js", () => ({ gateOwnerOrAdmin: vi.fn() }));
// The casual seat swap answers the pool write's row as it came, so a draft with no casual
// flag reads exactly as it did before 2026-10 item 254 Arcade 6.
vi.mock("./challengeBoard.js", () => ({ refreshDraftCard: vi.fn(), yieldBotSeatsTo: vi.fn(async (_client: unknown, _before: unknown, after: unknown) => after), challengeBoard: {} }));
vi.mock("./roomTrail.js", () => ({ roomTrail: { postMove: vi.fn() } }));
vi.mock("./roomLifecycle.js", () => ({ roomLifecycle: { finish: vi.fn() } }));
vi.mock("@features/leveling/awardXp.js", () => ({ awardXp: vi.fn() }));
vi.mock("@features/games/gameXp.js", () => ({ awardMultiPlayerResult: vi.fn(), awardTwoPlayerResult: vi.fn() }));
vi.mock("@features/games/monopolyRenderer.js", () => ({ renderBoard: vi.fn(), renderWinnerCard: vi.fn(), monopolyWinnerView: vi.fn() }));
vi.mock("./roomMonopolyReferee.js", () => ({ announceReferee: vi.fn() }));
vi.mock("@features/ratings/recordMatchRatings.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("@features/ratings/recordMatchRatings.js")>()),
	recordMatchRatings: vi.fn(),
}));

import { hostControls, removableMembers } from "./hostControls.js";
import { _handleGameRoomButton } from "./gameRoomHandlers.js";
import { buildRoomOverwrites } from "./roomPermissions.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { gateOwnerOrAdmin } from "@utils/permissions.js";
import { refreshDraftCard } from "./challengeBoard.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { recordMatchRatings } from "@features/ratings/recordMatchRatings.js";
import { createTable, dealHand, joinTable, type HoldemTable } from "@features/games/holdemTable.js";
import { createInitialState, type MonopolyState } from "@features/games/monopolyState.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── the host controls (2026-10 item 244 Phase 4) ───────────────────────────
// What:  every host control refuses anyone but the host (or an admin), on the button
//        AND on the select it opens; a request is accepted or declined only while it
//        is still waiting; a removal writes the room first, takes the member's own
//        overwrite and nothing else, and lets the game go its own way, with the removed
//        player kept out of every rating.

const words = rokCommanderCopy.arcadeHostControls;
type Mock = ReturnType<typeof vi.fn>;
const storeMock = gameRoomStore as unknown as Record<
	"findByRoomId" | "update" | "updateSecretIf" | "removeMember" | "addPendingJoin" | "admitPendingJoin" | "declinePendingJoins",
	Mock
>;
const gateMock = gateOwnerOrAdmin as unknown as Mock;
const refreshMock = refreshDraftCard as unknown as Mock;
const finishMock = roomLifecycle.finish as unknown as Mock;
const ratingMock = recordMatchRatings as unknown as Mock;

const HOST = "host-1";
const OTHER = "player-2";
const THIRD = "player-3";

const makeRoom = (overrides: Partial<IGameRoom> = {}): IGameRoom =>
	({
		roomId: "room-1",
		guildId: "guild-1",
		game: "holdem",
		hostId: HOST,
		playerIds: [HOST],
		spectatorIds: [],
		pendingJoinIds: [],
		kickedIds: [],
		visibility: "public",
		status: "draft",
		channelId: "ch-room",
		...overrides,
	}) as unknown as IGameRoom;

const guild = {
	id: "guild-1",
	members: {
		cache: { get: (id: string) => ({ id, displayName: `Name ${id}`, user: { username: id } }) },
		fetch: vi.fn(async () => null),
	},
};

// A channel the removal can find, so the overwrite calls are observable.
function makeChannel() {
	const channel = Object.create(TextChannel.prototype) as TextChannel & { permissionOverwrites: { delete: Mock; set: Mock } };
	Object.defineProperty(channel, "permissionOverwrites", { value: { delete: vi.fn().mockResolvedValue(undefined), set: vi.fn().mockResolvedValue(undefined) } });
	return channel;
}

function makeSelect(action: string, values: string[], userId = HOST, client: unknown = { channels: { fetch: vi.fn().mockResolvedValue(null) } }) {
	return {
		customId: `gameroomSelect:${action}:room-1`,
		guildId: "guild-1",
		guild,
		user: { id: userId },
		values,
		isModalSubmit: () => false,
		client,
		reply: vi.fn().mockResolvedValue(undefined),
		deferUpdate: vi.fn().mockResolvedValue(undefined),
		editReply: vi.fn().mockResolvedValue(undefined),
	} as unknown as StringSelectMenuInteraction;
}

function makeButton(customId: string, userId: string) {
	return {
		customId,
		guildId: "guild-1",
		guild,
		user: { id: userId },
		client: { user: { id: "bot-1" }, channels: { fetch: vi.fn().mockResolvedValue(null) } },
		reply: vi.fn().mockResolvedValue(undefined),
		deferUpdate: vi.fn().mockResolvedValue(undefined),
	} as unknown as ButtonInteraction;
}

const replyText = (interaction: { reply: unknown }): string =>
	(((interaction.reply as Mock).mock.calls[0]?.[0] ?? {}) as { content?: string }).content ?? "";
const editedText = (interaction: { editReply: unknown }): string =>
	(((interaction.editReply as Mock).mock.calls[0]?.[0] ?? {}) as { content?: string }).content ?? "";

const WRITES = ["update", "updateSecretIf", "removeMember", "addPendingJoin", "admitPendingJoin", "declinePendingJoins"] as const;
const expectNoWrites = () => {
	for (const write of WRITES) expect(storeMock[write]).not.toHaveBeenCalled();
};

beforeEach(() => {
	vi.clearAllMocks();
	gateMock.mockResolvedValue(false);
	finishMock.mockResolvedValue(true);
	storeMock.updateSecretIf.mockResolvedValue({});
});

describe("nobody but the host (or an admin) can use a host control", () => {
	it.each([
		["approval", "gameroom:approval:room-1:on"],
		["requests", "gameroom:requests:room-1"],
		["kick", "gameroom:kick:room-1"],
		["hseats", "gameroom:hseats:room-1:on"],
	])("refuses the %s button to a player who is not the host", async (_action, customId) => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom({ playerIds: [HOST, OTHER], pendingJoinIds: [THIRD], status: customId.includes("hseats") || customId.includes("kick") ? "playing" : "draft" }));
		const interaction = makeButton(customId, OTHER);

		await _handleGameRoomButton(interaction);

		expect(replyText(interaction)).toBe(gameRoomsCopy.errors.notYours);
		expectNoWrites();
	});

	it.each([
		["band", ["tight"]],
		["accept", [THIRD]],
		["decline", [THIRD]],
		["kick", [THIRD]],
	])("refuses the %s select to a player who is not the host, writing nothing", async (action, values) => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom({ spectatorIds: [THIRD], pendingJoinIds: [THIRD] }));
		const interaction = makeSelect(action, values, OTHER);

		const handler = action === "band" ? hostControls.handleBandSelect : action === "kick" ? hostControls.handleRemoveSelect : hostControls.handleJoinRequestSelect;
		await handler(interaction);

		expect(replyText(interaction)).toBe(gameRoomsCopy.errors.notYours);
		expectNoWrites();
	});

	it("lets an admin past the select's gate, the override every host control carries", async () => {
		gateMock.mockResolvedValue(true);
		storeMock.findByRoomId.mockResolvedValue(makeRoom());
		storeMock.update.mockResolvedValue(makeRoom({ ratingBand: "close" }));

		await hostControls.handleBandSelect(makeSelect("band", ["close"], "admin-9"));

		expect(storeMock.update).toHaveBeenCalledWith("guild-1", "room-1", { ratingBand: "close" });
	});
});

describe("the band select", () => {
	it("stores the band and redraws the card", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom());
		storeMock.update.mockResolvedValue(makeRoom({ ratingBand: "tight" }));

		await hostControls.handleBandSelect(makeSelect("band", ["tight"]));

		expect(storeMock.update).toHaveBeenCalledWith("guild-1", "room-1", { ratingBand: "tight" });
		expect(refreshMock).toHaveBeenCalledOnce();
	});

	it("refuses a forged band, and any band on a game that is not rated", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom());
		await hostControls.handleBandSelect(makeSelect("band", ["everyone"]));
		storeMock.findByRoomId.mockResolvedValue(makeRoom({ game: "rps" }));
		await hostControls.handleBandSelect(makeSelect("band", ["tight"]));
		expectNoWrites();
	});
});

// ── who may watch (2026-10 item 254, Arcade 11) ─────────────────────────
describe("the spectator select", () => {
	it.each(["open", "invite", "none"] as const)("stores %s on the draft and redraws the card", async (mode) => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom({ game: "rps" }));
		storeMock.update.mockResolvedValue(makeRoom({ game: "rps", spectatorMode: mode }));
		const interaction = makeSelect("spectators", [mode]);

		await hostControls.handleSpectatorSelect(interaction);

		expect(storeMock.update).toHaveBeenCalledWith("guild-1", "room-1", { spectatorMode: mode });
		expect(interaction.deferUpdate).toHaveBeenCalledOnce();
		expect(refreshMock).toHaveBeenCalledOnce();
	});

	it("refuses anyone but the host, a forged value, a network table, and a room already open", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom());
		const stranger = makeSelect("spectators", ["none"], OTHER);
		await hostControls.handleSpectatorSelect(stranger);
		expect(replyText(stranger)).toBe(gameRoomsCopy.errors.notYours);

		await hostControls.handleSpectatorSelect(makeSelect("spectators", ["everyone"]));
		storeMock.findByRoomId.mockResolvedValue(makeRoom({ network: true }));
		await hostControls.handleSpectatorSelect(makeSelect("spectators", ["none"]));

		// A room already open keeps the permissions it opened with: no migration, no change.
		storeMock.findByRoomId.mockResolvedValue(makeRoom({ status: "playing" }));
		const late = makeSelect("spectators", ["none"]);
		await hostControls.handleSpectatorSelect(late);
		expect(replyText(late)).toBe(gameRoomsCopy.board.draftGone);
		expectNoWrites();
	});
});

describe("answering join requests on a draft", () => {
	it("accepts into the pool, and only members still waiting, whatever the select sent", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom({ pendingJoinIds: [THIRD] }));
		storeMock.admitPendingJoin.mockResolvedValue(makeRoom({ spectatorIds: [THIRD] }));
		const interaction = makeSelect("accept", [THIRD, "forged-9"]);

		await hostControls.handleJoinRequestSelect(interaction);

		expect(storeMock.admitPendingJoin).toHaveBeenCalledOnce();
		expect(storeMock.admitPendingJoin).toHaveBeenCalledWith("guild-1", "room-1", THIRD, "spectatorIds");
		expect(editedText(interaction)).toBe(words.approval.accepted(1));
		expect(refreshMock).toHaveBeenCalled();
	});

	it("declines, taking them off the waiting list and nothing else", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom({ pendingJoinIds: [THIRD, OTHER] }));
		storeMock.declinePendingJoins.mockResolvedValue(makeRoom({ pendingJoinIds: [OTHER] }));
		const interaction = makeSelect("decline", [THIRD]);

		await hostControls.handleJoinRequestSelect(interaction);

		expect(storeMock.declinePendingJoins).toHaveBeenCalledWith("guild-1", "room-1", [THIRD]);
		expect(storeMock.admitPendingJoin).not.toHaveBeenCalled();
		expect(editedText(interaction)).toBe(words.approval.declined(1));
	});

	it("answers nobody when every chosen member was already answered", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom({ pendingJoinIds: [] }));
		const interaction = makeSelect("accept", [THIRD]);

		await hostControls.handleJoinRequestSelect(interaction);

		expect(replyText(interaction)).toBe(words.approval.requestsEmpty);
		expectNoWrites();
	});
});

// ── the joiner hears the answer (2026-10 item 254, Arcade 6) ──
// The joiner's own press was answered long ago, so the answer is one DM line naming the
// game and the server, pinging nobody; a closed DM is logged and the answer still lands.
describe("telling the joiner the host's answer", () => {
	function dmClient(send: Mock) {
		return { channels: { fetch: vi.fn().mockResolvedValue(null) }, users: { fetch: vi.fn(async (userId: string) => ({ id: userId, send })) } };
	}
	const guildWithName = { ...guild, name: "Test Uno" };
	const withGuild = (interaction: StringSelectMenuInteraction) => Object.assign(interaction, { guild: guildWithName });

	it("DMs an accepted joiner one line naming the game, the server and the answer", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom({ game: "monopoly", pendingJoinIds: [THIRD] }));
		storeMock.admitPendingJoin.mockResolvedValue(makeRoom({ game: "monopoly", spectatorIds: [THIRD] }));
		const send = vi.fn().mockResolvedValue(undefined);
		const interaction = withGuild(makeSelect("accept", [THIRD], HOST, dmClient(send)));

		await hostControls.handleJoinRequestSelect(interaction);

		expect(send).toHaveBeenCalledOnce();
		expect(send).toHaveBeenCalledWith({ content: gameRoomsCopy.joinAnswer.accepted("Monopoly", "Test Uno"), allowedMentions: { parse: [] } });
		expect(editedText(interaction)).toBe(words.approval.accepted(1));
	});

	it("DMs each declined joiner the decline", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom({ pendingJoinIds: [THIRD, OTHER] }));
		storeMock.declinePendingJoins.mockResolvedValue(makeRoom({ pendingJoinIds: [] }));
		const send = vi.fn().mockResolvedValue(undefined);
		const interaction = withGuild(makeSelect("decline", [THIRD, OTHER], HOST, dmClient(send)));

		await hostControls.handleJoinRequestSelect(interaction);

		expect(send).toHaveBeenCalledTimes(2);
		expect(send).toHaveBeenCalledWith({ content: gameRoomsCopy.joinAnswer.declined("Texas hold em", "Test Uno"), allowedMentions: { parse: [] } });
		expect(editedText(interaction)).toBe(words.approval.declined(2));
	});

	it("logs a refused DM and still answers the host, since the card's player list is the answer", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom({ pendingJoinIds: [THIRD] }));
		storeMock.admitPendingJoin.mockResolvedValue(makeRoom({ spectatorIds: [THIRD] }));
		const send = vi.fn().mockRejectedValue(Object.assign(new Error("Cannot send messages to this user"), { code: 50007 }));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const interaction = withGuild(makeSelect("accept", [THIRD], HOST, dmClient(send)));

		await hostControls.handleJoinRequestSelect(interaction);

		expect(send).toHaveBeenCalledOnce();
		expect(warn).toHaveBeenCalledWith("[game-rooms] could not DM a joiner the host's answer", expect.objectContaining({ userId: THIRD, answer: "accepted" }));
		expect(editedText(interaction)).toBe(words.approval.accepted(1));
		expect(refreshMock).toHaveBeenCalled();
		warn.mockRestore();
	});

	it("DMs nobody who was not actually admitted", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom({ pendingJoinIds: [THIRD] }));
		storeMock.admitPendingJoin.mockResolvedValue(null);
		const send = vi.fn().mockResolvedValue(undefined);
		const interaction = withGuild(makeSelect("accept", [THIRD], HOST, dmClient(send)));

		await hostControls.handleJoinRequestSelect(interaction);

		expect(send).not.toHaveBeenCalled();
	});
});

describe("removing a member before the start", () => {
	it("writes the removal (out of the pool and the waiting list, onto kickedIds) and redraws the card", async () => {
		const draft = makeRoom({ spectatorIds: [OTHER, THIRD] });
		storeMock.findByRoomId.mockResolvedValue(draft);
		storeMock.removeMember.mockResolvedValue(makeRoom({ spectatorIds: [OTHER], kickedIds: [THIRD] }));
		const interaction = makeSelect("kick", [THIRD]);

		await hostControls.handleRemoveSelect(interaction);

		expect(storeMock.removeMember).toHaveBeenCalledWith("guild-1", "room-1", THIRD);
		expect(refreshMock).toHaveBeenCalledOnce();
		expect(editedText(interaction)).toBe(words.kick.removed(THIRD));
	});

	it("never removes the host, whatever a forged select sends", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom({ spectatorIds: [OTHER] }));
		const interaction = makeSelect("kick", [HOST]);

		await hostControls.handleRemoveSelect(interaction);

		expect(replyText(interaction)).toBe(words.kick.gone);
		expectNoWrites();
	});
});

describe("who can be removed", () => {
	it("offers a draft's pool and waiting list, never the host", () => {
		expect(removableMembers(makeRoom({ spectatorIds: [HOST, OTHER], pendingJoinIds: [THIRD] }))).toEqual([OTHER, THIRD]);
	});

	it("offers nobody in a finished room, or in play in a game with no removal", () => {
		expect(removableMembers(makeRoom({ status: "finished" }))).toBeNull();
		expect(removableMembers(makeRoom({ status: "playing", game: "rps" }))).toBeNull();
	});

	it("offers a Monopoly seat still in after its player left playerIds, so a busy board's removal can be pressed again", () => {
		const state = createInitialState([HOST, OTHER, THIRD], { auctionsEnabled: false }, 1_000, 1);
		expect(removableMembers(makeRoom({ status: "playing", game: "monopoly", playerIds: [HOST, OTHER], kickedIds: [THIRD], secret: state as never }))).toEqual([OTHER, THIRD]);
	});
});

describe("removing a player during the match", () => {
	// A Hold'em table two players deep into hand one; removing one ends the tournament.
	function twoSeatTable(): HoldemTable {
		const table = createTable();
		joinTable(table, HOST, "Host");
		joinTable(table, OTHER, "Other");
		table.status = "playing";
		dealHand(table, () => 0.5);
		table.boardMessageId = null;
		return table;
	}

	function playingRoom(game: IGameRoom["game"], secret: unknown, overrides: Partial<IGameRoom> = {}): IGameRoom {
		return makeRoom({ status: "playing", game, playerIds: [HOST, OTHER], secret: secret as never, ...overrides });
	}

	// Every read hands back a FRESH copy of the stored row, the way the database does:
	// the game steps mutate the table they read, and a retry must re-read the stored one.
	function wireRemoval(before: IGameRoom) {
		const stored = structuredClone({ ...before, playerIds: [HOST], kickedIds: [OTHER] }) as IGameRoom;
		const after = structuredClone(stored);
		storeMock.findByRoomId.mockResolvedValueOnce(before).mockImplementation(async () => structuredClone(stored));
		storeMock.removeMember.mockResolvedValue(after);
		const channel = makeChannel();
		const client = { channels: { fetch: vi.fn().mockResolvedValue(channel) }, guilds: { fetch: vi.fn().mockResolvedValue(null) }, user: { id: "bot-1" } };
		return { after, channel, client };
	}

	it("removes only the member's own overwrite, so a public room keeps its one @everyone overwrite", async () => {
		const { channel, client } = wireRemoval(playingRoom("holdem", twoSeatTable()));

		await hostControls.handleRemoveSelect(makeSelect("kick", [OTHER], HOST, client));

		expect(channel.permissionOverwrites.delete).toHaveBeenCalledOnce();
		expect(channel.permissionOverwrites.delete.mock.calls[0][0]).toBe(OTHER);
		expect(channel.permissionOverwrites.set).not.toHaveBeenCalled();
	});

	it("Hold'em: the seat leaves the table, and the removed player is excluded from the ratings", async () => {
		const { client } = wireRemoval(playingRoom("holdem", twoSeatTable()));

		await hostControls.handleRemoveSelect(makeSelect("kick", [OTHER], HOST, client));

		const table = storeMock.updateSecretIf.mock.calls[0][3] as HoldemTable;
		expect(table.seats.find((seat) => seat.userId === OTHER)?.out).toBe(true);
		expect(table.status).toBe("finished");
		expect(finishMock).toHaveBeenCalledOnce();
		expect(ratingMock).toHaveBeenCalledOnce();
		const [, order, excluded] = ratingMock.mock.calls[0];
		expect(order).toContain(OTHER);
		expect(excluded).toEqual([OTHER]);
	});

	it("Battleship: the match ends unrated through the abandoned path", async () => {
		const { after, client } = wireRemoval(playingRoom("battleship", null));

		await hostControls.handleRemoveSelect(makeSelect("kick", [OTHER], HOST, client));

		expect(finishMock).toHaveBeenCalledWith(client, after, { abandoned: true });
		expect(ratingMock).not.toHaveBeenCalled();
	});

	it("Monopoly: the seat goes out through the forfeit path, and is excluded from the ratings", async () => {
		const state: MonopolyState = { ...createInitialState([HOST, OTHER], { auctionsEnabled: false }, 1_000, 1), boardMessageId: null };
		const { client } = wireRemoval(playingRoom("monopoly", state));

		await hostControls.handleRemoveSelect(makeSelect("kick", [OTHER], HOST, client));

		const next = storeMock.updateSecretIf.mock.calls[0][3] as MonopolyState;
		expect(next.seats.find((seat) => seat.userId === OTHER)?.bankrupt).toBe(true);
		expect(next.winnerId).toBe(HOST);
		expect(ratingMock).toHaveBeenCalledOnce();
		expect(ratingMock.mock.calls[0][2]).toEqual([OTHER]);
	});

	it("tells the host to press again when a busy table kept the seat every time", async () => {
		const { client } = wireRemoval(playingRoom("holdem", twoSeatTable()));
		storeMock.updateSecretIf.mockResolvedValue(null);
		const interaction = makeSelect("kick", [OTHER], HOST, client);

		await hostControls.handleRemoveSelect(interaction);

		expect(editedText(interaction)).toBe(words.kick.seatStillHeld(OTHER));
	});
});

describe("the room's overwrites after a removal", () => {
	it("still spends exactly ONE @everyone overwrite on a public room, and none on the removed member", () => {
		const overwrites = buildRoomOverwrites({
			everyoneRoleId: "everyone",
			botId: "bot-1",
			hostId: HOST,
			playerIds: [HOST, THIRD],
			spectatorIds: [],
			visibility: "public",
			phase: "finished",
		});
		expect(overwrites.filter((entry) => entry.id === "everyone")).toHaveLength(1);
		expect(overwrites.find((entry) => entry.id === "everyone")?.deny).toContain(PermissionFlagsBits.SendMessages);
		expect(overwrites.some((entry) => entry.id === OTHER)).toBe(false);
	});
});
