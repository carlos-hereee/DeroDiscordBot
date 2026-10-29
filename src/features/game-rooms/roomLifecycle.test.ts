import { describe, it, expect, vi, beforeEach } from "vitest";
import { PermissionFlagsBits } from "discord.js";
import type { Client } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: { finish: vi.fn(), markArchived: vi.fn(), appendMove: vi.fn(), closeHoldemTable: vi.fn(), takeBuyInPaid: vi.fn() },
}));
vi.mock("@db/stores/chipWalletStore.js", () => ({ chipWalletStore: { credit: vi.fn(), debit: vi.fn() } }));
vi.mock("@db/stores/guildConfigStore.js", () => ({
	guildConfigStore: { findByGuildId: vi.fn() },
}));
vi.mock("@db/stores/botLogStore.js", () => ({ botLogStore: { log: vi.fn() } }));
vi.mock("@features/leveling/awardXp.js", () => ({ awardXp: vi.fn() }));

import { finish, archiveRoom, archiveNow } from "./roomLifecycle.js";
import { awardXp } from "@features/leveling/awardXp.js";
import { postMove } from "./roomTrail.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { chipWalletStore } from "@db/stores/chipWalletStore.js";
import { createTable, joinTable } from "@features/games/holdemTable.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

const storeMock = gameRoomStore as unknown as {
	finish: ReturnType<typeof vi.fn>;
	markArchived: ReturnType<typeof vi.fn>;
	appendMove: ReturnType<typeof vi.fn>;
	closeHoldemTable: ReturnType<typeof vi.fn>;
	takeBuyInPaid: ReturnType<typeof vi.fn>;
};
const creditMock = chipWalletStore.credit as unknown as ReturnType<typeof vi.fn>;
const configMock = guildConfigStore as unknown as { findByGuildId: ReturnType<typeof vi.fn> };
const logMock = botLogStore as unknown as { log: ReturnType<typeof vi.fn> };
const awardMock = awardXp as unknown as ReturnType<typeof vi.fn>;

// The room-rate top up resolves display names through the guild member CACHE, after one
// bulk fetch it deliberately ignores. Seeding the cache is therefore what decides whether a
// player is payable at all, which is exactly what the "member who left" case exercises.
function makeGuild(memberIds: string[] = ["host-1", "player-2"]) {
	const cache = new Map(memberIds.map((id) => [id, { id, displayName: `Display ${id}` }]));
	return {
		members: {
			fetch: vi.fn().mockResolvedValue(undefined),
			cache,
		},
	};
}

function makeRoom(overrides: Partial<IGameRoom> = {}): IGameRoom {
	return {
		roomId: "room-1",
		guildId: "guild-1",
		game: "hangman",
		hostId: "host-1",
		playerIds: ["host-1", "player-2"],
		spectatorIds: ["spectator-3"],
		visibility: "invite",
		channelId: "room-channel-1",
		openerMessageId: "opener-1",
		boardMessageId: null,
		status: "playing",
		secret: null,
		moves: [],
		winnerId: null,
		startedAt: new Date(),
		endedAt: null,
		archiveAt: null,
		...overrides,
	} as IGameRoom;
}

function makeChannel() {
	return {
		id: "room-channel-1",
		guild: { roles: { everyone: { id: "everyone" } } },
		isTextBased: () => true,
		isDMBased: () => false,
		send: vi.fn().mockResolvedValue({ id: "result-1" }),
		delete: vi.fn().mockResolvedValue(undefined),
		permissionOverwrites: { set: vi.fn().mockResolvedValue(undefined) },
	};
}

function makeClient(channel: unknown, guild: unknown = makeGuild()): Client {
	return {
		user: { id: "bot-1" },
		channels: { fetch: vi.fn().mockResolvedValue(channel) },
		guilds: { fetch: vi.fn().mockResolvedValue(guild) },
	} as unknown as Client;
}

beforeEach(() => {
	vi.clearAllMocks();
	// A ROW, not undefined. gameRoomStore.finish is a conditional write over the non-terminal
	// statuses, so its return value is the claim: a row means this caller took the transition,
	// null means somebody else already finished the room. Resolving undefined here would make
	// every test in this file exercise the already-finished path by accident.
	storeMock.finish.mockResolvedValue(makeRoom({ status: "finished" }));
	storeMock.markArchived.mockResolvedValue(undefined);
	storeMock.appendMove.mockResolvedValue(undefined);
	configMock.findByGuildId.mockResolvedValue({ adminRoleId: "admin-role" });
	logMock.log.mockResolvedValue(undefined);
});

describe("roomLifecycle.finish", () => {
	it("stamps endedAt and an archiveAt exactly one archive window out", async () => {
		const now = new Date("2026-08-12T10:00:00.000Z");
		const channel = makeChannel();
		await finish(makeClient(channel), makeRoom(), { winnerId: "host-1", now });

		expect(storeMock.finish).toHaveBeenCalledWith("guild-1", "room-1", {
			winnerId: "host-1",
			endedAt: now,
			archiveAt: new Date(now.getTime() + BOT_CONSTANTS.GAME_ROOM_ARCHIVE_DELAY_MS),
		});
	});

	// ⚠️ THE ORDER IS LOAD BEARING IN ONE DIRECTION. Persist-then-lock leaves, on a
	// crash between them, a finished row with a real archiveAt and a still-writable
	// channel: untidy for hours, and the sweep still cleans it. Lock-then-persist would
	// leave a LOCKED channel on a row still marked "playing", which the finished-only
	// sweep never touches and no recovery path finds, so it sits locked forever.
	it("persists the row BEFORE it touches the channel", async () => {
		const order: string[] = [];
		const channel = makeChannel();
		storeMock.finish.mockImplementation(async () => {
			order.push("persist");
			return makeRoom({ status: "finished" });
		});
		channel.permissionOverwrites.set.mockImplementation(async () => void order.push("lock"));

		await finish(makeClient(channel), makeRoom());

		expect(order).toEqual(["persist", "lock"]);
	});

	// ⚠️ THE REPLAY GUARD. Four paths can call finish on a room that is already finished: the
	// Forfeit button stays clickable (the status refusal in gameRoomHandlers covers only
	// BOARD_ACTIONS, and a SendMessages deny does not block a component interaction),
	// ChannelDeleteWatcher still matches the row for the whole archive window, versus takes no
	// claim of its own, and the hold em clock sweeps on a timer. The store's conditional write
	// is what stops them, and this asserts finish HONORS the refusal instead of carrying on:
	// re-running would pay every player a second time and let the winner overwrite winnerId
	// with the loser.
	it("does nothing at all when the room was already finished by somebody else", async () => {
		const channel = makeChannel();
		storeMock.finish.mockResolvedValue(null);

		await finish(makeClient(channel), makeRoom({ status: "finished" }), { winnerId: "player-2" });

		expect(channel.permissionOverwrites.set).not.toHaveBeenCalled();
		expect(channel.send).not.toHaveBeenCalled();
		expect(awardMock).not.toHaveBeenCalled();
	});

	it("locks the channel so nobody but the bot can write", async () => {
		const channel = makeChannel();
		await finish(makeClient(channel), makeRoom());

		const overwrites = channel.permissionOverwrites.set.mock.calls[0][0] as {
			id: string;
			allow?: bigint[];
			deny?: bigint[];
		}[];
		expect(overwrites.find((entry) => entry.id === "everyone")?.deny).toContain(PermissionFlagsBits.SendMessages);
		const writers = overwrites.filter((entry) => entry.allow?.includes(PermissionFlagsBits.SendMessages));
		expect(writers.map((entry) => entry.id)).toEqual(["bot-1"]);
	});

	// `set` replaces the entire array. A merge-style per-entry edit would leave behind
	// whichever playing-phase allows this code forgot to mention, which is the exact
	// shape of a lock that looks applied and is not.
	it("REPLACES the overwrite array rather than editing entries", async () => {
		const channel = makeChannel();
		await finish(makeClient(channel), makeRoom());
		expect(channel.permissionOverwrites.set).toHaveBeenCalledOnce();
	});

	it("posts the result card with the Archive now button", async () => {
		const channel = makeChannel();
		await finish(makeClient(channel), makeRoom(), { winnerId: "player-2" });

		const payload = channel.send.mock.calls[0][0] as { components: { components: unknown[] }[] };
		expect(payload.components).toHaveLength(1);
		expect(channel.send).toHaveBeenCalledOnce();
	});

	it("still stamps the row when the channel is already gone", async () => {
		// The ordinary abandonment case: an admin deleted the room channel. The row is
		// what the sweep reads, so stamping it is what lets the room close out at all.
		await finish(makeClient(null), makeRoom());
		expect(storeMock.finish).toHaveBeenCalledOnce();
	});

	it("survives a guild config read failure rather than leaving the room unlocked", async () => {
		configMock.findByGuildId.mockRejectedValue(new Error("mongo blip"));
		const channel = makeChannel();

		await finish(makeClient(channel), makeRoom());

		// The admin role is a nice-to-have on the overwrite array; the LOCK is not.
		expect(channel.permissionOverwrites.set).toHaveBeenCalledOnce();
	});
});

// ── the room-rate top up ──
// Every case here is one that type checks either way and only one shape is right, which is
// the whole reason this block is longer than the feature it covers.
describe("roomLifecycle.finish room-rate top up", () => {
	const { GAME_PLAY_XP, GAME_WIN_XP, GAME_ROOM_PLAY_XP, GAME_ROOM_WIN_XP } = BOT_CONSTANTS.LEVELING;
	const playTopUp = GAME_ROOM_PLAY_XP - GAME_PLAY_XP;
	const winTopUp = GAME_ROOM_WIN_XP - GAME_WIN_XP;

	// The award is fire and forget inside finish, so it lands a microtask or two after the
	// call resolves. Polling beats a fixed tick count, which would silently start passing
	// for the wrong reason if an await were ever added ahead of it.
	const awaitAwards = (count: number) => vi.waitFor(() => expect(awardMock).toHaveBeenCalledTimes(count));

	it("tops the winner and the loser up to exactly the room rate", async () => {
		await finish(makeClient(makeChannel()), makeRoom(), { winnerId: "player-2" });
		await awaitAwards(2);

		const byUser = Object.fromEntries(awardMock.mock.calls.map(([call]) => [call.userId, call]));

		// The POINT of a top up rather than a flat bonus: added to what the game's own hook
		// already paid, each total lands on the constant's face value. If someone converts
		// this to an additive bonus these two lines are what break.
		expect(byUser["player-2"].amount + GAME_PLAY_XP + GAME_WIN_XP).toBe(GAME_ROOM_PLAY_XP + GAME_ROOM_WIN_XP);
		expect(byUser["host-1"].amount + GAME_PLAY_XP).toBe(GAME_ROOM_PLAY_XP);

		expect(byUser["player-2"].amount).toBe(playTopUp + winTopUp);
		expect(byUser["host-1"].amount).toBe(playTopUp);
	});

	it("never names a game, which is what stops /account reading 'played 2'", async () => {
		await finish(makeClient(makeChannel()), makeRoom(), { winnerId: "player-2" });
		await awaitAwards(2);

		for (const [call] of awardMock.mock.calls) {
			// `game` is the field that increments games.<slug>.played, and the game's own hook
			// has already recorded this match. `outcome` is dead weight without it.
			expect(call.game).toBeUndefined();
			expect(call.outcome).toBeUndefined();
			expect(call.source).toBe("gameRoom");
		}
	});

	// 2026-10 item 254, Arcade 1: a round against Dero plays in a solo room so nothing is
	// played in ⚔️challenges, and it already paid its own capped solo luck award. A room rate
	// on top would pay one coin flip like a whole match, outside the daily cap.
	it.each(["solo-coinflip", "solo-diceroll", "solo-rps"] as const)("pays NO room rate for a %s round against Dero", async (game) => {
		await finish(makeClient(makeChannel()), makeRoom({ game, visibility: "solo", playerIds: ["host-1"] }), { winnerId: "host-1" });
		await new Promise((resolve) => setImmediate(resolve));
		expect(awardMock).not.toHaveBeenCalled();
	});

	// Every game ends with Rematch (2026-10 item 267, decision 8), a coin flip and a dice roll
	// included: their next round plays in the same channel as the rematch seeds.
	it.each(["solo-coinflip", "solo-diceroll"] as const)("offers Rematch beside Archive now on a %s room's result card", async (game) => {
		const channel = makeChannel();
		await finish(makeClient(channel), makeRoom({ game, visibility: "solo", playerIds: ["host-1"] }));
		const card = channel.send.mock.calls[0][0] as { components: { toJSON(): { components: { custom_id: string }[] } }[] };
		const ids = card.components[0].toJSON().components.map((button) => button.custom_id);
		expect(ids).toContain("gameroom:rematch:room-1");
		expect(ids).toContain("gameroom:archive:room-1");
	});

	// Rock paper scissors asks its throw in the room (2026-10 item 257 Phase 4b), so its result
	// card offers the next round in the same channel, on the same short window.
	it("offers Rematch on a solo rock paper scissors room's result card", async () => {
		const channel = makeChannel();
		await finish(makeClient(channel), makeRoom({ game: "solo-rps", visibility: "solo", playerIds: ["host-1"] }));
		const card = channel.send.mock.calls[0][0] as { components: { toJSON(): { components: { custom_id: string }[] } }[] };
		const ids = card.components[0].toJSON().components.map((button) => button.custom_id);
		expect(ids).toContain("gameroom:rematch:room-1");
	});

	// The owner's 30 minute window for a solo luck round (2026-10 item 254): finish stamps
	// it itself, so it stays the one writer of a date, and the card names that window.
	it("stamps the shorter window a solo luck round passes, and its card says so", async () => {
		const now = new Date("2026-10-26T10:00:00.000Z");
		const channel = makeChannel();
		const delay = BOT_CONSTANTS.GAME_ROOM_SOLO_LUCK_ARCHIVE_DELAY_MS;

		await finish(makeClient(channel), makeRoom({ game: "solo-coinflip", visibility: "solo", playerIds: ["host-1"] }), { winnerId: "host-1", now, archiveDelayMs: delay });

		expect(storeMock.finish).toHaveBeenCalledWith("guild-1", "room-1", { winnerId: "host-1", endedAt: now, archiveAt: new Date(now.getTime() + delay) });
		const card = channel.send.mock.calls[0][0] as { embeds: { data: { description?: string } }[] };
		expect(card.embeds[0].data.description).toContain("It disappears in 30 minutes");
	});

	it("keeps the ordinary four hour window, and says so, when no window is passed", async () => {
		const channel = makeChannel();

		await finish(makeClient(channel), makeRoom(), { winnerId: "host-1" });

		const card = channel.send.mock.calls[0][0] as { embeds: { data: { description?: string } }[] };
		expect(card.embeds[0].data.description).toContain("It disappears in 4 hours");
	});

	it("pays NOTHING for an abandoned room, which is the farm this closes", async () => {
		// Open a room, delete its channel, repeat. finish() is called with abandoned:true by
		// both the boot recovery sweep and ChannelDeleteWatcher's R14 path.
		await finish(makeClient(makeChannel()), makeRoom(), { abandoned: true });
		await finish(makeClient(makeChannel()), makeRoom(), { winnerId: "player-2", abandoned: true });

		expect(awardMock).not.toHaveBeenCalled();
	});

	it("excludes hold em, whose placement prize already includes the room win", async () => {
		await finish(makeClient(makeChannel()), makeRoom({ game: "holdem" }), { winnerId: "player-2" });

		expect(awardMock).not.toHaveBeenCalled();
	});

	it("pays a tie: no winner means the play top up for everyone and no win top up", async () => {
		await finish(makeClient(makeChannel()), makeRoom(), { winnerId: null });
		await awaitAwards(2);

		for (const [call] of awardMock.mock.calls) {
			expect(call.amount).toBe(playTopUp);
		}
	});

	it("SKIPS an unresolvable member rather than writing their id as their username", async () => {
		// memberLevelStore does `$set: { username }` on every award, so an id fallback would
		// replace a real display name with a snowflake on /account AND /levels. One missed
		// top up is the cheaper failure, and their own game hook already paid them.
		const guild = makeGuild(["host-1"]);
		await finish(makeClient(makeChannel(), guild), makeRoom(), { winnerId: "player-2" });
		await awaitAwards(1);

		expect(awardMock.mock.calls[0][0].userId).toBe("host-1");
		expect(awardMock.mock.calls[0][0].username).toBe("Display host-1");
		for (const [call] of awardMock.mock.calls) {
			expect(call.username).not.toBe(call.userId);
		}
	});

	it("still pays when the channel is already gone, because xp is not a Discord fact", async () => {
		// finish() early-returns under `if (!channel)`. The top up sits ABOVE that on purpose:
		// a match whose channel an admin deleted in the final seconds still happened.
		await finish(makeClient(null), makeRoom(), { winnerId: "player-2" });
		await awaitAwards(2);
	});

	it("does not reject when the guild cannot be fetched", async () => {
		const client = makeClient(makeChannel());
		(client.guilds.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("gateway blip"));

		// true, not undefined: finish reports whether THIS call claimed the transition, and a
		// guild it could not fetch is a failure of the bookkeeping, not of ending the match.
		await expect(finish(client, makeRoom(), { winnerId: "player-2" })).resolves.toBe(true);
		expect(awardMock).not.toHaveBeenCalled();
	});
});

// ── the room's invite dies with the match (2026-10 item 254, Arcade 10) ──
describe("roomLifecycle.finish, the room invite", () => {
	// A client whose guild can delete invites, recording the order of what finish does.
	function makeInviteClient(channel: unknown, order: string[], deleteInvite = vi.fn().mockImplementation(async () => void order.push("invite"))) {
		const guild = { ...makeGuild(), invites: { delete: deleteInvite } };
		const client = {
			user: { id: "bot-1" },
			channels: { fetch: vi.fn().mockResolvedValue(channel) },
			guilds: { cache: new Map([["guild-1", guild]]), fetch: vi.fn().mockResolvedValue(guild) },
		} as unknown as Client;
		return { client, deleteInvite };
	}

	it("deletes the stored invite AFTER the row is persisted and the channel is locked", async () => {
		const order: string[] = [];
		storeMock.finish.mockImplementation(async () => {
			order.push("persist");
			return makeRoom({ status: "finished", visibility: "public", inviteCode: "code-1" });
		});
		const channel = makeChannel();
		channel.permissionOverwrites.set.mockImplementation(async () => void order.push("lock"));
		const { client, deleteInvite } = makeInviteClient(channel, order);

		await finish(client, makeRoom({ visibility: "public", inviteCode: "code-1" }));
		await vi.waitFor(() => expect(deleteInvite).toHaveBeenCalled());

		expect(deleteInvite).toHaveBeenCalledWith("code-1", expect.any(String));
		expect(order.slice(0, 3)).toEqual(["persist", "lock", "invite"]);
		// It writes nothing: the only row write is finish's own claim.
		expect(storeMock.finish).toHaveBeenCalledTimes(1);
	});

	it("never blocks or fails the finish when the delete fails, and logs it", async () => {
		storeMock.finish.mockResolvedValue(makeRoom({ status: "finished", visibility: "public", inviteCode: "code-1" }));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const failing = vi.fn().mockRejectedValue(new Error("Unknown Invite"));
		const { client } = makeInviteClient(makeChannel(), [], failing);

		await expect(finish(client, makeRoom({ visibility: "public", inviteCode: "code-1" }))).resolves.toBe(true);
		await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledWith("[game-rooms] failed to delete a finished room's invite", expect.anything()));
		errorSpy.mockRestore();
	});

	it("deletes nothing for a room that never had an invite", async () => {
		storeMock.finish.mockResolvedValue(makeRoom({ status: "finished", inviteCode: null }));
		const { client, deleteInvite } = makeInviteClient(makeChannel(), []);

		await finish(client, makeRoom({ inviteCode: null }));
		await new Promise((resolve) => setImmediate(resolve));

		expect(deleteInvite).not.toHaveBeenCalled();
	});
});

// ── 2026-10 item 276: the money a room still holds when something outside the game ends it ──
describe("roomLifecycle.finish, what a room ended from outside still holds", () => {
	// Audit P1-3: the idle sweep, the leave watcher and a deleted channel finish a draft too, and
	// once it is finished Call it off can no longer reach the buy ins its joiners paid.
	it("refunds every buy in a challenge that never started still holds, each claimed before it pays", async () => {
		const order: string[] = [];
		storeMock.finish.mockImplementation(async () => {
			order.push("claim");
			return makeRoom({ game: "holdem", status: "finished", buyInPaidBy: ["a", "b"], holdemBuyIn: 2_500 });
		});
		storeMock.takeBuyInPaid.mockImplementation(async (_guildId: string, _roomId: string, userId: string) => {
			order.push(`take:${userId}`);
			return makeRoom();
		});
		creditMock.mockImplementation(async (key: { userId: string }) => void order.push(`pay:${key.userId}`));

		await finish(makeClient(null), makeRoom({ game: "holdem", status: "draft", channelId: null }), { abandoned: true });

		expect(creditMock.mock.calls).toEqual([
			[{ userId: "a" }, 2_500],
			[{ userId: "b" }, 2_500],
		]);
		expect(order).toEqual(["claim", "take:a", "pay:a", "take:b", "pay:b"]);
	});

	it("refunds nothing when another caller already finished the room", async () => {
		storeMock.finish.mockResolvedValue(null);

		await finish(makeClient(null), makeRoom({ game: "holdem", status: "draft", buyInPaidBy: ["a"] }), { abandoned: true });

		expect(storeMock.takeBuyInPaid).not.toHaveBeenCalled();
		expect(creditMock).not.toHaveBeenCalled();
	});

	// Audit P1-1: the table in the row is marked finished AFTER its stacks are paid back, so no
	// table control can pay a stack again or deal a new hand in a finished room.
	it("marks a Hold'em table finished in its row after paying its stacks back", async () => {
		const table = createTable();
		table.chips = { guildId: "guild-1" };
		joinTable(table, "host-1", "Host");
		joinTable(table, "player-2", "Player");
		table.status = "playing";
		const order: string[] = [];
		storeMock.finish.mockResolvedValue(makeRoom({ game: "holdem", status: "finished", secret: table as never }));
		creditMock.mockImplementation(async (key: { userId: string }) => void order.push(`pay:${key.userId}`));
		storeMock.closeHoldemTable.mockImplementation(async () => void order.push("close"));

		await finish(makeClient(null), makeRoom({ game: "holdem" }), { abandoned: true });

		expect(storeMock.closeHoldemTable).toHaveBeenCalledWith("guild-1", "room-1");
		expect(order).toEqual(["pay:host-1", "pay:player-2", "close"]);
	});

	it("leaves every other game's state alone", async () => {
		await finish(makeClient(null), makeRoom());

		expect(storeMock.closeHoldemTable).not.toHaveBeenCalled();
	});
});

describe("roomLifecycle.archiveRoom", () => {
	it("deletes the channel, closes the row and logs it", async () => {
		const channel = makeChannel();
		await archiveRoom(makeClient(channel), makeRoom());

		expect(channel.delete).toHaveBeenCalled();
		expect(storeMock.markArchived).toHaveBeenCalledWith("guild-1", "room-1");
		expect(logMock.log).toHaveBeenCalled();
	});

	// ⚠️ AN ALREADY-DELETED CHANNEL IS A SUCCESS, NOT AN ERROR. Treating it as a failure
	// would leave the row un-archived, and the sweep would retry it every five minutes
	// forever.
	it("closes the row anyway when the channel is already gone", async () => {
		await archiveRoom(makeClient(null), makeRoom({ channelId: null }));
		expect(storeMock.markArchived).toHaveBeenCalledWith("guild-1", "room-1");
	});

	it("closes the row even when the delete itself fails", async () => {
		const channel = makeChannel();
		channel.delete.mockRejectedValue(new Error("50013"));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

		await archiveRoom(makeClient(channel), makeRoom());

		expect(storeMock.markArchived).toHaveBeenCalledOnce();
		errorSpy.mockRestore();
	});
});

describe("roomLifecycle.archiveNow", () => {
	it("lets the host archive their own room", async () => {
		const channel = makeChannel();
		const result = await archiveNow(makeClient(channel), makeRoom(), "host-1", false);

		expect(result).toEqual({ ok: true });
		expect(channel.delete).toHaveBeenCalled();
	});

	it("lets an admin archive somebody else's room", async () => {
		const channel = makeChannel();
		const result = await archiveNow(makeClient(channel), makeRoom(), "moderator-9", true);
		expect(result).toEqual({ ok: true });
	});

	it("refuses a player who is neither host nor admin, and deletes NOTHING", async () => {
		const channel = makeChannel();
		const result = await archiveNow(makeClient(channel), makeRoom(), "player-2", false);

		expect(result).toEqual({ ok: false, reason: "notYours" });
		expect(channel.delete).not.toHaveBeenCalled();
		expect(storeMock.markArchived).not.toHaveBeenCalled();
	});
});

describe("roomTrail.postMove", () => {
	it("sends the move, then records it", async () => {
		const order: string[] = [];
		const channel = makeChannel();
		channel.send.mockImplementation(async () => {
			order.push("send");
			return { id: "m1" };
		});
		storeMock.appendMove.mockImplementation(async () => void order.push("append"));

		const posted = await postMove(makeClient(channel), makeRoom(), { actorId: "host-1", kind: "guess", text: "played E" });

		expect(posted).toBe(true);
		expect(order).toEqual(["send", "append"]);
	});

	// ⚠️ A TRANSCRIPT ROW FOR A MOVE NOBODY SAW IS UNRECOVERABLE. The dashboard would
	// show a move absent from the channel and nothing could say which one lied. A
	// missing row after a successful send is merely a gap, which is the tolerable
	// direction, so the send failing must abort the write entirely.
	it("records NOTHING when the send fails", async () => {
		const channel = makeChannel();
		channel.send.mockRejectedValue(new Error("50013"));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

		const posted = await postMove(makeClient(channel), makeRoom(), { actorId: "host-1", kind: "guess", text: "played E" });

		expect(posted).toBe(false);
		expect(storeMock.appendMove).not.toHaveBeenCalled();
		errorSpy.mockRestore();
	});

	it("still reports success when only the transcript append fails", async () => {
		const channel = makeChannel();
		storeMock.appendMove.mockRejectedValue(new Error("mongo blip"));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

		const posted = await postMove(makeClient(channel), makeRoom(), { actorId: "host-1", kind: "guess", text: "played E" });

		// The players saw it. Failing here would make a Mongo blip look like a rejected
		// move to whoever just played.
		expect(posted).toBe(true);
		errorSpy.mockRestore();
	});

	// ⚠️ SECURITY CONTROL, NOT A COURTESY. Move text is composed from user input in
	// places (a host-authored hangman hint, a display name). Without the pin, an
	// "@everyone" inside that text would ping the whole server from the bot's mouth.
	it("pins allowedMentions to the actor so text cannot smuggle a mass ping", async () => {
		const channel = makeChannel();
		await postMove(makeClient(channel), makeRoom(), {
			actorId: "host-1",
			kind: "hint",
			text: "@everyone look at this",
		});

		const payload = channel.send.mock.calls[0][0] as { allowedMentions: { users: string[] } };
		expect(payload.allowedMentions).toEqual({ users: ["host-1"] });
	});

	it("never attaches files to a move", async () => {
		const channel = makeChannel();
		await postMove(makeClient(channel), makeRoom(), { actorId: "host-1", kind: "system", text: "x" });
		expect(channel.send.mock.calls[0][0]).not.toHaveProperty("files");
	});

	it("drops the move rather than throwing when the room channel is gone", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const posted = await postMove(makeClient(null), makeRoom({ channelId: null }), {
			actorId: "host-1",
			kind: "system",
			text: "x",
		});

		expect(posted).toBe(false);
		expect(storeMock.appendMove).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});
});
