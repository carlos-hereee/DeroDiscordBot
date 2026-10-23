import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type ColorResolvable } from "discord.js";
import { infoEmbed } from "@utils/embedBuilder.js";
import { COLORS } from "@base/copy/brand.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { GAME_ROOM_PREFIX } from "./gameRoomActions.js";
import type { GameSlug, RoomVisibility } from "./roomTypes.js";

// ── challengeBoardEmbeds ─────────────────────────────────────────────
// What:  the pinned ⚔️challenges intro, and the opener card that is edited in place
//        as one challenge moves from "choosing visibility" to "under way".
// Who:   challengeBoard.ts.
// When:  the intro once per boot (refreshIntroEmbeds keeps it current); the card on
//        every state change of a draft.
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

const GAME_EMOJI: Record<string, string> = {
	coinflip: "🪙",
	diceroll: "🎲",
	rps: "✊",
	hangman: "🪢",
	battleship: "🚢",
	holdem: "🃏",
	monopoly: "🏠",
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
// roomId, because no room exists until this is pressed. Rides the pinned ⚔️challenges
// intro: resolveIntroComponents in GuildSetupManager attaches these rows on first build
// and on every boot's refresh, so a guild set up before the board existed gets it on
// its next boot without a re-run of /setup.
export function boardStartRows(): ActionRowBuilder<ButtonBuilder>[] {
	const rows: ActionRowBuilder<ButtonBuilder>[] = [];
	for (let start = 0; start < CHALLENGE_GAMES.length; start += BOARD_BUTTONS_PER_ROW) {
		rows.push(
			new ActionRowBuilder<ButtonBuilder>().addComponents(
				...CHALLENGE_GAMES.slice(start, start + BOARD_BUTTONS_PER_ROW).map((game) =>
					new ButtonBuilder()
						.setCustomId(`${GAME_ROOM_PREFIX}:new:${game}`)
						.setLabel(gameRoomsCopy.board.startButtonLabel(game))
						.setEmoji(GAME_EMOJI[game] ?? "⚔️")
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
}

// How many pool members the card names before it summarises the rest. Well under the
// 25 member cap so the card never becomes a wall of mentions, and the copy states the
// remainder rather than silently dropping it.
const POOL_NAMES_SHOWN = 8;

export function openerCardEmbed(state: OpenerCardState): EmbedBuilder {
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
		lines.push(gameRoomsCopy.board.cardOpenToAll(state.hostId));
		lines.push("", gameRoomsCopy.board.cardPool(state.pool, POOL_NAMES_SHOWN));
	}
	// The Monopoly choices are shown once the host is past the visibility step, the
	// same step that offers their toggles, so each line and its button appear together.
	if (state.game === "monopoly" && state.visibility && !state.cancelled && !state.startedChannelId) {
		lines.push("", gameRoomsCopy.board.cardMonopolyAuctions(state.monopolyAuctions ?? false));
		lines.push(gameRoomsCopy.board.cardMonopolyReferee(state.monopolyReferee ?? false));
	}

	return infoEmbed(
		gameRoomsCopy.board.cardTitle(state.game),
		lines.join("\n"),
		COLORS.ARCADE as ColorResolvable
	);
}

// The card's controls for the current state. Returns an empty array once the draft is
// terminal, which is what strips the buttons off a finished card rather than leaving
// dead controls a member can still press.
export function openerCardRows(roomId: string, state: OpenerCardState): ActionRowBuilder<ButtonBuilder>[] {
	if (state.cancelled || state.startedChannelId) return [];

	const cancel = new ButtonBuilder()
		.setCustomId(`${GAME_ROOM_PREFIX}:cancel:${roomId}`)
		.setLabel(gameRoomsCopy.board.cancelLabel)
		.setStyle(ButtonStyle.Secondary);

	// Step 1: the host has not chosen who can see the room yet.
	if (!state.visibility) {
		return [
			new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder()
					.setCustomId(`${GAME_ROOM_PREFIX}:vis:${roomId}:invite`)
					.setLabel(gameRoomsCopy.board.visibilityInviteLabel)
					.setEmoji("🔒")
					.setStyle(ButtonStyle.Secondary),
				new ButtonBuilder()
					.setCustomId(`${GAME_ROOM_PREFIX}:vis:${roomId}:public`)
					.setLabel(gameRoomsCopy.board.visibilityOpenLabel)
					.setEmoji("🌐")
					.setStyle(ButtonStyle.Primary),
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
	if (state.game === "monopoly") {
		const auctions = draftSettingToggle(roomId, "auctions", state.monopolyAuctions ?? false, gameRoomsCopy.board.monopolyAuctionsToggleLabel, "🔨");
		const referee = draftSettingToggle(roomId, "referee", state.monopolyReferee ?? false, gameRoomsCopy.board.monopolyRefereeToggleLabel, "🎙️");
		return [new ActionRowBuilder<ButtonBuilder>().addComponents(gather, start, auctions, referee, cancel)];
	}
	return [new ActionRowBuilder<ButtonBuilder>().addComponents(gather, start, cancel)];
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
