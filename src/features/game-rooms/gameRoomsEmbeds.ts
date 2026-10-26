import {
	ActionRowBuilder,
	AttachmentBuilder,
	ButtonBuilder,
	ButtonStyle,
	EmbedBuilder,
	type APIEmbed,
	type ColorResolvable,
	type JSONEncodable,
} from "discord.js";
import { basename } from "node:path";
import { gameAssetPath, type GameAssetKey } from "@features/games/gamesAssets.js";
import { infoEmbed } from "@utils/embedBuilder.js";
import { COLORS } from "@base/copy/brand.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { GAME_ROOM_PREFIX } from "./gameRoomActions.js";
import type { GameSlug, RoomVisibility, SpectatorMode } from "./roomTypes.js";
import { labelBotMentions } from "./botSeat.js";
import { effectiveSpectatorMode } from "./roomPermissions.js";

// ── gameRoomsEmbeds ──────────────────────────────────────────────────
// What:  every embed and button row a room renders: the pinned opener card and the
//        result card that closes it.
// Who:   RoomProvisioner (opener), roomLifecycle (result), and the Rematch button
//        (the result card's rematched form).
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
	visibility: RoomVisibility,
	spectatorMode: SpectatorMode | null,
	inviteCode?: string | null,
	logoRef?: string
): EmbedBuilder {
	// A Dero bot seat (2026-10 item 250 Phase 5) is named rather than mentioned. The
	// audience line names who may watch, from the same helper the matrix reads.
	const audience = effectiveSpectatorMode(visibility, spectatorMode);
	const description = labelBotMentions(gameRoomsCopy.opener.description(hostId, playerIds, visibility, audience, inviteCode));
	// Monopoly's rules ride the pinned opener because its board message, edited
	// every move, has no room left for them, and a match that runs for days is
	// joined mid way by people who never saw the start.
	const body = game === "monopoly" ? [description, "", gameRoomsCopy.monopoly.openerRules()].join("\n") : description;
	const embed = infoEmbed(gameRoomsCopy.opener.title(game), body, COLORS.ARCADE as ColorResolvable);
	return logoRef ? embed.setThumbnail(logoRef) : embed;
}

// The game's logo for its room opener (2026-10 item 243 Phase 3b), one of the two
// room messages allowed a file (R8), and for its challenge post (2026-10 item 245
// Phase 3b), so a game shows one mark everywhere. Only games with a logo in the
// art are listed.
const OPENER_LOGOS: Partial<Record<GameSlug, GameAssetKey>> = {
	hangman: "hangmanLogoStacked",
	"solo-hangman": "hangmanLogoStacked",
	battleship: "battleshipLogo",
};

/** The art slot of a game's logo, or null for a game that has none. The challenge card draws it. */
export function openerLogoKey(game: GameSlug): GameAssetKey | null {
	return OPENER_LOGOS[game] ?? null;
}

/**
 * The opener's logo as an attachment plus the `attachment://` ref for the
 * embed's thumbnail, or null for a game with no logo or a logo not on disk. Unlike
 * resolveGameAsset it never substitutes the Dero avatar: an opener without a logo
 * stays the plain card it always was. The room opener and the challenge post's
 * text card both carry it.
 */
export function roomOpenerLogo(game: GameSlug): { attachment: AttachmentBuilder; ref: string } | null {
	const key = openerLogoKey(game);
	const path = key ? gameAssetPath(key) : null;
	if (!path) return null;
	const name = `opener-${basename(path)}`;
	return { attachment: new AttachmentBuilder(path, { name }), ref: `attachment://${name}` };
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

/**
 * The finished room's result card once a rematch has taken its channel over: the same
 * title, outcome and picture, with the archive notice swapped for who started the
 * rematch, because the channel no longer disappears on the archive clock.
 *
 * Rebuilt from the POSTED card rather than from the row, because the row does not
 * record whether the ending was an abandonment and the posted outcome line already
 * says so. The image reference survives `from`, and the message keeps its attachment
 * as long as the edit does not pass `attachments`.
 */
export function rematchedResultEmbed(posted: JSONEncodable<APIEmbed> | APIEmbed, presserId: string): EmbedBuilder {
	const embed = EmbedBuilder.from(posted);
	const notice = gameRoomsCopy.result.archiveNotice();
	const kept = (embed.data.description ?? "").split("\n").filter((line) => line !== notice);
	while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
	return embed.setDescription([...kept, "", gameRoomsCopy.result.rematchStarted(presserId)].join("\n"));
}

// ── the result card's row: Rematch, then Archive now ──
// Rendered for everyone, gated in the handler. Discord has no per-member button
// visibility, so a "host only" button is a lie the client cannot tell: the honest
// shape is a visible button whose handler refuses politely, which is what
// GAME_ROOM_ACTIONS.archive.hostOnly does. Rematch leads because it is the action a
// table that just finished actually wants; Archive stays for the player who does not.
// A solo luck round against Dero (2026-10 item 254, Arcade 1) offers no Rematch: its round
// is played the moment its room opens, so a rematch would need a fresh press anyway, and a
// button that only ever answers "not found" is worse than none. checkRematch refuses it too.
export function roomArchiveRow(roomId: string, options: { rematch?: boolean } = {}): ActionRowBuilder<ButtonBuilder> {
	const archive = new ButtonBuilder()
		.setCustomId(`${GAME_ROOM_PREFIX}:archive:${roomId}`)
		.setLabel(gameRoomsCopy.result.archiveButtonLabel)
		.setEmoji("🗄️")
		.setStyle(ButtonStyle.Secondary);
	if (options.rematch === false) return new ActionRowBuilder<ButtonBuilder>().addComponents(archive);
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder()
			.setCustomId(`${GAME_ROOM_PREFIX}:rematch:${roomId}`)
			.setLabel(gameRoomsCopy.result.rematchButtonLabel)
			.setEmoji("🔁")
			.setStyle(ButtonStyle.Primary),
		archive
	);
}

// ── the pinned opener's host row (2026-10 item 244 Phase 4) ──
/**
 * The games whose host may remove a player in the middle of a match: Hold'em (the seat
 * leaves the table), Battleship (the match ends unrated, as abandoned) and Monopoly (the
 * seat goes out through the forfeit path). The other games resolve in a press or two,
 * or are played together against the host's word, so there is nothing to remove from.
 */
export const REMOVABLE_IN_PLAY_GAMES: readonly GameSlug[] = ["holdem", "battleship", "monopoly"];

/**
 * The host's Remove a player button for a room's pinned opener, or null for a game with
 * no removal in play. Rendered for everyone like Archive now and gated in the handler,
 * for the reason the result card's row explains; it opens the host's private picker.
 */
export function roomHostRow(game: GameSlug, roomId: string): ActionRowBuilder<ButtonBuilder> | null {
	if (!REMOVABLE_IN_PLAY_GAMES.includes(game)) return null;
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder()
			.setCustomId(`${GAME_ROOM_PREFIX}:kick:${roomId}`)
			.setLabel(rokCommanderCopy.arcadeHostControls.kick.buttonLabel)
			.setEmoji("🚫")
			.setStyle(ButtonStyle.Secondary)
	);
}
