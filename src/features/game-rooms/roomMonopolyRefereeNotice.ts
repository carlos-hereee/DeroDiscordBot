import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, type ButtonInteraction, type Client, type ColorResolvable, type MessageCreateOptions } from "discord.js";
import { COLORS } from "@base/copy/brand.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { infoEmbed } from "@utils/embedBuilder.js";
import { gateOwnerOrAdmin } from "@utils/permissions.js";
import { showNotice } from "@utils/textModal.js";
import * as deroConfigCommand from "@commands/admin/dero-config.js";
import { bringDeroIntoCall } from "@commands/utility/dero.js";
import { checkEarlyAccess, earlyAccessEmbed } from "@features/early-access/earlyAccess.js";
import { FormOptionReader } from "@features/command-buttons/formOptionReader.js";
import { GAME_ROOM_PREFIX } from "./gameRoomActions.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { moveMonopolyBoardToBottom } from "./roomMonopolyBoard.js";
import type { RefereeSilence } from "./roomMonopolyReferee.js";
import { resolveRoomChannel } from "./roomTrail.js";

// ── roomMonopolyRefereeNotice ────────────────────────────────────────
// What:  the one notice a refereed match gets when its voice referee is on and cannot
//        speak (2026-10 item 254, Arcade 7; Hold'em too since 2026-10 item 257 Phase 4b):
//        why, and the one press that fixes it.
//        Voice off: Enable Dero's voice, admin gated, through the /dero-config enable
//        handler the settings panel already runs. Dero in no call: Bring Dero into the
//        call, through bringDeroIntoCall and every checkJoin gate. No player in Dero's
//        call, or the month's budget spent: the notice alone, since no press here fixes it.
// Who:   roomReferee.startRoomReferee at match start, when voice is off or the host is in
//        no call; roomMonopolyHandlers.applyMonopolyOutcome hands postRefereeNotice to the
//        Monopoly referee as its onSilent; gameRoomHandlers routes the two buttons here.
// When:  at most once per match: the claim on the row is what makes it once, so a second
//        silent move, a restart or a racing sweep posts nothing.
// Where: the only join a match makes by itself is roomReferee's request for the host's own
//        call at match start. This file only says why it is quiet; any other join stays a
//        member's press.
// How:   claim, then post the notice. A Monopoly board then moves below it, so the board
//        stays the last message in the room (Arcade 8); a Hold'em table posts afresh at its
//        next reveal anyway (roomBoardRepost), so the notice simply posts in the room.

const PRIVATE = { flags: MessageFlags.Ephemeral } as const;

/** The fix button a silence offers, if any. */
function fixButton(reason: RefereeSilence, roomId: string): ButtonBuilder | null {
	const words = gameRoomsCopy.monopoly;
	if (reason === "voiceOff") {
		return new ButtonBuilder().setCustomId(`${GAME_ROOM_PREFIX}:mrefvoice:${roomId}`).setLabel(words.enableVoiceLabel).setStyle(ButtonStyle.Primary).setEmoji("🔊");
	}
	if (reason === "noCall") {
		return new ButtonBuilder().setCustomId(`${GAME_ROOM_PREFIX}:mrefcall:${roomId}`).setLabel(words.bringIntoCallLabel).setStyle(ButtonStyle.Primary).setEmoji("🎙️");
	}
	return null;
}

/** The notice's message: the reason, and its fix button when one press can fix it. Exported for the tests. */
export function refereeNoticeMessage(reason: RefereeSilence, roomId: string) {
	const words = gameRoomsCopy.monopoly;
	const embed = infoEmbed(words.refereeSilentTitle, words.refereeSilent[reason], COLORS.ARCADE as ColorResolvable);
	const button = fixButton(reason, roomId);
	return { embeds: [embed], components: button ? [new ActionRowBuilder<ButtonBuilder>().addComponents(button)] : [] };
}

/**
 * Post a line in a refereed room: above Monopoly's board, which then moves down so it stays
 * the last message, or straight into any other room. `room` must carry its channel id.
 */
export async function postAboveBoard(client: Client, room: IGameRoom, payload: MessageCreateOptions): Promise<void> {
	if (room.game === "monopoly") {
		await moveMonopolyBoardToBottom(client, room, (channel) => channel.send(payload));
		return;
	}
	const channel = await resolveRoomChannel(client, room.channelId);
	await channel?.send(payload);
}

/**
 * Post the match's one silent referee notice, if this match has not had it. Fire and
 * forget: it never throws, because it runs off the referee's own promise chain.
 */
export async function postRefereeNotice(client: Client, room: IGameRoom, reason: RefereeSilence): Promise<void> {
	try {
		const claimed = await gameRoomStore.claimRefereeNotice(room.guildId, room.roomId, new Date());
		if (!claimed) return;
		await postAboveBoard(client, claimed, { ...refereeNoticeMessage(reason, room.roomId), allowedMentions: { parse: [] } });
	} catch (error) {
		console.error("[game-rooms] the silent referee notice did not post", { roomId: room.roomId, reason, error });
	}
}

// ── the fix buttons ───────────────────────────────────────────────────
/**
 * Enable Dero's voice: the guild owner or an admin, then the /dero-config enable leaf
 * through the command's own run, the same run the settings panel's voice switch makes,
 * behind the same early access gate. Anyone else gets a private notice.
 */
export async function handleEnableVoice(interaction: ButtonInteraction): Promise<void> {
	const config = interaction.guildId ? await guildConfigStore.findByGuildId(interaction.guildId) : null;
	if (!(await gateOwnerOrAdmin(interaction, config))) {
		const words = gameRoomsCopy.monopoly;
		await showNotice(interaction, { title: words.refereeSilentTitle, sections: [words.enableVoiceAdminOnly] }, () => ({ content: words.enableVoiceAdminOnly, ...PRIVATE }));
		return;
	}
	const access = await checkEarlyAccess(deroConfigCommand.data.name, interaction.guildId ?? "");
	if (!access.allowed && access.generalReleaseAt) {
		const embed = earlyAccessEmbed(access.generalReleaseAt);
		await showNotice(interaction, { title: embed.data.title ?? "", sections: [embed.data.description ?? ""] }, () => ({ embeds: [embed], ...PRIVATE }));
		return;
	}
	await deroConfigCommand.run(interaction, new FormOptionReader({ subcommand: "enable", group: null }, new Map()));
}

/**
 * Bring Dero into the call: bringDeroIntoCall answers and gates the press itself. Its
 * join notice posts in this room, so a Monopoly board then moves back below it.
 */
export async function handleBringIntoCall(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	await bringDeroIntoCall(interaction);
	if (room.game === "monopoly") await moveMonopolyBoardToBottom(interaction.client, room);
}

export const roomMonopolyRefereeNotice = { postRefereeNotice, handleEnableVoice, handleBringIntoCall };
