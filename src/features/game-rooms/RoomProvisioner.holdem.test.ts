import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CategoryChannel, Guild } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: {
		findOpenByHost: vi.fn(),
		countOpenInGuild: vi.fn(),
		countOpenInGuildByVisibility: vi.fn(),
		create: vi.fn(),
		setStatus: vi.fn(),
		update: vi.fn(),
		findByRoomId: vi.fn(),
	},
}));
vi.mock("@db/stores/botLogStore.js", () => ({ botLogStore: { log: vi.fn() } }));
vi.mock("@features/entitlements/gameRoomAccess.js", () => ({ checkGameRoomAccess: vi.fn() }));
// The challenge reach read a public open makes (2026-10 item 244 Phase 4); no config reads as "server".
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn().mockResolvedValue(null) } }));

import { RoomProvisioner, _clearInflightOpens, type RoomOpenInput } from "./RoomProvisioner.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { checkGameRoomAccess } from "@features/entitlements/gameRoomAccess.js";
import { createTable, joinTable } from "@features/games/holdemTable.js";
import { joiningRows, tableEmbed } from "./roomHoldem.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";

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

// The secret the provisioner stored on the row for the hold em table.
const storedTable = () => (storeMock.update.mock.calls.find((call) => "secret" in (call[2] as object))?.[2] as { secret: Record<string, unknown> }).secret;

beforeEach(() => {
	vi.clearAllMocks();
	_clearInflightOpens();
	storeMock.findOpenByHost.mockResolvedValue(null);
	storeMock.countOpenInGuild.mockResolvedValue(0);
	storeMock.create.mockResolvedValue({ roomId: "room-1", guildId: "guild-1" });
	storeMock.setStatus.mockResolvedValue({ roomId: "room-1", guildId: "guild-1", status: "playing" });
	storeMock.update.mockResolvedValue(undefined);
	(botLogStore.log as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
	(checkGameRoomAccess as ReturnType<typeof vi.fn>).mockResolvedValue({ allowed: true, privateQuota: Number.POSITIVE_INFINITY });
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
