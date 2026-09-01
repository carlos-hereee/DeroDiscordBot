import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type ColorResolvable } from "discord.js";
import { infoEmbed } from "@utils/embedBuilder.js";
import { COLORS } from "@base/copy/brand.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { GAME_ROOM_PREFIX } from "./gameRoomActions.js";
import type { GameSlug } from "./roomTypes.js";

// ── gameRoomsEmbeds ──────────────────────────────────────────────────
// What:  every embed and button row a room renders: the pinned opener card and the
//        result card that closes it.
// Who:   RoomProvisioner (opener) and roomLifecycle (result).
// When:  once each per room.
// Where: colors come from @base/copy/brand directly rather than through
//        getPluginCopy, matching gamesCopy and fortuneCopy: game rooms are a bot
//        feature, not a platform plugin, so there is no pack to resolve.
// How:   ARCADE is the room's color in both phases on purpose. The per game colors
//        (GAME_HANGMAN, GAME_RPS) identify a MATCH posted into a shared channel where
//        several games compete for a reader's eye; inside a room there is only ever
//        one game, so the useful signal is which arena you are in, not which game.

export function roomOpenerEmbed(
	game: GameSlug,
	hostId: string,
	playerIds: string[],
	isPublic: boolean,
	inviteCode?: string | null
): EmbedBuilder {
	return infoEmbed(
		gameRoomsCopy.opener.title(game),
		gameRoomsCopy.opener.description(hostId, playerIds, isPublic, inviteCode),
		COLORS.ARCADE as ColorResolvable
	);
}

// The card that closes a room. `winnerId` null covers every drawn, forfeited or
// abandoned ending; `abandoned` distinguishes the one the players did not choose, so
// a reaped room does not read as though somebody lost.
// `imageRef` is an `attachment://` reference whose file MUST ride the same message,
// or Discord renders an empty image slot.
//
// ⚠️ ART RIDES THE OPENER AND THE RESULT CARD ONLY (risk R8). A move card must stay
// text and embed, because a room can carry thirty of them and re-uploading a PNG per
// move is bandwidth and a rate limit for no gain. This is the payoff moment and is
// posted once, so it earns the weight.
export function roomResultEmbed(winnerId: string | null, abandoned = false, imageRef?: string): EmbedBuilder {
	const outcome = abandoned
		? gameRoomsCopy.result.abandonedLine
		: winnerId
		  ? gameRoomsCopy.result.winnerLine(winnerId)
		  : gameRoomsCopy.result.noWinnerLine;

	const embed = infoEmbed(
		gameRoomsCopy.result.title,
		[outcome, "", gameRoomsCopy.result.archiveNotice()].join("\n"),
		COLORS.ARCADE as ColorResolvable
	);

	if (imageRef) embed.setImage(imageRef);
	return embed;
}

// ── the Archive now row ──
// Rendered for everyone, gated in the handler. Discord has no per-member button
// visibility, so a "host only" button is a lie the client cannot tell: the honest
// shape is a visible button whose handler refuses politely, which is what
// GAME_ROOM_ACTIONS.archive.hostOnly does.
export function roomArchiveRow(roomId: string): ActionRowBuilder<ButtonBuilder> {
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder()
			.setCustomId(`${GAME_ROOM_PREFIX}:archive:${roomId}`)
			.setLabel(gameRoomsCopy.result.archiveButtonLabel)
			.setEmoji("🗄️")
			.setStyle(ButtonStyle.Secondary)
	);
}
