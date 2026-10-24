import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	EmbedBuilder,
	StringSelectMenuBuilder,
	type ColorResolvable,
	type MessageActionRowComponentBuilder,
} from "discord.js";
import { infoEmbed } from "@utils/embedBuilder.js";
import { COLORS } from "@base/copy/brand.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { bandWidth, isRatedGame } from "@features/ratings/ratingEngine.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { GAME_ROOM_PREFIX, GAME_ROOM_SELECT_PREFIX } from "./gameRoomActions.js";
import { RATING_BANDS, type GameSlug, type RatingBand, type RoomVisibility } from "./roomTypes.js";

// The host controls' words are shared by every pack, so the default pack is the right
// one here and the card stays a pure function of its state.
const hostWords = rokCommanderCopy.arcadeHostControls;
const networkWords = rokCommanderCopy.arcadeNetwork;

type CardRow = ActionRowBuilder<MessageActionRowComponentBuilder>;

// ── challengeBoardEmbeds ─────────────────────────────────────────────
// What:  the pinned ⚔️challenges intro, and the opener card that is edited in place
//        as one challenge moves from "choosing visibility" to "under way".
// Who:   challengeBoard.ts.
// When:  the intro once per boot (refreshIntroEmbeds keeps it current); the card on
//        every state change of a draft, including the host's controls (2026-10 item
//        244 Phase 4: the reach capped visibility step, the band, approval and Remove
//        a player), which render only when the caller passes the draft's host state,
//        and the network choice and its card line (Phase 5b).
// How:   ONE card, edited, rather than a new message per step. A challenge that
//        posted a fresh message for each of visibility, join and start would bury
//        the channel it lives in, and ⚔️challenges is meant to be scannable.

// The games the board can start. Blackjack is absent on purpose: it needs no named
// opponent and a hand takes a minute, so a table runs in place on one edited message
// and never earns a room.
//
// ⚠️ HANGMAN IS HERE BUT IS NOT HEAD TO HEAD, and the difference is load bearing at
// the start step. Coin flip, dice roll and rps seat exactly TWO, so the host picks
// one joiner to play and the rest watch. Hangman is COOPERATIVE: everyone who joined
// guesses together against a word the host wrote, so every joiner becomes a player
// and the host is the one person who does not play. See COOPERATIVE_GAMES below.
export const CHALLENGE_GAMES: readonly GameSlug[] = [
	"coinflip",
	"diceroll",
	"rps",
	"hangman",
	"battleship",
	"holdem",
	"monopoly",
] as const;

// Games whose whole pool plays rather than one chosen opponent. Declared as a set
// rather than checked inline, because the start path and the permission matrix both
// need the answer and a second `=== "hangman"` in either would be the beginning of a
// drift.
// ⚠️ HOLD EM IS COOPERATIVE ONLY IN THE NARROW SENSE THIS SET MEANS. It is fiercely
// competitive at the table, but the board's question is "does the host pick ONE
// opponent, or does the whole pool play?", and a poker tournament seats everyone.
// A better name would be MULTI_PLAYER_GAMES; the set is what matters. Monopoly is
// here for the same reason: two to six players share one board, so nobody is singled
// out, and challengeBoard.startMatch caps the pool at the board's six seats.
export const COOPERATIVE_GAMES: readonly GameSlug[] = ["hangman", "holdem", "monopoly"] as const;

export const isCooperativeGame = (game: GameSlug): boolean => COOPERATIVE_GAMES.includes(game);

/**
 * Every game's one emoji: the board's start buttons and the front of each room's
 * channel name (roomNaming) both read it, so a room and the button that opened it
 * can never disagree. A solo form shares its game's emoji, and solo blackjack takes
 * the card the arcade's Play Blackjack button already shows. Each is a single code
 * point with no variation selector, so the name Discord stores is the one the
 * collision check compares against.
 */
export const GAME_EMOJI: Record<GameSlug, string> = {
	coinflip: "🪙",
	diceroll: "🎲",
	rps: "✊",
	hangman: "🪢",
	battleship: "🚢",
	holdem: "🃏",
	monopoly: "🏠",
	"solo-hangman": "🪢",
	"solo-blackjack": "🃏",
};

export function boardIntroEmbed(): EmbedBuilder {
	return infoEmbed(
		gameRoomsCopy.board.introTitle,
		gameRoomsCopy.board.introDescription,
		COLORS.ARCADE as ColorResolvable
	);
}

// How many start buttons share one row. Discord caps an action row at FIVE components
// and rejects the whole send (50035) past that, which is what kept this board dark: six
// games in one row never posted. Three per row splits the roster where it already
// divides, the three quick two-seat games on top and the long-form games below, which
// spill onto a third row once there are more than three of them.
const BOARD_BUTTONS_PER_ROW = 3;

// One button per challenge game, chunked into rows. Carries the SLUG rather than a
// roomId, because no room exists until this is pressed. Rides 🕹️games' second
// message, the Challenge Board: GuildSetupManager.gamesBoardContent attaches these
// rows, the board is posted at first build and kept present on every boot by
// maintainGamesBoard, so a guild set up before it existed gets it without a re-run
// of /setup. stripMovedArcadeControls reads the same rows' customIds to clear them
// off a superseded ⚔️challenges intro, where the card a press opens is still posted.
export function boardStartRows(): ActionRowBuilder<ButtonBuilder>[] {
	const rows: ActionRowBuilder<ButtonBuilder>[] = [];
	for (let start = 0; start < CHALLENGE_GAMES.length; start += BOARD_BUTTONS_PER_ROW) {
		rows.push(
			new ActionRowBuilder<ButtonBuilder>().addComponents(
				...CHALLENGE_GAMES.slice(start, start + BOARD_BUTTONS_PER_ROW).map((game) =>
					new ButtonBuilder()
						.setCustomId(`${GAME_ROOM_PREFIX}:new:${game}`)
						.setLabel(gameRoomsCopy.board.startButtonLabel(game))
						.setEmoji(GAME_EMOJI[game])
						.setStyle(ButtonStyle.Primary)
				)
			)
		);
	}
	return rows;
}

export interface OpenerCardState {
	game: GameSlug;
	hostId: string;
	visibility: RoomVisibility | null;
	pool: string[];
	// Monopoly only: the host's auction and voice referee choices, each shown on the
	// card and switched by its own toggle. Ignored for every other game.
	monopolyAuctions?: boolean;
	monopolyReferee?: boolean;
	// Terminal states. When either is set the card stops offering controls.
	cancelled?: boolean;
	startedChannelId?: string | null;
	// False when the server's challenge reach is invite only (2026-10 item 244 Phase 4),
	// which drops Open to all from the visibility step. Absent offers both, the card
	// as it was; the choice is refused server side either way, since a stale card
	// still carries the button.
	allowPublic?: boolean;
	// True offers Open to the network beside Open to all (2026-10 item 244 Phase 5b): a
	// server whose reach is network, for a game a satellite can mirror. Absent offers no
	// network choice, the card as it was; the choice is refused server side either way.
	allowNetwork?: boolean;
	// True once the host opened the table to the network, which changes the card's line.
	network?: boolean;
	// The host's say over who joins (Phase 4), read off the draft row. Absent renders
	// the card exactly as it was before the controls existed.
	hostControls?: DraftHostControls;
}

/** The draft's host controls the card shows: the band, approval, and how many wait for an answer. */
export interface DraftHostControls {
	ratingBand: RatingBand;
	requireApproval: boolean;
	pendingJoinCount: number;
}

// How many pool members the card names before it summarises the rest. Well under the
// 25 member cap so the card never becomes a wall of mentions, and the copy states the
// remainder rather than silently dropping it.
const POOL_NAMES_SHOWN = 8;

// imageRef, when passed, is the challenge card's picture (the host's and the
// joiners' faces, 2026-10 item 243 Phase 4), attached to the same message by
// challengeBoard. logoRef is the game's logo (roomOpenerLogo), shown as the
// thumbnail only while there is no picture: the picture already leads with the
// logo, and the text card a failed draw leaves behind should lead with it too
// (2026-10 item 245 Phase 3b). Both refs need their files on the same message.
export function openerCardEmbed(state: OpenerCardState, imageRef?: string, logoRef?: string): EmbedBuilder {
	const lines: string[] = [];

	if (state.cancelled) {
		lines.push(gameRoomsCopy.board.cardCancelled(state.hostId));
	} else if (state.startedChannelId) {
		lines.push(gameRoomsCopy.board.cardStarted(state.startedChannelId));
	} else if (!state.visibility) {
		lines.push(gameRoomsCopy.board.cardWaitingVisibility(state.hostId));
	} else if (state.visibility === "invite") {
		lines.push(gameRoomsCopy.board.cardInviteOnly(state.hostId));
		lines.push("", gameRoomsCopy.board.cardPool(state.pool, POOL_NAMES_SHOWN));
	} else {
		lines.push(state.network ? networkWords.cardLine(state.hostId) : gameRoomsCopy.board.cardOpenToAll(state.hostId));
		lines.push("", gameRoomsCopy.board.cardPool(state.pool, POOL_NAMES_SHOWN));
	}
	// The Monopoly choices are shown once the host is past the visibility step, the
	// same step that offers their toggles, so each line and its button appear together.
	if (state.game === "monopoly" && state.visibility && !state.cancelled && !state.startedChannelId) {
		lines.push("", gameRoomsCopy.board.cardMonopolyAuctions(state.monopolyAuctions ?? false));
		lines.push(gameRoomsCopy.board.cardMonopolyReferee(state.monopolyReferee ?? false));
	}
	lines.push(...hostControlLines(state));

	const embed = infoEmbed(
		gameRoomsCopy.board.cardTitle(state.game),
		lines.join("\n"),
		COLORS.ARCADE as ColorResolvable
	);
	if (imageRef) embed.setImage(imageRef);
	else if (logoRef) embed.setThumbnail(logoRef);
	return embed;
}

// ── the host's controls on the card (2026-10 item 244 Phase 4) ────────
// The band and the approval only bite on an Open to all challenge: an invite only host
// picks every member by hand, so there is no stranger to band or approve. Removing a
// member applies to both, since an invited member can be removed too.
const showsJoinControls = (state: OpenerCardState): boolean => state.visibility === "public" && Boolean(state.hostControls);
const showsBand = (state: OpenerCardState): boolean => showsJoinControls(state) && isRatedGame(state.game);

const BAND_LABELS: Record<RatingBand, string> = {
	any: hostWords.band.options.any.label,
	close: hostWords.band.options.close.label,
	tight: hostWords.band.options.tight.label,
};

// The band and approval lines under the pool, while the card still gathers.
function hostControlLines(state: OpenerCardState): string[] {
	const controls = state.hostControls;
	if (!controls || state.cancelled || state.startedChannelId || !showsJoinControls(state)) return [];
	const lines: string[] = [""];
	if (showsBand(state)) lines.push(hostWords.band.cardLine(BAND_LABELS[controls.ratingBand], bandWidth(controls.ratingBand)));
	if (controls.requireApproval) lines.push(hostWords.approval.cardLine(controls.pendingJoinCount));
	return lines.length > 1 ? lines : [];
}

// The host's row: Approve each joiner and Requests on an open challenge, then Remove a
// player. The approval toggle's arg is the value the press SETS, like the Monopoly
// toggles, so a stale card does what its label says. Requests shows while approval is
// on or somebody still waits after it was turned off. Remove a player opens a private
// picker (hostControls) rather than listing names here, because the card is public
// and a picker of names belongs to the one person who may use it.
function hostControlRow(roomId: string, state: OpenerCardState, controls: DraftHostControls): CardRow {
	const buttons: ButtonBuilder[] = [];
	if (showsJoinControls(state)) {
		buttons.push(
			new ButtonBuilder()
				.setCustomId(`${GAME_ROOM_PREFIX}:approval:${roomId}:${controls.requireApproval ? "off" : "on"}`)
				.setLabel(hostWords.approval.toggleLabel(controls.requireApproval))
				.setEmoji("✋")
				.setStyle(ButtonStyle.Secondary)
		);
		if (controls.requireApproval || controls.pendingJoinCount > 0) {
			buttons.push(
				new ButtonBuilder()
					.setCustomId(`${GAME_ROOM_PREFIX}:requests:${roomId}`)
					.setLabel(hostWords.approval.requestsLabel(controls.pendingJoinCount))
					.setEmoji("📨")
					.setStyle(ButtonStyle.Secondary)
			);
		}
	}
	buttons.push(
		new ButtonBuilder()
			.setCustomId(`${GAME_ROOM_PREFIX}:kick:${roomId}`)
			.setLabel(hostWords.kick.buttonLabel)
			.setEmoji("🚫")
			.setStyle(ButtonStyle.Secondary)
			// A hint only: the picker answers honestly when there is nobody to remove.
			.setDisabled(state.pool.length === 0 && controls.pendingJoinCount === 0)
	);
	return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(...buttons);
}

// The band select, on rated games only, with the current band as its default so the
// card shows the choice in force. A select rather than three buttons because it costs
// one row however many bands there are.
function bandSelectRow(roomId: string, band: RatingBand): CardRow {
	const describe = (option: RatingBand): string => {
		if (option === "any") return hostWords.band.options.any.description;
		const width = bandWidth(option) ?? 0;
		return option === "close" ? hostWords.band.options.close.description(width) : hostWords.band.options.tight.description(width);
	};
	const select = new StringSelectMenuBuilder()
		.setCustomId(`${GAME_ROOM_SELECT_PREFIX}:band:${roomId}`)
		.setPlaceholder(hostWords.band.placeholder)
		.addOptions(RATING_BANDS.map((option) => ({ label: BAND_LABELS[option], value: option, description: describe(option), default: option === band })));
	return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(select);
}

// The card's controls for the current state. Returns an empty array once the draft is
// terminal, which is what strips the buttons off a finished card rather than leaving
// dead controls a member can still press.
export function openerCardRows(roomId: string, state: OpenerCardState): CardRow[] {
	if (state.cancelled || state.startedChannelId) return [];

	const cancel = new ButtonBuilder()
		.setCustomId(`${GAME_ROOM_PREFIX}:cancel:${roomId}`)
		.setLabel(gameRoomsCopy.board.cancelLabel)
		.setStyle(ButtonStyle.Secondary);

	// Step 1: the host has not chosen who can see the room yet. Open to all is left off
	// when the server's challenge reach is invite only.
	if (!state.visibility) {
		const openToAll =
			state.allowPublic === false
				? []
				: [
						new ButtonBuilder()
							.setCustomId(`${GAME_ROOM_PREFIX}:vis:${roomId}:public`)
							.setLabel(gameRoomsCopy.board.visibilityOpenLabel)
							.setEmoji("🌐")
							.setStyle(ButtonStyle.Primary),
				  ];
		const openToNetwork = state.allowNetwork
			? [
					new ButtonBuilder()
						.setCustomId(`${GAME_ROOM_PREFIX}:vis:${roomId}:network`)
						.setLabel(networkWords.visibilityLabel)
						.setEmoji("🛰️")
						.setStyle(ButtonStyle.Primary),
			  ]
			: [];
		return [
			new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
				new ButtonBuilder()
					.setCustomId(`${GAME_ROOM_PREFIX}:vis:${roomId}:invite`)
					.setLabel(gameRoomsCopy.board.visibilityInviteLabel)
					.setEmoji("🔒")
					.setStyle(ButtonStyle.Secondary),
				...openToAll,
				...openToNetwork,
				cancel
			),
		];
	}

	// Step 2: gather the pool, then start.
	//
	// Invite mode offers the picker; open-to-all offers Join to everyone. Start is
	// present in both and refuses an empty pool in the handler rather than being
	// hidden here: a hidden button is a suggestion, not a gate, and an honestly
	// refused press tells the host WHY nothing happened.
	const gather =
		state.visibility === "invite"
			? new ButtonBuilder()
					.setCustomId(`${GAME_ROOM_PREFIX}:invite:${roomId}`)
					.setLabel(gameRoomsCopy.board.pickerPlaceholder)
					.setEmoji("✉️")
					.setStyle(ButtonStyle.Secondary)
			: new ButtonBuilder()
					.setCustomId(`${GAME_ROOM_PREFIX}:join:${roomId}`)
					.setLabel(gameRoomsCopy.board.joinLabel)
					.setEmoji("🙋")
					.setStyle(ButtonStyle.Success)
					// The cap is Discord's select ceiling and the overwrite budget at once.
					// Disabling at the cap beats letting a press fail.
					.setDisabled(state.pool.length >= BOT_CONSTANTS.GAME_ROOM_MAX_SPECTATORS);

	const start = new ButtonBuilder()
		.setCustomId(`${GAME_ROOM_PREFIX}:start:${roomId}`)
		.setLabel(gameRoomsCopy.board.startLabel)
		.setEmoji("⚔️")
		.setStyle(ButtonStyle.Primary);

	// Monopoly's choices sit beside Start because they have to be made before the match
	// is seeded. That makes five buttons, Discord's cap for one row, so a sixth Monopoly
	// setting needs a second row.
	const gatherRow =
		state.game === "monopoly"
			? new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
					gather,
					start,
					draftSettingToggle(roomId, "auctions", state.monopolyAuctions ?? false, gameRoomsCopy.board.monopolyAuctionsToggleLabel, "🔨"),
					draftSettingToggle(roomId, "referee", state.monopolyReferee ?? false, gameRoomsCopy.board.monopolyRefereeToggleLabel, "🎙️"),
					cancel
			  )
			: new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(gather, start, cancel);

	// The host's controls ride their own rows below, so the gather row keeps its shape
	// (and Monopoly keeps all five of its slots). Three rows at most, inside Discord's five.
	const controls = state.hostControls;
	if (!controls) return [gatherRow];
	return [gatherRow, hostControlRow(roomId, state, controls), ...(showsBand(state) ? [bandSelectRow(roomId, controls.ratingBand)] : [])];
}

/** The card actions that switch a Monopoly draft setting; challengeBoard maps each to its row field. */
export type MonopolyDraftSettingAction = "auctions" | "referee";

// One on or off draft setting. The arg is the value the press SETS, so a stale card's
// button cannot flip the choice back the wrong way, and the label names that value.
function draftSettingToggle(
	roomId: string,
	action: MonopolyDraftSettingAction,
	enabled: boolean,
	label: (enabled: boolean) => string,
	emoji: string
): ButtonBuilder {
	return new ButtonBuilder()
		.setCustomId(`${GAME_ROOM_PREFIX}:${action}:${roomId}:${enabled ? "off" : "on"}`)
		.setLabel(label(enabled))
		.setEmoji(emoji)
		.setStyle(ButtonStyle.Secondary);
}
