import { describe, it, expect } from "vitest";
import type { ModalSubmitInteraction } from "discord.js";
import {
	GAME_SETTING_FIELDS,
	SETTINGS_GAMES,
	buildSettingsModal,
	defaultSettings,
	matchOfRoom,
	readSettingsAnswers,
	settingWrites,
	settingsOfRoom,
	settingsTitle,
	type SettingField,
	type SettingsContext,
	type SettingsGame,
	type SettingsMode,
} from "./challengeSettings.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { maxBotSeats } from "./botSeat.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── the creation modal (2026-10 item 263 Phase 2a, R3-13) ──────────────────
// One modal per game, built by one builder from one table. What is pinned: each game carries
// exactly the fields the owner decided (decision 2), never more than Discord's five components
// (a held draft's line included), a title of 45 characters or fewer naming where the card
// posts, options that follow the server's reach and bot switch, and Edit settings showing every
// field but the match before a joiner and only the three still editable after one (decision 7).

const MAX_COMPONENTS = 5;
const MAX_TITLE = 45;

const contextFor = (game: SettingsGame, overrides: Partial<SettingsContext> = {}): SettingsContext => ({
	game,
	reach: "network",
	botsAllowed: true,
	hasRatedChannel: true,
	...overrides,
});

type ModalJson = { title: string; custom_id: string; components: Array<{ type: number; content?: string; label?: string; component?: ModalComponentJson }> };
type ModalComponentJson = { custom_id: string; type: number; min_values?: number; max_values?: number; required?: boolean; value?: string; options?: Array<{ value: string; default?: boolean }> };

function modalJson(game: SettingsGame, mode: SettingsMode = { kind: "create" }, context: Partial<SettingsContext> = {}, notice: string | null = null): ModalJson {
	const fullContext = contextFor(game, context);
	return buildSettingsModal(fullContext, { customId: `gameroom:newok:${game}`, mode, values: defaultSettings(fullContext), notice }).modal.toJSON() as unknown as ModalJson;
}

const fieldIds = (json: ModalJson): string[] => json.components.flatMap((entry) => (entry.component ? [entry.component.custom_id] : []));
const fieldOf = (json: ModalJson, id: string): ModalComponentJson | undefined => json.components.find((entry) => entry.component?.custom_id === id)?.component;
const optionValues = (json: ModalJson, id: string): string[] => fieldOf(json, id)?.options?.map((option) => option.value) ?? [];

// Owner decision 6, game by game, each ending with Dero voice (2026-10 item 267, decision 10).
const DECIDED: Record<SettingsGame, SettingField[]> = {
	coinflip: ["join", "watch", "opponent", "voice"],
	diceroll: ["join", "watch", "opponent", "voice"],
	rps: ["join", "watch", "opponent", "voice"],
	hangman: ["join", "watch", "voice"],
	blackjack: ["join", "watch", "buyIn", "voice"],
	battleship: ["join", "watch", "match", "voice"],
	holdem: ["join", "watch", "match", "buyIn", "voice"],
	monopoly: ["join", "watch", "match", "auctions", "voice"],
};

describe("each game's creation modal", () => {
	for (const game of SETTINGS_GAMES) {
		it(`${game} holds its decided fields in at most ${MAX_COMPONENTS} components, with or without a held draft's line`, () => {
			const plain = modalJson(game);
			expect(fieldIds(plain)).toEqual(DECIDED[game]);
			expect(plain.components.length).toBeLessThanOrEqual(MAX_COMPONENTS);

			const held = modalJson(game, { kind: "create" }, {}, gameRoomsCopy.confirms.replaceDraft(null));
			expect(held.components.length).toBeLessThanOrEqual(MAX_COMPONENTS);
			expect(held.components[0].content).toBe(gameRoomsCopy.confirms.replaceDraft(null));
		});

		it(`${game}'s title fits ${MAX_TITLE} characters and names where its card posts`, () => {
			const title = modalJson(game).title;
			expect(title.length).toBeLessThanOrEqual(MAX_TITLE);
			const rated = game === "holdem" || game === "battleship" || game === "monopoly";
			expect(title).toContain(rated ? "#rated-challenges" : "#challenges");
		});
	}

	it("gives Dero voice's slot to a held draft's line on the two five field games, and keeps it everywhere else", () => {
		expect(fieldIds(modalJson("holdem", { kind: "create" }, {}, "held"))).toEqual(["join", "watch", "match", "buyIn"]);
		expect(fieldIds(modalJson("monopoly", { kind: "create" }, {}, "held"))).toEqual(["join", "watch", "match", "auctions"]);
		for (const game of SETTINGS_GAMES) {
			if (DECIDED[game].length < MAX_COMPONENTS) expect(fieldIds(modalJson(game, { kind: "create" }, {}, "held"))).toContain("voice");
		}
	});

	it("puts Dero voice on every game's modal", () => {
		for (const game of SETTINGS_GAMES) expect(fieldIds(modalJson(game))).toContain("voice");
	});

	it("names #challenges in a rated game's title while the server has no 🏆rated-challenges", () => {
		expect(modalJson("holdem", { kind: "create" }, { hasRatedChannel: false }).title).toContain("#challenges");
	});

	it("matches the owner's example title, shortened to fit", () => {
		expect(settingsTitle(contextFor("hangman"), { kind: "create" })).toBe("Start Hangman, card posts in #challenges");
		// "Start Battleship, card posts in #rated-challenges" is 49 characters, past Discord's 45.
		expect(settingsTitle(contextFor("battleship"), { kind: "create" })).toBe("Start Battleship in #rated-challenges");
		expect(settingsTitle(contextFor("holdem"), { kind: "create" })).toBe("Start Texas hold em in #rated-challenges");
	});
});

describe("the options", () => {
	it("offers Open to all only within the reach, and the network only at network reach for a game it mirrors", () => {
		expect(optionValues(modalJson("holdem"), "join")).toEqual(["invite", "public", "approve", "network"]);
		expect(optionValues(modalJson("holdem", { kind: "create" }, { reach: "server" }), "join")).toEqual(["invite", "public", "approve"]);
		expect(optionValues(modalJson("holdem", { kind: "create" }, { reach: "invite-only" }), "join")).toEqual(["invite"]);
		expect(optionValues(modalJson("monopoly"), "join")).not.toContain("network");
	});

	it("offers the three spectator settings on every game", () => {
		for (const game of SETTINGS_GAMES) expect(optionValues(modalJson(game), "watch")).toEqual(["open", "invite", "none"]);
	});

	it("offers one Casual option per Dero bot count up to the game's limit, only where a bot may sit", () => {
		const rated = ["rated-any", "rated-close", "rated-tight", "casual"];
		expect(optionValues(modalJson("holdem"), "match")).toEqual([...rated, "casual-bots-1", "casual-bots-2", "casual-bots-3", "casual-bots-4", "casual-bots-5"]);
		expect(optionValues(modalJson("monopoly"), "match")).toEqual([...rated, ...Array.from({ length: maxBotSeats("monopoly") }, (_, index) => `casual-bots-${index + 1}`)]);
		expect(optionValues(modalJson("battleship"), "match")).toEqual([...rated, "casual-bots-1"]);
		expect(optionValues(modalJson("monopoly", { kind: "create" }, { botsAllowed: false }), "match")).toEqual(rated);
	});

	it("labels each bot count from the count, never typed per number", () => {
		const labels = fieldOf(modalJson("holdem"), "match")?.options?.slice(4).map((option) => (option as { label?: string }).label);
		expect(labels).toEqual([1, 2, 3, 4, 5].map((count) => gameRoomsCopy.creation.fields.match.casualBots.label(count)));
		expect(labels?.slice(0, 2)).toEqual(["Casual, 1 Dero bot", "Casual, 2 Dero bots"]);
	});

	it("opens rated at any rating, Dero voice on for Hold'em and off elsewhere, Monopoly's auctions off, against anyone", () => {
		const chosen = (json: ModalJson, id: string) => fieldOf(json, id)?.options?.filter((option) => option.default).map((option) => option.value);
		expect(chosen(modalJson("holdem"), "match")).toEqual(["rated-any"]);
		expect(chosen(modalJson("holdem"), "voice")).toEqual(["on"]);
		for (const game of SETTINGS_GAMES) if (game !== "holdem") expect(chosen(modalJson(game), "voice")).toEqual(["off"]);
		expect(chosen(modalJson("monopoly"), "auctions")).toEqual(["off"]);
		expect(chosen(modalJson("rps"), "opponent")).toEqual(["anyone"]);
	});

	it("makes Monopoly's auctions and every game's Dero voice an On or Off select", () => {
		expect(optionValues(modalJson("monopoly"), "auctions")).toEqual(["on", "off"]);
		for (const game of SETTINGS_GAMES) expect(optionValues(modalJson(game), "voice")).toEqual(["on", "off"]);
	});

	it("states the buy in's allowed range in its placeholder", () => {
		const buyIn = fieldOf(modalJson("holdem"), "buyIn") as (ModalComponentJson & { placeholder?: string }) | undefined;
		expect(buyIn?.placeholder).toBe(gameRoomsCopy.creation.fields.buyIn.placeholder(200, 1_000_000, 1_000));
	});
});

describe("Edit settings (owner decision 7)", () => {
	it("shows every field but the match until somebody joins", () => {
		expect(fieldIds(modalJson("holdem", { kind: "edit", hasJoiner: false }))).toEqual(["join", "watch", "buyIn", "voice"]);
		expect(fieldIds(modalJson("monopoly", { kind: "edit", hasJoiner: false }))).toEqual(["join", "watch", "auctions", "voice"]);
		expect(fieldIds(modalJson("rps", { kind: "edit", hasJoiner: false }))).toEqual(["join", "watch", "opponent", "voice"]);
	});

	it("shows only Who may watch, Auctions and Dero voice once somebody joined", () => {
		expect(fieldIds(modalJson("holdem", { kind: "edit", hasJoiner: true }))).toEqual(["watch", "voice"]);
		expect(fieldIds(modalJson("monopoly", { kind: "edit", hasJoiner: true }))).toEqual(["watch", "auctions", "voice"]);
		expect(fieldIds(modalJson("battleship", { kind: "edit", hasJoiner: true }))).toEqual(["watch", "voice"]);
	});

	it("prefills the draft's own values", () => {
		const room = { visibility: "public", network: false, requireApproval: true, spectatorMode: "none", casual: false, botSeats: 0, ratingBand: "tight", holdemBuyIn: 5_000, referee: false, monopolyAuctions: true } as unknown as IGameRoom;
		const values = settingsOfRoom(room);
		expect(values).toMatchObject({ join: "approve", watch: "none", match: "rated-tight", buyIn: "5000", voice: false, auctions: true });

		const json = buildSettingsModal(contextFor("holdem"), { customId: "gameroom:editok:room-1", mode: { kind: "edit", hasJoiner: false }, values }).modal.toJSON() as unknown as ModalJson;
		expect(fieldOf(json, "buyIn")?.value).toBe("5000");
		expect(fieldOf(json, "voice")?.options?.find((option) => option.default)?.value).toBe("off");
		expect(json.title).toBe("Edit your Texas hold em challenge");
	});

	it("reads a casual draft's match back, with or without its bots", () => {
		expect(matchOfRoom({ casual: true, botSeats: 0, ratingBand: "any" })).toBe("casual");
		expect(matchOfRoom({ casual: true, botSeats: 2, ratingBand: "any" })).toBe("casual-bots-2");
	});

	it("reads a row with only the old referee field through to its old choice", () => {
		expect(settingsOfRoom({ game: "holdem", referee: false, deroVoice: null } as unknown as IGameRoom).voice).toBe(false);
		expect(settingsOfRoom({ game: "monopoly", referee: null, monopolyReferee: true } as unknown as IGameRoom).voice).toBe(true);
		expect(settingsOfRoom({ game: "monopoly", referee: true, deroVoice: false } as unknown as IGameRoom).voice).toBe(false);
	});
});

describe("reading a Submit back", () => {
	function submitOf(values: Record<string, string | string[]>): ModalSubmitInteraction {
		return {
			fields: {
				getStringSelectValues: (id: string) => {
					const value = values[id];
					if (value === undefined) throw new Error("no field");
					return Array.isArray(value) ? value : [value];
				},
				getTextInputValue: (id: string) => {
					const value = values[id];
					if (typeof value !== "string") throw new Error("no field");
					return value;
				},
			},
		} as unknown as ModalSubmitInteraction;
	}

	it("reads every field the modal showed over the defaults", () => {
		const context = contextFor("monopoly");
		const read = readSettingsAnswers(submitOf({ join: "invite", watch: "none", match: "casual-bots-3", auctions: "on", voice: "on" }), context, GAME_SETTING_FIELDS.monopoly, defaultSettings(context));
		expect(read).toMatchObject({ join: "invite", watch: "none", match: "casual-bots-3", auctions: true, voice: true });
	});

	it("refuses a bot count past the game's limit, or none, as a forged Submit", () => {
		const context = contextFor("battleship");
		for (const match of ["casual-bots-2", "casual-bots-0", "casual-bots-x", "casual-bots"]) {
			expect(readSettingsAnswers(submitOf({ match }), context, GAME_SETTING_FIELDS.battleship, defaultSettings(context)).match).toBe("rated-any");
		}
	});

	it("keeps the defaults for a value no option has, which only a forged Submit sends", () => {
		const context = contextFor("holdem");
		const read = readSettingsAnswers(submitOf({ join: "everyone", match: "ranked", voice: "maybe", buyIn: " 5,000 " }), context, GAME_SETTING_FIELDS.holdem, defaultSettings(context));
		expect(read).toMatchObject({ join: "public", match: "rated-any", voice: true, buyIn: "5,000" });
	});

	it("names the draft fields each setting writes through the card's functions", () => {
		expect(settingWrites("join")).toEqual(["visibility", "network", "requireApproval"]);
		expect(settingWrites("match")).toEqual(["casual", "botSeats", "ratingBand"]);
		expect(settingWrites("auctions")).toEqual(["monopolyAuctions"]);
		expect(settingWrites("voice")).toEqual(["deroVoice"]);
	});
});
