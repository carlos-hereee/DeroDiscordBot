import { describe, it, expect, vi, beforeEach } from "vitest";
import { TextChannel, type Client } from "discord.js";

vi.mock("@db/stores/partyGameStore.js", () => ({
	partyGameStore: { findDueToOpen: vi.fn(), claimOpen: vi.fn(), recordOpen: vi.fn() },
}));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn() } }));
vi.mock("@utils/permissions.js", () => ({ gateOwnerOrAdmin: vi.fn() }));
vi.mock("@features/setup/adminLog.js", () => ({ adminLog: { emit: vi.fn(), emitFor: vi.fn() } }));
vi.mock("@features/games/hangmanHandler.js", () => ({ startHangmanRound: vi.fn() }));
vi.mock("./challengeBoard.js", () => ({ openChallengeDraft: vi.fn() }));

import { openDuePartyGames } from "./partyGamesOpen.js";
import { partyGameStore } from "@db/stores/partyGameStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { adminLog } from "@features/setup/adminLog.js";
import { startHangmanRound } from "@features/games/hangmanHandler.js";
import { openChallengeDraft } from "./challengeBoard.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import type { IPartyGame } from "@db/models/PartyGame.js";

// ── partyGamesOpen (2026-10 item 254, Arcade 4) ─────────────────────────────
// A scheduled party game opens by itself once its time comes, hosted by the admin who
// scheduled it, exactly once however many ticks or restarts find it; the RSVP card says
// where it is, or why it could not open, and a game that could not open writes one admin
// log line. The store here keeps the real store's claim rule (openedAt matched while
// null), so a second sweep, as after a restart, finds nothing left to open.

type Mock = ReturnType<typeof vi.fn>;
const words = gameRoomsCopy.partyGames;
const storeMock = partyGameStore as unknown as Record<"findDueToOpen" | "claimOpen" | "recordOpen", Mock>;
const configMock = guildConfigStore as unknown as { findByGuildId: Mock };
const logMock = adminLog as unknown as { emit: Mock };
const hangmanMock = startHangmanRound as unknown as Mock;
const draftMock = openChallengeDraft as unknown as Mock;

const START = new Date("2026-10-31T19:00:00.000Z");
const ADMIN = "admin-1";
const CARD_URL = "https://discord.com/channels/guild-1/ch-rated/card-1";

function makeRow(overrides: Partial<IPartyGame> = {}): IPartyGame {
	return {
		guildId: "guild-1",
		partyGameId: "pg-1",
		game: "holdem",
		hostId: ADMIN,
		startAt: START,
		durationMinutes: 60,
		maxAttendees: 0,
		attendeeIds: ["a"],
		declinedIds: [],
		rsvpChannelId: "ch-upcoming",
		rsvpMessageId: "rsvp-1",
		announcementMessageId: null,
		openedAt: null,
		openedLink: null,
		openFailure: null,
		createdAt: START,
		...overrides,
	};
}

// The rows the fake store holds, with the claim the real one makes in one conditional write.
let rows: IPartyGame[] = [];
function useStore(...seeded: IPartyGame[]): void {
	rows = seeded.map((row) => ({ ...row }));
	storeMock.findDueToOpen.mockImplementation(async (now: Date) => rows.filter((row) => row.openedAt === null && row.startAt <= now));
	storeMock.claimOpen.mockImplementation(async (guildId: string, partyGameId: string, now: Date) => {
		const row = rows.find((entry) => entry.guildId === guildId && entry.partyGameId === partyGameId && entry.openedAt === null);
		if (!row) return null;
		row.openedAt = now;
		return { ...row };
	});
	storeMock.recordOpen.mockImplementation(async (guildId: string, partyGameId: string, outcome: Partial<IPartyGame>) => {
		const row = rows.find((entry) => entry.guildId === guildId && entry.partyGameId === partyGameId);
		if (!row) return null;
		Object.assign(row, outcome);
		return { ...row };
	});
}

const rsvpMessage = { edit: vi.fn() };
const rsvpChannel = Object.assign(Object.create(TextChannel.prototype) as TextChannel, { id: "ch-upcoming", messages: { fetch: vi.fn(async () => rsvpMessage) } });
const partyChannel = Object.assign(Object.create(TextChannel.prototype) as TextChannel, { id: "ch-party" });
Object.defineProperty(partyChannel, "url", { value: "https://discord.com/channels/guild-1/ch-party" });
const guild = { id: "guild-1", channels: { fetch: vi.fn(async (id: string) => (id === "ch-party" ? partyChannel : null)) } };
const client = {
	guilds: { cache: { get: (id: string) => (id === "guild-1" ? guild : undefined) }, fetch: vi.fn(async () => null) },
	channels: { fetch: vi.fn(async (id: string) => (id === "ch-upcoming" ? rsvpChannel : null)) },
} as unknown as Client;

const editedDescription = (): string => {
	const options = rsvpMessage.edit.mock.calls.at(-1)?.[0] as { embeds: { toJSON(): { description?: string } }[] };
	return options.embeds[0].toJSON().description ?? "";
};

beforeEach(() => {
	vi.clearAllMocks();
	rsvpMessage.edit.mockResolvedValue(undefined);
	configMock.findByGuildId.mockResolvedValue({ partyGamesChannelId: "ch-party" });
	draftMock.mockResolvedValue({ ok: true, card: { url: CARD_URL } });
	hangmanMock.mockResolvedValue("started");
});

describe("opening a scheduled party game at its time", () => {
	it("opens nothing before the start time", async () => {
		useStore(makeRow());

		await openDuePartyGames(client, new Date(START.getTime() - 60_000));

		expect(draftMock).not.toHaveBeenCalled();
		expect(rsvpMessage.edit).not.toHaveBeenCalled();
	});

	it("opens a Hold'em party's challenge as the admin who scheduled it, open to all, and links it on the RSVP card", async () => {
		useStore(makeRow());

		await openDuePartyGames(client, new Date(START.getTime() + 2 * 60_000));

		expect(draftMock).toHaveBeenCalledOnce();
		expect(draftMock).toHaveBeenCalledWith(guild, ADMIN, "holdem", { openToAll: true });
		expect(rows[0].openedLink).toBe(CARD_URL);
		expect(rsvpMessage.edit).toHaveBeenCalledWith(expect.objectContaining({ allowedMentions: { parse: [] } }));
		expect(editedDescription()).toContain(words.openedLine(CARD_URL));
		expect(logMock.emit).not.toHaveBeenCalled();
	});

	it("opens each game once, even when the sweep runs again after a restart", async () => {
		useStore(makeRow({ game: "monopoly" }));
		const now = new Date(START.getTime() + 60_000);

		await openDuePartyGames(client, now);
		await openDuePartyGames(client, new Date(now.getTime() + 5 * 60_000));

		expect(draftMock).toHaveBeenCalledOnce();
		expect(draftMock).toHaveBeenCalledWith(guild, ADMIN, "monopoly", { openToAll: true });
	});

	it("opens nothing when another tick claimed the game first", async () => {
		useStore(makeRow());
		storeMock.claimOpen.mockResolvedValueOnce(null);

		await openDuePartyGames(client, new Date(START.getTime() + 60_000));

		expect(draftMock).not.toHaveBeenCalled();
	});

	it("tells the RSVP card why when the admin already hosts an open room, and writes one party.open line", async () => {
		useStore(makeRow());
		draftMock.mockResolvedValue({ ok: false, reason: "alreadyHosting", channelId: "ch-their-room" });

		await openDuePartyGames(client, new Date(START.getTime() + 60_000));

		expect(rows[0].openFailure).toBe("alreadyHosting");
		expect(editedDescription()).toContain(words.notOpenedLine(words.openFailures.alreadyHosting));
		expect(logMock.emit).toHaveBeenCalledOnce();
		expect(logMock.emit).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "party.open",
				actor: { source: "dero" },
				payload: expect.objectContaining({ partyGameId: "pg-1", hostId: ADMIN, reason: "alreadyHosting" }),
			})
		);
	});

	it("opens a hangman party's round in 🎉party-games as its host", async () => {
		useStore(makeRow({ game: "hangman" }));

		await openDuePartyGames(client, new Date(START.getTime() + 60_000));

		expect(hangmanMock).toHaveBeenCalledWith(partyChannel, ADMIN);
		expect(draftMock).not.toHaveBeenCalled();
		expect(editedDescription()).toContain(words.openedLine(partyChannel.url));
	});

	it("does not open a game whose whole window passed while Dero was away, and never claims it twice", async () => {
		useStore(makeRow({ durationMinutes: 30 }));

		await openDuePartyGames(client, new Date(START.getTime() + 2 * 60 * 60_000));
		await openDuePartyGames(client, new Date(START.getTime() + 3 * 60 * 60_000));

		expect(draftMock).not.toHaveBeenCalled();
		expect(storeMock.claimOpen).toHaveBeenCalledOnce();
		expect(rows[0].openedAt).not.toBeNull();
	});

	it("never throws into the sweep it rides when the read fails", async () => {
		storeMock.findDueToOpen.mockRejectedValue(new Error("mongo down"));
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

		await expect(openDuePartyGames(client, START)).resolves.toBeUndefined();

		error.mockRestore();
	});
});
