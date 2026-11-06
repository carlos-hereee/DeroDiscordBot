import { type ButtonInteraction, type Client, type Guild, type StringSelectMenuInteraction } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { networkBanStore } from "@db/stores/networkBanStore.js";
import { networkConsentStore } from "@db/stores/networkConsentStore.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { registerButton, registerSelectMenu } from "@handlers/interactionRegistry.js";
import { replyWithAgeGate } from "@features/age-gate/ageGateRules.js";
import { beginChannelAnswer } from "@utils/answerInChannel.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { judgeJoin } from "./joinGate.js";
import { NETWORK_BOARD_PREFIX, NETWORK_BOARD_SELECT_ID, scheduleNetworkBoardRefresh, takingPlayers } from "./networkBoard.js";
import {
	NETWORK_CONSENT_PREFIX,
	blocksEachOther,
	consentPrompt,
	isGuildBanned,
	isUserBanned,
	parseConsentId,
	readNetworkGuild,
} from "./networkRules.js";
import { hasNetworkConsent } from "./networkConsent.js";
import { redrawTable, seatAcceptedPlayer } from "./roomHoldemHandlers.js";
import { describeSatelliteRefusal, satelliteIn } from "./satelliteRooms.js";
import { openSatelliteWithTable } from "./satelliteSeats.js";
import { showNotice } from "@utils/textModal.js";

// ── networkJoin ──────────────────────────────────────────────────────
// What:  a member of one network server asking for a seat at a table hosted in another
//        (2026-10 item 244 Phase 5b): the network board's select, and the network
//        notice's two buttons, which every door hands a member who has not accepted it.
// Who:   registerNetworkHandlers, called by gameRoomHandlers' registration at boot.
// Does NOT: list tables (networkBoard), open, relay or seat out a satellite
//        (satelliteRooms, satelliteSeats), or judge the host's band and approval itself
//        (joinGate, the one gate every door reads).
//
// ⚠️ THE BOARD'S LISTING IS RE-CHECKED, ALL OF IT, ON THE FRESH ROW. A board message
// lives on in the channel's history and its select's value is user input, so a press is
// judged as if the board did not exist, in the owner's order: ① the member's own server
// is on the network and the table still takes players; ② the network notice; ③ the
// owner's bans (the member, their server, the host, the host's server); ④ the host's
// server is still on the network and neither server blocks the other; ⑤ the host's band
// and approval (joinGate); ⑥ only then a satellite opens.

const words = rokCommanderCopy.arcadeNetwork;

/** What a request for a seat came to. The caller turns it into a private reply. */
export type SeatRequestOutcome =
	| { kind: "consent" }
	// The age gate (2026-11 item 302) is global and ahead of the network notice; the
	// caller answers with replyWithAgeGate, ephemeral, never the board's public answer.
	| { kind: "ageGate" }
	| { kind: "refused"; text: string }
	| { kind: "asked" }
	| { kind: "seated"; channelId: string }
	| { kind: "alreadySeated"; channelId: string };

/**
 * Judge and, when everything passes, carry out one member's request for a seat at the
 * table `roomId` hosted in `hostGuildId`, asked from `fromGuild`. Writes only on the last
 * steps: the host's waiting list, or the satellite.
 */
export async function requestNetworkSeat(client: Client, fromGuild: Guild, userId: string, hostGuildId: string, roomId: string): Promise<SeatRequestOutcome> {
	// ①
	const viewer = await readNetworkGuild(client, fromGuild.id);
	if (!viewer.onNetwork) return { kind: "refused", text: words.joinRefusals.serverOffNetwork };
	const room = await gameRoomStore.findByRoomId(hostGuildId, roomId);
	if (!room || !isListable(room, fromGuild.id)) return { kind: "refused", text: words.joinRefusals.tableGone };
	const seatedHere = satelliteIn(room, fromGuild.id);
	if (seatedHere?.userIds.includes(userId)) return { kind: "alreadySeated", channelId: seatedHere.channelId };
	if ((room.pendingJoinIds ?? []).includes(userId)) return { kind: "refused", text: words.alreadyAsked };

	// ②
	if (!(await hasNetworkConsent(userId))) return { kind: "consent" };

	// ③
	const bans = await networkBanStore.findAgainst({ userIds: [userId, room.hostId], guildIds: [fromGuild.id, hostGuildId] });
	if (isUserBanned(bans, userId)) return { kind: "refused", text: words.joinRefusals.bannedUser };
	if (isGuildBanned(bans, fromGuild.id)) return { kind: "refused", text: words.joinRefusals.bannedServer };
	if (isGuildBanned(bans, hostGuildId) || isUserBanned(bans, room.hostId)) return { kind: "refused", text: words.joinRefusals.hostServerClosed };

	// ④
	const host = await readNetworkGuild(client, hostGuildId);
	if (!host.onNetwork) return { kind: "refused", text: words.joinRefusals.hostServerClosed };
	if (blocksEachOther(viewer.config, host.config)) return { kind: "refused", text: words.joinRefusals.blocked };

	// ⑤
	const verdict = await judgeJoin(room, userId, { alreadyApproved: false });
	if (verdict.kind === "refuse") return refusalFor(room, verdict.reason);
	if (verdict.kind === "ask") return askHost(client, room, userId, fromGuild.id);

	// ⑥
	return openSeat(room, fromGuild, userId);
}

// A table this server may still ask for a seat at: a live network game, hosted in another
// server, still taking players by the same two doors the board lists.
function isListable(room: IGameRoom, fromGuildId: string): boolean {
	if (!room.network || room.status !== "playing") return false;
	if (!(BOT_CONSTANTS.NETWORK_GAMES as readonly string[]).includes(room.game)) return false;
	if (room.guildId === fromGuildId) return false;
	return takingPlayers(room) !== null;
}

function refusalFor(room: IGameRoom, reason: "kicked" | "outsideBand" | "noConsent" | "noAgeConfirmation"): SeatRequestOutcome {
	if (reason === "noAgeConfirmation") return { kind: "ageGate" };
	if (reason === "noConsent") return { kind: "consent" };
	if (reason === "kicked") return { kind: "refused", text: words.joinRefusals.removed };
	return { kind: "refused", text: words.joinRefusals.outsideBand(gameRoomsCopy.gameLabel(room.game)) };
}

// The host approves each player: the request waits on the host's Requests list with the
// server it came from, and the table redraws so the Requests count moves. A null write
// means the host removed this member a moment ago (the store's kickedIds filter), or the
// table closed.
async function askHost(client: Client, room: IGameRoom, userId: string, fromGuildId: string): Promise<SeatRequestOutcome> {
	const updated = await gameRoomStore.addNetworkPendingJoin(room.guildId, room.roomId, userId, fromGuildId);
	if (!updated) return { kind: "refused", text: (room.kickedIds ?? []).includes(userId) ? words.joinRefusals.removed : words.joinRefusals.tableGone };
	await redrawTable(client, updated);
	return { kind: "asked" };
}

async function openSeat(room: IGameRoom, fromGuild: Guild, userId: string): Promise<SeatRequestOutcome> {
	const opened = await openSatelliteWithTable(room, fromGuild, [userId]);
	if (!opened.ok) return { kind: "refused", text: describeSatelliteRefusal(opened.reason, room) };
	scheduleNetworkBoardRefresh();
	return { kind: "seated", channelId: opened.channelId };
}

/**
 * Seat a member of another server the host just accepted from Requests: re-check what
 * may have changed while they waited (their server still on the network, no ban, no
 * block), open their satellite in the server they asked from, then seat them the way
 * their own Buy in would. Answers null once seated, or the reason they were not, for the
 * host's summary. The accept already put them in playerIds.
 */
export async function seatAcceptedRemotePlayer(client: Client, room: IGameRoom, userId: string, fromGuildId: string): Promise<string | null> {
	const guild = client.guilds.cache.get(fromGuildId);
	const [from, host, bans] = await Promise.all([
		readNetworkGuild(client, fromGuildId),
		readNetworkGuild(client, room.guildId),
		networkBanStore.findAgainst({ userIds: [userId], guildIds: [fromGuildId] }),
	]);
	if (!guild || !from.onNetwork) return words.hostAccept.serverGone;
	if (bans.length > 0 || blocksEachOther(from.config, host.config)) return words.hostAccept.closed;

	const opened = await openSatelliteWithTable(room, guild, [userId]);
	if (!opened.ok) return describeSatelliteRefusal(opened.reason, room);
	scheduleNetworkBoardRefresh();
	const member = await guild.members.fetch(userId).catch(() => null);
	return seatAcceptedPlayer(client, opened.room, userId, member?.displayName ?? rokCommanderCopy.arcadeSatellites.unknownPlayer);
}

/** The private words for an outcome. The consent and age gate outcomes are answered with their own prompt instead, by each caller. */
export function describeSeatRequest(outcome: Exclude<SeatRequestOutcome, { kind: "consent" } | { kind: "ageGate" }>): string {
	if (outcome.kind === "refused") return outcome.text;
	if (outcome.kind === "asked") return words.asked;
	if (outcome.kind === "alreadySeated") return words.alreadySeated(outcome.channelId);
	return words.seatReady(outcome.channelId);
}

// ── the board's select ────────────────────────────────────────────────
/** A member picked a table on their server's network board. */
export async function handleNetworkBoardSelect(interaction: StringSelectMenuInteraction): Promise<void> {
	const target = parseTableValue(interaction.customId === NETWORK_BOARD_SELECT_ID ? interaction.values[0] : undefined);
	if (!target || !interaction.guild) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.network, sections: [gameRoomsCopy.errors.controlRetired] });
		return;
	}
	// A satellite opening talks to Discord several times, which can outrun three seconds,
	// so the press is acknowledged first and the outcome posts where it was pressed (2026-10
	// item 257 Phase 5).
	const answer = await beginChannelAnswer(interaction, "here");
	const outcome = await requestNetworkSeat(interaction.client, interaction.guild, interaction.user.id, target.hostGuildId, target.roomId);
	if (outcome.kind === "consent") {
		await answer.send(consentPrompt({ kind: "join", ...target }));
		return;
	}
	if (outcome.kind === "ageGate") {
		await replyWithAgeGate(interaction);
		return;
	}
	await answer.send({ content: describeSeatRequest(outcome) });
}

// A board option's value, `<hostGuildId>:<roomId>`, checked for shape only; everything it
// names is re-read by requestNetworkSeat.
function parseTableValue(value: string | undefined): { hostGuildId: string; roomId: string } | null {
	const [hostGuildId, roomId, extra] = (value ?? "").split(":");
	if (!hostGuildId || !roomId || extra !== undefined) return null;
	if (!BOT_CONSTANTS.NETWORK.SERVER_ID_PATTERN.test(hostGuildId)) return null;
	return { hostGuildId, roomId };
}

// ── the network notice's buttons ──────────────────────────────────────
/**
 * I agree or Not now on the network notice. Agreeing stores consent at the current
 * version, then either asks the member to press again (a door in their own server, or
 * the host's network choice) or carries a board request on by itself.
 */
export async function handleNetworkConsentButton(interaction: ButtonInteraction): Promise<void> {
	const parsed = parseConsentId(interaction.customId);
	if (!parsed) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.network, sections: [gameRoomsCopy.errors.controlRetired] });
		return;
	}
	if (!parsed.accepted) {
		await interaction.update({ content: words.consent.declined, embeds: [], components: [] });
		return;
	}

	await networkConsentStore.accept(interaction.user.id, BOT_CONSTANTS.NETWORK.CONSENT_VERSION, new Date());
	if (parsed.next.kind === "again" || !interaction.guild) {
		await interaction.update({ content: words.consent.acceptedPressAgain, embeds: [], components: [] });
		return;
	}

	// The board request carries on. Acknowledged first, for the same three seconds.
	await interaction.deferUpdate();
	const outcome = await requestNetworkSeat(interaction.client, interaction.guild, interaction.user.id, parsed.next.hostGuildId, parsed.next.roomId);
	// The age gate (2026-11 item 302) is global and ahead of the network notice; the
	// network consent just accepted still stands, so this is said first, then the age
	// gate's own ephemeral prompt follows rather than being folded into this edit.
	if (outcome.kind === "ageGate") {
		await interaction.editReply({ content: words.consent.accepted, embeds: [], components: [] });
		await replyWithAgeGate(interaction);
		return;
	}
	// The consent row was just written, so "consent" cannot come back unless the write was
	// lost; the member is told they are on the network and can pick the table again.
	const text = outcome.kind === "consent" ? words.consent.accepted : `${words.consent.accepted}\n\n${describeSeatRequest(outcome)}`;
	await interaction.editReply({ content: text, embeds: [], components: [] });
}

/**
 * Register the network board's select and the network notice's buttons. Called once at
 * boot from gameRoomHandlers.registerGameRoomHandlers, beside the game room controls.
 */
export function registerNetworkHandlers(): void {
	registerSelectMenu(NETWORK_BOARD_PREFIX, handleNetworkBoardSelect);
	registerButton(NETWORK_CONSENT_PREFIX, handleNetworkConsentButton);
}

export const networkJoin = {
	requestNetworkSeat,
	handleNetworkBoardSelect,
	handleNetworkConsentButton,
	registerNetworkHandlers,
};
