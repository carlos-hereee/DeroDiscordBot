import {
	ActionRowBuilder,
	StringSelectMenuBuilder,
	TextChannel,
	type ButtonInteraction,
	type Client,
	type Guild,
	type ModalSubmitInteraction,
	type StringSelectMenuInteraction,
} from "discord.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { gateOwnerOrAdmin } from "@utils/permissions.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { isRatedGame } from "@features/ratings/ratingEngine.js";
import type { HoldemTable } from "@features/games/holdemTable.js";
import { GAME_ROOM_SELECT_PREFIX } from "./gameRoomActions.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { answerPick, deferPick, pickedValues, showPicker } from "./pickerModal.js";
import { REMOVABLE_IN_PLAY_GAMES } from "./gameRoomsEmbeds.js";
import { refreshDraftCard, yieldBotSeatsTo } from "./challengeBoard.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { roomTrail } from "./roomTrail.js";
import { redrawTable, removeFromTable, seatAcceptedPlayer } from "./roomHoldemHandlers.js";
import { refundJoiners } from "./holdemDraftBuyIn.js";
import { monopolyStateOf, removeFromMonopolyMatch } from "./roomMonopolyHandlers.js";
import { seatAcceptedRemotePlayer } from "./networkJoin.js";
import { RATING_BANDS, SPECTATOR_MODES, type RatingBand, type SpectatorMode } from "./roomTypes.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { botSeatName, isBotSeatId } from "./botSeat.js";
import { adminLog } from "@features/setup/adminLog.js";
import type { StoredBattleship } from "./roomBattleship.js";
import { answerInChannel } from "@utils/answerInChannel.js";
import { showNotice } from "@utils/textModal.js";

// ── hostControls ─────────────────────────────────────────────────────
// What:  the host's say over who is in a room (2026-10 item 244 Phase 4): the rating
//        band and the approval toggle on the challenge card, the Requests panel that
//        accepts or declines who asked to join, and Remove a player, before the match
//        (out of the pool) or during it (Hold'em, Battleship, Monopoly). And who may
//        watch, the spectator select on the draft card (2026-10 item 254, Arcade 11). A
//        joiner the host answers from Requests hears the answer by DM (Arcade 6).
// Who:   gameRoomHandlers routes the `approval`, `requests` and `kick` buttons and the
//        `band`, `accept`, `decline` and `kick` selects here. The router's hostOnly gate
//        covers a button; every select is gated again in this file, because a select is
//        reached without the button that opened it.
// Does NOT: decide whether a JOIN is allowed (joinGate, which every door reads), touch a
//        Hold'em table or Monopoly board itself (roomHoldemHandlers and
//        roomMonopolyHandlers own those, and are handed the room after the removal is on
//        it), or cap a server's reach (challengeReach).
//
// ⚠️ A REMOVAL WRITES THE ROOM ROW FIRST, then the channel, then the game. The row write
// (gameRoomStore.removeMember) is the guarantee: from it on, every door refuses the
// member (kickedIds), no gate counts them a player (out of playerIds), and a finish rates
// without them. A game step that loses to a busy table is retried, and its failure leaves
// a seat the host is told to remove again, never a member who can walk back in.

// Shared by every pack, so the default pack serves every guild (see the pack's note).
const words = rokCommanderCopy.arcadeHostControls;

// ── who may press ─────────────────────────────────────────────────────
// The host, or an admin: the same override the router gives every hostOnly button,
// because clearing a room a host abandoned is moderation.
async function isHostOrAdmin(interaction: StringSelectMenuInteraction | ModalSubmitInteraction, room: IGameRoom): Promise<boolean> {
	if (interaction.user.id === room.hostId) return true;
	return gateOwnerOrAdmin(interaction, await guildConfigStore.findByGuildId(room.guildId));
}

// A host control select's room, read fresh and scoped to the clicking guild (a room in
// another guild reads as not found, invariant 2), with the press gated. Replies and
// answers null on every refusal.
async function loadRoomForHost(interaction: StringSelectMenuInteraction | ModalSubmitInteraction): Promise<IGameRoom | null> {
	const roomId = interaction.customId.split(":")[2];
	const guildId = interaction.guildId;
	if (!guildId || !interaction.guild || !roomId) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.host, sections: [gameRoomsCopy.errors.controlRetired] });
		return null;
	}
	const room = await gameRoomStore.findByRoomId(guildId, roomId);
	if (!room) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.host, sections: [gameRoomsCopy.errors.notFound] });
		return null;
	}
	if (!(await isHostOrAdmin(interaction, room))) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.host, sections: [gameRoomsCopy.errors.notYours] });
		return null;
	}
	return room;
}

const isRatingBand = (value: string | undefined): value is RatingBand => (RATING_BANDS as readonly (string | undefined)[]).includes(value);

// One select option per member, named as the server shows them. Capped at a select's 25,
// which is also GAME_ROOM_MAX_SPECTATORS, so no room can hold more than a picker shows.
async function memberOptions(guild: Guild, userIds: readonly string[]): Promise<{ label: string; value: string }[]> {
	const options: { label: string; value: string }[] = [];
	for (const userId of [...new Set(userIds)].slice(0, BOT_CONSTANTS.GAME_ROOM_MAX_SPECTATORS)) {
		// A Dero bot seat (2026-10 item 250 Phase 5) is named, never fetched: its id is no member's.
		if (isBotSeatId(userId)) {
			options.push({ label: botSeatName(userId), value: userId });
			continue;
		}
		const member = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
		options.push({ label: (member?.displayName || member?.user.username || userId).slice(0, 100), value: userId });
	}
	return options;
}

function pickerSelect(action: string, roomId: string, placeholder: string, options: { label: string; value: string }[], maxValues: number): StringSelectMenuBuilder {
	return new StringSelectMenuBuilder()
		.setCustomId(`${GAME_ROOM_SELECT_PREFIX}:${action}:${roomId}`)
		.setPlaceholder(placeholder)
		.setMinValues(1)
		.setMaxValues(maxValues)
		.addOptions(options);
}

function pickerRow(action: string, roomId: string, placeholder: string, options: { label: string; value: string }[], maxValues: number) {
	return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(pickerSelect(action, roomId, placeholder, options, maxValues));
}

// ── the rating band ───────────────────────────────────────────────────
/** The band select on a draft card: rated games only, and only the three bands there are. */
export async function handleBandSelect(interaction: StringSelectMenuInteraction): Promise<void> {
	const room = await loadRoomForHost(interaction);
	if (!room) return;
	if (room.status !== "draft") {
		await showNotice(interaction, { title: gameRoomsCopy.notices.host, sections: [gameRoomsCopy.board.draftGone] });
		return;
	}
	const band = interaction.values[0];
	if (!isRatedGame(room.game) || !isRatingBand(band)) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.host, sections: [gameRoomsCopy.errors.controlRetired] });
		return;
	}
	const updated = (await gameRoomStore.update(room.guildId, room.roomId, { ratingBand: band })) ?? room;
	await interaction.deferUpdate();
	await refreshDraftCard(interaction.guild!, updated);
}

// ── who may watch (2026-10 item 254, Arcade 11) ────────────────────────
const isSpectatorMode = (value: string | undefined): value is SpectatorMode => (SPECTATOR_MODES as readonly (string | undefined)[]).includes(value);

/**
 * The spectator select on a draft card: Open to spectators, Invite only or No spectators.
 * A draft control, stored on the row and read once, when the provisioner builds the room's
 * matrix; a room already open keeps the permissions it opened with. Never on a network
 * table, whose card offers no select, since its watchers elsewhere are its satellites.
 */
export async function handleSpectatorSelect(interaction: StringSelectMenuInteraction): Promise<void> {
	const room = await loadRoomForHost(interaction);
	if (!room) return;
	if (room.status !== "draft") {
		await showNotice(interaction, { title: gameRoomsCopy.notices.host, sections: [gameRoomsCopy.board.draftGone] });
		return;
	}
	const mode = interaction.values[0];
	if (!isSpectatorMode(mode) || room.network) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.host, sections: [gameRoomsCopy.errors.controlRetired] });
		return;
	}
	const updated = (await gameRoomStore.update(room.guildId, room.roomId, { spectatorMode: mode })) ?? room;
	await interaction.deferUpdate();
	await refreshDraftCard(interaction.guild!, updated);
}

// ── approving each joiner ─────────────────────────────────────────────
/**
 * Approve each joiner, on or off. `choice` is the value the press SETS. A draft control:
 * the router refuses it once the draft has started. Turning it off leaves anybody already
 * waiting on the list, still answered from Requests, rather than letting them in unasked.
 */
export async function toggleApproval(interaction: ButtonInteraction, room: IGameRoom, choice: string): Promise<void> {
	if (choice !== "on" && choice !== "off") {
		await showNotice(interaction, { title: gameRoomsCopy.notices.host, sections: [gameRoomsCopy.errors.controlRetired] });
		return;
	}
	const updated = (await gameRoomStore.update(room.guildId, room.roomId, { requireApproval: choice === "on" })) ?? room;
	await interaction.deferUpdate();
	await refreshDraftCard(interaction.guild!, updated);
}

// Requests can be answered while a draft gathers, and at a Hold'em table, the one room
// a member can still ask to join once it is open.
const canAnswerRequests = (room: IGameRoom): boolean => room.status === "draft" || (room.game === "holdem" && room.status === "playing");

/**
 * The Requests button: a panel with an Accept and a Decline select over everyone waiting,
 * posted in 💬dero-commands (2026-10 item 257 Phase 5: two multi picks are no single choice a
 * modal holds). Each select re-gates its presser through loadRoomForHost.
 */
export async function openJoinRequests(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	if (!canAnswerRequests(room)) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.host, sections: [gameRoomsCopy.board.draftGone] });
		return;
	}
	const waiting = room.pendingJoinIds ?? [];
	if (waiting.length === 0) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.host, sections: [words.approval.requestsEmpty] });
		return;
	}
	const options = await memberOptions(interaction.guild!, waiting);
	await answerInChannel(interaction, "member", {
		content: words.approval.requestsPrompt,
		components: [
			pickerRow("accept", room.roomId, words.approval.acceptPlaceholder, options, options.length),
			pickerRow("decline", room.roomId, words.approval.declinePlaceholder, options, options.length),
		],
	});
}

/** The Accept and Decline selects. Only ids still waiting are answered, whatever the select sent. */
export async function handleJoinRequestSelect(interaction: StringSelectMenuInteraction): Promise<void> {
	const action = interaction.customId.split(":")[1];
	const room = await loadRoomForHost(interaction);
	if (!room) return;
	if (!canAnswerRequests(room)) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.host, sections: [gameRoomsCopy.board.draftGone] });
		return;
	}
	// ⚠️ RE-FILTERED AGAINST THE ROW. The values arrive from the client, so only members
	// still on the waiting list are answered; a forged id, or one answered a moment ago,
	// is ignored rather than admitted.
	const waiting = new Set(room.pendingJoinIds ?? []);
	const chosen = [...new Set(interaction.values)].filter((userId) => waiting.has(userId));
	if (chosen.length === 0) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.host, sections: [words.approval.requestsEmpty] });
		return;
	}

	// Accepting can seat Hold'em players one at a time, which can outrun Discord's three
	// seconds; the panel is edited with the summary once it is done.
	await interaction.deferUpdate();
	const summary = action === "decline" ? await declineRequests(interaction, room, chosen) : await acceptRequests(interaction, room, chosen);
	await interaction.editReply({ content: summary, components: [] });
}

async function declineRequests(interaction: StringSelectMenuInteraction, room: IGameRoom, userIds: string[]): Promise<string> {
	const updated = (await gameRoomStore.declinePendingJoins(room.guildId, room.roomId, userIds)) ?? room;
	// A Hold'em joiner paid the card's buy in when they asked; declined, they get it back.
	if (room.status === "draft") await refundJoiners(room, userIds);
	await refreshRoomControls(interaction, updated);
	await tellJoiners(interaction, room, userIds, "declined");
	return words.approval.declined(userIds.length);
}

// A draft's accepted member joins its pool, up to the pool's cap; a Hold'em table's
// joins its players and is then seated the way their own press would have seated them.
async function acceptRequests(interaction: StringSelectMenuInteraction, room: IGameRoom, userIds: string[]): Promise<string> {
	if (room.status === "draft") return acceptIntoPool(interaction, room, userIds);

	const lines: string[] = [];
	const accepted: string[] = [];
	let latest = room;
	for (const userId of userIds) {
		// Read BEFORE the admit, which takes the origin off the row with the request: a
		// member who asked from another server's network board (2026-10 item 244 Phase 5b)
		// is seated through a satellite in that server, not in this room.
		const origin = (room.pendingNetworkJoins ?? []).find((entry) => entry.userId === userId) ?? null;
		const admitted = await gameRoomStore.admitPendingJoin(room.guildId, room.roomId, userId, "playerIds");
		if (!admitted) continue;
		accepted.push(userId);
		latest = admitted;
		const refusal = origin
			? await seatAcceptedRemotePlayer(interaction.client, admitted, userId, origin.guildId)
			: await seatAcceptedPlayer(interaction.client, admitted, userId, (await memberOptions(interaction.guild!, [userId]))[0]?.label ?? userId);
		if (refusal) lines.push(words.approval.acceptedNotSeated(userId, refusal));
	}
	// A seat that landed redrew the table already; this catches the Requests count when none did.
	await redrawTable(interaction.client, (await gameRoomStore.findByRoomId(room.guildId, room.roomId)) ?? latest);
	await tellJoiners(interaction, room, accepted, "accepted");
	return [words.approval.accepted(accepted.length), ...lines].join("\n");
}

async function acceptIntoPool(interaction: StringSelectMenuInteraction, room: IGameRoom, userIds: string[]): Promise<string> {
	let poolSize = (room.spectatorIds ?? []).length;
	const accepted: string[] = [];
	let latest = room;
	let poolFilled = false;
	for (const userId of userIds) {
		if (poolSize >= BOT_CONSTANTS.GAME_ROOM_MAX_SPECTATORS) {
			poolFilled = true;
			break;
		}
		const admitted = await gameRoomStore.admitPendingJoin(room.guildId, room.roomId, userId, "spectatorIds");
		if (!admitted) continue;
		accepted.push(userId);
		poolSize++;
		latest = admitted;
	}
	// Each accepted person takes a Dero bot's seat on a Casual draft (2026-10 item 254,
	// Arcade 6), the same as a person who pressed Join with no approval to wait on.
	latest = await yieldBotSeatsTo(interaction.client, room, latest);
	await refreshDraftCard(interaction.guild!, latest);
	await tellJoiners(interaction, room, accepted, "accepted");
	const summary = words.approval.accepted(accepted.length);
	return poolFilled ? `${summary}\n${words.approval.poolFull(BOT_CONSTANTS.GAME_ROOM_MAX_SPECTATORS)}` : summary;
}

// ── telling a joiner the host's answer (2026-10 item 254, Arcade 6) ──
// What:  one DM to each member the host accepted or declined from Requests, naming the
//        game, the server and the answer.
// Why a DM: the joiner's own press was answered long ago with "your request is with the
//        host", and that interaction token is gone, so a private reply cannot reach them.
// ⚠️ NEVER THROWS AND NEVER HOLDS THE ANSWER BACK. Many members close DMs from server
// members; a refused DM is logged and skipped, since the card's player list (or the
// table) already shows whether they are in. Mentions are switched off, as on every line.
async function tellJoiners(interaction: StringSelectMenuInteraction, room: IGameRoom, userIds: readonly string[], answer: "accepted" | "declined"): Promise<void> {
	const line = gameRoomsCopy.joinAnswer[answer](gameRoomsCopy.gameLabel(room.game), interaction.guild?.name ?? "");
	await Promise.all(
		userIds.map(async (userId) => {
			try {
				const user = await interaction.client.users.fetch(userId);
				await user.send({ content: line, allowedMentions: { parse: [] } });
			} catch (error) {
				console.warn("[game-rooms] could not DM a joiner the host's answer", { guildId: room.guildId, roomId: room.roomId, userId, answer, error });
			}
		})
	);
}

// After a request is answered: the draft's card, or the Hold'em table, shows the new count.
async function refreshRoomControls(interaction: StringSelectMenuInteraction, room: IGameRoom): Promise<void> {
	if (room.status === "draft") await refreshDraftCard(interaction.guild!, room);
	else await redrawTable(interaction.client, room);
}

// ── removing a member ─────────────────────────────────────────────────
/**
 * Who the host may remove from this room right now, never the host; null when the room
 * allows no removal (a finished room, or a game outside REMOVABLE_IN_PLAY_GAMES in play).
 * A draft offers its pool and its waiting list. In play it is every player plus anyone
 * the game itself still seats: a Hold'em seat still in or waiting for the deal, and a
 * Monopoly seat not yet out, which is also how a removal whose seat a busy board kept can
 * be pressed again to finish the job.
 */
export function removableMembers(room: IGameRoom): string[] | null {
	const othersIn = (userIds: readonly string[]): string[] => [...new Set(userIds)].filter((userId) => userId !== room.hostId);
	if (room.status === "draft") return othersIn([...(room.spectatorIds ?? []), ...(room.pendingJoinIds ?? [])]);
	if (room.status !== "playing" || !REMOVABLE_IN_PLAY_GAMES.includes(room.game)) return null;

	const players = room.playerIds ?? [];
	if (room.game === "holdem") {
		const table = room.secret as unknown as HoldemTable | null;
		const seated = (table?.seats ?? []).filter((seat) => !seat.out).map((seat) => seat.userId);
		const waitingForDeal = (table?.pendingSeats ?? []).map((entry) => entry.userId);
		return othersIn([...players, ...seated, ...waitingForDeal, ...(room.pendingJoinIds ?? [])]);
	}
	if (room.game === "monopoly") {
		const stillIn = (monopolyStateOf(room)?.seats ?? []).filter((seat) => !seat.bankrupt).map((seat) => seat.userId);
		return othersIn([...players, ...stillIn]);
	}
	// A battleship captain can be a Dero bot (2026-10 item 250 Phase 5), seated only in the match.
	const captains = ((room.secret as StoredBattleship | null)?.players ?? []).map((player) => player.userId);
	return othersIn([...players, ...captains]);
}

/** Remove a player: a private picker over removableMembers, one member per press. */
export async function openRemovePicker(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	const candidates = removableMembers(room);
	if (candidates === null) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.host, sections: [gameRoomsCopy.errors.controlRetired] });
		return;
	}
	if (candidates.length === 0) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.host, sections: [words.kick.empty] });
		return;
	}
	const options = await memberOptions(interaction.guild!, candidates);
	const select = pickerSelect("kick", room.roomId, words.kick.placeholder, options, 1);
	await showPicker(interaction, { action: "kick", roomId: room.roomId, title: gameRoomsCopy.notices.host, prompt: words.kick.prompt, label: words.kick.placeholder, select });
}

/**
 * The picker's submission, from its modal or its select message. Re-gated and re-read,
 * and the chosen member must still be removable by the fresh row, so the host (never in
 * the list) and anyone already gone are refused whatever the select sent.
 */
export async function handleRemoveSelect(interaction: StringSelectMenuInteraction | ModalSubmitInteraction): Promise<void> {
	const room = await loadRoomForHost(interaction);
	if (!room) return;
	const target = pickedValues(interaction)[0];
	if (!target || !(removableMembers(room) ?? []).includes(target)) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.host, sections: [words.kick.gone] });
		return;
	}

	// A removal in play talks to Discord and may retry a busy table, so the picker is
	// acknowledged first and edited with the outcome.
	await deferPick(interaction);
	const updated = await gameRoomStore.removeMember(room.guildId, room.roomId, target);
	if (!updated) {
		await answerPick(interaction, words.kick.gone);
		return;
	}
	const outcome =
		updated.status === "draft"
			? await removeFromDraft(interaction.guild!, updated, target)
			: await removeFromMatch(interaction.client, updated, target, interaction.user.id);
	await answerPick(interaction, outcome);
}

async function removeFromDraft(guild: Guild, room: IGameRoom, userId: string): Promise<string> {
	// A removed Hold'em joiner gets the card's buy in back (2026-10 item 257 Phase 4a).
	await refundJoiners(room, [userId]);
	await refreshDraftCard(guild, room);
	return words.kick.removed(userId);
}

// The room row already holds the removal. Then: the member's own overwrite goes, so they
// can no longer type in the room; the trail says who removed whom; and the game lets the
// seat go its own way. `room` is the row the removal returned, carrying kickedIds, which
// is what keeps any finish this sets off from rating the removed player.
async function removeFromMatch(client: Client, room: IGameRoom, userId: string, actorId: string): Promise<string> {
	// A Dero bot has no overwrite to take away, and its removal is a bot.slot line in
	// 🗒️admin-log (2026-10 item 250 Phase 5), the same flow as removing a member otherwise.
	if (isBotSeatId(userId)) logBotRemoved(client, room, userId, actorId);
	else await revokeMemberOverwrite(client, room, userId);
	const trailLine = words.kick.trailLine(actorId, userId);

	// Monopoly carries the line on its board with the forfeit it causes, so the board stays
	// the last message in the room (2026-10 item 254, Arcade 8); it posts on its own only
	// when there was no seat left to take out.
	if (room.game === "monopoly") {
		const removal = await removeFromMonopolyMatch(client, room, userId, actorId, trailLine);
		if (removal !== "removed") await roomTrail.postMove(client, room, { actorId, kind: "system", text: trailLine });
		return removal === "busy" ? words.kick.seatStillHeld(userId) : words.kick.removed(userId);
	}
	await roomTrail.postMove(client, room, { actorId, kind: "system", text: trailLine });

	if (room.game === "battleship") {
		// A two player match with one player removed has nobody to play: it ends
		// through the abandoned path, which rates nothing and pays no room top up.
		await roomLifecycle.finish(client, room, { abandoned: true });
		return words.kick.removed(userId);
	}
	const removal = await removeFromTable(client, room, userId, actorId);
	// Nothing to take off the table (an invitee who never bought in) still changes the
	// board's Requests count and players, so the table redraws either way.
	if (removal === "notAtTable") await redrawTable(client, room);
	return removal === "busy" ? words.kick.seatStillHeld(userId) : words.kick.removed(userId);
}

function logBotRemoved(client: Client, room: IGameRoom, botId: string, actorId: string): void {
	adminLog.emit({
		guild: { id: room.guildId, client },
		kind: "bot.slot",
		actor: { userId: actorId },
		payload: { subject: gameRoomsCopy.gameLabel(room.game), detail: gameRoomsCopy.board.botRemovedDetail(botSeatName(botId)), game: room.game, matchId: room.roomId, botId, actor: actorId },
	});
}

// ⚠️ THE MEMBER'S OWN OVERWRITE IS DELETED, AND NOTHING ELSE. In a room open to
// spectators that leaves the ONE @everyone overwrite exactly as it was (view, no send,
// no reactions), so the removed member falls back to it and can no longer type;
// rebuilding the whole set here would re-derive every other entry for no reason. In a
// room closed to spectators they fall back to the @everyone ViewChannel deny and lose
// sight of the room. Logged on failure: the row
// already refuses them everywhere, and a removal must not stop on a Discord hiccup.
async function revokeMemberOverwrite(client: Client, room: IGameRoom, userId: string): Promise<void> {
	if (!room.channelId) return;
	const channel = await client.channels.fetch(room.channelId).catch(() => null);
	if (!(channel instanceof TextChannel)) return;
	await channel.permissionOverwrites
		.delete(userId, "removed from the game room by its host")
		.catch((error) => console.warn("[game-rooms] failed to remove a removed member's overwrite", { roomId: room.roomId, error }));
}

export const hostControls = {
	handleSpectatorSelect,
	handleBandSelect,
	toggleApproval,
	openJoinRequests,
	handleJoinRequestSelect,
	openRemovePicker,
	handleRemoveSelect,
};
