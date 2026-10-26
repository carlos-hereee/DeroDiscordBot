import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TextChannel, type ButtonInteraction, type ModalSubmitInteraction } from "discord.js";

vi.mock("@db/stores/partyGameStore.js", () => ({
	partyGameStore: { create: vi.fn(), findById: vi.fn(), setMessages: vi.fn(), attend: vi.fn(), decline: vi.fn() },
}));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn() } }));
vi.mock("@utils/permissions.js", () => ({ gateOwnerOrAdmin: vi.fn() }));
vi.mock("@features/setup/adminLog.js", () => ({ adminLog: { emit: vi.fn(), emitFor: vi.fn() } }));

import {
	buildScheduleModal,
	capCrossing,
	handleRsvpButton,
	handleScheduleSubmit,
	isPartyOver,
	parsePartyGameForm,
	rsvpCard,
	PARTY_GAMES,
	PARTY_RSVP_PREFIX,
} from "./partyGamesSchedule.js";
import { partyGameStore } from "@db/stores/partyGameStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { gateOwnerOrAdmin } from "@utils/permissions.js";
import { adminLog } from "@features/setup/adminLog.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { PARTY_GAME_SLUGS, PartyGame, type IPartyGame } from "@db/models/PartyGame.js";

// ── partyGamesSchedule (post-launch plan item 3) ─────────────────────
// The schedule form's rules, the RSVP card, the cap that Mongo enforces and the two
// admin log moments. Every refusal is paired with the case that gets through.

const words = gameRoomsCopy.partyGames;
const NOW = new Date("2026-10-24T12:00:00.000Z");
const storeMock = partyGameStore as unknown as Record<"create" | "findById" | "setMessages" | "attend" | "decline", ReturnType<typeof vi.fn>>;
const configMock = guildConfigStore as unknown as { findByGuildId: ReturnType<typeof vi.fn> };
const gateMock = gateOwnerOrAdmin as unknown as ReturnType<typeof vi.fn>;
const logMock = adminLog as unknown as { emit: ReturnType<typeof vi.fn>; emitFor: ReturnType<typeof vi.fn> };

const form = (overrides: Partial<{ game: string | undefined; start: string; duration: string; max: string }> = {}) => ({
	game: "hangman",
	start: "10/31 @19:00",
	duration: "30",
	max: "20",
	...overrides,
});

function makeRow(overrides: Partial<IPartyGame> = {}): IPartyGame {
	return {
		guildId: "guild-1",
		partyGameId: "pg-1",
		game: "hangman",
		hostId: "host-1",
		startAt: new Date("2026-10-31T19:00:00.000Z"),
		durationMinutes: 30,
		maxAttendees: 2,
		attendeeIds: [],
		declinedIds: [],
		rsvpChannelId: null,
		rsvpMessageId: null,
		announcementMessageId: null,
		openedAt: null,
		openedLink: null,
		openFailure: null,
		createdAt: NOW,
		...overrides,
	};
}

afterEach(() => vi.useRealTimers());

beforeEach(() => {
	vi.clearAllMocks();
	gateMock.mockResolvedValue(true);
	configMock.findByGuildId.mockResolvedValue({ partyGamesChannelId: "ch-party", announcementsChannelId: "ch-announce", nextDecreeChannelId: "ch-upcoming" });
});

describe("parsePartyGameForm", () => {
	it("reads a full form into a party game", () => {
		const result = parsePartyGameForm(form(), NOW);
		expect(result).toEqual({
			ok: true,
			form: { game: "hangman", startAt: new Date("2026-10-31T19:00:00.000Z"), durationMinutes: 30, maxAttendees: 20 },
		});
	});

	it("refuses a game not on the list, and a start it cannot read", () => {
		expect(parsePartyGameForm(form({ game: "chess" }), NOW)).toEqual({ ok: false, error: words.badGame });
		expect(parsePartyGameForm(form({ game: undefined }), NOW)).toEqual({ ok: false, error: words.badGame });
		expect(parsePartyGameForm(form({ start: "tomorrow" }), NOW)).toEqual({ ok: false, error: words.badStart });
	});

	it("refuses a time already past this month, but reads an earlier month as next year", () => {
		expect(parsePartyGameForm(form({ start: "10/24 @09:00" }), NOW)).toEqual({ ok: false, error: words.pastStart });
		const january = parsePartyGameForm(form({ start: "01/02 @18:00" }), NOW);
		expect(january.ok && january.form.startAt.toISOString()).toBe("2027-01-02T18:00:00.000Z");
	});

	it("holds the length to its bounds and to whole minutes", () => {
		const min = BOT_CONSTANTS.PARTY_GAME_MIN_DURATION_MINUTES;
		const max = BOT_CONSTANTS.PARTY_GAME_MAX_DURATION_MINUTES;
		expect(parsePartyGameForm(form({ duration: String(min - 1) }), NOW)).toEqual({ ok: false, error: words.badDuration(min, max) });
		expect(parsePartyGameForm(form({ duration: String(max + 1) }), NOW)).toEqual({ ok: false, error: words.badDuration(min, max) });
		expect(parsePartyGameForm(form({ duration: "12.5" }), NOW).ok).toBe(false);
		expect(parsePartyGameForm(form({ duration: String(max) }), NOW).ok).toBe(true);
	});

	it("takes 0 as no limit and refuses a cap past the ceiling", () => {
		const ceiling = BOT_CONSTANTS.PARTY_GAME_MAX_ATTENDEES;
		const none = parsePartyGameForm(form({ max: "0" }), NOW);
		expect(none.ok && none.form.maxAttendees).toBe(0);
		expect(parsePartyGameForm(form({ max: String(ceiling + 1) }), NOW)).toEqual({ ok: false, error: words.badMax(ceiling) });
		expect(parsePartyGameForm(form({ max: "-1" }), NOW).ok).toBe(false);
	});
});

// ── Hold'em and Monopoly at a party (2026-10 item 254, Arcade 4) ──
describe("the party game list", () => {
	it("offers hangman, Texas hold em and Monopoly, the same list the model stores", () => {
		expect([...PARTY_GAMES]).toEqual(["hangman", "holdem", "monopoly"]);
		// The model cannot import the feature, so the two lists are a hand kept pair.
		expect([...PARTY_GAMES]).toEqual([...PARTY_GAME_SLUGS]);
		expect(PartyGame.schema.path("game").options.enum).toEqual([...PARTY_GAME_SLUGS]);
	});

	it("reads a Hold'em or a Monopoly party from the form", () => {
		for (const game of ["holdem", "monopoly"]) {
			const result = parsePartyGameForm(form({ game }), NOW);
			expect(result.ok && result.form.game).toBe(game);
		}
	});

	it("puts all three games in the schedule modal's list", () => {
		const json = JSON.stringify(buildScheduleModal().toJSON());
		for (const game of PARTY_GAMES) expect(json).toContain(`"value":"${game}"`);
		expect(json).toContain(`"label":"${words.gameLabels.holdem}"`);
		expect(json).toContain(`"label":"${words.gameLabels.monopoly}"`);
	});
});

describe("buildScheduleModal", () => {
	it("fills in the owner's defaults", () => {
		const json = JSON.stringify(buildScheduleModal().toJSON());
		expect(json).toContain(`"value":"${BOT_CONSTANTS.PARTY_GAME_DEFAULT_DURATION_MINUTES}"`);
		expect(json).toContain(`"value":"${BOT_CONSTANTS.PARTY_GAME_DEFAULT_MAX_ATTENDEES}"`);
	});
});

describe("rsvpCard", () => {
	it("lists who is coming against the cap, and both buttons carry the game's id", () => {
		const { embeds, components } = rsvpCard(makeRow({ attendeeIds: ["a"], declinedIds: ["b", "c"] }), "ch-party");
		const fields = embeds[0].toJSON().fields ?? [];
		expect(fields[0]).toEqual({ name: words.attendingTitle(1, 2), value: "<@a>" });
		expect(fields[1]).toEqual({ name: words.decliningTitle(2), value: "<@b>, <@c>" });
		const ids = components[0].toJSON().components.map((button) => ("custom_id" in button ? button.custom_id : ""));
		expect(ids).toEqual([`${PARTY_RSVP_PREFIX}:yes:pg-1`, `${PARTY_RSVP_PREFIX}:no:pg-1`]);
	});

	it("links the game once it opened, and says why when it could not", () => {
		const description = (row: IPartyGame): string => rsvpCard(row, "ch-party").embeds[0].toJSON().description ?? "";
		expect(description(makeRow())).not.toContain(words.openedLine(""));
		const link = "https://discord.com/channels/guild-1/ch-rated/msg-1";
		expect(description(makeRow({ game: "holdem", openedLink: link }))).toContain(words.openedLine(link));
		expect(description(makeRow({ game: "holdem", openFailure: "alreadyHosting" }))).toContain(words.notOpenedLine(words.openFailures.alreadyHosting));
	});

	it("summarises a list longer than the card names", () => {
		const shown = BOT_CONSTANTS.PARTY_GAME_NAMES_SHOWN;
		const ids = Array.from({ length: shown + 3 }, (_, index) => `m${index}`);
		const value = (rsvpCard(makeRow({ maxAttendees: 0, attendeeIds: ids }), null).embeds[0].toJSON().fields ?? [])[0].value;
		expect(value.endsWith("and 3 more")).toBe(true);
		expect(value.length).toBeLessThanOrEqual(1024);
	});
});

describe("the cap and the clock", () => {
	it("names the press that fills the list and the one that frees a seat", () => {
		expect(capCrossing(2, 1, 2)).toBe("full");
		expect(capCrossing(2, 2, 1)).toBe("reopened");
		expect(capCrossing(2, 0, 1)).toBeNull();
		expect(capCrossing(0, 50, 51)).toBeNull();
	});

	it("closes the card once the game's running time is over", () => {
		const row = makeRow();
		expect(isPartyOver(row, new Date("2026-10-31T19:29:00.000Z"))).toBe(false);
		expect(isPartyOver(row, new Date("2026-10-31T19:30:00.000Z"))).toBe(true);
	});
});

function rsvpPress(customId: string, userId = "member-1"): ButtonInteraction {
	return {
		customId,
		guildId: "guild-1",
		user: { id: userId },
		client: {},
		reply: vi.fn().mockResolvedValue(undefined),
		update: vi.fn().mockResolvedValue(undefined),
	} as unknown as ButtonInteraction;
}

describe("handleRsvpButton", () => {
	beforeEach(() => vi.useFakeTimers({ now: NOW, toFake: ["Date"] }));

	it("adds the member through the capped write and redraws the card in place", async () => {
		storeMock.findById.mockResolvedValue(makeRow());
		storeMock.attend.mockResolvedValue(makeRow({ attendeeIds: ["member-1"] }));
		const interaction = rsvpPress(`${PARTY_RSVP_PREFIX}:yes:pg-1`);

		await handleRsvpButton(interaction);

		expect(storeMock.attend).toHaveBeenCalledWith("guild-1", "pg-1", "member-1", 2);
		expect(interaction.update).toHaveBeenCalledOnce();
		expect(logMock.emit).not.toHaveBeenCalled();
	});

	it("logs, as Dero, the press that fills the list", async () => {
		storeMock.findById.mockResolvedValue(makeRow({ attendeeIds: ["a"] }));
		storeMock.attend.mockResolvedValue(makeRow({ attendeeIds: ["a", "member-1"] }));

		await handleRsvpButton(rsvpPress(`${PARTY_RSVP_PREFIX}:yes:pg-1`));

		expect(logMock.emit).toHaveBeenCalledOnce();
		expect(logMock.emit.mock.calls[0][0]).toMatchObject({ kind: "event.update", actor: { source: "dero" }, payload: { detail: words.logFull(2) } });
	});

	it("refuses a seat past the cap, which Mongo answered with null", async () => {
		storeMock.findById.mockResolvedValue(makeRow({ attendeeIds: ["a", "b"] }));
		storeMock.attend.mockResolvedValue(null);
		const interaction = rsvpPress(`${PARTY_RSVP_PREFIX}:yes:pg-1`);

		await handleRsvpButton(interaction);

		expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: words.full }));
		expect(interaction.update).not.toHaveBeenCalled();
	});

	it("records a decline, and refuses any press once the game is over", async () => {
		storeMock.findById.mockResolvedValue(makeRow());
		storeMock.decline.mockResolvedValue(makeRow({ declinedIds: ["member-1"] }));
		await handleRsvpButton(rsvpPress(`${PARTY_RSVP_PREFIX}:no:pg-1`));
		expect(storeMock.decline).toHaveBeenCalledWith("guild-1", "pg-1", "member-1");

		storeMock.findById.mockResolvedValue(makeRow({ startAt: new Date("2026-10-24T10:00:00.000Z") }));
		const late = rsvpPress(`${PARTY_RSVP_PREFIX}:yes:pg-1`);
		await handleRsvpButton(late);
		expect(late.reply).toHaveBeenCalledWith(expect.objectContaining({ content: words.over }));
	});
});

describe("handleScheduleSubmit", () => {
	beforeEach(() => vi.useFakeTimers({ now: NOW, toFake: ["Date"] }));

	function submit(values = form()): ModalSubmitInteraction {
		return {
			customId: "party_games:schedule",
			guildId: "guild-1",
			user: { id: "admin-1" },
			client: { channels: { fetch: vi.fn(async (id: string) => channels.get(id) ?? null) } },
			fields: { getStringSelectValues: () => (values.game ? [values.game] : []), getTextInputValue: (id: string) => (values as Record<string, string>)[id] },
			reply: vi.fn().mockResolvedValue(undefined),
			deferReply: vi.fn().mockResolvedValue(undefined),
			editReply: vi.fn().mockResolvedValue(undefined),
		} as unknown as ModalSubmitInteraction;
	}
	const channels = new Map<string, TextChannel>();
	const fakeChannel = (id: string) => {
		const channel = Object.create(TextChannel.prototype) as TextChannel;
		Object.assign(channel, { id, send: vi.fn().mockResolvedValue({ id: `msg-${id}` }) });
		return channel;
	};

	beforeEach(() => {
		channels.clear();
		channels.set("ch-upcoming", fakeChannel("ch-upcoming"));
		channels.set("ch-announce", fakeChannel("ch-announce"));
		storeMock.create.mockImplementation(async (row: Partial<IPartyGame>) => makeRow({ ...row, attendeeIds: [], declinedIds: [] }));
		storeMock.setMessages.mockResolvedValue(null);
	});

	it("stores the game, posts the RSVP card in 🔜upcoming-events and logs event.create", async () => {
		const interaction = submit();

		await handleScheduleSubmit(interaction);

		expect(storeMock.create).toHaveBeenCalledWith(expect.objectContaining({ guildId: "guild-1", game: "hangman", hostId: "admin-1", maxAttendees: 20, durationMinutes: 30 }));
		expect((channels.get("ch-upcoming") as unknown as { send: ReturnType<typeof vi.fn> }).send).toHaveBeenCalledOnce();
		expect(logMock.emitFor).toHaveBeenCalledWith(interaction, "guild-1", "event.create", expect.objectContaining({ subject: words.logSubject("Hangman") }));
		expect(interaction.editReply).toHaveBeenCalledWith({ content: words.scheduled("ch-upcoming") });
	});

	it("schedules a Hold'em or a Monopoly party the same way (2026-10 item 254, Arcade 4)", async () => {
		for (const game of ["holdem", "monopoly"] as const) {
			const interaction = submit(form({ game }));

			await handleScheduleSubmit(interaction);

			expect(storeMock.create).toHaveBeenLastCalledWith(expect.objectContaining({ game, hostId: "admin-1" }));
			expect(logMock.emitFor).toHaveBeenLastCalledWith(interaction, "guild-1", "event.create", expect.objectContaining({ subject: words.logSubject(words.gameLabels[game]) }));
			expect(interaction.editReply).toHaveBeenCalledWith({ content: words.scheduled("ch-upcoming") });
		}
	});

	// A modal is reachable without the button that opened it.
	it("re-gates the admin on the submit and stores nothing for anyone else", async () => {
		gateMock.mockResolvedValue(false);
		const interaction = submit();

		await handleScheduleSubmit(interaction);

		expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: words.adminsOnly }));
		expect(storeMock.create).not.toHaveBeenCalled();
	});

	it("answers a bad form with what to fix and stores nothing", async () => {
		const interaction = submit(form({ start: "soon" }));

		await handleScheduleSubmit(interaction);

		expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: words.badStart }));
		expect(storeMock.create).not.toHaveBeenCalled();
	});
});
