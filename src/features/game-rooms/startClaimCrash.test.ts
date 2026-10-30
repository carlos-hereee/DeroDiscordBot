import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client, Guild, TextChannel } from "discord.js";

// ── a crash between the start claim and a game's first write (2026-10 item 278 Phase 1) ──────
// The start claim empties the draft's buy in ledger as the room goes to playing. A ranked Monopoly
// or Battleship match used to write its pot, and a Hold'em chip table its table, seconds later,
// after Discord calls; a crash in between left every buy in on no ledger, so the finish that boot
// recovery or the idle sweep runs paid nobody (gaps G1 and G2). What is pinned here, against the
// REAL seedRoom and the REAL finish over a row kept in memory: a process that dies at any step
// after the claim leaves the buy ins where finish gives every wallet back exactly what it paid,
// and a finish that lands while the room is still being built pays each buy in once.
//
// The fake store mirrors gameRoomStore's conditional writes (each filter is the claim it makes);
// the claim's update pipeline itself is the store's own and is exercised against a real MongoDB
// outside this suite. A crash is a process that stops: every store and wallet call after it never
// settles. The restart is recoverGameRoomsOnBoot over the row as it was left, its channel gone.

type Row = Record<string, unknown> & { status: string; buyInPaidBy: string[] };
type StartLedger = { kind: string; buyIn: number; seatIds: readonly string[] };

const world = vi.hoisted(() => ({
	row: null as unknown as Record<string, unknown> & { status: string; buyInPaidBy: string[] },
	dead: false,
	crashAt: "never" as "never" | "claim" | "tableWrite",
	afterClaim: null as null | (() => Promise<void>),
	credits: [] as { userId: string; amount: number }[],
}));

vi.mock("@db/stores/gameRoomStore.js", () => {
	const clone = <T>(value: T): T => structuredClone(value);
	const pull = (list: unknown, userId: string): boolean => {
		const userIds = (list as { userIds?: string[] } | null)?.userIds;
		if (!userIds?.includes(userId)) return false;
		userIds.splice(userIds.indexOf(userId), 1);
		return true;
	};
	const store: Record<string, (...args: never[]) => unknown> = {
		async claimForPlay(_guildId: string, _roomId: string, patch: Record<string, unknown>, ledger?: StartLedger) {
			if (world.row.status !== "draft") return null;
			const before = clone(world.row);
			Object.assign(world.row, patch, { status: "playing" });
			if (ledger && ledger.kind !== "blackjackStacks") {
				// The pipeline's order: the seats Start read that are still paid, then any other payer.
				const paid = world.row.buyInPaidBy;
				const userIds = [...ledger.seatIds.filter((userId) => paid.includes(userId)), ...paid.filter((userId) => !ledger.seatIds.includes(userId))];
				world.row[ledger.kind] = { buyIn: ledger.buyIn, userIds };
			}
			world.row.buyInPaidBy = [];
			if (world.crashAt === "claim") world.dead = true;
			if (world.afterClaim) await world.afterClaim();
			return before;
		},
		async findByRoomId() {
			return clone(world.row);
		},
		async update(_guildId: string, _roomId: string, patch: Record<string, unknown>) {
			if ("secret" in patch && world.crashAt === "tableWrite") return crash();
			Object.assign(world.row, patch);
			return clone(world.row);
		},
		// The pre item 278 pot write, kept so this suite reads the old code the same way.
		async openChipPot(_guildId: string, _roomId: string, pot: unknown) {
			if (world.row.status !== "playing") return null;
			world.row.chipPot = clone(pot);
			return clone(world.row);
		},
		async saveOpeningHoldemTable(_guildId: string, _roomId: string, secret: unknown, seatedPayers: readonly string[]) {
			if (world.crashAt === "tableWrite") return crash();
			const held = (world.row.heldBuyIns as { userIds: string[] } | null)?.userIds ?? [];
			if (world.row.status !== "playing" || !seatedPayers.every((userId) => held.includes(userId))) return null;
			for (const userId of seatedPayers) held.splice(held.indexOf(userId), 1);
			world.row.secret = clone(secret);
			return clone(world.row);
		},
		async takePotPayer(_guildId: string, _roomId: string, userId: string) {
			if (world.row.status !== "playing") return null;
			const before = clone(world.row);
			return pull(world.row.chipPot, userId) ? before : null;
		},
		async takeHeldBuyIn(_guildId: string, _roomId: string, userId: string) {
			const before = clone(world.row);
			return pull(world.row.heldBuyIns, userId) ? before : null;
		},
		async takeBuyInPaid(_guildId: string, _roomId: string, userId: string) {
			if (!world.row.buyInPaidBy.includes(userId)) return null;
			const before = clone(world.row);
			world.row.buyInPaidBy = world.row.buyInPaidBy.filter((id) => id !== userId);
			return before;
		},
		async finish(_guildId: string, _roomId: string, outcome: Record<string, unknown>) {
			if (!["draft", "playing"].includes(world.row.status)) return null;
			Object.assign(world.row, outcome, { status: "finished" });
			return clone(world.row);
		},
		async findNonTerminal() {
			return ["draft", "playing"].includes(world.row.status) ? [clone(world.row)] : [];
		},
		async findExpiredArchives() {
			return [];
		},
	};
	// A dead process answers nothing, ever; every other store method a path reaches is a no op.
	const die = () => new Promise<never>(() => undefined);
	const crash = () => {
		world.dead = true;
		return die();
	};
	const gameRoomStore = new Proxy(store, {
		get: (target, name: string) => {
			if (world.dead) return die;
			return target[name] ?? (async () => null);
		},
	});
	return { gameRoomStore };
});
vi.mock("@db/stores/chipWalletStore.js", () => ({
	chipWalletStore: {
		credit: vi.fn((key: { userId: string }, amount: number) => {
			if (world.dead) return new Promise(() => undefined);
			world.credits.push({ userId: key.userId, amount });
			return Promise.resolve({ balance: amount });
		}),
		debit: vi.fn(),
	},
}));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn(async () => ({ chipEconomyEnabled: true })) } }));
vi.mock("@db/stores/botLogStore.js", () => ({ botLogStore: { log: vi.fn(async () => undefined) } }));
vi.mock("@features/leveling/awardXp.js", () => ({ awardXp: vi.fn() }));
vi.mock("@features/games/monopolyRenderer.js", () => ({ renderBoard: vi.fn(async () => null) }));
// The opening deal is roomHoldemHandlers' own; here only whether the open reaches it.
vi.mock("./roomHoldemHandlers.js", async (importOriginal) => ({ ...(await importOriginal<object>()), dealOpeningHand: vi.fn(async () => undefined) }));

import { seedRoom } from "./RoomProvisioner.js";
import { finish } from "./roomLifecycle.js";
import { recoverGameRoomsOnBoot } from "./roomBootRecovery.js";
import { dealOpeningHand } from "./roomHoldemHandlers.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── the world ─────────────────────────────────────────────────────────
const client = {
	user: { id: "bot-1" },
	channels: { fetch: vi.fn(async () => null) },
	guilds: { fetch: vi.fn(async () => null), cache: new Map() },
} as unknown as Client;

function makeChannel(): TextChannel {
	let sent = 0;
	return {
		id: "room-ch",
		send: vi.fn(async () => ({ id: `message-${++sent}`, pin: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) })),
		permissionOverwrites: { delete: vi.fn(async () => undefined) },
		createInvite: vi.fn(),
	} as unknown as TextChannel;
}

const guild = { id: "g1", client, members: { cache: new Map(), fetch: vi.fn(async () => undefined) }, roles: { everyone: { id: "everyone" } } } as unknown as Guild;

interface Match {
	game: "monopoly" | "battleship" | "holdem";
	buyIn: number;
	// The seats the card's Start answered, host first.
	seats: string[];
	// The draft ledger as the claim finds it: the joiners in the order they paid, then the host,
	// whose seat Start put on it last. "late" paid after Start read the card, so no seat names them.
	ledger: string[];
	// Who the row lists as players at the claim.
	players: string[];
}

const MATCHES: Match[] = [
	{ game: "monopoly", buyIn: 1_500, seats: ["host", "a", "b"], ledger: ["a", "b", "late", "host"], players: ["host", "a", "b"] },
	{ game: "battleship", buyIn: 250, seats: ["host", "a"], ledger: ["a", "late", "host"], players: ["host", "a"] },
	{ game: "holdem", buyIn: 2_500, seats: ["host", "a", "b"], ledger: ["a", "b", "late", "host"], players: ["host", "a", "b"] },
];

function draftRow(match: Match): Row {
	return {
		guildId: "g1",
		roomId: "room-1",
		game: match.game,
		hostId: "host",
		status: "draft",
		casual: false,
		network: false,
		botSeats: 0,
		deroVoice: false,
		visibility: "invite",
		channelId: null,
		playerIds: [...match.players],
		spectatorIds: [],
		holdemBuyIn: match.game === "holdem" ? match.buyIn : null,
		buyInPaidBy: [...match.ledger],
		chipPot: null,
		heldBuyIns: null,
		secret: null,
		moves: [],
	};
}

function open(match: Match): Promise<unknown> {
	return seedRoom({
		guild,
		channel: makeChannel(),
		room: structuredClone(world.row) as unknown as IGameRoom,
		game: match.game,
		hostId: "host",
		playerIds: [...match.players],
		visibility: "invite",
		draftSeats: { buyIn: match.buyIn, userIds: [...match.seats], charged: true },
	});
}

// The process comes back: nothing it was doing resumes, and boot recovery finds the room's
// channel gone (the bot never finished building it) and finishes the row as abandoned.
async function restart(): Promise<void> {
	world.dead = false;
	world.crashAt = "never";
	await recoverGameRoomsOnBoot(client);
}

// Every chip each payer got back. Each paid the buy in once, so whole is exactly that, once.
const refundsOf = (userId: string): number[] => world.credits.filter((credit) => credit.userId === userId).map((credit) => credit.amount);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	vi.clearAllMocks();
	world.dead = false;
	world.crashAt = "never";
	world.afterClaim = null;
	world.credits = [];
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("a crash right after the start claim", () => {
	it.each(MATCHES)("gives every $game buy in back once when the room is recovered", async (match) => {
		world.row = draftRow(match);
		world.crashAt = "claim";

		void open(match);
		await flush();
		expect(world.row.status).toBe("playing");
		await restart();

		expect(world.row.status).toBe("finished");
		for (const userId of match.ledger) expect(refundsOf(userId), userId).toEqual([match.buyIn]);
	});
});

describe("a crash as the game writes its opening state", () => {
	it.each(MATCHES)("gives every $game buy in back once, the late payer's included", async (match) => {
		world.row = draftRow(match);
		world.crashAt = "tableWrite";

		void open(match).catch(() => undefined);
		await vi.waitFor(() => expect(world.dead).toBe(true));
		await restart();

		for (const userId of match.ledger) expect(refundsOf(userId), userId).toEqual([match.buyIn]);
	});
});

describe("a finish that lands while the room is still being built", () => {
	it.each(MATCHES)("pays each $game buy in once, and never deals a Hold'em hand on the finished row", async (match) => {
		world.row = draftRow(match);
		// The idle sweep or a deleted channel finishes the row the moment the claim lands.
		world.afterClaim = async () => {
			world.afterClaim = null;
			await finish(client, structuredClone(world.row) as unknown as IGameRoom, { abandoned: true });
		};

		await open(match).catch(() => undefined);

		for (const userId of match.ledger) expect(refundsOf(userId), userId).toEqual([match.buyIn]);
		if (match.game === "holdem") expect(dealOpeningHand).not.toHaveBeenCalled();
	});
});

describe("an open nothing interrupts", () => {
	it.each(MATCHES)("refunds only the $game payer the room did not seat and leaves the rest staked", async (match) => {
		world.row = draftRow(match);

		await open(match).catch(() => undefined);

		expect(refundsOf("late")).toEqual([match.buyIn]);
		for (const userId of match.seats) expect(refundsOf(userId), userId).toEqual([]);
		// The match's own ledger now holds every seat, so its finish pays them.
		const staked = match.game === "holdem" ? (world.row.secret as { seats: { userId: string; stack: number }[] }).seats.map((seat) => [seat.userId, seat.stack]) : (world.row.chipPot as { userIds: string[] }).userIds.map((userId) => [userId, match.buyIn]);
		expect(staked).toEqual(match.seats.map((userId) => [userId, match.buyIn]));
		if (match.game === "holdem") expect(world.row.heldBuyIns ?? { userIds: [] }).toMatchObject({ userIds: [] });
	});
});
