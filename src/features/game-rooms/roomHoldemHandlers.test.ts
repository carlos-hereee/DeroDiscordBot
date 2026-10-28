import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ButtonInteraction, Client } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: {
		update: vi.fn(),
		findPlayingByGame: vi.fn(),
		// The compare-and-swap every hold em write goes through. A truthy return means
		// the caller's read was still current and its write landed; null means somebody
		// else got there first, which callers treat as "their action counts, not mine".
		updateSecretIf: vi.fn(),
		findByRoomId: vi.fn(),
	},
}));
vi.mock("./roomTrail.js", () => ({ roomTrail: { postMove: vi.fn() } }));
vi.mock("./roomLifecycle.js", () => ({ roomLifecycle: { finish: vi.fn() } }));
vi.mock("@features/leveling/awardXp.js", () => ({ awardXp: vi.fn() }));

import {
	handleBuyIn,
	handleDeal,
	dealOpeningHand,
	handleShowCards,
	handleMove,
	handleLeaveTable,
	handleEndTable,
	sweepHoldemClocks,
	currentPot,
} from "./roomHoldemHandlers.js";
import { joiningRows, bettingRows, betweenHandsRows } from "./roomHoldem.js";
import { GAME_ROOM_ACTIONS } from "./gameRoomActions.js";
import { roomTrail } from "./roomTrail.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { awardXp } from "@features/leveling/awardXp.js";
import { act, createTable, joinTable, dealHand, whoActs, type HoldemTable } from "@features/games/holdemTable.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { formatCard } from "@features/games/holdemHand.js";

const storeMock = gameRoomStore as unknown as {
	update: ReturnType<typeof vi.fn>;
	findPlayingByGame: ReturnType<typeof vi.fn>;
	updateSecretIf: ReturnType<typeof vi.fn>;
	findByRoomId: ReturnType<typeof vi.fn>;
};
const awardXpMock = awardXp as unknown as ReturnType<typeof vi.fn>;

function seededRng(seed = 11): () => number {
	let state = seed;
	return () => {
		state = (state * 1664525 + 1013904223) % 4294967296;
		return state / 4294967296;
	};
}

function dealtTable(seats = 3): HoldemTable {
	const table = createTable();
	for (let index = 0; index < seats; index++) joinTable(table, `p${index}`, `Player ${index}`);
	table.status = "playing";
	dealHand(table, seededRng(11));
	table.boardMessageId = null;
	return table;
}

function makeRoom(table: HoldemTable): IGameRoom {
	return {
		roomId: "room-1",
		guildId: "guild-1",
		game: "holdem",
		status: "playing",
		playerIds: table.seats.map((seat) => seat.userId),
		channelId: "ch-1",
		secret: table,
	} as unknown as IGameRoom;
}

function makeInteraction(userId: string): ButtonInteraction {
	return {
		guildId: "guild-1",
		guild: { members: { cache: { get: () => ({ displayName: "P" }) } } },
		user: { id: userId, username: userId, globalName: userId },
		client: { channels: { fetch: vi.fn().mockResolvedValue(null) } },
		reply: vi.fn().mockResolvedValue(undefined),
		deferUpdate: vi.fn().mockResolvedValue(undefined),
		showModal: vi.fn().mockResolvedValue(undefined),
	} as unknown as ButtonInteraction;
}

// A press whose private view modal Discord refuses, so the old ephemeral reply answers.
function makeRefusedModalInteraction(userId: string): ButtonInteraction {
	const interaction = makeInteraction(userId);
	(interaction.showModal as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Invalid Form Body"));
	return interaction;
}

const client = { channels: { fetch: vi.fn().mockResolvedValue(null) } } as unknown as Client;

// The modals a press opened, and the text of its notice: a refusal or a short answer now
// opens a notice modal instead of a private reply (2026-10 item 254 Phase 5b).
const shownModals = (interaction: { showModal: unknown }) =>
	(interaction.showModal as ReturnType<typeof vi.fn>).mock.calls.map((call) => (call[0] as { toJSON(): { custom_id: string; components: { content?: string }[] } }).toJSON());
const noticeText = (interaction: { showModal: unknown }): string =>
	shownModals(interaction)
		.filter((modal) => modal.custom_id.startsWith("notice:"))
		.flatMap((modal) => modal.components.map((component) => component.content ?? ""))
		.join("\n");

beforeEach(() => {
	vi.clearAllMocks();
	storeMock.update.mockResolvedValue(undefined);
	// The default is the UNCONTENDED case: the caller's read was still current, so the
	// write landed. Cases that exercise a race override this per test.
	storeMock.updateSecretIf.mockResolvedValue({} as never);
	storeMock.findByRoomId.mockResolvedValue(null);
});

// ⚠️ THE HOLE CARDS ARE THE WHOLE SECRECY PROPERTY. A player's two cards must
// reach nobody but them, pulled on their own click, never pushed and never a DM.
describe("the private peek", () => {
	// Post-launch plan item 16: the hand opens in a modal only the presser sees.
	it("opens the clicker's OWN cards in a modal and posts nothing", async () => {
		const table = dealtTable();
		const interaction = makeInteraction("p1");

		await handleShowCards(interaction, makeRoom(table));

		expect(interaction.reply).not.toHaveBeenCalled();
		const modal = (interaction.showModal as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
			toJSON(): { components: { content?: string }[] };
		};
		const shown = modal.toJSON().components.map((component) => component.content ?? "").join("\n");
		const mine = table.holeCards.p1 ?? [];
		for (const card of mine) expect(shown).toContain(formatCard(card));
		for (const card of [...(table.holeCards.p0 ?? []), ...(table.holeCards.p2 ?? [])]) {
			const isAlsoMine = mine.some((own) => own.rank === card.rank && own.suit === card.suit);
			if (!isAlsoMine) expect(shown).not.toContain(formatCard(card));
		}
	});

	it("falls back to an ephemeral reply when the modal is refused", async () => {
		const table = dealtTable();
		const interaction = makeRefusedModalInteraction("p0");

		await handleShowCards(interaction, makeRoom(table));

		const reply = (interaction.reply as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as { flags?: number };
		// 64 is MessageFlags.Ephemeral.
		expect(reply.flags).toBe(64);
	});

	it("shows the clicker their OWN cards and nobody else's, in the fallback too", async () => {
		const table = dealtTable();
		const interaction = makeRefusedModalInteraction("p1");

		await handleShowCards(interaction, makeRoom(table));

		const payload = (interaction.reply as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
			embeds: { data: { description?: string } }[];
		};
		const rendered = payload.embeds[0].data.description ?? "";
		// Every other player's cards must be absent from what p1 sees.
		const others = [...(table.holeCards.p0 ?? []), ...(table.holeCards.p2 ?? [])];
		const mine = table.holeCards.p1 ?? [];
		expect(mine.length).toBe(2);
		for (const card of others) {
			const label = `${card.rank}${card.suit}`;
			// Compare on the raw pair rather than the rendered string, since a rank can
			// legitimately repeat across suits.
			const isAlsoMine = mine.some((own) => own.rank === card.rank && own.suit === card.suit);
			if (!isAlsoMine) expect(rendered).not.toContain(label);
		}
	});
});

describe("buying in", () => {
	it("adds the buyer to the room's player list, which every other gate reads", async () => {
		const table = createTable();
		const room = { ...makeRoom(table), playerIds: [] } as unknown as IGameRoom;
		const interaction = makeInteraction("newcomer");

		await handleBuyIn(interaction, room);

		// ⚠️ $addToSet ON THE SAME WRITE AS THE SEAT, not a rebuilt array. Two members
		// buying in at once both read the same playerIds, so writing the array back
		// dropped whichever of them lost the race, AFTER the trail had announced them.
		// Without the id here the playersOnly gate on every other hold em control would
		// refuse the very player who just bought in.
		const [, , expected, , extra] = storeMock.updateSecretIf.mock.calls[0] as [
			string,
			string,
			Record<string, unknown>,
			unknown,
			{ $addToSet: { playerIds: string } },
		];
		expect(extra.$addToSet.playerIds).toBe("newcomer");
		// And the write is CONDITIONAL on the seat count it read, which is what makes
		// the loser of that race write nothing at all, and on the buyer not being
		// removed by the host, which is what keeps a member removed after this read
		// off the table (2026-10 item 244 Phase 4).
		expect(expected).toEqual({ "secret.seats": { $size: 0 }, kickedIds: { $ne: "newcomer" }, "secret.boardMessageId": null });
	});

	it("re-reads and seats the loser of a race rather than overwriting the winner", async () => {
		// The first write loses (another buy in landed between this handler's read and
		// its write), so the handler must pick up the winner's table and seat itself on
		// top of it. Overwriting was the bug: the winner lost their seat AND their
		// stack, and only found out when every later control refused them.
		const stale = createTable();
		const winners = createTable();
		joinTable(winners, "first", "First");

		storeMock.updateSecretIf.mockResolvedValueOnce(null).mockResolvedValueOnce({} as never);
		storeMock.findByRoomId.mockResolvedValue(makeRoom(winners) as never);

		await handleBuyIn(makeInteraction("second"), makeRoom(stale));

		expect(storeMock.updateSecretIf).toHaveBeenCalledTimes(2);
		const retried = storeMock.updateSecretIf.mock.calls[1] as [string, string, unknown, HoldemTable, unknown];
		// Both players are seated, in the order they won the race.
		expect(retried[3].seats.map((seat) => seat.userId)).toEqual(["first", "second"]);
	});

	it("refuses a second buy in from the same player", async () => {
		const table = createTable();
		joinTable(table, "p0", "P0");
		const interaction = makeInteraction("p0");

		await handleBuyIn(interaction, makeRoom(table));

		expect(noticeText(interaction)).toMatch(/already have a seat/i);
	});
});

describe("acting", () => {
	it("refuses a player who is not on turn", async () => {
		const table = dealtTable();
		const notActing = table.seats.find((seat) => seat.userId !== whoActs(table))!.userId;
		const interaction = makeInteraction(notActing);

		await handleMove(interaction, makeRoom(table), "fold");

		expect(noticeText(interaction)).toMatch(/not your turn/i);
		expect(storeMock.update).not.toHaveBeenCalled();
	});

	it("refuses an unknown preset rather than guessing what it meant", async () => {
		const table = dealtTable();
		const interaction = makeInteraction(whoActs(table)!);

		await handleMove(interaction, makeRoom(table), "nonsense");

		expect(storeMock.update).not.toHaveBeenCalled();
	});
});

// ⚠️ PER-HAND XP MUST NOT NAME THE GAME. awardXp increments games.<slug>.played for
// any call naming one, so a 30 hand tournament would record 30 plays on /account
// for a tournament the member entered once.
describe("the xp record", () => {
	it("pays per hand WITHOUT a game field", async () => {
		const table = dealtTable(2);
		const room = makeRoom(table);
		// Fold the player on turn so the hand ends immediately and pays out.
		const interaction = makeInteraction(whoActs(table)!);

		await handleMove(interaction, room, "fold");

		const perHand = awardXpMock.mock.calls.map((call) => call[0] as Record<string, unknown>);
		expect(perHand.length).toBeGreaterThan(0);
		const handAwards = perHand.filter((call) => call.amount === BOT_CONSTANTS.LEVELING.HOLDEM_HAND_WIN_XP);
		for (const award of handAwards) expect(award).not.toHaveProperty("game");
	});

	// Folding ONE hand heads up does not end a tournament: the loser still has
	// chips. A table only finishes when somebody has none, so these drive a short
	// stack all the way out.
	async function playToFinish(): Promise<IGameRoom> {
		const table = createTable();
		joinTable(table, "p0", "P0");
		joinTable(table, "p1", "P1");
		// p1 cannot cover the big blind, so they are all in on the deal and the hand
		// settles the tournament either way.
		table.seats[1].stack = BOT_CONSTANTS.HOLDEM_BIG_BLIND;
		table.status = "playing";
		dealHand(table, seededRng(5));
		const room = makeRoom(table);

		let guard = 0;
		while (table.status === "playing" && whoActs(table) && guard++ < 40) {
			const actor = whoActs(table)!;
			await handleMove(makeInteraction(actor), room, "call");
		}
		return room;
	}

	it("records the match once, on the placement payout, with the game named", async () => {
		await playToFinish();

		const named = awardXpMock.mock.calls
			.map((call) => call[0] as Record<string, unknown>)
			.filter((call) => call.game === "holdem");
		// One row per finisher, each carrying an outcome. Nothing else names the
		// game, which is what keeps /account at one hold em played per tournament.
		expect(named.length).toBe(2);
		expect(named.every((call) => typeof call.outcome === "string")).toBe(true);
	});

	it("scales the placement bonus by finishing position", async () => {
		await playToFinish();

		const placementAmounts = awardXpMock.mock.calls
			.map((call) => call[0] as { game?: string; amount: number })
			.filter((call) => call.game === "holdem")
			.map((call) => call.amount);

		// First place takes the full amount; second takes less but not nothing,
		// which is what keeps a short stack playing rather than folding out.
		expect(placementAmounts[0]).toBe(BOT_CONSTANTS.LEVELING.HOLDEM_PLACEMENT_XP);
		expect(placementAmounts[1]).toBeLessThan(placementAmounts[0]);
		expect(placementAmounts[1]).toBeGreaterThan(0);
	});
});

// ⚠️ FORCE FOLD, NEVER PAUSE. A table that waits for an absent player hands one
// person the power to stall five.
describe("the turn clock", () => {
	it("leaves a table alone inside the turn budget", async () => {
		const table = dealtTable();
		table.lastActionAt = Date.now();
		storeMock.findPlayingByGame.mockResolvedValue([makeRoom(table)]);

		expect(await sweepHoldemClocks(client)).toEqual({ forced: 0, dealt: 0 });
		expect(storeMock.update).not.toHaveBeenCalled();
	});

	it("acts for a player who has run out of time", async () => {
		const table = dealtTable();
		table.lastActionAt = Date.now() - BOT_CONSTANTS.HOLDEM_TURN_TIMEOUT_MS - 1000;
		const stalling = whoActs(table);
		storeMock.findPlayingByGame.mockResolvedValue([makeRoom(table)]);

		expect(await sweepHoldemClocks(client)).toEqual({ forced: 1, dealt: 0 });
		expect(whoActs(table)).not.toBe(stalling);
	});

	it("ignores a table that is still waiting for buy ins", async () => {
		const table = createTable();
		table.lastActionAt = Date.now() - BOT_CONSTANTS.HOLDEM_TURN_TIMEOUT_MS - 1000;
		storeMock.findPlayingByGame.mockResolvedValue([makeRoom(table)]);

		expect(await sweepHoldemClocks(client)).toEqual({ forced: 0, dealt: 0 });
	});

	it("keeps sweeping when one table throws", async () => {
		const good = dealtTable();
		good.lastActionAt = Date.now() - BOT_CONSTANTS.HOLDEM_TURN_TIMEOUT_MS - 1000;
		const broken = makeRoom(dealtTable());
		(broken as { secret: unknown }).secret = { status: "playing", seats: null };

		storeMock.findPlayingByGame.mockResolvedValue([broken, makeRoom(good)]);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

		expect(await sweepHoldemClocks(client)).toEqual({ forced: 1, dealt: 0 });
		errorSpy.mockRestore();
	});
});

// ── regressions from the 2026-08-12 review ────────────────────────────
describe("aggression after the flop", () => {
	// ⚠️ THE BUG THAT MADE HOLD EM UNPLAYABLE PAST PREFLOP. The size presets were
	// dispatched as a hardcoded "raise", but the engine names the aggressive action
	// "bet" whenever there is no bet to raise, and every street after preflop opens
	// that way. applyAction's `legal.find` therefore missed, returned "illegal", and
	// the handler answered with the NOT YOUR TURN copy to the one player whose turn it
	// actually was. Both halves are pinned: that the press lands, and that the refusal
	// copy is no longer a lie.
	function tableOnTheFlop(): HoldemTable {
		const table = dealtTable();
		act(table, whoActs(table)!, "call");
		act(table, whoActs(table)!, "call");
		act(table, whoActs(table)!, "check");
		return table;
	}

	it("accepts a min bet on the flop instead of refusing it", async () => {
		const table = tableOnTheFlop();
		expect(table.street).toBe("flop");
		const actor = whoActs(table)!;
		const interaction = makeInteraction(actor);

		await handleMove(interaction, makeRoom(table), "min");

		expect(interaction.reply).not.toHaveBeenCalled();
		expect(interaction.deferUpdate).toHaveBeenCalled();
		// The bet actually landed rather than being silently dropped.
		expect(table.betting!.currentBet).toBe(table.bigBlind);
	});

	it("accepts the pot preset on the flop", async () => {
		const table = tableOnTheFlop();
		const interaction = makeInteraction(whoActs(table)!);

		await handleMove(interaction, makeRoom(table), "pot");

		expect(interaction.reply).not.toHaveBeenCalled();
		expect(table.betting!.currentBet).toBeGreaterThanOrEqual(table.bigBlind);
	});

	it("never answers a real turn with the not-your-turn copy", async () => {
		const table = tableOnTheFlop();
		const interaction = makeInteraction(whoActs(table)!);

		await handleMove(interaction, makeRoom(table), "min");

		const replies = (interaction.reply as unknown as ReturnType<typeof vi.fn>).mock.calls;
		for (const [payload] of replies) {
			expect((payload as { content: string }).content).not.toBe(gameRoomsCopy.holdem.notYourTurn);
		}
	});
});

describe("dealing the next hand", () => {
	// ⚠️ dealHand IS NOT A RESTART. It reshuffles and zeroes every seat's committed
	// chips while their stacks stay debited, so dealing over a running hand vaporises
	// the pot standing in it. The status check cannot catch this, because the joining
	// branch sets the status to "playing" one line before the status is tested.
	it("refuses a second deal while a hand is live", async () => {
		const table = dealtTable();
		const interaction = makeInteraction("p0");

		await handleDeal(interaction, makeRoom(table));

		expect(noticeText(interaction)).toBe(gameRoomsCopy.holdem.handInProgress);
		expect(table.handNumber).toBe(1);
	});

	it("refuses the loser of a double click, so only one hand is dealt", async () => {
		const table = createTable();
		joinTable(table, "p0", "P0");
		joinTable(table, "p1", "P1");
		// The claim write finds a different hand number, meaning the other half of the
		// double click already dealt.
		storeMock.updateSecretIf.mockResolvedValue(null);
		const interaction = makeInteraction("p0");

		await handleDeal(interaction, makeRoom(table));

		expect(noticeText(interaction)).toBe(gameRoomsCopy.holdem.handInProgress);
		expect(interaction.deferUpdate).not.toHaveBeenCalled();
	});

	it("deals hand two once the previous one has settled", async () => {
		// The dead end this closes: the Deal control lived only in joiningRows, and
		// redraw stopped rendering those the instant hand one was dealt, so a tournament
		// sat on disabled buttons forever holding its host's one room slot.
		const table = dealtTable(2);
		act(table, whoActs(table)!, "fold");
		expect(table.street).toBe("showdown");
		const interaction = makeInteraction("p0");

		await handleDeal(interaction, makeRoom(table));

		expect(table.handNumber).toBe(2);
		expect(interaction.deferUpdate).toHaveBeenCalled();
	});
});

// 2026-10 item 263 R3-27: a table a challenge card opens is seated already and deals its first
// hand as the room opens, through the same claim the host's Start uses.
describe("the opening deal of a card's table", () => {
	function seatedTable(seats: number): HoldemTable {
		const table = createTable();
		for (let index = 0; index < seats; index++) joinTable(table, `p${index}`, `Player ${index}`);
		return table;
	}

	it("deals hand one to every seated player at once", async () => {
		const table = seatedTable(3);
		storeMock.findByRoomId.mockResolvedValue(makeRoom(table));

		await expect(dealOpeningHand(client, makeRoom(table))).resolves.toBe(true);

		const written = storeMock.updateSecretIf.mock.calls[0][3] as HoldemTable;
		expect(written.status).toBe("playing");
		expect(written.handNumber).toBe(1);
		expect(Object.values(written.holeCards).map((cards) => cards.length)).toEqual([2, 2, 2]);
		expect(roomTrail.postMove).toHaveBeenCalledWith(client, expect.anything(), expect.objectContaining({ text: gameRoomsCopy.holdem.handDealt(1, table.smallBlind, table.bigBlind) }));
	});

	it("deals nothing to a table short of two seats, or one already dealt", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom(seatedTable(1)));
		await expect(dealOpeningHand(client, makeRoom(seatedTable(1)))).resolves.toBe(false);

		storeMock.findByRoomId.mockResolvedValue(makeRoom(dealtTable(2)));
		await expect(dealOpeningHand(client, makeRoom(dealtTable(2)))).resolves.toBe(false);
		expect(storeMock.updateSecretIf).not.toHaveBeenCalled();
	});
});

describe("the turn clock defers to a real action", () => {
	// The sweep decides against a snapshot read seconds earlier, so a short stack
	// acting at 29.9 seconds races the fold. If their action landed first the
	// conditional write finds a different lastActionAt and does nothing, so their real
	// move stands. Without it both wrote, both settled, and payPlacements paid twice.
	it("forces nothing when the player's own action won the race", async () => {
		const table = dealtTable();
		table.lastActionAt = Date.now() - BOT_CONSTANTS.HOLDEM_TURN_TIMEOUT_MS - 1000;
		storeMock.findPlayingByGame.mockResolvedValue([makeRoom(table)]);
		storeMock.updateSecretIf.mockResolvedValue(null);

		expect(await sweepHoldemClocks(client)).toEqual({ forced: 0, dealt: 0 });
	});
});

// ── leaving and ending (the 1.7.0 test run's stuck table) ──────────────
describe("leaving and ending the table", () => {
	const trailMock = roomTrail as unknown as { postMove: ReturnType<typeof vi.fn> };
	const finishMock = roomLifecycle.finish as unknown as ReturnType<typeof vi.fn>;
	const hostedRoom = (table: HoldemTable): IGameRoom => ({ ...makeRoom(table), hostId: "p0" }) as IGameRoom;
	const customIdsOf = (rows: { toJSON(): { components: { custom_id?: string }[] } }[]) =>
		rows.flatMap((row) => row.toJSON().components.map((component) => component.custom_id));

	it("puts Leave table and End table on every live state of the board", () => {
		const exits = ["gameroom:hleave:room-1", "gameroom:hend:room-1"];
		const joining = createTable();
		joinTable(joining, "p0", "P");
		const dealt = dealtTable(3);

		expect(customIdsOf(joiningRows("room-1", 1, joining))).toEqual(expect.arrayContaining(exits));
		expect(customIdsOf(bettingRows(dealt, "room-1", currentPot(dealt)))).toEqual(expect.arrayContaining(exits));
		expect(customIdsOf(betweenHandsRows("room-1"))).toEqual(expect.arrayContaining(exits));
	});

	it("gates Leave to the room's players and End to its host", () => {
		expect(GAME_ROOM_ACTIONS.hleave).toEqual({ hostOnly: false, playersOnly: true });
		expect(GAME_ROOM_ACTIONS.hend).toEqual({ hostOnly: true, playersOnly: false });
	});

	it("folds a leaver's live hand, posts one line for the leave, and ends a heads up tournament as a bust would", async () => {
		const table = dealtTable(2);
		const interaction = makeInteraction("p0");

		await handleLeaveTable(interaction, hostedRoom(table));

		expect(interaction.deferUpdate).toHaveBeenCalledOnce();
		const lines = trailMock.postMove.mock.calls.map((call) => (call[2] as { text: string }).text);
		expect(lines[0]).toBe(gameRoomsCopy.holdem.leftTable("p0", true));
		expect(lines.filter((line) => line.includes("left the table"))).toHaveLength(1);
		expect(finishMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), { winnerId: "p1", outcome: { bucket: "forfeit" } });
		expect(awardXpMock).toHaveBeenCalledWith(expect.objectContaining({ userId: "p1", game: "holdem", outcome: "won" }));
	});

	it("frees a seat before the first deal without ending anything", async () => {
		const table = createTable();
		joinTable(table, "p0", "P0");
		joinTable(table, "p1", "P1");

		await handleLeaveTable(makeInteraction("p1"), hostedRoom(table));

		const written = storeMock.updateSecretIf.mock.calls[0][3] as HoldemTable;
		expect(written.seats.map((seat) => seat.userId)).toEqual(["p0"]);
		expect(trailMock.postMove.mock.calls[0][2]).toMatchObject({ text: gameRoomsCopy.holdem.leftTable("p1", false) });
		expect(finishMock).not.toHaveBeenCalled();
	});

	it("guards the write on both the action stamp and the seat count, so a racing buy in survives", async () => {
		const table = createTable();
		joinTable(table, "p0", "P0");
		joinTable(table, "p1", "P1");
		const readAt = table.lastActionAt;

		await handleLeaveTable(makeInteraction("p1"), hostedRoom(table));

		expect(storeMock.updateSecretIf.mock.calls[0][2]).toEqual({
			"secret.lastActionAt": readAt,
			"secret.seats": { $size: 2 },
			"secret.boardMessageId": null,
		});
	});

	it("refuses a member with no seat and writes nothing", async () => {
		const interaction = makeInteraction("invitee");

		await handleLeaveTable(interaction, hostedRoom(dealtTable(3)));

		expect(noticeText(interaction)).toBe(gameRoomsCopy.holdem.notSeated);
		expect(storeMock.updateSecretIf).not.toHaveBeenCalled();
	});

	it("says nothing in the room when somebody else's write landed first", async () => {
		storeMock.updateSecretIf.mockResolvedValue(null);
		const interaction = makeInteraction("p0");

		await handleLeaveTable(interaction, hostedRoom(dealtTable(3)));

		expect(noticeText(interaction)).toBe(gameRoomsCopy.holdem.tableBusy);
		expect(trailMock.postMove).not.toHaveBeenCalled();
	});

	it("ends a running table on the standings, with the chip leader as the winner and no placement prize", async () => {
		const table = dealtTable(3);
		const interaction = makeInteraction("p0");

		await handleEndTable(interaction, hostedRoom(table));

		const ended = storeMock.updateSecretIf.mock.calls[0][3] as HoldemTable;
		expect(ended.status).toBe("finished");
		const text = (trailMock.postMove.mock.calls[0][2] as { text: string }).text;
		expect(text).toContain("Final standings");
		// The host ended it, so the standings decide the flavor (post-launch plan item 21).
		expect(finishMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
			winnerId: ended.winnerId,
			outcome: { bucket: expect.stringMatching(/^(decisive|narrow)$/) },
		});
		expect(ended.winnerId).not.toBeNull();
		expect(awardXpMock).not.toHaveBeenCalledWith(expect.objectContaining({ game: "holdem" }));
	});

	it("ends a table that never dealt with no winner", async () => {
		const table = createTable();
		joinTable(table, "p0", "P0");

		await handleEndTable(makeInteraction("p0"), hostedRoom(table));

		expect(trailMock.postMove.mock.calls[0][2]).toMatchObject({
			text: gameRoomsCopy.holdem.tableEnded("p0", [], false),
		});
		expect(finishMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), { winnerId: null, outcome: { bucket: "narrow" } });
	});

	it("refuses to end a table that is already over", async () => {
		const table = dealtTable(2);
		table.status = "finished";
		const interaction = makeInteraction("p0");

		await handleEndTable(interaction, hostedRoom(table));

		expect(noticeText(interaction)).toBe(gameRoomsCopy.holdem.tournamentOver);
		expect(finishMock).not.toHaveBeenCalled();
	});
});
