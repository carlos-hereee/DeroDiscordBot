import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	EmbedBuilder,
	type ColorResolvable,
	type MessageActionRowComponentBuilder,
} from "discord.js";
import { infoEmbed } from "@utils/embedBuilder.js";
import { COLORS } from "@base/copy/brand.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { bandWidth, isRatedGame } from "@features/ratings/ratingEngine.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { GAME_ROOM_PREFIX } from "./gameRoomActions.js";
import { isBuyInGame, type GameSlug, type RatingBand, type RoomVisibility, type SpectatorMode } from "./roomTypes.js";
import type { SoloLuckGame } from "@features/games/soloLuck.js";

// The host controls' words are shared by every pack, so the default pack is the right
// one here and the card stays a pure function of its state.
const hostWords = rokCommanderCopy.arcadeHostControls;
const networkWords = rokCommanderCopy.arcadeNetwork;

type CardRow = ActionRowBuilder<MessageActionRowComponentBuilder>;

// ── challengeBoardEmbeds ─────────────────────────────────────────────
// What:  the pinned ⚔️challenges intro, and the opener card that is edited in place
//        as one challenge moves from "gathering" to "under way".
// Who:   challengeBoard.ts.
// When:  the intro once per boot (refreshIntroEmbeds keeps it current); the card on
//        every state change of a draft. Since 2026-10 item 263 Phase 2a the card posts
//        already configured by the creation modal (challengeSettings.ts), so it carries
//        no settings control: only what happens after creation (Join or Invite, Start,
//        Call it off, the host's Requests and Remove a player) and the host's Edit
//        settings, with one line naming every setting in force.
// How:   ONE card, edited, rather than a new message per step. A challenge that
//        posted a fresh message for each of join and start would bury the channel it
//        lives in, and ⚔️challenges is meant to be scannable.

// The games the board can start. Blackjack is absent from the BOARD on purpose: its one
// door is 🕹️games' Open a Blackjack table (and /mini-game blackjack typed in ⚔️challenges),
// which posts the same challenge card through offerChallengeDraft (2026-10 item 254,
// Arcade 1), so a second button would only be a second way to the same card.
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
// Blackjack is here for the same reason (2026-10 item 254, Arcade 1): everyone who
// joined takes a seat at the one table, and startMatch caps the pool at its five seats.
export const COOPERATIVE_GAMES: readonly GameSlug[] = ["hangman", "holdem", "monopoly", "blackjack"] as const;

export const isCooperativeGame = (game: GameSlug): boolean => COOPERATIVE_GAMES.includes(game);

// The games a host may play against Dero instead of a member (post-launch plan item
// 13): the three one press luck games, whose solo round soloLuck already plays.
export const DERO_PLAYABLE_GAMES: readonly GameSlug[] = ["coinflip", "diceroll", "rps"] as const;

export const isDeroPlayable = (game: GameSlug): game is SoloLuckGame => DERO_PLAYABLE_GAMES.includes(game);

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
	blackjack: "🃏",
	"solo-hangman": "🪢",
	"solo-blackjack": "🃏",
	"solo-coinflip": "🪙",
	"solo-diceroll": "🎲",
	"solo-rps": "✊",
};

// ── the rated or casual badge (2026-10 item 254, Arcade 5) ──
export type ChallengeBadge = "rated" | "casual";

/**
 * The ONE helper that decides a challenge card's badge, read by the embed's badge line
 * and the picture's pill alike, so the two can never disagree: RATED for a rated game
 * (ratingEngine.RATED_GAMES) with no Dero bot seated and the host's Rated choice, CASUAL
 * otherwise, since a match with a bot is never rated (botSeat) and a Casual match is
 * never rated even once every bot gave its seat to a person (2026-10 item 254, Arcade 6).
 *
 * ⚠️ THE BADGE NEVER MOVES A CARD. Which channel a card lives in is decided once, at
 * creation, by the game and the match (challengeCard.resolveChallengesChannel, 2026-10 item
 * 263 R3-5), and the match is fixed there, so a card stays where it posted whatever its
 * badge later says (a card from before the creation modal can still seat a Dero bot).
 */
export function challengeBadge(game: GameSlug, botCount: number, casual = false): ChallengeBadge {
	return isRatedGame(game) && botCount === 0 && !casual ? "rated" : "casual";
}

/** The badge of one card state: its game, the bots the host seated and the host's Casual choice. */
export const badgeOfCard = (state: Pick<OpenerCardState, "game" | "bots" | "casual">): ChallengeBadge =>
	challengeBadge(state.game, state.bots?.count ?? 0, state.casual ?? false);

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
	// Monopoly only: the host's auction choice, named on the card's settings line.
	monopolyAuctions?: boolean;
	// The host's Dero voice choice, on every game's card (2026-10 item 267, decision 10).
	deroVoice?: boolean;
	// Terminal states. When any is set the card stops offering controls.
	cancelled?: boolean;
	startedChannelId?: string | null;
	// The card's last word: how the match ended (post-launch plan item 21), or that the
	// host played Dero instead (item 13). It replaces the "under way" line.
	resultLine?: string | null;
	// True once the host opened the table to the network, which changes the card's line.
	network?: boolean;
	// The host's say over who joins (Phase 4), read off the draft row. Absent renders
	// the card exactly as it was before the controls existed.
	hostControls?: DraftHostControls;
	// Dero bot opponents (2026-10 item 250 Phase 5): present on a draft whose game and server
	// take bots, with the number seated. Absent seats none.
	bots?: { count: number };
	// The host's Casual (unrated) choice (2026-10 item 254, Arcade 6), off the row: with Dero
	// bots in the empty seats or, since 2026-10 item 263 R3-5, without.
	casual?: boolean;
	// Hold'em only (2026-10 item 257 Phase 4a): the buy in the host set, or null for the standard
	// stack. Shown as a line; it is set in the creation modal or Edit settings since 2026-10 item 263.
	holdemBuyIn?: number | null;
	// What the creation modal or Edit settings could not apply, each a sentence, shown under
	// the settings line while the card gathers (2026-10 item 263 Phase 2a).
	settingsNotes?: readonly string[];
}

/** The draft's host controls the card shows: the band, approval, and how many wait for an answer. */
export interface DraftHostControls {
	ratingBand: RatingBand;
	requireApproval: boolean;
	pendingJoinCount: number;
	// Who may watch once the room opens (2026-10 item 254, Arcade 11), already resolved
	// by roomPermissions.effectiveSpectatorMode, so the card shows what the matrix will do.
	spectatorMode: SpectatorMode;
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
	// The badge leads every card, in every state, so a member scanning the channel sees at
	// once whether a match counts.
	const lines: string[] = [gameRoomsCopy.board.badgeLine(badgeOfCard(state), state.game), ""];

	if (state.resultLine) {
		lines.push(state.resultLine);
	} else if (state.cancelled) {
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
	// While the card gathers it names every setting in force on one line, then anything the
	// host chose that could not apply, then what a joiner pays at a Hold'em chip table.
	const gathering = Boolean(state.visibility && !state.cancelled && !state.startedChannelId && !state.resultLine);
	if (gathering) {
		lines.push("", settingsLine(state), ...(state.settingsNotes ?? []));
		lines.push(...buyInLines(state));
	}

	const embed = infoEmbed(
		gameRoomsCopy.board.cardTitle(state.game),
		lines.join("\n"),
		COLORS.ARCADE as ColorResolvable
	);
	if (imageRef) embed.setImage(imageRef);
	else if (logoRef) embed.setThumbnail(logoRef);
	return embed;
}

// ── the settings line (2026-10 item 263 Phase 2a) ─────────────────────
// One line naming every setting in force while the card gathers: who can join, the match on
// a rated game, who may watch, and the game's own switches. Read off the card state, which
// is read off the row, so it says what the creation modal or Edit settings actually applied.
const summaryWords = gameRoomsCopy.creation.summary;

// The band and the approval only bite on an Open to all challenge: an invite only host picks
// every member by hand, so there is no stranger to band or approve.
const showsJoinControls = (state: OpenerCardState): boolean => state.visibility === "public" && Boolean(state.hostControls);

function joinPart(state: OpenerCardState): string {
	if (state.network) return summaryWords.join.network;
	if (state.visibility !== "public") return summaryWords.join.invite;
	return state.hostControls?.requireApproval ? summaryWords.join.approve : summaryWords.join.public;
}

// Rated with its band where a band applies, or Casual, naming the Dero bots that sit down.
// A card from before the creation modal can hold bots on a rated match; it reads casual,
// which is what the badge says too (challengeBadge).
function matchPart(state: OpenerCardState): string {
	const bots = state.bots?.count ?? 0;
	if (badgeOfCard(state) === "casual") return bots > 0 ? `${summaryWords.casual}, ${summaryWords.bots(bots)}` : summaryWords.casual;
	const width = showsJoinControls(state) && state.hostControls ? bandWidth(state.hostControls.ratingBand) : null;
	return width === null ? summaryWords.rated : `${summaryWords.rated}, ${summaryWords.band(width)}`;
}

function settingsLine(state: OpenerCardState): string {
	const parts = [joinPart(state)];
	if (isRatedGame(state.game)) parts.push(matchPart(state));
	// A network table's watchers in other servers are its satellites' business, so it names none.
	if (!state.network && state.hostControls) parts.push(summaryWords.watch[state.hostControls.spectatorMode]);
	if (state.game === "monopoly") parts.push(summaryWords.auctions(state.monopolyAuctions ?? false));
	parts.push(summaryWords.voice(state.deroVoice ?? false));
	return `${summaryWords.lead} ${parts.join(" · ")}`;
}

// A Hold'em or Blackjack card names the buy in wherever a table could play for chips: not on a
// network table (its seats come from other servers) and not with a Dero bot seat (it plays free).
function showsBuyIn(state: OpenerCardState): boolean {
	return isBuyInGame(state.game) && !state.network && (state.bots?.count ?? 0) === 0;
}

function buyInLines(state: OpenerCardState): string[] {
	if (!showsBuyIn(state) || state.holdemBuyIn == null) return [];
	return ["", gameRoomsCopy.board.cardBuyIn(state.holdemBuyIn)];
}

// ── the card's controls ───────────────────────────────────────────────
// The host's row: Requests on an open challenge while approval is on or somebody still waits
// after it was turned off, then Remove a player. Remove a player opens a private picker
// (hostControls) rather than listing names here, because the card is public and a picker of
// names belongs to the one person who may use it.
function hostControlRow(roomId: string, state: OpenerCardState, controls: DraftHostControls): CardRow {
	const buttons: ButtonBuilder[] = [];
	if (showsJoinControls(state) && (controls.requireApproval || controls.pendingJoinCount > 0)) {
		buttons.push(
			new ButtonBuilder()
				.setCustomId(`${GAME_ROOM_PREFIX}:requests:${roomId}`)
				.setLabel(hostWords.approval.requestsLabel(controls.pendingJoinCount))
				.setEmoji("📨")
				.setStyle(ButtonStyle.Secondary)
		);
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

// The host's Edit settings (owner decision 7): it reopens the creation modal prefilled, every
// field until somebody joins and then only those a match can still change. Host only.
function editSettingsButton(roomId: string): ButtonBuilder {
	return new ButtonBuilder()
		.setCustomId(`${GAME_ROOM_PREFIX}:edit:${roomId}`)
		.setLabel(gameRoomsCopy.creation.editLabel)
		.setEmoji("⚙️")
		.setStyle(ButtonStyle.Secondary);
}

// The card's controls for the current state. Returns an empty array once the draft is
// terminal, which is what strips the buttons off a finished card rather than leaving
// dead controls a member can still press.
//
// ⚠️ NO SETTING IS A CARD CONTROL (2026-10 item 263 R3-13). Visibility, the network, Play
// Dero, approval, the band, who may watch, Rated or Casual, Play vs bots, the buy in, Dero
// voice and the auctions are all chosen in the creation modal and changed through Edit
// settings. Their routes stay registered in gameRoomHandlers, so a card posted before the
// change still works until its next redraw, which shows these rows.
export function openerCardRows(roomId: string, state: OpenerCardState): CardRow[] {
	if (state.cancelled || state.startedChannelId || state.resultLine) return [];

	const cancel = new ButtonBuilder()
		.setCustomId(`${GAME_ROOM_PREFIX}:cancel:${roomId}`)
		.setLabel(gameRoomsCopy.board.cancelLabel)
		.setStyle(ButtonStyle.Secondary);

	// A card whose host never chose who can join: only a card posted before the creation
	// modal, at its old first step, can be here. Edit settings is its way forward.
	if (!state.visibility) return [new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(editSettingsButton(roomId), cancel)];

	// Invite mode offers the picker; open-to-all offers Join to everyone. Start is present in
	// both and refuses an empty pool in the handler rather than being hidden here: a hidden
	// button is a suggestion, not a gate, and an honestly refused press tells the host WHY
	// nothing happened.
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

	// Four of the row's five, and the fifth is an invited member's Accept and buy in on an
	// Invite only Hold'em or Blackjack card that may charge one (2026-10 item 263 R3-27), so the card never
	// needs a row of its own for it. Shown to everyone, since Discord cannot show a button to some
	// members only; the handler refuses anybody the host did not invite.
	const accept =
		state.visibility === "invite" && showsBuyIn(state)
			? [
					new ButtonBuilder()
						.setCustomId(`${GAME_ROOM_PREFIX}:haccept:${roomId}`)
						.setLabel(gameRoomsCopy.holdem.acceptLabel)
						.setEmoji("🪙")
						.setStyle(ButtonStyle.Success),
			  ]
			: [];
	const gatherRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(gather, start, editSettingsButton(roomId), cancel, ...accept);

	const controls = state.hostControls;
	if (!controls) return [gatherRow];
	return [gatherRow, hostControlRow(roomId, state, controls)];
}

/** The card actions that switch an on or off draft setting; challengeBoard maps each to its row field. */
export type DraftSettingAction = "auctions" | "referee";
