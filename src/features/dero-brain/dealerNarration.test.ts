import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { describe, it, expect, vi, beforeEach } from "vitest";
// Dero's variant lines always pick the first, so these tests read exact words.
vi.mock("@utils/pickLine.js", () => ({ pickLine: <Line>(lines: readonly Line[]): Line => lines[0] as Line }));
import type { Client } from "discord.js";
import type { IDeroVoiceConfig } from "@db/models/DeroVoiceConfig.js";
import { createTable, joinTable, dealHand, act, actionsFor, whoActs, handInProgress, type HoldemTable } from "@features/games/holdemTable.js";
import { formatCard, freshDeck, type Card } from "@features/games/holdemHand.js";
import type { VoiceSessionView } from "@features/voice/voiceSessions.js";
import {
	announceDealer,
	dealerTableOf,
	narrate,
	pickSpokenLines,
	pickTextLines,
	registerDealerTable,
	toPublicView,
	toPublicResult,
	_clearDealerTables,
	type DealerDeps,
	type DealerLine,
	type PublicView,
} from "./dealerNarration.js";
import { deroBrainCopy } from "./deroBrainCopy.js";

// ── dealerNarration ───────────────────────────────────────────────────────
// The narrator against the real engine: a scripted six player hand played to a
// showdown, every table change turned into lines, and every line checked to name
// only board cards and public numbers. Then the per hand caps, and delivery
// against fakes (text with no pings, speech at dealer priority, a table Dero
// does not deal costing nothing).

const OWNER_TERMS = { maxSeats: 6, startingStack: 5000, smallBlind: 100, bigBlind: 200 };

function seededRng(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state * 1664525 + 1013904223) % 4294967296;
		return state / 4294967296;
	};
}

function sixPlayerTable(): HoldemTable {
	const table = createTable(5, OWNER_TERMS);
	for (let index = 0; index < 6; index++) joinTable(table, `p${index}`, `Player ${index}`);
	table.status = "playing";
	return table;
}

interface PlayedHand {
	table: HoldemTable;
	lines: { line: DealerLine; board: Card[] }[];
}

// Deal and play one hand, everybody checking or calling to the end, narrating
// every change exactly as the room handlers do: a view before, a view after.
function playCallingHand(seed: number): PlayedHand {
	const table = sixPlayerTable();
	const rng = seededRng(seed);
	const lines: PlayedHand["lines"] = [];
	let lastTurn: string | null = null;
	const record = (before: PublicView, after: PublicView, result: ReturnType<typeof toPublicResult>) => {
		for (const line of narrate(before, after, result, { lastTurnUserId: lastTurn })) {
			lines.push({ line, board: after.board });
			if (line.kind === "toAct") lastTurn = after.actingUserId;
		}
	};

	const beforeDeal = toPublicView(table);
	dealHand(table, rng);
	record(beforeDeal, toPublicView(table), null);

	let guard = 0;
	while (handInProgress(table) && guard++ < 100) {
		const actor = whoActs(table)!;
		const legal = actionsFor(table, actor).map((entry) => entry.action);
		const before = toPublicView(table);
		const outcome = act(table, actor, legal.includes("check") ? "check" : "call", 0, rng);
		record(before, toPublicView(table), toPublicResult(outcome));
	}
	return { table, lines };
}

const allText = (lines: DealerLine[]) => lines.flatMap((line) => [line.text, line.spoken]).join("\n");

const spokenName = (card: Card) => deroBrainCopy.dealer.spokenCard(card.rank, card.suit);

const sameCard = (a: Card, b: Card) => a.rank === b.rank && a.suit === b.suit;

describe("toPublicView", () => {
	it("copies only public fields", () => {
		const table = sixPlayerTable();
		dealHand(table, seededRng(7));
		const view = toPublicView(table);
		expect(Object.keys(view).sort()).toEqual(
			["actingUserId", "bigBlind", "board", "buttonUserId", "handNumber", "seats", "smallBlind", "status", "street", "winnerId"].sort(),
		);
		expect(Object.keys(view.seats[0]).sort()).toEqual(["allIn", "folded", "lastAction", "name", "out", "sittingOut", "stack", "userId"].sort());
		expect(view).toMatchObject({ handNumber: 1, smallBlind: 100, bigBlind: 200, board: [] });
	});

	it("names nobody to act between hands, even after a fold out left the round open", () => {
		const table = sixPlayerTable();
		dealHand(table, seededRng(7));
		while (handInProgress(table)) act(table, whoActs(table)!, "fold");
		expect(toPublicView(table).actingUserId).toBeNull();
	});
});

describe("narrate on a scripted six player hand", () => {
	const hand = playCallingHand(11);
	const lines = hand.lines.map((entry) => entry.line);

	it("tells the deal, every street, the result and whose turn it is, in order", () => {
		const kinds = lines.map((line) => line.kind).filter((kind) => kind !== "toAct" && kind !== "action");
		expect(kinds).toEqual(["handStart", "flop", "turn", "river", "result"]);
		expect(lines.some((line) => line.kind === "toAct")).toBe(true);
		// Every call and check of the scripted hand is called aloud, like a commentator.
		expect(lines.some((line) => line.kind === "action")).toBe(true);
		expect(lines[0].text).toMatch(/^Hand 1\. Blinds are 100 and 200\. <@p\d> has the button\.$/);
		expect(lines[0].spoken).toMatch(/^Hand 1\. Blinds are 100 and 200\. Player \d has the button\.$/);
	});

	it("names only cards that are on the board", () => {
		for (const { line, board } of hand.lines) {
			for (const card of line.cards) expect(board.some((shown) => sameCard(shown, card))).toBe(true);
		}
		const offBoard = freshDeck().filter((card) => !hand.table.board.some((shown) => sameCard(shown, card)));
		const said = allText(lines);
		for (const card of offBoard) {
			expect(said).not.toContain(formatCard(card));
			expect(said).not.toContain(spokenName(card));
		}
	});

	it("reads the board aloud as card names, and says who won with the category the engine named", () => {
		const flop = lines.find((line) => line.kind === "flop")!;
		expect(flop.spoken).toMatch(/^The flop: the \w+ of \w+, the \w+ of \w+ and the \w+ of \w+\.$/);
		const result = lines.find((line) => line.kind === "result")!;
		expect(result.spoken).toMatch(/Player \d wins \d+ with /);
		expect(result.text).toMatch(/<@p\d> wins \d+ with /);
	});

	it("never repeats a turn prompt for the same player twice in a row", () => {
		const prompts = lines.filter((line) => line.kind === "toAct").map((line) => line.text);
		for (let index = 1; index < prompts.length; index++) expect(prompts[index]).not.toBe(prompts[index - 1]);
	});

	it("says amounts that match the public stacks: everyone called 200, so a winner shows 4800 plus the win", () => {
		const result = lines.find((entry) => entry.kind === "result")!;
		const wins = [...result.text.matchAll(/<@(p\d)> wins (\d+)/g)].map((match) => ({ userId: match[1], amount: Number(match[2]) }));
		expect(wins.reduce((sum, win) => sum + win.amount, 0)).toBe(6 * 200);
		for (const win of wins) expect(hand.table.seats.find((seat) => seat.userId === win.userId)?.stack).toBe(4800 + win.amount);
	});
});

describe("narrate, the edges", () => {
	it("calls out raised blinds at the start of a hand", () => {
		const before = { ...toPublicView(sixPlayerTable()), handNumber: 6, bigBlind: 200, smallBlind: 100 };
		const after: PublicView = { ...before, handNumber: 7, smallBlind: 200, bigBlind: 400, buttonUserId: "p2" };
		expect(narrate(before, after, null)[0].text).toBe("Hand 7. The blinds are up to 200 and 400. <@p2> has the button.");
	});

	it("tells every street an all in run out turns at once", () => {
		const board: Card[] = [
			{ rank: 2, suit: "c" },
			{ rank: 9, suit: "h" },
			{ rank: 14, suit: "s" },
			{ rank: 5, suit: "d" },
			{ rank: 11, suit: "c" },
		];
		const before: PublicView = { ...toPublicView(sixPlayerTable()), handNumber: 1, board: board.slice(0, 3), street: "flop" };
		const after: PublicView = { ...before, board, street: "showdown" };
		const kinds = narrate(before, after, null).map((line) => line.kind);
		expect(kinds).toEqual(["turn", "river"]);
	});

	it("adds the tournament winner to the last result", () => {
		const before = toPublicView(sixPlayerTable());
		const after: PublicView = { ...before, status: "finished", winnerId: "p3" };
		const [line] = narrate(before, after, { winners: [{ userId: "p3", amount: 900, category: null }], tournamentOver: true });
		expect(line.text).toBe("<@p3> wins 900. <@p3> wins the tournament.");
		expect(line.spoken).toBe("Player 3 wins 900. Player 3 wins the tournament.");
	});

	it("skips a turn prompt for the player the last prompt named", () => {
		const view: PublicView = { ...toPublicView(sixPlayerTable()), actingUserId: "p1" };
		expect(narrate(view, view, null, { lastTurnUserId: "p1" })).toEqual([]);
		expect(narrate(view, view, null, { lastTurnUserId: "p0" }).map((line) => line.kind)).toEqual(["toAct"]);
	});

	it("carries a hand category only when the engine's outcome named one", () => {
		expect(toPublicResult({ ok: true })).toBeNull();
		expect(
			toPublicResult({ ok: true, handOver: true, awards: [{ userId: "a", amount: 40 }, { userId: "b", amount: 0 }], showdown: [{ userId: "a", hand: "flush" }] }),
		).toEqual({ winners: [{ userId: "a", amount: 40, category: "flush" }], tournamentOver: false });
		expect(toPublicResult({ ok: true, handOver: true, awards: [{ userId: "a", amount: 40 }] })?.winners[0].category).toBeNull();
	});
});

const line = (kind: DealerLine["kind"]): DealerLine => ({ kind, text: kind, spoken: kind, cards: [] });

describe("the per hand caps", () => {
	it("posts only the hand start and the result in text, two per hand at most", () => {
		const lines = [line("handStart"), line("flop"), line("toAct"), line("result")];
		expect(pickTextLines(lines, 0).map((entry) => entry.kind)).toEqual(["handStart", "result"]);
		expect(pickTextLines(lines, 1).map((entry) => entry.kind)).toEqual(["handStart"]);
		expect(pickTextLines(lines, 2)).toEqual([]);
	});

	it("speaks at most the cap a hand, dropping action calls and turn prompts first so the streets and result still fit", () => {
		const cap = BOT_CONSTANTS.DERO_DEALER_SPOKEN_LINES_PER_HAND;
		const preflop: PublicView = { ...toPublicView(sixPlayerTable()), status: "playing", street: "preflop", board: [] };
		// Four streets and the result are still to come preflop, so a low value line that would
		// crowd them out (spoken + 1 + 4 > cap) is dropped.
		for (const kind of ["toAct", "action"] as const) {
			expect(pickSpokenLines([line(kind)], cap - 5, preflop).map((entry) => entry.kind)).toEqual([kind]);
			expect(pickSpokenLines([line(kind)], cap - 4, preflop)).toEqual([]);
		}
		// A high value line still goes out until the cap itself.
		expect(pickSpokenLines([line("flop")], cap - 1, preflop).map((entry) => entry.kind)).toEqual(["flop"]);
		expect(pickSpokenLines([line("flop")], cap, preflop)).toEqual([]);
	});

	it("never speaks more than the cap over a whole scripted hand", () => {
		const hand = playCallingHand(23);
		let spoken = 0;
		for (const { line: entry, board } of hand.lines) {
			const view = { ...toPublicView(hand.table), board, street: board.length === 5 ? ("river" as const) : ("flop" as const) };
			spoken += pickSpokenLines([entry], spoken, view).length;
		}
		expect(spoken).toBeLessThanOrEqual(BOT_CONSTANTS.DERO_DEALER_SPOKEN_LINES_PER_HAND);
	});
});

// ── delivery ──

function fakeDeps(withCall = true) {
	const speak = vi.fn(() => "queued" as const);
	const call = { guildId: "g1", channelId: "vc1", controlChannelId: "t1", status: "ready", speaker: { speak } } as unknown as VoiceSessionView;
	const config = { guildId: "g1", enabled: true, voiceId: "voice-1" } as unknown as IDeroVoiceConfig;
	const deps: DealerDeps = {
		sessionIn: vi.fn(() => (withCall ? call : null)),
		loadConfig: vi.fn(async () => config),
		render: vi.fn(async () => ({ status: "ok" as const, pcm48kStereo: Buffer.from([1]), cached: false })),
		postText: vi.fn(async () => undefined),
	};
	return { deps, speak };
}

const client = {} as Client;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function dealtChange() {
	const table = sixPlayerTable();
	const before = toPublicView(table);
	dealHand(table, seededRng(5));
	return { before, after: toPublicView(table) };
}

beforeEach(() => _clearDealerTables());

describe("announceDealer", () => {
	it("does nothing at all for a table Dero does not deal", async () => {
		const { deps } = fakeDeps();
		announceDealer({ client, roomId: "room-x", ...dealtChange() }, deps);
		await flush();
		expect(deps.postText).not.toHaveBeenCalled();
		expect(deps.render).not.toHaveBeenCalled();
		expect(deps.loadConfig).not.toHaveBeenCalled();
	});

	it("posts the hand start in the room's text channel and speaks nothing for a text opened table", async () => {
		const { deps } = fakeDeps();
		registerDealerTable({ roomId: "room-1", guildId: "g1", channelId: "room-ch", voice: false });
		announceDealer({ client, roomId: "room-1", ...dealtChange() }, deps);
		await flush();
		expect(deps.postText).toHaveBeenCalledTimes(1);
		expect(deps.postText).toHaveBeenCalledWith(client, "room-ch", expect.stringMatching(/^Hand 1\. Blinds are 100 and 200\./));
		expect(deps.render).not.toHaveBeenCalled();
	});

	it("speaks every picked line at dealer priority in the call for a voice opened table", async () => {
		const { deps, speak } = fakeDeps();
		registerDealerTable({ roomId: "room-1", guildId: "g1", channelId: "room-ch", voice: true });
		announceDealer({ client, roomId: "room-1", ...dealtChange() }, deps);
		await flush();
		expect(deps.render).toHaveBeenCalledWith(expect.objectContaining({ guildId: "g1", voiceId: "voice-1", text: expect.stringContaining("Hand 1.") }));
		expect(speak).toHaveBeenCalledWith(expect.any(Buffer), "dealer");
	});

	it("stays silent when the call has ended or Dero is switched off, and keeps the text", async () => {
		const noCall = fakeDeps(false);
		registerDealerTable({ roomId: "room-1", guildId: "g1", channelId: "room-ch", voice: true });
		announceDealer({ client, roomId: "room-1", ...dealtChange() }, noCall.deps);
		await flush();
		expect(noCall.deps.render).not.toHaveBeenCalled();
		expect(noCall.deps.postText).toHaveBeenCalledTimes(1);

		const off = fakeDeps();
		off.deps.loadConfig = vi.fn(async () => ({ guildId: "g1", enabled: false, voiceId: "voice-1" }) as unknown as IDeroVoiceConfig);
		registerDealerTable({ roomId: "room-2", guildId: "g1", channelId: "room-ch", voice: true });
		announceDealer({ client, roomId: "room-2", ...dealtChange() }, off.deps);
		await flush();
		expect(off.deps.render).not.toHaveBeenCalled();
	});

	it("prompts the first player of a new hand even if the last prompt named them", async () => {
		const { deps } = fakeDeps();
		registerDealerTable({ roomId: "room-1", guildId: "g1", channelId: "room-ch", voice: true });
		const base: PublicView = { ...toPublicView(sixPlayerTable()), handNumber: 1, actingUserId: "p2", buttonUserId: "p0" };
		announceDealer({ client, roomId: "room-1", before: { ...base, actingUserId: "p1" }, after: base }, deps);
		announceDealer({ client, roomId: "room-1", before: base, after: { ...base, handNumber: 2 } }, deps);
		await flush();
		const spoken = (deps.render as ReturnType<typeof vi.fn>).mock.calls.map((call) => (call[0] as { text: string }).text);
		expect(spoken).toHaveLength(2);
		for (const text of spoken) expect(text).toContain("Player 2, it is your turn.");
	});

	it("attaches the showdown card to the result line, and only to it (2026-10 item 243)", async () => {
		const { deps } = fakeDeps();
		registerDealerTable({ roomId: "room-1", guildId: "g1", channelId: "room-ch", voice: false });
		const table = sixPlayerTable();
		dealHand(table, seededRng(7));
		let before = toPublicView(table);
		let outcome: ReturnType<typeof act> | undefined;
		while (handInProgress(table)) {
			before = toPublicView(table);
			outcome = act(table, whoActs(table)!, "fold");
		}
		announceDealer({ client, roomId: "room-1", before, after: toPublicView(table), outcome }, deps);
		await vi.waitFor(() => expect(deps.postText).toHaveBeenCalled());

		const calls = (deps.postText as ReturnType<typeof vi.fn>).mock.calls;
		const resultCall = calls.find((call) => call.length === 4);
		expect(resultCall?.[3]).toMatchObject({ ref: expect.stringMatching(/^attachment:\/\/holdem-showdown-[0-9a-f]{12}\.png$/) });
		for (const call of calls.filter((entry) => entry !== resultCall)) expect(call).toHaveLength(3);
	});

	// 2026-10 item 263 R3-28: the 12 hour prune drops only a table silent for the whole window,
	// so a table that is still dealing at 13 hours keeps its dealer.
	it("keeps a table that is still dealing past the prune window, and drops a silent one", () => {
		const { deps } = fakeDeps();
		const hour = 60 * 60_000;
		const start = 1_000_000;
		registerDealerTable({ roomId: "playing", guildId: "g1", channelId: "room-ch", voice: true, now: start });
		registerDealerTable({ roomId: "silent", guildId: "g1", channelId: "room-ch", voice: true, now: start });
		announceDealer({ client, roomId: "playing", ...dealtChange() }, deps, start + 11 * hour);

		registerDealerTable({ roomId: "new", guildId: "g1", channelId: "room-ch", voice: true, now: start + 13 * hour });

		expect(dealerTableOf("playing")).toEqual({ voice: true });
		expect(dealerTableOf("silent")).toBeNull();
	});

	it("forgets the table once the tournament is over", async () => {
		const { deps } = fakeDeps();
		registerDealerTable({ roomId: "room-1", guildId: "g1", channelId: "room-ch", voice: false });
		const before = toPublicView(sixPlayerTable());
		announceDealer({ client, roomId: "room-1", before, after: { ...before, status: "finished", winnerId: "p0" } }, deps);
		expect(dealerTableOf("room-1")).toBeNull();
	});

	it("never throws into the caller, even when delivery fails", async () => {
		const { deps } = fakeDeps();
		deps.postText = vi.fn(async () => {
			throw new Error("discord down");
		});
		const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		registerDealerTable({ roomId: "room-1", guildId: "g1", channelId: "room-ch", voice: false });
		expect(() => announceDealer({ client, roomId: "room-1", ...dealtChange() }, deps)).not.toThrow();
		await flush();
		expect(spy).toHaveBeenCalled();
		spy.mockRestore();
	});
});
