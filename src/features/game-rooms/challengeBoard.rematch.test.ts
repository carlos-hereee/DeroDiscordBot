// ── the Rematch button, end to end over an in-memory GameRoom collection ──
// What:  proves a rematch plays on IN THE SAME CHANNEL: a new row takes the channel over,
//        the finished row releases it, and the two consumers that find rows BY CHANNEL
//        (the archive sweep and ChannelDeleteWatcher) then see only the live match.
// Why:   both of those consumers act on the database, not on the rematch code, so a unit
//        test that mocks the store would prove nothing about them. The collection below
//        reproduces each store method's FILTER (including the one-live-room-per-host
//        partial unique index) and the real rematch, sweep, lifecycle and watcher run on it.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChannelType, DiscordAPIError, Events, RESTJSONErrorCodes, type APIEmbed, type ButtonInteraction, type Client, type Guild } from "discord.js";

type FakeRow = Record<string, unknown> & { roomId: string; guildId: string; status: string };

const fake = vi.hoisted(() => {
	// Mirrors NON_TERMINAL_ROOM_STATUSES; the first test pins the two together.
	const LIVE = ["draft", "open", "playing"];
	const rows: FakeRow[] = [];
	let nextId = 2;

	// Every read hands back a COPY, the way a Mongoose query returns a fresh document, so
	// code under test can never change the collection by mutating what it read.
	const copy = (row: FakeRow | undefined) =>
		row
			? { ...row, playerIds: [...(row.playerIds as string[])], spectatorIds: [...(row.spectatorIds as string[])], moves: [...(row.moves as unknown[])] }
			: null;
	const find = (guildId: string, roomId: string) => rows.find((row) => row.guildId === guildId && row.roomId === roomId);

	const store = {
		async create(input: Record<string, unknown>) {
			const hostTaken = rows.some((row) => row.guildId === input.guildId && row.hostId === input.hostId && LIVE.includes(row.status));
			if (hostTaken) throw Object.assign(new Error("E11000 duplicate key error"), { code: 11000 });
			const row: FakeRow = {
				roomId: `room-${nextId++}`,
				guildId: input.guildId as string,
				game: input.game,
				hostId: input.hostId,
				playerIds: (input.playerIds as string[] | undefined) ?? [input.hostId as string],
				spectatorIds: (input.spectatorIds as string[] | undefined) ?? [],
				visibility: input.visibility,
				channelId: input.channelId ?? null,
				openerMessageId: null,
				inviteCode: null,
				boardMessageId: input.boardMessageId ?? null,
				status: "draft",
				rematchedFromRoomId: input.rematchedFromRoomId ?? null,
				monopolyAuctions: input.monopolyAuctions ?? false,
				monopolyReferee: input.monopolyReferee ?? false,
				// The referee flag (2026-10 item 257 Phase 4b), as the real store writes it.
				referee: input.referee ?? false,
				// Dero voice (2026-10 item 267), as the real store writes it.
				deroVoice: input.deroVoice ?? null,
				// The host's spectator setting (2026-10 item 254, Arcade 11), as the real store writes it.
				spectatorMode: input.spectatorMode ?? null,
				// A Blackjack rematch's buy in and its stacks ledger (2026-10 item 267).
				holdemBuyIn: input.holdemBuyIn ?? null,
				// The Dero bots a rematch seats again (2026-10 item 250 Phase 5), as the real store writes them.
				botSeats: input.botSeats ?? 0,
				// A Casual match's rematch stays casual (2026-10 item 254), as the real store writes it.
				casual: input.casual ?? false,
				blackjackStacks: [],
				// A ranked rematch's stakes are born on the new row's draft ledger (2026-10 item 276).
				buyInPaidBy: (input.buyInPaidBy as string[] | undefined) ?? [],
				secret: null,
				moves: [],
				winnerId: null,
				startedAt: null,
				endedAt: null,
				archiveAt: null,
			};
			rows.push(row);
			return copy(row);
		},
		async findByRematchedFrom(guildId: string, roomId: string) {
			return copy(rows.find((row) => row.guildId === guildId && row.rematchedFromRoomId === roomId));
		},
		async findByRoomId(guildId: string, roomId: string) {
			return copy(find(guildId, roomId));
		},
		// findOne in natural (insertion) order, exactly the ambiguity two rows on one
		// channel would expose.
		async findByChannelId(guildId: string, channelId: string) {
			return copy(rows.find((row) => row.guildId === guildId && row.channelId === channelId));
		},
		async findOtherRoomOnChannel(guildId: string, channelId: string, roomId: string) {
			return copy(rows.find((row) => row.guildId === guildId && row.channelId === channelId && row.roomId !== roomId));
		},
		async findOpenByHost(guildId: string, hostId: string) {
			return copy(rows.find((row) => row.guildId === guildId && row.hostId === hostId && LIVE.includes(row.status)));
		},
		async countOpenInGuild(guildId: string) {
			return rows.filter((row) => row.guildId === guildId && LIVE.includes(row.status)).length;
		},
		async countOpenInGuildByVisibility(guildId: string, visibilities: string[]) {
			return rows.filter((row) => row.guildId === guildId && LIVE.includes(row.status) && visibilities.includes(row.visibility as string)).length;
		},
		async update(guildId: string, roomId: string, patch: Record<string, unknown>) {
			const row = find(guildId, roomId);
			if (row) Object.assign(row, patch);
			return copy(row);
		},
		async setStatus(guildId: string, roomId: string, status: string, patch: Record<string, unknown> = {}) {
			const row = find(guildId, roomId);
			if (row) Object.assign(row, patch, { status });
			return copy(row);
		},
		// The start claim (2026-10 item 276): only a row not yet playing moves, with its ledger
		// emptied in the same write, answering the row as it was BEFORE.
		// A Blackjack table's claim also opens the stacks ledger from the seats on the draft ledger,
		// in the same write, as the real pipeline update does.
		async claimForPlay(guildId: string, roomId: string, patch: Record<string, unknown>, blackjackTable?: { buyIn: number; seatIds: string[]; actedAt: Date }) {
			const row = find(guildId, roomId);
			if (!row || !["draft", "open"].includes(row.status as string)) return null;
			const before = { ...copy(row), buyInPaidBy: [...((row.buyInPaidBy as string[] | undefined) ?? [])] };
			const stacks = blackjackTable
				? blackjackTable.seatIds.filter((userId) => ((row.buyInPaidBy as string[] | undefined) ?? []).includes(userId)).map((userId) => ({ userId, buyIn: blackjackTable.buyIn, stack: blackjackTable.buyIn }))
				: null;
			Object.assign(row, patch, { status: "playing", buyInPaidBy: [] }, stacks ? { blackjackStacks: stacks, blackjackActedAt: blackjackTable?.actedAt } : {});
			return before;
		},
		async archiveDraft(guildId: string, roomId: string) {
			const row = find(guildId, roomId);
			if (!row || row.status !== "draft") return null;
			Object.assign(row, { status: "archived", channelId: null });
			return copy(row);
		},
		async closeHoldemTable() {
			return { matchedCount: 0 };
		},
		async finish(guildId: string, roomId: string, outcome: Record<string, unknown>) {
			const row = find(guildId, roomId);
			if (!row || !LIVE.includes(row.status)) return null;
			Object.assign(row, outcome, { status: "finished" });
			return copy(row);
		},
		async releaseChannel(guildId: string, roomId: string, channelId: string) {
			const row = find(guildId, roomId);
			if (!row || row.status !== "finished" || row.channelId !== channelId) return null;
			Object.assign(row, { channelId: null, archiveAt: null });
			return copy(row);
		},
		async findNonTerminal() {
			return rows.filter((row) => LIVE.includes(row.status)).map((row) => copy(row));
		},
		async findExpiredArchives(now: Date) {
			return rows
				.filter((row) => row.status === "finished" && row.archiveAt instanceof Date && row.archiveAt.getTime() <= now.getTime())
				.map((row) => copy(row));
		},
		async markArchived(guildId: string, roomId: string) {
			const row = find(guildId, roomId);
			if (row) Object.assign(row, { status: "archived", channelId: null });
			return copy(row);
		},
		// A ranked Monopoly or Battleship pot, opened on a playing row (2026-10 item 276).
		async openChipPot(guildId: string, roomId: string, pot: unknown) {
			const row = find(guildId, roomId);
			if (!row || row.status !== "playing") return null;
			Object.assign(row, { chipPot: pot });
			return copy(row);
		},
		async openBlackjackStacks(guildId: string, roomId: string, entries: unknown[]) {
			const row = find(guildId, roomId);
			if (row) Object.assign(row, { blackjackStacks: entries.map((entry) => ({ ...(entry as object) })) });
			return copy(row);
		},
		async saveBlackjackStacks() {
			return null;
		},
		async takeBlackjackStack(guildId: string, roomId: string, userId: string) {
			const row = find(guildId, roomId);
			const entries = (row?.blackjackStacks as { userId: string }[] | undefined) ?? [];
			const entry = entries.find((candidate) => candidate.userId === userId);
			if (!row || !entry) return null;
			row.blackjackStacks = entries.filter((candidate) => candidate !== entry);
			return { ...entry };
		},
		async appendMove(guildId: string, roomId: string, move: unknown) {
			const row = find(guildId, roomId);
			if (row) (row.moves as unknown[]).push(move);
			return copy(row);
		},
	};

	return {
		LIVE,
		rows,
		store,
		reset() {
			rows.length = 0;
			nextId = 2;
		},
		insert(row: FakeRow) {
			rows.push(row);
		},
		row(roomId: string) {
			return rows.find((entry) => entry.roomId === roomId);
		},
		snapshot() {
			return JSON.stringify(rows);
		},
	};
});

vi.mock("@db/stores/gameRoomStore.js", () => ({ gameRoomStore: fake.store }));
// Every member's chip wallet, in memory: a Blackjack rematch charges its buy in again (2026-10
// item 267), and a server with no chips switch stored plays for chips.
const wallets = vi.hoisted(() => new Map<string, number>());
vi.mock("@features/economy/chipWallet.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("@features/economy/chipWallet.js")>()),
	takeChips: vi.fn(async (key: { userId: string }, amount: number) => {
		const balance = wallets.get(key.userId) ?? 0;
		if (balance < amount) return false;
		wallets.set(key.userId, balance - amount);
		return true;
	}),
	returnChips: vi.fn(async (key: { userId: string }, amount: number) => {
		wallets.set(key.userId, (wallets.get(key.userId) ?? 0) + amount);
	}),
}));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn() } }));
vi.mock("@db/stores/botLogStore.js", () => ({ botLogStore: { log: vi.fn() } }));
vi.mock("@features/leveling/awardXp.js", () => ({ awardXp: vi.fn() }));
vi.mock("./challengeCardRenderer.js", () => ({ renderChallengeCard: vi.fn(), challengeCardView: vi.fn() }));
// The tier decision, defaulted per case to "not enforcing" like production today.
vi.mock("@features/entitlements/gameRoomAccess.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("@features/entitlements/gameRoomAccess.js")>()),
	checkGameRoomAccess: vi.fn(),
}));
// The two solo games' own starts, so each case can see what the rematch dealt into
// which channel without running a blackjack collector or a hangman round.
vi.mock("@features/games/blackjackHandler.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("@features/games/blackjackHandler.js")>()),
	startBlackjackTable: vi.fn(),
}));
vi.mock("./roomHangman.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./roomHangman.js")>()),
	startSoloHangmanRound: vi.fn(),
}));
// The turn prompt and the referee's start, so each case can see what the rematch asked for
// without posting a prompt line or reaching for Dero's voice (2026-10 item 257 Phase 4b).
vi.mock("./turnPrompt.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./turnPrompt.js")>()),
	syncTurnPrompt: vi.fn(),
}));
vi.mock("./roomReferee.js", () => ({ startRoomReferee: vi.fn() }));
// The solo rooms roll with secureRandom, so a test pins the round here; null keeps the real source.
const securePin = vi.hoisted(() => ({ value: null as number | null }));
vi.mock("@utils/secureRng.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("@utils/secureRng.js")>();
	return { ...real, secureRandom: () => securePin.value ?? real.secureRandom() };
});

import { rematchFromRoom } from "./challengeBoard.js";
import { syncTurnPrompt } from "./turnPrompt.js";
import { startRoomReferee } from "./roomReferee.js";
import { resolveSoloLuck } from "@features/games/soloLuck.js";
import { buildSoloLuckEmbed } from "@features/games/gamesEmbeds.js";
import { soloRpsTurnAdapter } from "./soloLuckRoom.js";
import { sweepExpiredRooms } from "./roomArchiveSweep.js";
import { recoverGameRoomsOnBoot } from "./roomBootRecovery.js";
import { buildRoomOverwrites } from "./roomPermissions.js";
import { roomResultEmbed } from "./gameRoomsEmbeds.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { NON_TERMINAL_ROOM_STATUSES } from "./roomTypes.js";
import { registerChannelDeleteWatcher } from "@features/setup/ChannelDeleteWatcher.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { checkGameRoomAccess } from "@features/entitlements/gameRoomAccess.js";
import { startBlackjackTable } from "@features/games/blackjackHandler.js";
import { startSoloHangmanRound } from "./roomHangman.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";

const configMock = guildConfigStore as unknown as { findByGuildId: ReturnType<typeof vi.fn> };
const logMock = botLogStore as unknown as { log: ReturnType<typeof vi.fn> };
const accessMock = checkGameRoomAccess as unknown as ReturnType<typeof vi.fn>;
const blackjackMock = startBlackjackTable as unknown as ReturnType<typeof vi.fn>;
const soloHangmanMock = startSoloHangmanRound as unknown as ReturnType<typeof vi.fn>;

const GUILD = "guild-1";
const CHANNEL = "room-ch-1";
const FINISHED = "room-1";
const P1 = "p1";
const P2 = "p2";
const WATCHER = "watcher-3";

// ── the fake Discord side ─────────────────────────────────────────────

function makeRoomChannel() {
	let messageCount = 0;
	return {
		id: CHANNEL,
		guild: { roles: { everyone: { id: "everyone" } } },
		isTextBased: () => true,
		isDMBased: () => false,
		send: vi.fn(async () => ({ id: `msg-${++messageCount}`, pin: vi.fn().mockResolvedValue(undefined) })),
		createInvite: vi.fn().mockResolvedValue({ code: "invite-2" }),
		delete: vi.fn().mockResolvedValue(undefined),
		permissionOverwrites: { set: vi.fn().mockResolvedValue(undefined) },
		// The boot sweep looks back for a dead Blackjack board; this channel has none.
		messages: { unpin: vi.fn().mockResolvedValue(undefined), fetch: vi.fn().mockResolvedValue(new Map()) },
	};
}

// A client whose channel cache is a Map the test controls: deleting a channel (by the
// sweep, or by hand before firing the watcher) takes it out, so a later fetch misses.
function makeWorld() {
	const channel = makeRoomChannel();
	const live = new Map<string, unknown>([[CHANNEL, channel]]);
	channel.delete.mockImplementation(async () => {
		live.delete(CHANNEL);
	});
	let channelDeleteHandler: ((deleted: unknown) => Promise<void>) | null = null;
	const client = {
		user: { id: "bot-1" },
		channels: { fetch: vi.fn(async (id: string) => live.get(id) ?? null) },
		guilds: { fetch: vi.fn().mockResolvedValue(null) },
		on: vi.fn((event: string, handler: (deleted: unknown) => Promise<void>) => {
			if (event === Events.ChannelDelete) channelDeleteHandler = handler;
		}),
	} as unknown as Client;
	const members = new Map([
		[P1, { id: P1, displayName: "Player One" }],
		[P2, { id: P2, displayName: "Player Two" }],
	]);
	const guild = {
		id: GUILD,
		client,
		roles: { everyone: { id: "everyone" } },
		members: { cache: members, fetch: vi.fn().mockResolvedValue(null) },
		// A rematch must never build a channel; the spy is what proves it.
		channels: { create: vi.fn() },
	} as unknown as Guild;
	return {
		channel,
		client,
		guild,
		live,
		fireChannelDelete: async () => {
			live.delete(CHANNEL);
			await channelDeleteHandler?.({ id: CHANNEL, name: "rps-player-one", guild, type: ChannelType.GuildText });
		},
	};
}

type World = ReturnType<typeof makeWorld>;

// The Rematch press, carrying the posted result card it lives on.
function pressRematch(world: World, userId: string): ButtonInteraction {
	const posted = roomResultEmbed(P1).toJSON() as APIEmbed;
	// As discord.js does: deferUpdate marks the press deferred, which is what sends a refusal
	// answerInChannel cannot post (no 💬dero-commands stored here) as a private followUp.
	const press: Record<string, unknown> = {
		guildId: GUILD,
		guild: world.guild,
		client: world.client,
		user: { id: userId, globalName: null, username: userId },
		message: { embeds: [posted] },
		deferred: false,
		replied: false,
		reply: vi.fn().mockResolvedValue(undefined),
		deferUpdate: vi.fn(async () => {
			press.deferred = true;
		}),
		editReply: vi.fn().mockResolvedValue(undefined),
		followUp: vi.fn().mockResolvedValue(undefined),
	};
	return press as unknown as ButtonInteraction;
}

const ARCHIVE_DELAY = BOT_CONSTANTS.GAME_ROOM_ARCHIVE_DELAY_MS;

function insertFinishedRoom(overrides: Partial<FakeRow> = {}): void {
	const endedAt = new Date();
	fake.insert({
		roomId: FINISHED,
		guildId: GUILD,
		game: "rps",
		hostId: P1,
		playerIds: [P1, P2],
		spectatorIds: [WATCHER],
		visibility: "invite",
		channelId: CHANNEL,
		openerMessageId: "opener-1",
		inviteCode: "invite-1",
		boardMessageId: "card-1",
		status: "finished",
		rematchedFromRoomId: null,
		monopolyAuctions: false,
		monopolyReferee: false,
		// A row from before the referee field existed: null, read through refereeOn.
		referee: null,
		secret: null,
		moves: [{ actorId: P1, at: endedAt, kind: "move", text: "played rock" }],
		winnerId: P1,
		startedAt: new Date(endedAt.getTime() - 60_000),
		endedAt,
		archiveAt: new Date(endedAt.getTime() + ARCHIVE_DELAY),
		...overrides,
	});
}

// The one row a rematch of the finished room created, read straight off the collection.
function rematchRow(): FakeRow | undefined {
	return fake.rows.find((row) => row.rematchedFromRoomId === FINISHED);
}

const roomOf = (roomId: string) => fake.store.findByRoomId(GUILD, roomId) as unknown as Promise<Parameters<typeof rematchFromRoom>[1]>;

beforeEach(() => {
	vi.clearAllMocks();
	fake.reset();
	configMock.findByGuildId.mockResolvedValue({ guildId: GUILD, adminRoleId: null, gamesCategoryId: "arcade-cat", autoHealEnabled: true });
	logMock.log.mockResolvedValue(undefined);
	accessMock.mockResolvedValue({ allowed: true, privateQuota: Number.POSITIVE_INFINITY });
	blackjackMock.mockResolvedValue("started");
	soloHangmanMock.mockResolvedValue(undefined);
	wallets.clear();
	wallets.set(P1, 5000);
	wallets.set(P2, 5000);
});

describe("a rematch in the same channel", () => {
	// 2026-10 item 254, Arcade 10: a rematch follows the same invite rule as an open.
	it("mints a fresh invite for a public rematch everyone may watch, and carries the spectator setting", async () => {
		const world = makeWorld();
		insertFinishedRoom({ visibility: "public", spectatorIds: [], spectatorMode: "open" });

		await rematchFromRoom(pressRematch(world, P2), await roomOf(FINISHED));

		const next = rematchRow();
		expect(next).toMatchObject({ visibility: "public", spectatorMode: "open", inviteCode: "invite-2" });
		expect(world.channel.createInvite).toHaveBeenCalledTimes(1);
	});

	it("mints no invite for a public rematch the host closed to spectators", async () => {
		const world = makeWorld();
		insertFinishedRoom({ visibility: "public", spectatorIds: [], spectatorMode: "none" });

		await rematchFromRoom(pressRematch(world, P2), await roomOf(FINISHED));

		expect(rematchRow()).toMatchObject({ spectatorMode: "none", inviteCode: null });
		expect(world.channel.createInvite).not.toHaveBeenCalled();
	});

	it("fakes the same live statuses the partial unique index covers", () => {
		expect(fake.LIVE).toEqual([...NON_TERMINAL_ROOM_STATUSES]);
	});

	it("keeps the channel id, unlocks it and seats the same players with the presser hosting", async () => {
		const world = makeWorld();
		insertFinishedRoom();
		const interaction = pressRematch(world, P2);

		await rematchFromRoom(interaction, await roomOf(FINISHED));

		const next = rematchRow();
		expect(next).toMatchObject({
			channelId: CHANNEL,
			hostId: P2,
			game: "rps",
			visibility: "invite",
			spectatorIds: [WATCHER],
			status: "playing",
			// An invite only rematch mints no invite, like an invite only open (2026-10
			// item 254, Arcade 10).
			inviteCode: null,
		});
		expect(world.channel.createInvite).not.toHaveBeenCalled();
		expect([...(next?.playerIds as string[])].sort()).toEqual([P1, P2]);
		expect(next?.startedAt).toBeInstanceOf(Date);
		expect(next?.openerMessageId).toBe("msg-1");
		expect(world.guild.channels.create).not.toHaveBeenCalled();

		// The unlock is the playing matrix for the NEW room, replacing the finished
		// room's @everyone SendMessages deny wholesale.
		expect(world.channel.permissionOverwrites.set).toHaveBeenCalledWith(
			buildRoomOverwrites({
				everyoneRoleId: "everyone",
				botId: "bot-1",
				hostId: P2,
				playerIds: next?.playerIds as string[],
				spectatorIds: [WATCHER],
				visibility: "invite",
				phase: "playing",
				adminRoleId: null,
			})
		);

		// The finished row keeps its transcript and lets the channel go.
		expect(fake.row(FINISHED)).toMatchObject({ status: "finished", channelId: null, archiveAt: null, winnerId: P1 });
		expect(fake.row(FINISHED)?.moves).toHaveLength(1);

		// The result card says who pressed, drops the archive notice that is no longer
		// true, and loses its buttons; the old opener is no longer pinned.
		const edit = (interaction.editReply as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
			embeds: Array<{ data: { description?: string } }>;
			components: unknown[];
		};
		expect(edit.components).toEqual([]);
		expect(edit.embeds[0].data.description).toContain(gameRoomsCopy.result.rematchStarted(P2));
		expect(edit.embeds[0].data.description).toContain(gameRoomsCopy.result.winnerLine(P1));
		expect(edit.embeds[0].data.description).not.toContain(gameRoomsCopy.result.archiveNotice());
		expect(world.channel.messages.unpin).toHaveBeenCalledWith("opener-1");
		expect(interaction.followUp).not.toHaveBeenCalled();
	});

	// A row from before the referee field carries only monopolyReferee; the rematch writes the
	// new field, read through refereeOn (2026-10 item 257 Phase 4b), so the referee survives.
	it("carries Monopoly's settings to the rematch row as Dero voice, which is read every move", async () => {
		const world = makeWorld();
		// A row from before Dero voice: only the oldest referee flag says the voice was on.
		insertFinishedRoom({ game: "monopoly", monopolyAuctions: true, monopolyReferee: true });

		await rematchFromRoom(pressRematch(world, P2), await roomOf(FINISHED));

		expect(rematchRow()).toMatchObject({ monopolyAuctions: true, deroVoice: true, status: "playing" });
		// And the rematch starts its referee exactly as a first match does, through seedRoom.
		expect(startRoomReferee).toHaveBeenCalledWith(world.client, expect.objectContaining({ roomId: rematchRow()?.roomId, deroVoice: true }), world.channel);
	});
});

// ⚠️ RISK R1 OF THE 1.7.0 PLAN. Both consumers find rows BY CHANNEL, so a finished row
// still pointing at the channel would delete, or wrongly close, the live match.
describe("after a rematch, the channel belongs to the live match only", () => {
	it("control: without a rematch the same sweep deletes the finished room's channel", async () => {
		const world = makeWorld();
		insertFinishedRoom();
		vi.spyOn(console, "log").mockImplementation(() => undefined);

		await sweepExpiredRooms(world.client, new Date(Date.now() + ARCHIVE_DELAY + 60_000));

		expect(world.channel.delete).toHaveBeenCalledOnce();
	});

	it("the archive sweep run past the old archive clock leaves the channel", async () => {
		const world = makeWorld();
		insertFinishedRoom();
		await rematchFromRoom(pressRematch(world, P2), await roomOf(FINISHED));

		const summary = await sweepExpiredRooms(world.client, new Date(Date.now() + ARCHIVE_DELAY + 60_000));

		expect(summary).toEqual({ archived: 0, failed: 0 });
		expect(world.channel.delete).not.toHaveBeenCalled();
		expect(world.live.has(CHANNEL)).toBe(true);
		expect(rematchRow()?.status).toBe("playing");
	});

	it("ChannelDeleteWatcher on that channel finds the NEW row and closes it, leaving the finished row alone", async () => {
		const world = makeWorld();
		insertFinishedRoom();
		await rematchFromRoom(pressRematch(world, P2), await roomOf(FINISHED));
		const finishedBefore = JSON.stringify(fake.row(FINISHED));
		registerChannelDeleteWatcher(world.client);
		vi.spyOn(console, "log").mockImplementation(() => undefined);

		await world.fireChannelDelete();

		// The new row was the one found: it is closed as abandoned, which frees the
		// presser's host slot. The finished row was not touched.
		expect(rematchRow()).toMatchObject({ status: "finished", winnerId: null });
		expect(rematchRow()?.archiveAt).toBeInstanceOf(Date);
		expect(JSON.stringify(fake.row(FINISHED))).toBe(finishedBefore);
	});
});

describe("refusals write nothing", () => {
	it("refuses a presser who already hosts another open room, with the alreadyHosting copy", async () => {
		const world = makeWorld();
		insertFinishedRoom();
		fake.insert({
			roomId: "room-other",
			guildId: GUILD,
			hostId: P2,
			status: "playing",
			channelId: "other-ch",
			visibility: "public",
			playerIds: [P2],
			spectatorIds: [],
			moves: [],
		});
		const before = fake.snapshot();
		const interaction = pressRematch(world, P2);

		await rematchFromRoom(interaction, await roomOf(FINISHED));

		// An admission refusal is a state, so it is a titled notice now, not an error embed (2026-10 item 263 R3-12).
		const reply = (interaction.reply as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as { content?: string };
		expect(reply.content).toBe(gameRoomsCopy.errors.alreadyHosting("other-ch"));
		expect(fake.snapshot()).toBe(before);
		expect(interaction.deferUpdate).not.toHaveBeenCalled();
		expect(world.channel.permissionOverwrites.set).not.toHaveBeenCalled();
		expect(world.channel.send).not.toHaveBeenCalled();
	});

	it("refuses a second rematch of the same finished room", async () => {
		const world = makeWorld();
		insertFinishedRoom();
		await rematchFromRoom(pressRematch(world, P2), await roomOf(FINISHED));
		const before = fake.snapshot();
		const second = pressRematch(world, P1);

		await rematchFromRoom(second, await roomOf(FINISHED));

		expect(second.reply).toHaveBeenCalledWith(expect.objectContaining({ content: gameRoomsCopy.errors.rematchAlreadyOffered }));
		expect(fake.snapshot()).toBe(before);
	});

	// Two players pressing in the same moment both pass the read check; the release is
	// the claim that lets exactly one take the channel.
	it("lets exactly one of two simultaneous presses take the channel, and archives the loser's row", async () => {
		const world = makeWorld();
		insertFinishedRoom();
		const first = pressRematch(world, P1);
		const second = pressRematch(world, P2);
		const room = await roomOf(FINISHED);

		await Promise.all([rematchFromRoom(first, room), rematchFromRoom(second, { ...room })]);

		const onChannel = fake.rows.filter((row) => row.channelId === CHANNEL);
		expect(onChannel).toHaveLength(1);
		expect(onChannel[0]).toMatchObject({ status: "playing", rematchedFromRoomId: FINISHED });
		const losers = fake.rows.filter((row) => row.rematchedFromRoomId === FINISHED && row.status !== "playing");
		for (const loser of losers) expect(loser).toMatchObject({ status: "archived", channelId: null });
	});

	it("refuses a room that is not finished", async () => {
		const world = makeWorld();
		insertFinishedRoom({ status: "playing", archiveAt: null });
		const before = fake.snapshot();
		const interaction = pressRematch(world, P2);

		await rematchFromRoom(interaction, await roomOf(FINISHED));

		expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: gameRoomsCopy.errors.notFound }));
		expect(fake.snapshot()).toBe(before);
	});
});

// ── the rematch's seats (2026-10 item 276) ───────────────────────────
// A rematch seats the finished match's players again, the presser hosting. A player the host
// removed is already off playerIds, and one who left the server during the match (which went on
// without them) is left out here; a game the seats left outside its range is refused before any
// write, since seeding it stranded the row (audit P1-5).
describe("the rematch's seats", () => {
	const P3 = "p3";
	// Discord's own answer for a member who is not in the server, which is the one failure that
	// proves a player left; the cache in makeWorld knows P1 and P2 only.
	const unknownMember = (): DiscordAPIError => Object.assign(Object.create(DiscordAPIError.prototype) as DiscordAPIError, { code: RESTJSONErrorCodes.UnknownMember });

	it("refuses a Monopoly rematch with one seat left, writing nothing", async () => {
		const world = makeWorld();
		// The host removed P2, which took them off playerIds, and the match ended with P1 alone.
		insertFinishedRoom({ game: "monopoly", playerIds: [P1], spectatorIds: [] });
		const before = fake.snapshot();
		const interaction = pressRematch(world, P1);

		await rematchFromRoom(interaction, await roomOf(FINISHED));

		expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: gameRoomsCopy.errors.rematchSeats(2, 6, 1) }));
		expect(fake.snapshot()).toBe(before);
	});

	it("counts a Dero bot as a seat, so a host and a bot rematch", async () => {
		const world = makeWorld();
		insertFinishedRoom({ game: "monopoly", playerIds: [P1], spectatorIds: [], botSeats: 1 });

		await rematchFromRoom(pressRematch(world, P1), await roomOf(FINISHED));

		expect(rematchRow()).toMatchObject({ status: "playing", playerIds: [P1] });
	});

	it("leaves out a player who left the server during the match", async () => {
		const world = makeWorld();
		(world.guild.members.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (userId: string) => {
			if (userId === P3) throw unknownMember();
			return null;
		});
		insertFinishedRoom({ game: "monopoly", playerIds: [P1, P2, P3], spectatorIds: [] });

		await rematchFromRoom(pressRematch(world, P2), await roomOf(FINISHED));

		expect(rematchRow()).toMatchObject({ status: "playing", hostId: P2 });
		expect(rematchRow()?.playerIds).toEqual([P2, P1]);
	});

	it("refuses a head to head rematch whose opponent left the server", async () => {
		const world = makeWorld();
		(world.guild.members.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(unknownMember());
		insertFinishedRoom({ game: "rps", playerIds: [P1, P3] });
		const before = fake.snapshot();
		const interaction = pressRematch(world, P1);

		await rematchFromRoom(interaction, await roomOf(FINISHED));

		expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: gameRoomsCopy.errors.rematchSeats(2, 2, 1) }));
		expect(fake.snapshot()).toBe(before);
	});

	it("keeps a player whose member fetch failed for any other reason than leaving", async () => {
		const world = makeWorld();
		(world.guild.members.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("gateway timeout"));
		insertFinishedRoom({ game: "rps", playerIds: [P1, P3] });

		await rematchFromRoom(pressRematch(world, P1), await roomOf(FINISHED));

		expect(rematchRow()?.playerIds).toEqual([P1, P3]);
	});
});

// ── a restart mid table (2026-10 item 267, risk R5) ──────────────────
// The table lived in a process that is gone, so the boot sweep finishes its room as abandoned,
// and the one finish pays every stack the row stored after the last settled hand, each claimed
// once: a second boot, or any later finish, pays nothing more.
describe("a Blackjack table lost to a restart", () => {
	it("pays every stored stack back once and closes the room as abandoned", async () => {
		const world = makeWorld();
		insertFinishedRoom({
			game: "blackjack",
			status: "playing",
			archiveAt: null,
			endedAt: null,
			winnerId: null,
			blackjackStacks: [
				{ userId: P1, buyIn: 1000, stack: 1400 },
				{ userId: P2, buyIn: 1000, stack: 0 },
			],
		});

		const summary = await recoverGameRoomsOnBoot(world.client);

		expect(summary.lostTables).toBe(1);
		expect(fake.row(FINISHED)?.status).toBe("finished");
		expect(fake.row(FINISHED)?.blackjackStacks).toEqual([]);
		expect(wallets.get(P1)).toBe(5000 + 1400);
		expect(wallets.get(P2)).toBe(5000);
		const lines = (fake.row(FINISHED)?.moves as { text: string }[]).map((move) => move.text);
		expect(lines).toContain(gameRoomsCopy.trail.tableLostToRestart);
		expect(lines).toContain(gameRoomsCopy.trail.blackjackChipsReturned([{ userId: P1, amount: 1400 }]));

		await recoverGameRoomsOnBoot(world.client);
		expect(wallets.get(P1)).toBe(5000 + 1400);
	});
});

describe("solo rooms rematch in place", () => {
	it("solo blackjack deals the new table into the same channel, with no new channel", async () => {
		const world = makeWorld();
		insertFinishedRoom({ game: "solo-blackjack", visibility: "solo", playerIds: [P1], spectatorIds: [], inviteCode: null });

		await rematchFromRoom(pressRematch(world, P1), await roomOf(FINISHED));

		const next = rematchRow();
		expect(next).toMatchObject({ channelId: CHANNEL, hostId: P1, playerIds: [P1], visibility: "solo", status: "playing" });
		expect(world.guild.channels.create).not.toHaveBeenCalled();
		// A solo table against Dero is never a ranked match (2026-10 item 276, owner decision D1), so
		// it deals on the standard pretend stack, takes nothing and writes no ledger.
		expect(blackjackMock).toHaveBeenCalledWith(world.channel, GUILD, { userId: P1, username: "Player One" }, true, next?.roomId, [], { buyIn: 1000, chips: false }, false, false);
		expect(wallets.get(P1)).toBe(5000);
		expect(next?.blackjackStacks).toEqual([]);
		// A solo room mints no invite, exactly like its first match.
		expect(world.channel.createInvite).not.toHaveBeenCalled();
	});

	// 2026-10 item 267, owner decision 8: a Blackjack rematch takes a fresh buy in, and a presser
	// who cannot pay is refused at the press, before anything is written. Only a ranked table
	// charges since 2026-10 item 276 (decision D1), so a short wallet no longer stops a solo one.
	it("refuses a ranked blackjack rematch whose host cannot cover the buy in again, writing nothing", async () => {
		const world = makeWorld();
		insertFinishedRoom({ game: "blackjack", visibility: "invite", playerIds: [P1, P2], spectatorIds: [], inviteCode: null, holdemBuyIn: 2500 });
		wallets.set(P1, 999);
		const interaction = pressRematch(world, P1);

		await rematchFromRoom(interaction, await roomOf(FINISHED));

		expect(rematchRow()).toBeUndefined();
		expect(blackjackMock).not.toHaveBeenCalled();
		expect(wallets.get(P1)).toBe(999);
		expect(interaction.deferUpdate).not.toHaveBeenCalled();
	});

	it("deals a solo blackjack rematch free for a presser with an empty wallet, since it is never ranked", async () => {
		const world = makeWorld();
		insertFinishedRoom({ game: "solo-blackjack", visibility: "solo", playerIds: [P1], spectatorIds: [], inviteCode: null });
		wallets.set(P1, 0);

		await rematchFromRoom(pressRematch(world, P1), await roomOf(FINISHED));

		expect(rematchRow()?.status).toBe("playing");
		expect(wallets.get(P1)).toBe(0);
	});

	// 2026-10 item 276, owner decision D1: a casual Blackjack table's rematch charges nobody either.
	it("plays a casual blackjack rematch free with chips on, charging nobody", async () => {
		const world = makeWorld();
		insertFinishedRoom({ game: "blackjack", visibility: "invite", playerIds: [P1, P2], spectatorIds: [], inviteCode: null, holdemBuyIn: 2500, casual: true });

		await rematchFromRoom(pressRematch(world, P1), await roomOf(FINISHED));

		expect(wallets.get(P1)).toBe(5000);
		expect(rematchRow()?.blackjackStacks).toEqual([]);
		expect(blackjackMock).toHaveBeenCalledWith(world.channel, GUILD, expect.objectContaining({ userId: P1 }), true, rematchRow()?.roomId, expect.anything(), { buyIn: 2500, chips: false }, false, false);
	});

	it("charges every returning blackjack player the same buy in again, dealing a shared ranked table", async () => {
		const world = makeWorld();
		insertFinishedRoom({ game: "blackjack", visibility: "invite", playerIds: [P1, P2], spectatorIds: [], inviteCode: null, holdemBuyIn: 2500 });

		await rematchFromRoom(pressRematch(world, P1), await roomOf(FINISHED));

		const next = rematchRow();
		expect(next?.holdemBuyIn).toBe(2500);
		expect(wallets.get(P1)).toBe(2500);
		expect(wallets.get(P2)).toBe(2500);
		expect(next?.blackjackStacks).toEqual([
			{ userId: P1, buyIn: 2500, stack: 2500 },
			{ userId: P2, buyIn: 2500, stack: 2500 },
		]);
		expect(blackjackMock).toHaveBeenCalledWith(world.channel, GUILD, expect.objectContaining({ userId: P1 }), true, next?.roomId, [expect.objectContaining({ userId: P2 })], { buyIn: 2500, chips: true }, false, true);
	});

	// 2026-10 item 276, owner decision D13: a ranked table is never solo, so a returning player who
	// cannot pay again leaves a two seat rematch with nobody to share it, and nothing is dealt. The
	// stakes are taken before any row is written now, so the refusal writes no row at all and gives
	// the presser's stake straight back.
	it("gives every buy in back and writes no row when a ranked rematch is left with one seat it could charge", async () => {
		const world = makeWorld();
		insertFinishedRoom({ game: "blackjack", visibility: "invite", playerIds: [P1, P2], spectatorIds: [], inviteCode: null, holdemBuyIn: 2500 });
		wallets.set(P2, 100);
		const interaction = pressRematch(world, P1);

		await rematchFromRoom(interaction, await roomOf(FINISHED));

		expect(blackjackMock).not.toHaveBeenCalled();
		expect(wallets.get(P1)).toBe(5000);
		expect(wallets.get(P2)).toBe(100);
		expect(rematchRow()).toBeUndefined();
		expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: gameRoomsCopy.board.blackjackRankedTooFew(2, 1) }));
	});

	// 2026-10 item 276, found in Phase 6b: a ranked Monopoly or Battleship rematch played for
	// nothing, its Start's pot never charged again. Now each charges its stake as a Blackjack table does.
	it("charges a ranked Monopoly rematch's fixed buy in again and opens its pot with both seats", async () => {
		const world = makeWorld();
		const buyIn = BOT_CONSTANTS.ECONOMY.MONOPOLY_RANKED_BUY_IN;
		insertFinishedRoom({ game: "monopoly", visibility: "invite", playerIds: [P1, P2], spectatorIds: [], inviteCode: null });

		await rematchFromRoom(pressRematch(world, P1), await roomOf(FINISHED));

		expect(wallets.get(P1)).toBe(5000 - buyIn);
		expect(wallets.get(P2)).toBe(5000 - buyIn);
		expect(rematchRow()).toMatchObject({ status: "playing", playerIds: [P1, P2], chipPot: { buyIn, userIds: [P1, P2] } });
	});

	it("refuses a ranked Monopoly rematch left with one paying seat, giving the presser's buy in back", async () => {
		const world = makeWorld();
		insertFinishedRoom({ game: "monopoly", visibility: "invite", playerIds: [P1, P2], spectatorIds: [], inviteCode: null });
		wallets.set(P2, 0);
		const interaction = pressRematch(world, P1);

		await rematchFromRoom(interaction, await roomOf(FINISHED));

		expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: gameRoomsCopy.monopoly.tooFewPaid(2, 1) }));
		expect(wallets.get(P1)).toBe(5000);
		expect(rematchRow()).toBeUndefined();
	});

	it("charges a ranked Battleship rematch's wager to both captains again", async () => {
		const world = makeWorld();
		insertFinishedRoom({ game: "battleship", visibility: "invite", playerIds: [P1, P2], spectatorIds: [], inviteCode: null, holdemBuyIn: 500 });

		await rematchFromRoom(pressRematch(world, P1), await roomOf(FINISHED));

		expect(wallets.get(P1)).toBe(4500);
		expect(wallets.get(P2)).toBe(4500);
		expect(rematchRow()).toMatchObject({ status: "playing", chipPot: { buyIn: 500, userIds: [P1, P2] } });
	});

	it("refuses a ranked Battleship rematch whose other captain cannot cover the wager, charging nobody", async () => {
		const world = makeWorld();
		insertFinishedRoom({ game: "battleship", visibility: "invite", playerIds: [P1, P2], spectatorIds: [], inviteCode: null, holdemBuyIn: 500 });
		wallets.set(P2, 100);
		const interaction = pressRematch(world, P1);

		await rematchFromRoom(interaction, await roomOf(FINISHED));

		expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: gameRoomsCopy.holdem.opponentNotPaid(P2, 500) }));
		expect(wallets.get(P1)).toBe(5000);
		expect(wallets.get(P2)).toBe(100);
		expect(rematchRow()).toBeUndefined();
	});

	it("plays a blackjack rematch free, charging nobody, on a server with chips off", async () => {
		const world = makeWorld();
		configMock.findByGuildId.mockResolvedValue({ guildId: GUILD, adminRoleId: null, gamesCategoryId: "arcade-cat", autoHealEnabled: true, chipEconomyEnabled: false });
		insertFinishedRoom({ game: "solo-blackjack", visibility: "solo", playerIds: [P1], spectatorIds: [], inviteCode: null });

		await rematchFromRoom(pressRematch(world, P1), await roomOf(FINISHED));

		expect(wallets.get(P1)).toBe(5000);
		expect(rematchRow()?.blackjackStacks).toEqual([]);
		expect(blackjackMock).toHaveBeenCalledWith(world.channel, GUILD, expect.objectContaining({ userId: P1 }), true, rematchRow()?.roomId, [], { buyIn: 1000, chips: false }, false, false);
	});

	it("closes the new solo blackjack room when its table cannot start, and tells the presser", async () => {
		const world = makeWorld();
		insertFinishedRoom({ game: "solo-blackjack", visibility: "solo", playerIds: [P1], spectatorIds: [], inviteCode: null });
		blackjackMock.mockResolvedValue("failed");
		const interaction = pressRematch(world, P1);

		await rematchFromRoom(interaction, await roomOf(FINISHED));

		expect(rematchRow()?.status).toBe("finished");
		expect(interaction.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: gameRoomsCopy.errors.createFailed }));
		// The table never started, so the room's finish paid the buy in back off its ledger, once.
		expect(wallets.get(P1)).toBe(5000);
		expect(rematchRow()?.blackjackStacks).toEqual([]);
	});

	// Rock paper scissors against Dero asks its throw in the room (2026-10 item 257 Phase 4b), so
	// its rematch is the next round's prompt in the same channel, through seedRoom like a first room.
	it("solo rock paper scissors asks for the next throw in the same channel, with no new channel", async () => {
		const world = makeWorld();
		insertFinishedRoom({ game: "solo-rps", visibility: "solo", playerIds: [P1], spectatorIds: [], inviteCode: null });

		await rematchFromRoom(pressRematch(world, P1), await roomOf(FINISHED));

		const next = rematchRow();
		expect(next).toMatchObject({ channelId: CHANNEL, hostId: P1, playerIds: [P1], visibility: "solo", status: "playing" });
		expect(world.guild.channels.create).not.toHaveBeenCalled();
		expect(syncTurnPrompt).toHaveBeenCalledWith(world.client, expect.objectContaining({ roomId: next?.roomId }), soloRpsTurnAdapter);
		expect(world.channel.createInvite).not.toHaveBeenCalled();
	});

	// 2026-10 item 267, owner decision 8: every game ends with Rematch, a coin flip and a dice
	// roll included, and their next round plays in the same channel as the rematch seeds. The
	// round is the real one (soloLuck), its dice pinned, so the round posted is the one expected.
	it.each([
		["solo-coinflip", "coinflip"],
		["solo-diceroll", "diceroll"],
	] as const)("%s plays a fresh round in the same channel and finishes its new row", async (game, play) => {
		const world = makeWorld();
		insertFinishedRoom({ game, visibility: "solo", playerIds: [P1], spectatorIds: [], inviteCode: null });
		securePin.value = 0.1;
		const round = resolveSoloLuck({ game: play }, () => 0.1);

		await rematchFromRoom(pressRematch(world, P1), await roomOf(FINISHED));

		const next = rematchRow();
		expect(next).toMatchObject({ game, channelId: CHANNEL, hostId: P1, visibility: "solo", status: "finished", winnerId: round.outcome === "won" ? P1 : null });
		expect(world.guild.channels.create).not.toHaveBeenCalled();
		// The round's own embed, matched on what it says (its timestamp is the send's).
		const { title, description } = buildSoloLuckEmbed(P1, round).data;
		expect(world.channel.send).toHaveBeenCalledWith(expect.objectContaining({ embeds: [expect.objectContaining({ data: expect.objectContaining({ title, description }) })] }));
		// The finished row let the channel go to the new one, the rematch rule of every game.
		expect(await roomOf(FINISHED)).toMatchObject({ channelId: null, archiveAt: null });
		securePin.value = null;
	});

	it("solo hangman seeds a new round from the bank into the same channel, with no new channel", async () => {
		const world = makeWorld();
		insertFinishedRoom({ game: "solo-hangman", visibility: "solo", playerIds: [P1], spectatorIds: [], inviteCode: null });

		await rematchFromRoom(pressRematch(world, P1), await roomOf(FINISHED));

		const next = rematchRow();
		expect(next).toMatchObject({ channelId: CHANNEL, hostId: P1, visibility: "solo", status: "playing" });
		expect(world.guild.channels.create).not.toHaveBeenCalled();
		// The third argument is the shelf a 🕹️games category start picks; a rematch
		// carries none, so its word comes from the whole bank.
		expect(soloHangmanMock).toHaveBeenCalledWith(
			world.client,
			expect.objectContaining({ guildId: GUILD, roomId: next?.roomId, channelId: CHANNEL, hostId: P1 }),
			undefined
		);
	});
});
