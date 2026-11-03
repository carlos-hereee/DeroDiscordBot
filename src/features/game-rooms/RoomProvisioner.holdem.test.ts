import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CategoryChannel, Guild } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: {
		findOpenByHost: vi.fn(),
		countOpenInGuild: vi.fn(),
		countOpenInGuildByVisibility: vi.fn(),
		create: vi.fn(),
		claimForPlay: vi.fn(),
		update: vi.fn(),
		saveOpeningHoldemTable: vi.fn(),
		takeHeldBuyIn: vi.fn(),
		findByRoomId: vi.fn(),
	},
}));
vi.mock("@db/stores/botLogStore.js", () => ({ botLogStore: { log: vi.fn() } }));
vi.mock("@features/entitlements/gameRoomAccess.js", () => ({ checkGameRoomAccess: vi.fn() }));
// The challenge reach read a public open makes (2026-10 item 244 Phase 4); no config reads as "server".
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn().mockResolvedValue(null) } }));
vi.mock("@db/stores/chipWalletStore.js", () => ({ chipWalletStore: { debit: vi.fn(), credit: vi.fn() } }));
// The opening deal is roomHoldemHandlers' own (its suite pins it); here only that it is asked for.
vi.mock("./roomHoldemHandlers.js", async (importOriginal) => ({ ...(await importOriginal<object>()), dealOpeningHand: vi.fn() }));

import { RoomProvisioner, _clearInflightOpens, type RoomOpenInput } from "./RoomProvisioner.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { checkGameRoomAccess } from "@features/entitlements/gameRoomAccess.js";
import { createTable, joinTable } from "@features/games/holdemTable.js";
import { joiningRows, tableEmbed } from "./roomHoldem.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { chipWalletStore } from "@db/stores/chipWalletStore.js";
import { dealOpeningHand } from "./roomHoldemHandlers.js";

// ── a hold em room opened with terms ──────────────────────────────────
// RoomProvisioner's one additive field, holdemTerms, reaches the table it builds,
// and the joining board says the table's stack, blinds and seat cap. A room
// opened without terms (every caller but Dero's rules card) gets the standard
// table and the line it always had.

const storeMock = gameRoomStore as unknown as Record<string, ReturnType<typeof vi.fn>>;
const OWNER_TERMS = { maxSeats: 6, startingStack: 5000, smallBlind: 100, bigBlind: 200 };

function makeGuild() {
	const send = vi.fn().mockResolvedValue({ id: "message-1", pin: vi.fn().mockResolvedValue(undefined) });
	const created = { id: "room-channel-1", send, delete: vi.fn(), createInvite: vi.fn(async () => ({ code: "invite-1" })) };
	const guild = {
		id: "guild-1",
		roles: { everyone: { id: "everyone" } },
		members: { cache: { get: () => undefined } },
		client: { user: { id: "bot-1" }, channels: { fetch: vi.fn().mockResolvedValue(null) } },
		channels: { create: vi.fn(async () => created) },
	} as unknown as Guild;
	return { guild, send };
}

const category = { id: "arcade-cat", children: { cache: { map: () => [] } } } as unknown as CategoryChannel;

const input = (guild: Guild, overrides: Partial<RoomOpenInput> = {}): RoomOpenInput => ({
	guild,
	category,
	game: "holdem",
	hostId: "host-1",
	hostDisplayName: "Host",
	playerIds: ["host-1"],
	spectatorIds: [],
	visibility: "public",
	adminRoleId: null,
	...overrides,
});

// The secret the provisioner stored on the row for the hold em table, through the one write that
// also releases the held buy ins (2026-10 item 278).
const storedTable = () => storeMock.saveOpeningHoldemTable.mock.calls[0][2] as Record<string, unknown>;

beforeEach(() => {
	vi.clearAllMocks();
	_clearInflightOpens();
	storeMock.findOpenByHost.mockResolvedValue(null);
	storeMock.countOpenInGuild.mockResolvedValue(0);
	storeMock.create.mockResolvedValue({ roomId: "room-1", guildId: "guild-1" });
	// The start claim answers the row BEFORE it (a draft), and the re-read the row after it.
	storeMock.claimForPlay.mockResolvedValue({ roomId: "room-1", guildId: "guild-1", hostId: "host-1", status: "draft", buyInPaidBy: [] });
	storeMock.findByRoomId.mockResolvedValue({ roomId: "room-1", guildId: "guild-1", status: "playing" });
	storeMock.update.mockResolvedValue(undefined);
	storeMock.saveOpeningHoldemTable.mockResolvedValue({ roomId: "room-1", guildId: "guild-1", status: "playing" });
	// A held buy in is still on the row, so the pull lands and the refund pays.
	storeMock.takeHeldBuyIn.mockResolvedValue({ roomId: "room-1", guildId: "guild-1" });
	(botLogStore.log as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
	(checkGameRoomAccess as ReturnType<typeof vi.fn>).mockResolvedValue({ allowed: true, privateQuota: Number.POSITIVE_INFINITY });
	(guildConfigStore.findByGuildId as ReturnType<typeof vi.fn>).mockResolvedValue(null);
	(chipWalletStore.credit as ReturnType<typeof vi.fn>).mockResolvedValue({ balance: 0 });
});

describe("RoomProvisioner.open with holdemTerms", () => {
	it("builds the table with the terms and shows them on the joining board", async () => {
		const { guild, send } = makeGuild();
		const result = await RoomProvisioner.open(input(guild, { holdemTerms: OWNER_TERMS }));
		expect(result.ok).toBe(true);
		expect(storedTable()).toMatchObject({ status: "joining", startingStack: 5000, maxSeats: 6, smallBlind: 100, bigBlind: 200 });

		const board = send.mock.calls.map((call) => call[0]).find((payload) => payload.embeds?.[0]?.data.title === gameRoomsCopy.holdem.tableTitle) as {
			embeds: { data: { description?: string } }[];
			components: { toJSON(): { components: { label?: string }[] } }[];
		};
		expect(board.embeds[0].data.description).toContain("0 of 6 seated so far. Everyone starts with 5000 chips, blinds start at 100 and 200.");
		expect(board.components[0].toJSON().components[0].label).toBe("Buy in (5000)");
	});

	it("builds the standard table when no terms are given, exactly as before", async () => {
		const { guild, send } = makeGuild();
		await RoomProvisioner.open(input(guild));
		const table = storedTable();
		expect(table).not.toHaveProperty("startingStack");
		expect(table).not.toHaveProperty("maxSeats");
		expect(table).toMatchObject({ smallBlind: 10, bigBlind: 20 });
		const board = send.mock.calls.map((call) => call[0]).find((payload) => payload.embeds?.[0]?.data.title === gameRoomsCopy.holdem.tableTitle) as {
			embeds: { data: { description?: string } }[];
		};
		expect(board.embeds[0].data.description).toContain(gameRoomsCopy.holdem.joiningLine(0));
	});
});

// 2026-10 item 250 Phase 5: the host's Dero bots sit down before anybody buys in, named
// on the board rather than mentioned, and a table with a bot plays free.
describe("RoomProvisioner.open with Dero bots", () => {
	it("seats the bots on the table, names them on the board, and keeps them out of playerIds", async () => {
		const { guild, send } = makeGuild();
		await RoomProvisioner.open(input(guild, { botIds: ["dero-bot-red", "dero-bot-orange"] }));

		const table = storedTable() as { seats: Array<{ userId: string; username: string }>; chips?: unknown };
		expect(table.seats.map((seat) => [seat.userId, seat.username])).toEqual([
			["dero-bot-red", "Dero Red"],
			["dero-bot-orange", "Dero Orange"],
		]);
		expect(table.chips).toBeUndefined();
		const created = storeMock.create.mock.calls[0][0] as { playerIds: string[] };
		expect(created.playerIds).toEqual(["host-1"]);
		const board = send.mock.calls.map((call) => call[0]).find((payload) => payload.embeds?.[0]?.data.title === gameRoomsCopy.holdem.tableTitle) as {
			embeds: { data: { description?: string } }[];
		};
		expect(board.embeds[0].data.description).toContain("🤖 **Dero Red**");
		expect(board.embeds[0].data.description).not.toContain("<@dero-bot-red>");
	});
});

// 2026-10 item 263 R3-27: a table a challenge card opens sits everyone the card seated and
// deals at once, with no joining phase; Dero's rules card (no draftSeats) still gathers.
describe("RoomProvisioner.open for a challenge card's table", () => {
	const dealMock = dealOpeningHand as unknown as ReturnType<typeof vi.fn>;
	const boardOf = (send: ReturnType<typeof vi.fn>) =>
		send.mock.calls.map((call) => call[0]).find((payload) => payload.embeds?.[0]?.data.title === gameRoomsCopy.holdem.tableTitle) as { components: unknown[] };
	const seatsOf = () => (storedTable() as { seats: Array<{ userId: string; stack: number }> }).seats.map((seat) => [seat.userId, seat.stack]);

	// The ledger as the start claim found it: the card's payers (the host paid at Start, off it).
	const ledgerAtClaim = (payers: string[]) =>
		storeMock.claimForPlay.mockResolvedValue({ roomId: "room-1", guildId: "guild-1", hostId: "host-1", status: "draft", buyInPaidBy: payers });

	it("seats the host and two payers at the buy in they paid and deals the first hand", async () => {
		(guildConfigStore.findByGuildId as ReturnType<typeof vi.fn>).mockResolvedValue({ chipEconomyEnabled: true });
		ledgerAtClaim(["a", "b"]);
		const { guild, send } = makeGuild();

		await RoomProvisioner.open(input(guild, { draftSeats: { buyIn: 2_500, userIds: ["host-1", "a", "b"], charged: true } }));

		expect(seatsOf()).toEqual([["host-1", 2_500], ["a", 2_500], ["b", 2_500]]);
		expect(boardOf(send).components).toEqual([]);
		expect(dealMock).toHaveBeenCalledWith(guild.client, expect.objectContaining({ roomId: "room-1" }));
		// 2026-10 item 278, G2: the claim holds every buy in on the row, and the table write takes the
		// seats it pays off the held buy ins in the same update.
		expect(storeMock.claimForPlay).toHaveBeenCalledWith("guild-1", "room-1", expect.any(Object), { kind: "heldBuyIns", buyIn: 2_500, seatIds: ["host-1", "a", "b"] });
		expect(storeMock.saveOpeningHoldemTable.mock.calls[0][3]).toEqual(["host-1", "a", "b"]);
	});

	it("deals nothing when a finish landed before the opening table was saved", async () => {
		(guildConfigStore.findByGuildId as ReturnType<typeof vi.fn>).mockResolvedValue({ chipEconomyEnabled: true });
		ledgerAtClaim(["a", "host-1"]);
		storeMock.saveOpeningHoldemTable.mockResolvedValue(null);
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const { guild } = makeGuild();

		await RoomProvisioner.open(input(guild, { draftSeats: { buyIn: 2_500, userIds: ["host-1", "a"], charged: true } }));

		expect(dealMock).not.toHaveBeenCalled();
		expect(chipWalletStore.credit).not.toHaveBeenCalled();
	});

	it("seats every joiner free on a server with chips off", async () => {
		const { guild } = makeGuild();

		await RoomProvisioner.open(input(guild, { draftSeats: { buyIn: 2_500, userIds: ["host-1", "a", "b"], charged: false } }));

		expect(seatsOf()).toEqual([["host-1", 1_000], ["a", 1_000], ["b", 1_000]]);
		expect(chipWalletStore.credit).not.toHaveBeenCalled();
		expect(dealMock).toHaveBeenCalledOnce();
		// Nobody paid, so nothing is held and the table write releases nobody.
		expect(storeMock.claimForPlay.mock.calls[0][3]).toBeUndefined();
		expect(storeMock.saveOpeningHoldemTable.mock.calls[0][3]).toEqual([]);
	});

	// 2026-10 item 276, audit P3: what a card's table plays for is what its Start charged, never
	// the server's switch as it reads at the open.
	it("plays for the chips its Start charged even when chips went off since the card settled", async () => {
		ledgerAtClaim(["a"]);
		const { guild } = makeGuild();

		await RoomProvisioner.open(input(guild, { draftSeats: { buyIn: 2_500, userIds: ["host-1", "a"], charged: true } }));

		expect(seatsOf()).toEqual([["host-1", 2_500], ["a", 2_500]]);
		expect((storedTable() as { chips?: unknown }).chips).toEqual({ guildId: "guild-1" });
		expect(chipWalletStore.credit).not.toHaveBeenCalled();
	});

	it("plays free when its Start charged nobody, even when chips went on since the card settled", async () => {
		(guildConfigStore.findByGuildId as ReturnType<typeof vi.fn>).mockResolvedValue({ chipEconomyEnabled: true });
		const { guild } = makeGuild();

		await RoomProvisioner.open(input(guild, { draftSeats: { buyIn: 2_500, userIds: ["host-1", "a"], charged: false } }));

		// A chip table here would pay these unpaid stacks out of nothing when it ends.
		expect((storedTable() as { chips?: unknown }).chips).toBeUndefined();
		expect(seatsOf()).toEqual([["host-1", 1_000], ["a", 1_000]]);
	});

	// 2026-10 item 276, audit P2-13: the seats are the ledger as the start claim found it.
	it("never seats a payer the host removed while the room was built, and refunds a payer Start never read", async () => {
		(guildConfigStore.findByGuildId as ReturnType<typeof vi.fn>).mockResolvedValue({ chipEconomyEnabled: true });
		// "a" was removed and refunded after Start read the card; "c" paid after Start read it.
		ledgerAtClaim(["b", "c"]);
		const { guild } = makeGuild();

		await RoomProvisioner.open(input(guild, { draftSeats: { buyIn: 2_500, userIds: ["host-1", "a", "b"], charged: true } }));

		expect(seatsOf()).toEqual([["host-1", 2_500], ["b", 2_500]]);
		// "c" is refunded by pulling their held entry first (2026-10 item 278), so a finish racing the
		// open pays them once.
		expect(storeMock.takeHeldBuyIn.mock.calls).toEqual([["guild-1", "room-1", "c"]]);
		expect((chipWalletStore.credit as ReturnType<typeof vi.fn>).mock.calls).toEqual([[{ userId: "c" }, 2_500]]);
	});

	it("seats the host and every member beside the Dero bots (risk R8)", async () => {
		const { guild } = makeGuild();

		await RoomProvisioner.open(input(guild, { botIds: ["dero-bot-red"], draftSeats: { buyIn: 1_000, userIds: ["host-1", "a"], charged: false } }));

		expect(seatsOf().map(([userId]) => userId)).toEqual(["host-1", "a", "dero-bot-red"]);
		expect(dealMock).toHaveBeenCalledOnce();
	});

	it("lets a network table short of two seats gather from the network board instead", async () => {
		const { guild, send } = makeGuild();

		await RoomProvisioner.open(input(guild, { draftSeats: { buyIn: 1_000, userIds: ["host-1"], charged: false } }));

		expect(boardOf(send).components).not.toEqual([]);
		expect(dealMock).not.toHaveBeenCalled();
	});

	it("keeps the rules card's joining table, which deals nothing at open", async () => {
		const { guild } = makeGuild();

		await RoomProvisioner.open(input(guild, { holdemTerms: OWNER_TERMS }));

		expect(storedTable()).toMatchObject({ status: "joining", seats: [] });
		expect(dealMock).not.toHaveBeenCalled();
	});

	// The rules card writes its referee off (it registers its own dealer); everyone else leaves it
	// null, which roomTypes.refereeOn reads as the game's default (2026-10 item 263 R3-28).
	it("writes the referee the caller asked for on the new row, or null", async () => {
		const { guild } = makeGuild();
		await RoomProvisioner.open(input(guild, { referee: false }));
		expect(storeMock.create.mock.calls[0][0]).toMatchObject({ referee: false });

		_clearInflightOpens();
		await RoomProvisioner.open(input(makeGuild().guild));
		expect(storeMock.create.mock.calls[1][0]).toMatchObject({ referee: null });
	});
});

describe("the joining controls read the table's terms", () => {
	it("disable Buy in at the table's own seat cap", () => {
		const table = createTable(5, { ...OWNER_TERMS, maxSeats: 3 });
		for (let index = 0; index < 3; index++) joinTable(table, `p${index}`, "P");
		const [row] = joiningRows("room-1", table.seats.length, table).map((entry) => entry.toJSON());
		expect(row.components[0]).toMatchObject({ label: "Buy in (5000)", disabled: true });
	});

	it("keep the standard label and cap without a table, the way every caller used them", () => {
		const [row] = joiningRows("room-1", 2).map((entry) => entry.toJSON());
		expect(row.components[0]).toMatchObject({ label: "Buy in (1000)", disabled: false });
	});

	it("say the stack, blinds and seat cap while a termed table waits", () => {
		const table = createTable(5, OWNER_TERMS);
		joinTable(table, "a", "A");
		expect(tableEmbed(table, 0).data.description).toContain(
			"Buy in to take a seat. 1 of 6 seated so far. Everyone starts with 5000 chips, blinds start at 100 and 200. Chips are for this table only and vanish when it ends.",
		);
	});
});
