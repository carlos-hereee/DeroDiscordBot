import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ButtonInteraction, Client } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: { update: vi.fn(), findPlayingByGame: vi.fn() },
}));
vi.mock("./roomTrail.js", () => ({ roomTrail: { postMove: vi.fn() } }));
vi.mock("./roomLifecycle.js", () => ({ roomLifecycle: { finish: vi.fn() } }));
vi.mock("@features/leveling/awardXp.js", () => ({ awardXp: vi.fn() }));

import { handleBuyIn, handleShowCards, handleMove, sweepHoldemClocks } from "./roomHoldemHandlers.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { awardXp } from "@features/leveling/awardXp.js";
import { createTable, joinTable, dealHand, whoActs, type HoldemTable } from "@features/games/holdemTable.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

const storeMock = gameRoomStore as unknown as {
	update: ReturnType<typeof vi.fn>;
	findPlayingByGame: ReturnType<typeof vi.fn>;
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
	} as unknown as ButtonInteraction;
}

const client = { channels: { fetch: vi.fn().mockResolvedValue(null) } } as unknown as Client;

beforeEach(() => {
	vi.clearAllMocks();
	storeMock.update.mockResolvedValue(undefined);
});

// ⚠️ THE HOLE CARDS ARE THE WHOLE SECRECY PROPERTY. A player's two cards must
// reach nobody but them, pulled on their own click, never pushed and never a DM.
describe("the private peek", () => {
	it("always replies ephemerally", async () => {
		const table = dealtTable();
		const interaction = makeInteraction("p0");

		await handleShowCards(interaction, makeRoom(table));

		const reply = (interaction.reply as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as { flags?: number };
		// 64 is MessageFlags.Ephemeral.
		expect(reply.flags).toBe(64);
	});

	it("shows the clicker their OWN cards and nobody else's", async () => {
		const table = dealtTable();
		const interaction = makeInteraction("p1");

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

		const patch = storeMock.update.mock.calls[0][2] as { playerIds: string[] };
		// Without this, the playersOnly gate on every other hold em control would
		// refuse the very player who just bought in.
		expect(patch.playerIds).toContain("newcomer");
	});

	it("refuses a second buy in from the same player", async () => {
		const table = createTable();
		joinTable(table, "p0", "P0");
		const interaction = makeInteraction("p0");

		await handleBuyIn(interaction, makeRoom(table));

		const reply = (interaction.reply as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as { content: string };
		expect(reply.content).toMatch(/already have a seat/i);
	});
});

describe("acting", () => {
	it("refuses a player who is not on turn", async () => {
		const table = dealtTable();
		const notActing = table.seats.find((seat) => seat.userId !== whoActs(table))!.userId;
		const interaction = makeInteraction(notActing);

		await handleMove(interaction, makeRoom(table), "fold");

		const reply = (interaction.reply as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as { content: string };
		expect(reply.content).toMatch(/not your turn/i);
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

		expect(await sweepHoldemClocks(client)).toEqual({ forced: 0 });
		expect(storeMock.update).not.toHaveBeenCalled();
	});

	it("acts for a player who has run out of time", async () => {
		const table = dealtTable();
		table.lastActionAt = Date.now() - BOT_CONSTANTS.HOLDEM_TURN_TIMEOUT_MS - 1000;
		const stalling = whoActs(table);
		storeMock.findPlayingByGame.mockResolvedValue([makeRoom(table)]);

		expect(await sweepHoldemClocks(client)).toEqual({ forced: 1 });
		expect(whoActs(table)).not.toBe(stalling);
	});

	it("ignores a table that is still waiting for buy ins", async () => {
		const table = createTable();
		table.lastActionAt = Date.now() - BOT_CONSTANTS.HOLDEM_TURN_TIMEOUT_MS - 1000;
		storeMock.findPlayingByGame.mockResolvedValue([makeRoom(table)]);

		expect(await sweepHoldemClocks(client)).toEqual({ forced: 0 });
	});

	it("keeps sweeping when one table throws", async () => {
		const good = dealtTable();
		good.lastActionAt = Date.now() - BOT_CONSTANTS.HOLDEM_TURN_TIMEOUT_MS - 1000;
		const broken = makeRoom(dealtTable());
		(broken as { secret: unknown }).secret = { status: "playing", seats: null };

		storeMock.findPlayingByGame.mockResolvedValue([broken, makeRoom(good)]);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

		expect(await sweepHoldemClocks(client)).toEqual({ forced: 1 });
		errorSpy.mockRestore();
	});
});
