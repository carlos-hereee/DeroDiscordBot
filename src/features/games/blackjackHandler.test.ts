import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ButtonInteraction, TextChannel } from "discord.js";

// ── blackjackHandler ───────────────────────────────────────────────────────
// blackjackState already pins every RULE exhaustively, so nothing here re-tests
// a hand value or a split. What only a handler test can reach is the Discord
// shape and the two claims that protect it: one table per channel claimed
// synchronously, and a settlement that pays EXACTLY ONCE however many paths
// reach it. The second is the expensive one to get wrong, because paying twice
// costs real xp and nothing in the game surface would show it.

const mocks = vi.hoisted(() => ({ awardBlackjackResult: vi.fn() }));
vi.mock("./gameXp.js", () => ({ awardBlackjackResult: mocks.awardBlackjackResult }));

// Every redraw waits on a REAL card render (the table card every turn, the result
// card on settle), and the PNG encode finishes on the native thread pool, not in a
// microtask. The renderer stays real; this records each render in flight so flush()
// below can wait for it, the hangman handler test's pattern.
// `fail` stands in for a host where the cards do not draw; `gate`, while set, holds
// every render until the test releases it, so a test can look at a board mid draw.
const renders = vi.hoisted(() => ({ inFlight: new Set<Promise<unknown>>(), fail: false, gate: null as Promise<void> | null }));
vi.mock("./blackjackRenderer.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("./blackjackRenderer.js")>();
	const recorded = <T>(draw: () => Promise<T | null>): Promise<T | null> => {
		const gate = renders.gate;
		const render = (async () => {
			if (gate) await gate;
			return renders.fail ? null : draw();
		})();
		renders.inFlight.add(render);
		void render.finally(() => renders.inFlight.delete(render));
		return render;
	};
	return {
		...real,
		renderBlackjackTableCard: (view: Parameters<typeof real.renderBlackjackTableCard>[0]) => recorded(() => real.renderBlackjackTableCard(view)),
		renderBlackjackResultCard: (view: Parameters<typeof real.renderBlackjackResultCard>[0]) => recorded(() => real.renderBlackjackResultCard(view)),
	};
});

import {
	startBlackjackTable,
	hasLiveBlackjackTable,
	_clearBlackjackGames,
	_activeBlackjackGameCount,
	SEATING_WINDOW_MS,
	TABLE_TIMEOUT_MS,
	MAX_SEATS,
	roomWinnerOf,
} from "./blackjackHandler.js";
import { _resetDrawingPauses } from "@features/game-rooms/drawingPause.js";
import { gameRoomsCopy } from "@features/game-rooms/gameRoomsCopy.js";

interface SentPayload {
	content?: string | null;
	embeds: Array<{ data: { image?: { url: string } } }>;
	files?: unknown[];
	attachments?: unknown[];
	components: Array<{ components: Array<{ data: { custom_id?: string; label?: string; disabled?: boolean } }> }>;
}

interface Board {
	edit: ReturnType<typeof vi.fn>;
	collect: (click: unknown) => void;
	end: () => void;
	stopped: () => boolean;
}

function fakeChannel(id: string, opts: { failSend?: boolean } = {}): {
	channel: TextChannel;
	send: ReturnType<typeof vi.fn>;
	board: () => Board;
	sent: () => SentPayload;
} {
	let collectHandler: ((click: unknown) => void) | undefined;
	let endHandler: (() => void) | undefined;
	let stopped = false;
	const edit = vi.fn(async () => undefined);

	const message = {
		id: `${id}-board`,
		edit,
		guildId: "g1",
		client: { fake: true } as unknown,
		createMessageComponentCollector: () => {
			const collector = {
				on(event: string, callback: (arg?: unknown) => void) {
					if (event === "collect") collectHandler = callback as (click: unknown) => void;
					else endHandler = callback as () => void;
					return collector;
				},
				stop() {
					stopped = true;
					endHandler?.();
				},
			};
			return collector;
		},
	};

	const send = vi.fn(async () => {
		if (opts.failSend) throw new Error("missing permissions");
		return message;
	});

	return {
		// `client` is read by the settle path on the opening render, before any
		// board or click exists to read it from.
		channel: { id, send, client: { fake: true } } as unknown as TextChannel,
		send,
		sent: () => send.mock.calls[send.mock.calls.length - 1][0] as SentPayload,
		board: () => ({
			edit,
			collect: (click: unknown) => collectHandler?.(click),
			end: () => endHandler?.(),
			stopped: () => stopped,
		}),
	};
}

interface FakeClick {
	click: ButtonInteraction;
	update: ReturnType<typeof vi.fn>;
	editReply: ReturnType<typeof vi.fn>;
	reply: ReturnType<typeof vi.fn>;
	lastUpdate: () => SentPayload;
}

// A click's redraw is two writes: the drawing status as its update, then the board
// as its edited reply. lastUpdate is whichever of the two landed last.
function fakeClick(channelId: string, action: string, userId: string): FakeClick {
	const writes: SentPayload[] = [];
	const record = vi.fn(async (payload: SentPayload) => {
		writes.push(payload);
	});
	const update = vi.fn((payload: SentPayload) => record(payload));
	const editReply = vi.fn((payload: SentPayload) => record(payload));
	const reply = vi.fn(async () => undefined);
	const click = {
		customId: `minigame:blackjack:${channelId}:${action}`,
		user: { id: userId, username: userId, globalName: userId },
		client: {} as unknown,
		update,
		editReply,
		reply,
	};
	return {
		click: click as unknown as ButtonInteraction,
		update,
		editReply,
		reply,
		lastUpdate: () => writes[writes.length - 1] as SentPayload,
	};
}

const host = { userId: "host-1", username: "host-1" };
// Drains the microtasks, then waits out any card render in flight and drains again,
// until a pass finds nothing rendering.
const MAX_FLUSH_PASSES = 6;
const flush = async (): Promise<void> => {
	for (let pass = 0; pass < MAX_FLUSH_PASSES; pass++) {
		for (let i = 0; i < 8; i++) await Promise.resolve();
		if (renders.inFlight.size === 0) return;
		await Promise.allSettled([...renders.inFlight]);
	}
};

// Buttons the LAST render offered, by action suffix, with their disabled state.
const buttonsOf = (payload: SentPayload): Record<string, boolean> => {
	const row = payload.components?.[0];
	const out: Record<string, boolean> = {};
	for (const button of row?.components ?? []) {
		const id = button.data.custom_id ?? "";
		out[id.split(":")[3] ?? ""] = Boolean(button.data.disabled);
	}
	return out;
};

beforeEach(() => {
	_clearBlackjackGames();
	_resetDrawingPauses();
	renders.fail = false;
	renders.gate = null;
	mocks.awardBlackjackResult.mockReset();
	// Fixed rng so a deal is deterministic and a test cannot flake on the ~4.8%
	// of hands that open with a natural and settle before anyone can act.
	vi.spyOn(Math, "random").mockReturnValue(0.5);
});

afterEach(() => {
	_clearBlackjackGames();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

// ── the channel slot ────────────────────────────────────────────────────────

describe("one table per channel", () => {
	it("starts a table and registers it", async () => {
		const c = fakeChannel("chan-1");
		expect(await startBlackjackTable(c.channel, "g1", host, true)).toBe("started");
		expect(_activeBlackjackGameCount()).toBe(1);
	});

	it("refuses a second table in the same channel", async () => {
		const c = fakeChannel("chan-1");
		await startBlackjackTable(c.channel, "g1", host, true);
		expect(await startBlackjackTable(c.channel, "g1", { userId: "other", username: "other" }, true)).toBe("alreadyRunning");
		expect(_activeBlackjackGameCount()).toBe(1);
		expect(c.send).toHaveBeenCalledTimes(1);
	});

	it("allows a table in a different channel", async () => {
		const one = fakeChannel("chan-1");
		const two = fakeChannel("chan-2");
		await startBlackjackTable(one.channel, "g1", host, true);
		expect(await startBlackjackTable(two.channel, "g1", host, true)).toBe("started");
		expect(_activeBlackjackGameCount()).toBe(2);
	});

	it("releases the slot when the board cannot be posted", async () => {
		// Otherwise a missing-permission failure locks that channel out of blackjack
		// for the life of the process.
		const c = fakeChannel("chan-1", { failSend: true });
		expect(await startBlackjackTable(c.channel, "g1", host, true)).toBe("failed");
		expect(_activeBlackjackGameCount()).toBe(0);
	});

	it("drops the map entry when the collector ends", async () => {
		const c = fakeChannel("chan-1");
		await startBlackjackTable(c.channel, "g1", host, true);
		c.board().end();
		expect(_activeBlackjackGameCount()).toBe(0);
	});

	// The seam the boot recovery sweep reads. It must track the Map exactly: true only
	// while a table is registered for the channel, false again the moment the collector's
	// end handler drops the entry, or the sweep would close a live table or spare a dead one.
	it("reports the channel's slot to the boot sweep, and clears when the collector ends", async () => {
		const c = fakeChannel("chan-1");
		expect(hasLiveBlackjackTable("chan-1")).toBe(false);
		await startBlackjackTable(c.channel, "g1", host, true);
		expect(hasLiveBlackjackTable("chan-1")).toBe(true);
		expect(hasLiveBlackjackTable("chan-2")).toBe(false);
		c.board().end();
		expect(hasLiveBlackjackTable("chan-1")).toBe(false);
	});
});

// ── solo versus table ───────────────────────────────────────────────────────

describe("the two opening surfaces", () => {
	it("deals a solo hand immediately, with action buttons and no seating row", async () => {
		const c = fakeChannel("chan-1");
		await startBlackjackTable(c.channel, "g1", host, true);
		const buttons = buttonsOf(c.sent());
		expect(Object.keys(buttons).sort()).toEqual(["double", "hit", "split", "stand"]);
	});

	it("posts a seating board for a table, with no cards dealt yet", async () => {
		const c = fakeChannel("chan-1");
		await startBlackjackTable(c.channel, "g1", host, false);
		expect(Object.keys(buttonsOf(c.sent())).sort()).toEqual(["deal", "join", "leave"]);
	});

	it("offers hit and stand but disables split on an ordinary opening hand", async () => {
		const c = fakeChannel("chan-1");
		await startBlackjackTable(c.channel, "g1", host, true);
		const buttons = buttonsOf(c.sent());
		// Disabled rather than removed, so the row does not reflow under the
		// player's cursor between turns.
		expect(buttons.hit).toBe(false);
		expect(buttons.stand).toBe(false);
		expect(buttons.split).toBe(true);
	});
});

// ── seating ─────────────────────────────────────────────────────────────────

describe("seating a table", () => {
	const openTable = async () => {
		const c = fakeChannel("chan-1");
		await startBlackjackTable(c.channel, "g1", host, false);
		return c;
	};

	it("seats a member who joins", async () => {
		const c = await openTable();
		const join = fakeClick("chan-1", "join", "player-2");
		c.board().collect(join.click);
		await flush();
		expect(join.update).toHaveBeenCalled();
		expect(join.reply).not.toHaveBeenCalled();
	});

	it("refuses a member who is already seated", async () => {
		const c = await openTable();
		const join = fakeClick("chan-1", "join", host.userId);
		c.board().collect(join.click);
		await flush();
		expect(join.reply).toHaveBeenCalled();
		expect(join.update).not.toHaveBeenCalled();
	});

	it("refuses a member once the table is full", async () => {
		const c = await openTable();
		// The host already holds one seat, so MAX_SEATS - 1 more fills it.
		for (let i = 0; i < MAX_SEATS - 1; i++) {
			c.board().collect(fakeClick("chan-1", "join", `player-${i}`).click);
			await flush();
		}
		const late = fakeClick("chan-1", "join", "player-late");
		c.board().collect(late.click);
		await flush();
		expect(late.reply).toHaveBeenCalled();
	});

	it("lets a seated member leave, and tells anyone else they were not seated", async () => {
		const c = await openTable();
		const leave = fakeClick("chan-1", "leave", host.userId);
		c.board().collect(leave.click);
		await flush();
		expect(leave.update).toHaveBeenCalled();

		const stranger = fakeClick("chan-1", "leave", "nobody");
		c.board().collect(stranger.click);
		await flush();
		expect(stranger.reply).toHaveBeenCalled();
	});

	it("lets only the host deal early", async () => {
		const c = await openTable();
		const notHost = fakeClick("chan-1", "deal", "player-2");
		c.board().collect(notHost.click);
		await flush();
		expect(notHost.reply).toHaveBeenCalled();
		expect(notHost.update).not.toHaveBeenCalled();
	});

	it("deals on the host's word, replacing the seating row with actions", async () => {
		const c = await openTable();
		const deal = fakeClick("chan-1", "deal", host.userId);
		c.board().collect(deal.click);
		await flush();
		expect(Object.keys(buttonsOf(deal.lastUpdate())).sort()).toEqual(["double", "hit", "split", "stand"]);
	});

	it("deals itself when the window closes with nobody pressing Deal", async () => {
		vi.useFakeTimers();
		const c = fakeChannel("chan-1");
		await startBlackjackTable(c.channel, "g1", host, false);
		await vi.advanceTimersByTimeAsync(SEATING_WINDOW_MS);
		await flush();
		// The board was edited from the seating render into a dealt table.
		expect(c.board().edit).toHaveBeenCalled();
	});
});

// ── playing ─────────────────────────────────────────────────────────────────

describe("acting on a hand", () => {
	const soloTable = async () => {
		const c = fakeChannel("chan-1");
		await startBlackjackTable(c.channel, "g1", host, true);
		return c;
	};

	it("turns away a click from somebody who is not playing", async () => {
		const c = await soloTable();
		const intruder = fakeClick("chan-1", "hit", "stranger");
		c.board().collect(intruder.click);
		await flush();
		expect(intruder.reply).toHaveBeenCalled();
		expect(intruder.update).not.toHaveBeenCalled();
	});

	it("re-renders the board on a legal action", async () => {
		const c = await soloTable();
		const hit = fakeClick("chan-1", "hit", host.userId);
		c.board().collect(hit.click);
		await flush();
		expect(hit.update).toHaveBeenCalled();
	});

	it("ignores a stray customId that is not an action", async () => {
		const c = await soloTable();
		const stray = fakeClick("chan-1", "join", host.userId);
		c.board().collect(stray.click);
		await flush();
		expect(stray.update).not.toHaveBeenCalled();
		expect(stray.reply).not.toHaveBeenCalled();
	});
});

// ── settlement ──────────────────────────────────────────────────────────────
// ⚠️ HONEST NOTE ON COVERAGE, established by mutation on 2026-08-12: deleting
// `game.settled` from the settleGame guard leaves every test below GREEN. That
// is not a gap in these tests so much as a fact about the code: the PRIMARY
// defense against a double pay is the phase check inside applyAction, which
// returns "not-your-turn" to any second click once the table has left the
// playing phase, so no second caller ever reaches settlement. The `settled`
// flag is belt and braces behind it and is deliberately kept, because the phase
// check lives in a different module and a future refactor there should not be
// able to turn a re-entry into a double payout silently.
//
// What these tests DO pin is the observable contract: across every flow a table
// can actually take, the award fires exactly once and carries the right shape.

describe("settling exactly once", () => {
	it("pays the table when the last seat stands", async () => {
		const c = fakeChannel("chan-1");
		await startBlackjackTable(c.channel, "g1", host, true);
		const stand = fakeClick("chan-1", "stand", host.userId);
		c.board().collect(stand.click);
		await flush();

		expect(mocks.awardBlackjackResult).toHaveBeenCalledTimes(1);
		// The final render clears the buttons: there is nothing left to press.
		expect(stand.lastUpdate().components).toEqual([]);
	});

	it("does NOT pay again when the collector ends afterwards", async () => {
		// A settled hand whose board then times out. The cleanup path must drop the
		// map entry without touching the payout.
		const c = fakeChannel("chan-1");
		await startBlackjackTable(c.channel, "g1", host, true);
		c.board().collect(fakeClick("chan-1", "stand", host.userId).click);
		await flush();
		c.board().end();
		await flush();
		expect(mocks.awardBlackjackResult).toHaveBeenCalledTimes(1);
	});

	it("does not deal or pay twice when the seating window expires after the host dealt", async () => {
		// Deal clears the timer, and closeSeating additionally bails on a table that
		// already exists. This pins that both halves hold: one deal, one payout.
		vi.useFakeTimers();
		const c = fakeChannel("chan-1");
		await startBlackjackTable(c.channel, "g1", host, false);

		c.board().collect(fakeClick("chan-1", "deal", host.userId).click);
		await flush();
		await vi.advanceTimersByTimeAsync(SEATING_WINDOW_MS);
		await flush();

		c.board().collect(fakeClick("chan-1", "stand", host.userId).click);
		await flush();
		expect(mocks.awardBlackjackResult).toHaveBeenCalledTimes(1);
	});

	it("settles a solo hand dealt a NATURAL, where nobody ever acts", async () => {
		// ~4.8% of opening hands are a natural. createTable marks it and advances the
		// turn pointer straight past the seat, so the table reaches the dealer phase
		// before a single button exists. Without an explicit check on the opening
		// render, that hand posts a board whose every button is disabled and then
		// sits there paying nothing until the collector times out.
		// 0.05686 deals the seat K♦ A♠ against a dealer 10♦ 6♥.
		vi.spyOn(Math, "random").mockReturnValue(0.05686);
		const c = fakeChannel("chan-1");
		await startBlackjackTable(c.channel, "g1", host, true);
		await flush();

		expect(mocks.awardBlackjackResult).toHaveBeenCalledTimes(1);
		expect(c.sent().components).toEqual([]);
	});

	it("reports one seat result per seated member", async () => {
		const c = fakeChannel("chan-1");
		await startBlackjackTable(c.channel, "g1", host, false);
		c.board().collect(fakeClick("chan-1", "join", "player-2").click);
		await flush();
		c.board().collect(fakeClick("chan-1", "deal", host.userId).click);
		await flush();
		c.board().collect(fakeClick("chan-1", "stand", host.userId).click);
		await flush();
		c.board().collect(fakeClick("chan-1", "stand", "player-2").click);
		await flush();

		expect(mocks.awardBlackjackResult).toHaveBeenCalledTimes(1);
		const payload = mocks.awardBlackjackResult.mock.calls[0][0] as { seats: unknown[]; guildId: string };
		expect(payload.seats).toHaveLength(2);
		// Read off the game rather than off whichever message was in scope.
		expect(payload.guildId).toBe("g1");
	});
});

// ── the table every turn (Dero 1.7.0 test fixes, Phase 3a) ─────────────────

describe("drawing the table every turn", () => {
	const dealtTable = async () => {
		const c = fakeChannel("chan-1");
		await startBlackjackTable(c.channel, "g1", host, false);
		return c;
	};

	it("deals with the drawing status first, then the table card with the old card dropped", async () => {
		const c = await dealtTable();
		const deal = fakeClick("chan-1", "deal", host.userId);
		c.board().collect(deal.click);
		await flush();

		expect(deal.update.mock.calls[0][0]).toEqual({ content: gameRoomsCopy.drawing.status });
		const board = deal.lastUpdate();
		expect(board.content).toBeNull();
		expect(board.attachments).toEqual([]);
		expect(board.files).toHaveLength(1);
		expect(board.embeds[0].data.image?.url).toMatch(/^attachment:\/\/blackjack-table-/);
	});

	it("draws the table card on the opening post of a solo hand", async () => {
		const c = fakeChannel("chan-1");
		await startBlackjackTable(c.channel, "g1", host, true);
		expect(c.sent().files).toHaveLength(1);
		expect(c.sent().embeds[0].data.image?.url).toMatch(/^attachment:\/\/blackjack-table-/);
	});

	it("posts the text table, with no stale card, when the card does not draw", async () => {
		renders.fail = true;
		const c = await dealtTable();
		const deal = fakeClick("chan-1", "deal", host.userId);
		c.board().collect(deal.click);
		await flush();

		const board = deal.lastUpdate();
		expect(board.files).toEqual([]);
		expect(board.attachments).toEqual([]);
		expect(board.embeds[0].data.image).toBeUndefined();
		expect(Object.keys(buttonsOf(board)).sort()).toEqual(["double", "hit", "split", "stand"]);
	});

	it("holds the table's lifetime while the board draws, and adds the held time back", async () => {
		vi.useFakeTimers();
		const c = await dealtTable();
		let release: () => void = () => undefined;
		renders.gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		c.board().collect(fakeClick("chan-1", "deal", host.userId).click);
		await vi.advanceTimersByTimeAsync(TABLE_TIMEOUT_MS);
		// The lifetime is up, but the board is still drawing, so the table stays.
		expect(c.board().stopped()).toBe(false);

		release();
		await flush();
		await vi.advanceTimersByTimeAsync(0);
		// The draw held the clock for the whole lifetime, so the deadline moved on by that much.
		expect(c.board().stopped()).toBe(false);

		await vi.advanceTimersByTimeAsync(TABLE_TIMEOUT_MS);
		expect(c.board().stopped()).toBe(true);
	});
});

// ── a room's one winner (2026-10 item 254, Arcade 1) ─────────────────────
// A multi seat table plays in a room now, whose result card names one winner at most.
describe("roomWinnerOf", () => {
	const seat = (userId: string, hands: Array<"win" | "blackjack" | "push" | "lose">) => ({ userId, username: userId, hands, doubled: hands.map(() => false) });

	it("names the only seat that beat the dealer, a split seat counting once", () => {
		expect(roomWinnerOf([seat("a", ["lose"]), seat("b", ["win", "lose"])])).toBe("b");
		expect(roomWinnerOf([seat("a", ["blackjack"])])).toBe("a");
	});

	it("names nobody when several seats won, or none did", () => {
		expect(roomWinnerOf([seat("a", ["win"]), seat("b", ["blackjack"])])).toBeNull();
		expect(roomWinnerOf([seat("a", ["push"]), seat("b", ["lose"])])).toBeNull();
	});
});
