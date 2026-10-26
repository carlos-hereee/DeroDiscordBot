import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ButtonInteraction, ModalSubmitInteraction } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: { update: vi.fn(), updateSecretIf: vi.fn(), findByRoomId: vi.fn(), addPendingJoin: vi.fn() },
}));
vi.mock("@db/stores/playerRatingStore.js", () => ({ playerRatingStore: { findForPlayers: vi.fn() } }));
vi.mock("@db/stores/chipWalletStore.js", () => ({ chipWalletStore: { debit: vi.fn(), credit: vi.fn() } }));
vi.mock("./roomTrail.js", () => ({ roomTrail: { postMove: vi.fn() } }));
vi.mock("./roomLifecycle.js", () => ({ roomLifecycle: { finish: vi.fn() } }));
vi.mock("@features/leveling/awardXp.js", () => ({ awardXp: vi.fn() }));
vi.mock("@features/ratings/recordMatchRatings.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("@features/ratings/recordMatchRatings.js")>()),
	recordMatchRatings: vi.fn(),
}));

import { handleBuyIn, handleBuyInModal, handleLeaveTable, handleSetBuyIn, removeFromTable } from "./roomHoldemHandlers.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { chipWalletStore } from "@db/stores/chipWalletStore.js";
import { roomTrail } from "./roomTrail.js";
import { createTable, dealHand, joinTable, type HoldemTable } from "@features/games/holdemTable.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── a chip table's buy in and cash out (2026-10 item 250 Phase 5) ──────────
// The buy in leaves the wallet BEFORE the seat is claimed and comes back when the seat
// never lands; a refused seat costs nothing; a leave pays the stack it walked away with
// only after the leave's own write landed; the host sets the one buy in before anybody
// sits. The end of the table is holdemChips.test.ts's.

type Mock = ReturnType<typeof vi.fn>;
const storeMock = gameRoomStore as unknown as Record<"update" | "updateSecretIf" | "findByRoomId", Mock>;
const walletMock = chipWalletStore as unknown as Record<"debit" | "credit", Mock>;
const trailMock = roomTrail.postMove as unknown as Mock;
const words = gameRoomsCopy.holdem;

const HOST = "host";
const GUILD = "guild-1";

function chipTable(seated: string[] = [], buyIn = 2_500): HoldemTable {
	const table = createTable();
	table.chips = { guildId: GUILD };
	table.startingStack = buyIn;
	for (const userId of seated) joinTable(table, userId, userId);
	return table;
}

const makeRoom = (table: HoldemTable, overrides: Partial<IGameRoom> = {}): IGameRoom =>
	({
		roomId: "room-1",
		guildId: GUILD,
		game: "holdem",
		hostId: HOST,
		status: "playing",
		playerIds: [HOST, ...table.seats.map((seat) => seat.userId)],
		channelId: "ch-1",
		secret: table,
		...overrides,
	}) as unknown as IGameRoom;

function makeInteraction(userId: string): ButtonInteraction {
	return {
		guildId: GUILD,
		guild: { members: { cache: { get: () => ({ displayName: userId }) } } },
		user: { id: userId, username: userId, globalName: userId },
		client: { channels: { fetch: vi.fn().mockResolvedValue(null) } },
		reply: vi.fn().mockResolvedValue(undefined),
		deferUpdate: vi.fn().mockResolvedValue(undefined),
		showModal: vi.fn().mockResolvedValue(undefined),
	} as unknown as ButtonInteraction;
}

const replyText = (interaction: { reply: unknown }): string =>
	(((interaction.reply as Mock).mock.calls[0]?.[0] ?? {}) as { content?: string }).content ?? "";

beforeEach(() => {
	vi.clearAllMocks();
	storeMock.updateSecretIf.mockResolvedValue({});
	storeMock.findByRoomId.mockResolvedValue(null);
	walletMock.debit.mockResolvedValue({ balance: 0 });
	walletMock.credit.mockResolvedValue({ balance: 0 });
});

describe("buying in at a chip table", () => {
	it("takes the buy in from the wallet before the seat's write, and names the amount on the trail", async () => {
		const table = chipTable();

		await handleBuyIn(makeInteraction(HOST), makeRoom(table));

		expect(walletMock.debit).toHaveBeenCalledWith({ guildId: GUILD, userId: HOST }, 2_500);
		expect(walletMock.debit.mock.invocationCallOrder[0]).toBeLessThan(storeMock.updateSecretIf.mock.invocationCallOrder[0]);
		expect(trailMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ text: words.chipsSeatTaken(HOST, 2_500, 1) }));
		expect(walletMock.credit).not.toHaveBeenCalled();
	});

	it("refuses a wallet that cannot cover the buy in, writing no seat", async () => {
		walletMock.debit.mockResolvedValue(null);
		const interaction = makeInteraction(HOST);

		await handleBuyIn(interaction, makeRoom(chipTable()));

		expect(replyText(interaction)).toBe(words.notEnoughChips(2_500));
		expect(storeMock.updateSecretIf).not.toHaveBeenCalled();
	});

	it("refuses a seat the table would refuse anyway before any chips move", async () => {
		const interaction = makeInteraction("a");

		await handleBuyIn(interaction, makeRoom(chipTable(["a"])));

		expect(replyText(interaction)).toBe(words.alreadySeated);
		expect(walletMock.debit).not.toHaveBeenCalled();
	});

	it("gives the buy in back when the host changed it while the seat was being claimed", async () => {
		storeMock.updateSecretIf.mockResolvedValue(null);
		storeMock.findByRoomId.mockResolvedValue(makeRoom(chipTable([], 5_000)));
		const interaction = makeInteraction(HOST);

		await handleBuyIn(interaction, makeRoom(chipTable()));

		expect(walletMock.credit).toHaveBeenCalledWith({ guildId: GUILD, userId: HOST }, 2_500);
		expect(replyText(interaction)).toBe(`${words.buyInChanged} ${words.buyInBack}`);
	});

	it("never touches a wallet at a free play table", async () => {
		const table = createTable();

		await handleBuyIn(makeInteraction(HOST), makeRoom(table));

		expect(walletMock.debit).not.toHaveBeenCalled();
		expect(storeMock.updateSecretIf).toHaveBeenCalledOnce();
	});
});

describe("cashing out", () => {
	it("pays a player who leaves before the first deal their whole buy in, after the leave's write", async () => {
		const table = chipTable(["a", "b"]);
		const interaction = makeInteraction("a");

		await handleLeaveTable(interaction, makeRoom(table, { status: "playing" }));

		expect(walletMock.credit).toHaveBeenCalledWith({ guildId: GUILD, userId: "a" }, 2_500);
		expect(storeMock.updateSecretIf.mock.invocationCallOrder[0]).toBeLessThan(walletMock.credit.mock.invocationCallOrder[0]);
		expect(trailMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ text: words.chipsLeftTable("a", false, 2_500) }));
	});

	it("pays nothing when the leave's write lost to another move", async () => {
		storeMock.updateSecretIf.mockResolvedValue(null);
		const interaction = makeInteraction("a");

		await handleLeaveTable(interaction, makeRoom(chipTable(["a", "b"])));

		expect(walletMock.credit).not.toHaveBeenCalled();
		expect(replyText(interaction)).toBe(words.tableBusy);
	});

	it("pays a player the host removes mid tournament what they walked away with", async () => {
		const table = chipTable(["a", "b", "c"]);
		table.status = "playing";
		dealHand(table, () => 0.5);
		const stackBefore = table.seats.find((seat) => seat.userId === "c")!.stack;

		await expect(removeFromTable(makeInteraction(HOST).client, makeRoom(table), "c", HOST)).resolves.toBe("removed");

		const paid = walletMock.credit.mock.calls.find((call) => (call[0] as { userId: string }).userId === "c");
		// Folded out of a hand they never had to put more into: their stack, less any blind they had posted.
		expect(paid?.[1]).toBeGreaterThan(0);
		expect(paid?.[1]).toBeLessThanOrEqual(stackBefore + 2_500);
	});
});

describe("the host's buy in", () => {
	it("opens the modal for the host on an empty chip table", async () => {
		const interaction = makeInteraction(HOST);
		await handleSetBuyIn(interaction, makeRoom(chipTable()));
		expect(interaction.showModal).toHaveBeenCalledOnce();
	});

	it("refuses once somebody bought in, and on a free play table", async () => {
		const seated = makeInteraction(HOST);
		await handleSetBuyIn(seated, makeRoom(chipTable(["a"])));
		expect(replyText(seated)).toBe(words.buyInLocked);

		const free = makeInteraction(HOST);
		await handleSetBuyIn(free, makeRoom(createTable()));
		expect(replyText(free)).toBe(words.buyInFreeTable);
	});

	function submit(userId: string, typed: string, preset = "1000"): ModalSubmitInteraction {
		return {
			customId: "gameroomModal:hbuyin:room-1",
			guildId: GUILD,
			user: { id: userId },
			client: { channels: { fetch: vi.fn().mockResolvedValue(null) } },
			fields: { getTextInputValue: () => typed, getStringSelectValues: () => [preset] },
			reply: vi.fn().mockResolvedValue(undefined),
			deferUpdate: vi.fn().mockResolvedValue(undefined),
		} as unknown as ModalSubmitInteraction;
	}

	it("sets a typed amount on a joining table with no seat, in one guarded write", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom(chipTable()));
		storeMock.updateSecretIf.mockResolvedValue(makeRoom(chipTable([], 7_500)));

		await handleBuyInModal(submit(HOST, "7.5k"));

		const [, , expected, written] = storeMock.updateSecretIf.mock.calls[0] as [string, string, Record<string, unknown>, HoldemTable];
		expect(expected).toEqual({ "secret.status": "joining", "secret.seats": { $size: 0 } });
		expect(written.startingStack).toBe(7_500);
		expect(trailMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ text: words.buyInSet(HOST, 7_500) }));
	});

	it("uses the preset when nothing is typed, and refuses an amount outside the bounds", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom(chipTable()));
		await handleBuyInModal(submit(HOST, "", "10000"));
		expect((storeMock.updateSecretIf.mock.calls[0] as [string, string, unknown, HoldemTable])[3].startingStack).toBe(10_000);

		const tooSmall = submit(HOST, "50");
		await handleBuyInModal(tooSmall);
		expect(replyText(tooSmall)).toBe(words.buyInInvalid(200, 1_000_000));
	});

	it("refuses a submit from anybody but the host", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom(chipTable()));
		const stranger = submit("someone", "5000");
		await handleBuyInModal(stranger);
		expect(replyText(stranger)).toBe(gameRoomsCopy.board.onlyHostStarts);
		expect(storeMock.updateSecretIf).not.toHaveBeenCalled();
	});
});
