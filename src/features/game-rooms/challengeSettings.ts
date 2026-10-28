import type { ModalBuilder, ModalSubmitInteraction } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { bandWidth, isRatedGame } from "@features/ratings/ratingEngine.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { buildFieldsModal, readFieldAnswers, type FieldOption, type ModalField } from "./pickerModal.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { isWithinReach } from "./challengeReach.js";
import { takesBots } from "./botSeat.js";
import { effectiveSpectatorMode } from "./roomPermissions.js";
import { SPECTATOR_MODES, refereeOn, type ChallengeReach, type GameSlug, type RatingBand, type SpectatorMode } from "./roomTypes.js";

// ── challengeSettings ────────────────────────────────────────────────
// What:  the one creation modal every game starts from (2026-10 item 263 Phase 2a, R3-13):
//        a per game table naming each game's fields, their options, their defaults and the
//        draft fields each writes, and the one builder that renders it through
//        pickerModal.buildFieldsModal, for a new challenge and for the card's Edit settings.
// Who:   challengeBoard, which opens the modal at a start press or an Edit settings press and
//        reads it back on the Submit.
// Does NOT: write anything. A Submit's choices are applied by challengeBoard through the very
//        functions the card's own buttons and selects call (owner decision 3, fold never fork),
//        so a setting has one path onto the draft however the host made it.
// How:   pure, so the press can build the modal from constants plus the reads it already made
//        (the host's open room and one GuildConfig read), inside Discord's three seconds.

// ── which games have a card, and their fields ──
// Every game whose start posts a challenge card: the board's seven, and a multi seat
// Blackjack table (the 🕹️games host's Open a Blackjack table, 2026-10 item 254, Arcade 1).
export const SETTINGS_GAMES = ["coinflip", "diceroll", "rps", "hangman", "battleship", "holdem", "monopoly", "blackjack"] as const satisfies readonly GameSlug[];
export type SettingsGame = (typeof SETTINGS_GAMES)[number];
export const isSettingsGame = (game: string): game is SettingsGame => (SETTINGS_GAMES as readonly string[]).includes(game);

/** One setting of the creation modal; its name is also its field id on the modal. */
export type SettingField = "join" | "watch" | "match" | "buyIn" | "referee" | "table" | "opponent";

/**
 * Each game's fields, in the order the modal shows them (owner decision 6, Round 3 decision
 * 2). Every game has Who can join and Who may watch; the rated games add The match; Hold'em
 * its Buy in and Referee; Monopoly its Table options; the luck games Who you play. Five at
 * most, Discord's ceiling for one modal, which the creation modal test counts per game.
 */
export const GAME_SETTING_FIELDS: Record<SettingsGame, readonly SettingField[]> = {
	coinflip: ["join", "watch", "opponent"],
	diceroll: ["join", "watch", "opponent"],
	rps: ["join", "watch", "opponent"],
	hangman: ["join", "watch"],
	blackjack: ["join", "watch"],
	battleship: ["join", "watch", "match"],
	holdem: ["join", "watch", "match", "buyIn", "referee"],
	monopoly: ["join", "watch", "match", "table"],
};

// ── the choices ──
export const JOIN_CHOICES = ["invite", "public", "approve", "network"] as const;
export type JoinChoice = (typeof JOIN_CHOICES)[number];
export const MATCH_CHOICES = ["rated-any", "rated-close", "rated-tight", "casual", "casual-bots"] as const;
export type MatchChoice = (typeof MATCH_CHOICES)[number];
export const OPPONENT_CHOICES = ["anyone", "dero"] as const;
export type OpponentChoice = (typeof OPPONENT_CHOICES)[number];
const TABLE_OPTIONS = ["auctions", "referee"] as const;
const SWITCH_VALUES = { on: "on", off: "off" } as const;

/** Every setting a creation modal can carry, whatever the game shows of it. */
export interface ChallengeSettings {
	join: JoinChoice;
	watch: SpectatorMode;
	match: MatchChoice;
	// What the host typed, trimmed; empty means the standard stack.
	buyIn: string;
	referee: boolean;
	auctions: boolean;
	opponent: OpponentChoice;
}

/** What the modal's options depend on: the game, the server's challenge reach and bot switch, and whether 🏆rated-challenges exists. */
export interface SettingsContext {
	game: SettingsGame;
	reach: ChallengeReach;
	botsAllowed: boolean;
	hasRatedChannel: boolean;
}

/** Which modal: a new challenge's, or the card's Edit settings (and whether somebody has joined, owner decision 7). */
export type SettingsMode = { kind: "create" } | { kind: "edit"; hasJoiner: boolean };

// ── what each field writes and when Edit settings offers it ──
// `writes` names the draft row fields each setting ends up in, through the card's choice
// functions; the table is documentation the tests hold to, never a second write path.
interface FieldSpec {
	writes: readonly (keyof IGameRoom)[];
	// Owner decision 7: the match is fixed at creation and never on the edit modal.
	onEdit: boolean;
	// Owner decision 7: once somebody joined, only Who may watch, Referee and Table options remain.
	afterJoiner: boolean;
	build: (context: SettingsContext, values: ChallengeSettings) => ModalField;
}

const words = gameRoomsCopy.creation;

const option = (value: string, text: { label: string; description: string }): FieldOption => ({ value, label: text.label, description: text.description });

/** The channel a card of this game and match posts in, by name, as the modal says it. */
function channelNameFor(context: SettingsContext, casual: boolean): string {
	return isRatedGame(context.game) && !casual && context.hasRatedChannel ? words.channelNames.rated : words.channelNames.challenges;
}

// The visibilities a host may pick: Open to all (and its approving form) only within the
// server's reach, the network only for a game a satellite mirrors on a network server. The
// choice is refused again on the Submit by the card's own function, for a reach changed meanwhile.
function joinOptions(context: SettingsContext): FieldOption[] {
	const join = words.fields.join;
	const options = [option("invite", join.invite)];
	if (isWithinReach(context.reach, "public")) options.push(option("public", join.public), option("approve", join.approve));
	if (context.reach === "network" && (BOT_CONSTANTS.NETWORK_GAMES as readonly string[]).includes(context.game)) options.push(option("network", join.network));
	return options;
}

function matchOptions(context: SettingsContext): FieldOption[] {
	const match = words.fields.match;
	const options: FieldOption[] = [
		{ value: "rated-any", label: match.ratedAny.label, description: match.ratedAny.description(channelNameFor(context, false)) },
		{ value: "rated-close", label: match.ratedClose.label, description: match.ratedClose.description(bandWidth("close") ?? 0) },
		{ value: "rated-tight", label: match.ratedTight.label, description: match.ratedTight.description(bandWidth("tight") ?? 0) },
		{ value: "casual", label: match.casual.label, description: match.casual.description(channelNameFor(context, true)) },
	];
	// Filling the seats with Dero bots is offered only where a bot may sit (botSeat.takesBots
	// and the server's switch), the same doors Play vs bots keeps.
	if (takesBots(context.game) && context.botsAllowed) options.push({ value: "casual-bots", label: match.casualBots.label, description: match.casualBots.description });
	return options;
}

const FIELD_SPECS: Record<SettingField, FieldSpec> = {
	join: {
		writes: ["visibility", "network", "requireApproval"],
		onEdit: true,
		afterJoiner: false,
		build: (context, values) => {
			const options = joinOptions(context);
			// A prefilled choice the reach no longer offers falls back to what it does offer.
			const value = options.some((entry) => entry.value === values.join) ? values.join : options[0].value;
			return { kind: "select", id: "join", label: words.fields.join.label, options, value };
		},
	},
	watch: {
		writes: ["spectatorMode"],
		onEdit: true,
		afterJoiner: true,
		build: (_context, values) => ({
			kind: "select",
			id: "watch",
			label: words.fields.watch.label,
			options: SPECTATOR_MODES.map((mode) => option(mode, gameRoomsCopy.board.spectators.options[mode])),
			value: values.watch,
		}),
	},
	match: {
		writes: ["casual", "botSeats", "ratingBand"],
		onEdit: false,
		afterJoiner: false,
		build: (context, values) => {
			const options = matchOptions(context);
			const value = options.some((entry) => entry.value === values.match) ? values.match : "rated-any";
			return { kind: "select", id: "match", label: words.fields.match.label, options, value };
		},
	},
	buyIn: {
		writes: ["holdemBuyIn"],
		onEdit: true,
		afterJoiner: false,
		build: (_context, values) => {
			const economy = BOT_CONSTANTS.ECONOMY;
			return {
				kind: "text",
				id: "buyIn",
				label: words.fields.buyIn.label,
				placeholder: words.fields.buyIn.placeholder(economy.HOLDEM_MIN_BUY_IN, economy.HOLDEM_MAX_BUY_IN, BOT_CONSTANTS.HOLDEM_STARTING_STACK),
				// The longest amount the buy in validation accepts, with its thousands commas, fits in 12.
				maxLength: 12,
				value: values.buyIn,
			};
		},
	},
	referee: {
		writes: ["referee"],
		onEdit: true,
		afterJoiner: true,
		build: (_context, values) => ({
			kind: "select",
			id: "referee",
			label: words.fields.referee.label,
			options: [option(SWITCH_VALUES.on, words.fields.referee.on), option(SWITCH_VALUES.off, words.fields.referee.off)],
			value: values.referee ? SWITCH_VALUES.on : SWITCH_VALUES.off,
		}),
	},
	table: {
		writes: ["monopolyAuctions", "referee"],
		onEdit: true,
		afterJoiner: true,
		build: (_context, values) => ({
			kind: "multi",
			id: "table",
			label: words.fields.table.label,
			options: TABLE_OPTIONS.map((entry) => option(entry, words.fields.table[entry])),
			value: TABLE_OPTIONS.filter((entry) => (entry === "auctions" ? values.auctions : values.referee)),
		}),
	},
	opponent: {
		writes: [],
		onEdit: true,
		afterJoiner: false,
		build: (_context, values) => ({
			kind: "select",
			id: "opponent",
			label: words.fields.opponent.label,
			options: OPPONENT_CHOICES.map((entry) => option(entry, words.fields.opponent[entry])),
			value: values.opponent,
		}),
	},
};

/** The draft row fields a setting writes, for the tests that hold the table to the card's functions. */
export const settingWrites = (field: SettingField): readonly (keyof IGameRoom)[] => FIELD_SPECS[field].writes;

// ── defaults and the draft's current values ──
/**
 * A new challenge's settings before the host touches anything: Open to all where the reach
 * allows it (Invite only where it does not), watched as that visibility always defaulted,
 * rated at any rating, the standard buy in, the referee on for Hold'em (owner decision 5)
 * and Monopoly's own defaults (auctions and referee off), against anyone.
 */
export function defaultSettings(context: SettingsContext): ChallengeSettings {
	const open = isWithinReach(context.reach, "public");
	return {
		join: open ? "public" : "invite",
		watch: effectiveSpectatorMode(open ? "public" : "invite", null),
		match: "rated-any",
		buyIn: "",
		referee: context.game === "holdem",
		auctions: false,
		opponent: "anyone",
	};
}

const BAND_MATCH: Record<RatingBand, MatchChoice> = { any: "rated-any", close: "rated-close", tight: "rated-tight" };

/** A draft's settings as its row holds them, which Edit settings prefills. */
export function settingsOfRoom(room: IGameRoom): ChallengeSettings {
	return {
		join: joinOfRoom(room),
		watch: room.spectatorMode ?? effectiveSpectatorMode(room.visibility, null),
		match: matchOfRoom(room),
		buyIn: room.holdemBuyIn == null ? "" : String(room.holdemBuyIn),
		referee: refereeOn(room),
		auctions: room.monopolyAuctions ?? false,
		opponent: "anyone",
	};
}

export function joinOfRoom(room: Pick<IGameRoom, "network" | "visibility" | "requireApproval">): JoinChoice {
	if (room.network) return "network";
	if (room.visibility !== "public") return "invite";
	return room.requireApproval ? "approve" : "public";
}

export function matchOfRoom(room: Pick<IGameRoom, "casual" | "botSeats" | "ratingBand">): MatchChoice {
	if (room.casual) return (room.botSeats ?? 0) > 0 ? "casual-bots" : "casual";
	return BAND_MATCH[room.ratingBand ?? "any"];
}

/** The rating band a rated match choice sets, or null for a casual one. */
export function bandOfMatch(match: MatchChoice): RatingBand | null {
	if (match === "rated-close") return "close";
	if (match === "rated-tight") return "tight";
	return match === "rated-any" ? "any" : null;
}

// ── which fields a modal shows ──
/**
 * The fields of this game's modal: every one on a new challenge, and on Edit settings every
 * one but The match until somebody joined, then only those still editable (owner decision 7).
 */
export function settingFieldsFor(game: SettingsGame, mode: SettingsMode): SettingField[] {
	return GAME_SETTING_FIELDS[game].filter((field) => {
		if (mode.kind === "create") return true;
		const spec = FIELD_SPECS[field];
		return spec.onEdit && (!mode.hasJoiner || spec.afterJoiner);
	});
}

// Discord's ceiling on one modal's components, a text block included.
const MODAL_COMPONENT_LIMIT = 5;

/**
 * The fields left once a notice needs a slot of its own (the held draft Submit will close).
 * A setting the host can still change after anybody joins gives its place first, from the
 * end: on Hold'em's five that is the referee, which keeps its default (on) and stays on
 * Edit settings. Every other game has room for the notice already.
 */
function fitAroundNotice(fields: SettingField[], hasNotice: boolean): SettingField[] {
	const kept = [...fields];
	while (hasNotice && kept.length + 1 > MODAL_COMPONENT_LIMIT) {
		const yielding = kept.map((field, index) => ({ field, index })).reverse().find(({ field }) => FIELD_SPECS[field].afterJoiner);
		if (!yielding) break;
		kept.splice(yielding.index, 1);
	}
	return kept;
}

/** What a settings modal needs beyond its context: its routing id, which modal, the values it opens with, and an optional notice. */
export interface SettingsModalRequest {
	customId: string;
	mode: SettingsMode;
	values: ChallengeSettings;
	notice?: string | null;
}

/** A built settings modal and the fields it shows, which its Submit reads back. */
export interface SettingsModal {
	modal: ModalBuilder;
	fields: SettingField[];
}

/** Pick the first title that fits Discord's 45 characters, cutting the last one if none does. */
const MAX_MODAL_TITLE_LENGTH = 45;
function fittingTitle(candidates: readonly string[]): string {
	return candidates.find((title) => title.length <= MAX_MODAL_TITLE_LENGTH) ?? (candidates[candidates.length - 1] ?? "").slice(0, MAX_MODAL_TITLE_LENGTH);
}

/** The modal's title: the game and where its card posts at the default match, or the edit title. */
export function settingsTitle(context: SettingsContext, mode: SettingsMode): string {
	if (mode.kind === "edit") return fittingTitle(words.editTitles(context.game));
	return fittingTitle(words.titles(context.game, channelNameFor(context, false)));
}

/** The fields a settings modal shows, a notice's slot taken out; its Submit works them out again the same way. */
export function settingsModalFields(game: SettingsGame, mode: SettingsMode, hasNotice: boolean): SettingField[] {
	return fitAroundNotice(settingFieldsFor(game, mode), hasNotice);
}

/** The creation modal (or Edit settings), built from constants plus the context the press already read. */
export function buildSettingsModal(context: SettingsContext, request: SettingsModalRequest): SettingsModal {
	const fields = settingsModalFields(context.game, request.mode, Boolean(request.notice));
	return {
		fields,
		modal: buildFieldsModal({
			customId: request.customId,
			title: settingsTitle(context, request.mode),
			text: request.notice ? [request.notice] : [],
			fields: fields.map((field) => FIELD_SPECS[field].build(context, request.values)),
		}),
	};
}

// ── reading a Submit back ──
const isOneOf = <T extends string>(list: readonly T[], value: string): value is T => (list as readonly string[]).includes(value);

/**
 * The settings a Submit asks for: each field the modal showed read back over `base` (the
 * defaults, or the draft's current values), and anything missing or unknown left at `base`.
 * The values are user input whoever built the modal, so each is checked against its choices;
 * whether the server still allows a choice is the card's functions' call on the Submit.
 */
export function readSettingsAnswers(interaction: ModalSubmitInteraction, context: SettingsContext, fields: readonly SettingField[], base: ChallengeSettings): ChallengeSettings {
	const answers = readFieldAnswers(
		interaction,
		fields.map((field) => FIELD_SPECS[field].build(context, base))
	);
	const read = { ...base };
	const join = answers.join ?? "";
	if (isOneOf(JOIN_CHOICES, join)) read.join = join;
	const watch = answers.watch ?? "";
	if (isOneOf(SPECTATOR_MODES, watch)) read.watch = watch;
	const match = answers.match ?? "";
	if (isOneOf(MATCH_CHOICES, match)) read.match = match;
	if (fields.includes("buyIn")) read.buyIn = answers.buyIn ?? "";
	const referee = answers.referee ?? "";
	if (referee === SWITCH_VALUES.on || referee === SWITCH_VALUES.off) read.referee = referee === SWITCH_VALUES.on;
	if (fields.includes("table")) {
		const chosen = (answers.table ?? "").split(",");
		read.auctions = chosen.includes("auctions");
		read.referee = chosen.includes("referee");
	}
	const opponent = answers.opponent ?? "";
	if (isOneOf(OPPONENT_CHOICES, opponent)) read.opponent = opponent;
	return read;
}
