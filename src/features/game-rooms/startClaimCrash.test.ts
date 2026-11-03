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

//
// Phase 2 (gap G3) widens the same world to a joiner's charge on the card: the wallet is a fake
// with balances and receipts, and a press can die after any of its writes lands (`crashAfter`) or
// let another path run in that moment (`onStep`), the way a removal or Call it off can.

type Row = Record<string, unknown> & { status: string; buyInPaidBy: string[] };
type StartLedger = { kind: string; buyIn: number; seatIds: readonly string[] };
type Charge = { userId: string; buyIn: number; chargeId: string; released?: boolean };
// The writes a joiner's charge makes, by what each one means: the row holds the charge, the
// wallet pays it, the draft ledger records it. The pre item 278 Phase 2 charge had no hold.
type ChargeStep = "held" | "taken" | "recorded";

const world = vi.hoisted(() => {
	const state = {
		row: null as unknown as Record<string, unknown> & { status: string; buyInPaidBy: string[] },
		dead: false,
		crashAt: "never" as "never" | "claim" | "tableWrite",
		afterClaim: null as null | (() => Promise<void>),
		credits: [] as { userId: string; amount: number }[],
		wallets: {} as Record<string, { balance: number; receipts: string[] }>,
		crashAfter: null as null | ChargeStep,
		onStep: null as null | { step: ChargeStep; run: () => Promise<void> },
		// A charge step's write has landed: the process dies here when asked to, and otherwise the
		// path waiting on this moment runs before the caller sees the result.
		async landed<T>(step: ChargeStep, result: T): Promise<T> {
			if (state.crashAfter === step) {
				state.dead = true;
				return new Promise<never>(() => undefined);
			}
			if (state.onStep?.step === step) {
				const { run } = state.onStep;
				state.onStep = null;
				await run();
			}
			return result;
		},
	};
	return state;
});

vi.mock("@db/stores/gameRoomStore.js", () => {
	const clone = <T>(value: T): T => structuredClone(value);
	const chargesOf = (row: Record<string, unknown>): Charge[] => ((row.buyInCharges as Charge[] | undefined) ??= []);
	const pull =(list: unknown, userId: string): boolean => {
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
		// ── a joiner's charge (gap G3) ──
		// The pre Phase 2 record, kept so this suite reads the old code the same way.
		async addBuyInPaid(_guildId: string, _roomId: string, userId: string, expectedBuyIn: number | null) {
			const row = world.row;
			if (row.status !== "draft" || row.holdemBuyIn !== expectedBuyIn || row.buyInPaidBy.includes(userId)) return null;
			row.buyInPaidBy.push(userId);
			return world.landed("recorded", clone(row));
		},
		async holdBuyInCharge(_guildId: string, _roomId: string, charge: Charge, expectedBuyIn: number | null) {
			const row = world.row;
			const charges = chargesOf(row);
			if (row.status !== "draft" || row.holdemBuyIn !== expectedBuyIn || row.buyInPaidBy.includes(charge.userId) || charges.some((held) => held.userId === charge.userId)) return null;
			charges.push({ ...charge, released: false });
			return world.landed("held", clone(row));
		},
		async recordBuyInCharge(_guildId: string, _roomId: string, charge: Charge, expectedBuyIn: number | null) {
			const row = world.row;
			const charges = chargesOf(row);
			const held = charges.find((entry) => entry.chargeId === charge.chargeId && !entry.released);
			if (row.status !== "draft" || row.holdemBuyIn !== expectedBuyIn || row.buyInPaidBy.includes(charge.userId) || !held) return null;
			charges.splice(charges.indexOf(held), 1);
			row.buyInPaidBy.push(charge.userId);
			return world.landed("recorded", clone(row));
		},
		async dropBuyInCharge(_guildId: string, _roomId: string, chargeId: string) {
			const charges = chargesOf(world.row);
			const held = charges.find((entry) => entry.chargeId === chargeId);
			if (held) charges.splice(charges.indexOf(held), 1);
		},
		async releaseBuyInCharges(_guildId: string, _roomId: string, userIds: readonly string[] | null) {
			const matching = chargesOf(world.row).filter((entry) => !userIds || userIds.includes(entry.userId));
			if (matching.length === 0) return null;
			for (const entry of matching) entry.released = true;
			return clone(world.row);
		},
		async archiveDraft() {
			if (world.row.status !== "draft") return null;
			world.row.status = "archived";
			return clone(world.row);
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
// Every wallet starts at STARTING_BALANCE (declared below, since this factory is hoisted); a receipt is open from its debit until it is refunded or closed.
vi.mock("@db/stores/chipWalletStore.js", () => {
	const walletOf = (userId: string) => (world.wallets[userId] ??= { balance: 10_000, receipts: [] });
	const die = () => new Promise<never>(() => undefined);
	const credited = (userId: string, amount: number) => {
		walletOf(userId).balance += amount;
		world.credits.push({ userId, amount });
		return { balance: walletOf(userId).balance };
	};
	return {
		chipWalletStore: {
			async credit(key: { userId: string }, amount: number) {
				if (world.dead) return die();
				return credited(key.userId, amount);
			},
			async debit(key: { userId: string }, amount: number) {
				if (world.dead) return die();
				const wallet = walletOf(key.userId);
				if (wallet.balance < amount) return null;
				wallet.balance -= amount;
				return world.landed("taken", { balance: wallet.balance });
			},
			async debitWithReceipt(key: { userId: string }, amount: number, receiptId: string) {
				if (world.dead) return die();
				const wallet = walletOf(key.userId);
				if (wallet.balance < amount || wallet.receipts.includes(receiptId)) return null;
				wallet.balance -= amount;
				wallet.receipts.push(receiptId);
				return world.landed("taken", { balance: wallet.balance });
			},
			async refundReceipt(key: { userId: string }, amount: number, receiptId: string) {
				if (world.dead) return die();
				const wallet = walletOf(key.userId);
				if (!wallet.receipts.includes(receiptId)) return null;
				wallet.receipts.splice(wallet.receipts.indexOf(receiptId), 1);
				return credited(key.userId, amount);
			},
			async closeReceipt(key: { userId: string }, receiptId: string) {
				if (world.dead) return die();
				const wallet = walletOf(key.userId);
				if (wallet.receipts.includes(receiptId)) wallet.receipts.splice(wallet.receipts.indexOf(receiptId), 1);
			},
		},
	};
});
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
import { chargeJoiner, refundAllJoiners, refundJoiners } from "./holdemDraftBuyIn.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
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
		// Monopoly's buy in is fixed; a Hold'em buy in and a Battleship wager are the host's.
		holdemBuyIn: match.game === "monopoly" ? null : match.buyIn,
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
	world.wallets = {};
	world.crashAfter = null;
	world.onStep = null;
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

// ── a joiner's charge on the card (2026-10 item 278 Phase 2, gap G3) ─────────────────────────
// Join, or an invited member's Accept and buy in, used to take the chips and record the payer in
// a second write, so a crash between the two left a buy in on no ledger. Each case lets the press
// die after one of its writes lands, brings the process back, and runs one path that ends or
// settles the draft; the joiner's wallet must end exactly where it started, or one buy in down
// while they still hold a paid seat. The draft row carries no buyInCharges field at all, the way a
// row written before this phase reads (owner decision D2).

const STARTING_BALANCE = 10_000;
const JOINER = "joiner";
const CHARGE_STEPS: ChargeStep[] = ["held", "taken", "recorded"];
const PRESS_CASES = MATCHES.flatMap((match) => CHARGE_STEPS.map((step) => ({ ...match, step })));

const balanceOf = (userId: string): number => world.wallets[userId]?.balance ?? STARTING_BALANCE;
const asRoom = (): IGameRoom => structuredClone(world.row) as unknown as IGameRoom;

// A draft before Start that nobody has paid into yet, so every chip moved is the press's own.
const cardDraft = (match: Match): Row => ({ ...draftRow(match), buyInPaidBy: [] });

type BuyInModule = typeof import("./holdemDraftBuyIn.js");

// The press runs until `step` lands and the process dies there, then the process comes back.
// A step this code never writes lets the press finish, which is the old charge read the same way.
// The dying press runs in a module graph of its own, the process that dies: whatever it held in
// memory dies with it, and the suite's own modules play the process that comes back.
async function pressDiesAfter(step: ChargeStep, press: (doomed: BuyInModule) => Promise<unknown>): Promise<void> {
	vi.resetModules();
	const doomed = await import("./holdemDraftBuyIn.js");
	world.crashAfter = step;
	void press(doomed).catch(() => undefined);
	await flush();
	world.dead = false;
	world.crashAfter = null;
}

// Call it off's own two steps (challengeBoard.cancelDraft): close the draft, then refund from the
// row the close returned.
async function callItOff(refund: (room: IGameRoom) => Promise<void> = refundAllJoiners): Promise<void> {
	const closed = await gameRoomStore.archiveDraft("g1", "room-1");
	if (closed) await refund(closed);
}

describe("a joiner's press that dies part way", () => {
	it.each(PRESS_CASES)("gives a $game joiner's buy in back once when the idle sweep ends the draft (dies after $step)", async ({ step, ...match }) => {
		world.row = cardDraft(match);
		await pressDiesAfter(step, (doomed) => doomed.chargeJoiner(asRoom(), JOINER));

		await finish(client, asRoom(), { abandoned: true });

		expect(balanceOf(JOINER)).toBe(STARTING_BALANCE);
	});

	it.each(PRESS_CASES)("gives a $game joiner's buy in back once when the host calls it off (dies after $step)", async ({ step, ...match }) => {
		world.row = cardDraft(match);
		await pressDiesAfter(step, (doomed) => doomed.chargeJoiner(asRoom(), JOINER));

		await callItOff();

		expect(balanceOf(JOINER)).toBe(STARTING_BALANCE);
	});

	it.each(PRESS_CASES)("charges a $game joiner once when they press again after the restart (dies after $step)", async ({ step, ...match }) => {
		world.row = cardDraft(match);
		await pressDiesAfter(step, (doomed) => doomed.chargeJoiner(asRoom(), JOINER));

		await chargeJoiner(asRoom(), JOINER);

		expect(balanceOf(JOINER)).toBe(STARTING_BALANCE - match.buyIn);
		expect(world.row.buyInPaidBy).toEqual([JOINER]);
		await callItOff();
		expect(balanceOf(JOINER)).toBe(STARTING_BALANCE);
	});

	it.each(PRESS_CASES)("gives a $game joiner's buy in back once when the host starts without them (dies after $step)", async ({ step, ...match }) => {
		// The seats already paid; the joiner presses after Start read the card.
		world.row = { ...cardDraft(match), buyInPaidBy: match.ledger.filter((userId) => userId !== "late") };
		await pressDiesAfter(step, (doomed) => doomed.chargeJoiner(asRoom(), JOINER));

		await open(match).catch(() => undefined);
		expect(balanceOf(JOINER)).toBe(STARTING_BALANCE);

		await finish(client, asRoom(), { abandoned: true });
		expect(balanceOf(JOINER)).toBe(STARTING_BALANCE);
	});
});

describe("a joiner's press racing another path", () => {
	const holdem = MATCHES[2];

	it("charges a double press once", async () => {
		world.row = cardDraft(holdem);

		const answers = await Promise.all([chargeJoiner(asRoom(), JOINER), chargeJoiner(asRoom(), JOINER)]);

		expect(answers.filter((answer) => answer === null)).toHaveLength(1);
		expect(balanceOf(JOINER)).toBe(STARTING_BALANCE - holdem.buyIn);
		expect(world.row.buyInPaidBy).toEqual([JOINER]);
		await callItOff();
		expect(balanceOf(JOINER)).toBe(STARTING_BALANCE);
	});

	it.each(CHARGE_STEPS)("leaves nothing charged when Call it off lands after the press's %s write", async (step) => {
		world.row = cardDraft(holdem);
		world.onStep = { step, run: () => callItOff() };

		const answer = await chargeJoiner(asRoom(), JOINER);
		const cancelledMidPress = world.onStep === null;
		// A step this code never writes: Call it off follows the press instead.
		if (world.onStep) await world.onStep.run();

		expect(balanceOf(JOINER)).toBe(STARTING_BALANCE);
		// A press the cancel beat to its record is told so, rather than told it paid.
		if (cancelledMidPress && step !== "recorded") expect(answer).not.toBeNull();
	});

	it.each(CHARGE_STEPS)("leaves nothing charged when the host removes the joiner after the press's %s write", async (step) => {
		world.row = cardDraft(holdem);
		world.onStep = { step, run: () => refundJoiners(asRoom(), [JOINER]) };

		await chargeJoiner(asRoom(), JOINER);
		if (world.onStep) await world.onStep.run();

		expect(balanceOf(JOINER)).toBe(STARTING_BALANCE);
		expect(world.row.buyInPaidBy).not.toContain(JOINER);
	});

	it("gives the buy in back once when a removal lands mid press and the press then dies", async () => {
		world.row = cardDraft(holdem);
		// The removal refunds before the chips are taken, so only the held charge, still on the row,
		// can tell the finish that a buy in left the wallet afterwards.
		world.onStep = { step: "held", run: () => refundJoiners(asRoom(), [JOINER]) };
		await pressDiesAfter("taken", (doomed) => doomed.chargeJoiner(asRoom(), JOINER));

		await finish(client, asRoom(), { abandoned: true });

		expect(balanceOf(JOINER)).toBe(STARTING_BALANCE);
	});
});

describe("the host's seat charged at Start", () => {
	it.each(PRESS_CASES)("gives the $game host's buy in back once when Start dies part way (after $step)", async ({ step, ...match }) => {
		world.row = cardDraft(match);
		await pressDiesAfter(step, (doomed) => doomed.settleDraftBuyIns(asRoom(), []));

		await finish(client, asRoom(), { abandoned: true });

		expect(balanceOf("host")).toBe(STARTING_BALANCE);
	});
});
