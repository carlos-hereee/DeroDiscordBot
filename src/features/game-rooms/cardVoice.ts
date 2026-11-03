import type { ButtonInteraction, Guild } from "discord.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { deroVoiceConfigStore } from "@db/stores/deroVoiceConfigStore.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { postVoiceNotice } from "@features/voice/joinNotice.js";
import { normalizePriorityOrder } from "@features/voice/voicePriority.js";
import { voiceQueue, type QueueChange, type VoiceQueueInput } from "@features/voice/voiceQueue.js";
import { voiceSessions } from "@features/voice/voiceSessions.js";
import { acknowledgeConfirm, showConfirm, showNotice, type ConfirmInteraction } from "@utils/textModal.js";
import { cardStateFor, refreshCard } from "./challengeCard.js";
import { cardVoiceState } from "./cardVoiceState.js";
import { confirmCustomId } from "./gameRoomActions.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { matchCategory } from "./roomReferee.js";
import { refereeOn } from "./roomTypes.js";

// ── cardVoice ────────────────────────────────────────────────────────
// What:  Dero's voice from the challenge card (2026-10 item 267, decisions 11 and 12). A card
//        with Dero voice on asks for Dero the moment it posts, into the host's current call,
//        else 🎮 Arcade Lounge. While Dero is in another call nothing is queued by itself: the
//        card shows the host a Queue Dero button whose modal says where Dero is and the place
//        the card would take, and its Submit queues the card. Calling the card off takes its
//        request out and sends Dero away only from a call this card started.
// Who:   challengeBoard (the post, Call it off and the other closes), gameRoomHandlers (Queue
//        Dero and its Submit, actions `dqueue` and `dqueueok`), and main.ts, which hands
//        `afterQueueChange` to voiceQueue.onChange so the card's place line keeps up.
// Does NOT: join anything itself. Every join runs through voiceQueue and dero.ts
//        runQueuedJoin, the one join path, which skips the task speaker list for a game's
//        request but never the voice switch or the allow list, and says why on the card's
//        channel when it cannot join.
// Where: the card's voice line lives in cardVoiceState, memory only like the queue itself.

const words = gameRoomsCopy.cardVoice;

/** Where a card's request sends Dero: the host's own call, else the Arcade Lounge. */
interface CardVoiceTarget {
	channelId: string;
	followsHost: boolean;
}

// The host's call wins, because that is where the players already are; the Lounge is the
// arcade's shared room for a host who is in no call (decision 11).
async function targetFor(guild: Guild, room: IGameRoom): Promise<CardVoiceTarget | null> {
	const hostCallId = guild.voiceStates.cache.get(room.hostId)?.channelId ?? null;
	if (hostCallId) return { channelId: hostCallId, followsHost: true };
	const config = (await guildConfigStore.findByGuildId(guild.id)) as { arcadeVoiceChannelId?: string | null } | null;
	const loungeId = config?.arcadeVoiceChannelId ?? null;
	return loungeId ? { channelId: loungeId, followsHost: false } : null;
}

function requestFor(guild: Guild, room: IGameRoom, target: CardVoiceTarget, cardChannelId: string): VoiceQueueInput {
	return {
		guild,
		requesterId: room.hostId,
		channelId: target.channelId,
		// The card's channel hears the join notice, or the line saying why there was no join.
		controlChannelId: cardChannelId,
		category: matchCategory(room),
		gameVoice: { roomId: room.roomId, followsHost: target.followsHost, subject: words.cardSubject(room.game, cardChannelId) },
	};
}

// Redraws a card from its row while it still gathers; a card that started or closed keeps
// the words it ended with.
async function refreshDraft(guild: Guild, roomId: string): Promise<void> {
	const row = await gameRoomStore.findByRoomId(guild.id, roomId);
	if (!row || row.status !== "draft") return;
	await refreshCard(guild, row, cardStateFor(row, { visibility: row.visibility, pool: row.spectatorIds ?? [] }));
}

/**
 * Ask for Dero for a card that just posted (decision 11). Fire and forget after the card is
 * up (rulebook convention 7): it never throws, so a failed join never fails the card.
 */
export async function bringDeroToCard(guild: Guild, room: IGameRoom, cardChannelId: string): Promise<void> {
	if (!refereeOn(room)) return;
	try {
		const target = await targetFor(guild, room);
		if (!target) {
			await postVoiceNotice(guild, cardChannelId, words.noLounge);
			return;
		}
		cardVoiceState.markRequested(room.roomId);
		const call = voiceSessions.get(guild.id);
		if (call?.channelId === target.channelId) return;
		// Busy elsewhere: the host decides whether this card waits (decision 12).
		if (call) {
			cardVoiceState.set(room.roomId, { kind: "busy", guildId: guild.id, busyChannelId: call.channelId });
			await refreshDraft(guild, room.roomId);
			return;
		}
		await voiceQueue.requestVoice(requestFor(guild, room, target, cardChannelId));
	} catch (error) {
		console.error("[game-rooms] the card could not ask for Dero's voice", { roomId: room.roomId, error });
	}
}

// The card's request while it still waits, by the id the card remembers.
async function waitingRequest(guildId: string, roomId: string) {
	const state = cardVoiceState.get(roomId);
	return state?.kind === "queued" ? voiceQueue.find(guildId, state.requestId) : null;
}

/**
 * Queue Dero, the host's press (strict host only, through the router). The modal is the first
 * answer: where Dero is and the place the card would take, with Submit queueing it. A press
 * that finds the card already queued, Dero free or already there says so instead.
 */
export async function offerQueue(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	const guild = interaction.guild;
	if (!guild) return;
	const title = gameRoomsCopy.notices.deroVoice;
	const queued = await waitingRequest(guild.id, room.roomId);
	if (queued) {
		await showNotice(interaction, { title, sections: [words.alreadyQueued(queued.place.place, queued.place.total)] });
		return;
	}
	const target = await targetFor(guild, room);
	if (!target) {
		await showNotice(interaction, { title, sections: [words.noTarget] });
		return;
	}
	const call = voiceSessions.get(guild.id);
	if (call?.channelId === target.channelId) {
		await showNotice(interaction, { title, sections: [words.alreadyThere] });
		return;
	}
	// Dero came free: the press is acknowledged quietly and Dero's join notice on the card's
	// channel is the answer, since work done is never a notice (owner rule 1, item 263).
	if (!call) {
		await interaction.deferUpdate();
		await askNow(guild, room, target, interaction.channelId ?? target.channelId);
		return;
	}
	const place = await voiceQueue.placeFor(guild.id, matchCategory(room));
	await showConfirm(interaction, {
		title,
		sections: [words.confirmWhere(call.channelId), words.confirmPlace(place.place, place.total, target.channelId)],
		confirmId: confirmCustomId("dqueueok", room.roomId),
	});
}

// Dero came free between the card's line and the press: the card asks for him now, as it did
// when it posted, and its busy line goes.
async function askNow(guild: Guild, room: IGameRoom, target: CardVoiceTarget, cardChannelId: string): Promise<void> {
	cardVoiceState.clear(room.roomId);
	await voiceQueue.requestVoice(requestFor(guild, room, target, cardChannelId));
	await refreshDraft(guild, room.roomId);
}

/**
 * Queue Dero's Submit: re-read where the host is and whether Dero is still busy, then queue the
 * card once. The check and the enqueue run with no await between them, so two Submits close
 * together queue once and the second is told the place the first took.
 */
export async function confirmQueue(interaction: ConfirmInteraction, room: IGameRoom): Promise<void> {
	const guild = interaction.guild;
	if (!guild) return;
	const title = gameRoomsCopy.notices.deroVoice;
	const target = await targetFor(guild, room);
	if (!target) {
		await showNotice(interaction, { title, sections: [words.noTarget] });
		return;
	}
	const order = normalizePriorityOrder((await deroVoiceConfigStore.findByGuildId(guild.id))?.priorityOrder);
	const cardChannelId = interaction.channelId ?? target.channelId;

	const call = voiceSessions.get(guild.id);
	if (call?.channelId === target.channelId) {
		await showNotice(interaction, { title, sections: [words.alreadyThere] });
		return;
	}
	if (!call) {
		await acknowledgeConfirm(interaction);
		await askNow(guild, room, target, cardChannelId);
		return;
	}
	const state = cardVoiceState.get(room.roomId);
	const waiting = voiceQueue.list(guild.id, order);
	const already = state?.kind === "queued" ? waiting.findIndex((request) => request.id === state.requestId) : -1;
	if (already !== -1) {
		await showNotice(interaction, { title, sections: [words.alreadyQueued(already + 1, waiting.length)] });
		return;
	}
	const place = voiceQueue.enqueue(requestFor(guild, room, target, cardChannelId), order);
	// One place per member, so the host's request is the one the queue holds for them.
	const queued = voiceQueue.list(guild.id, order).find((request) => request.requesterId === room.hostId);
	if (queued) cardVoiceState.set(room.roomId, { kind: "queued", guildId: guild.id, requestId: queued.id, place: place.place, total: place.total });
	await acknowledgeConfirm(interaction);
	await refreshDraft(guild, room.roomId);
}

/**
 * A card closed without a room (Call it off, a replaced draft, Play Dero instead): its request
 * leaves the queue, and Dero leaves the call only when this card's request started it
 * (decision 11). A call someone started with /dero join is never ended by a card.
 */
export async function releaseCard(guild: Guild, roomId: string): Promise<void> {
	try {
		cardVoiceState.forget(roomId);
		// Any order finds the card's request, so the stored one is not read: closing a card costs no query.
		for (const request of voiceQueue.list(guild.id, normalizePriorityOrder(undefined))) {
			if (request.gameVoice?.roomId === roomId) voiceQueue.remove(guild.id, request.id);
		}
		if (voiceSessions.get(guild.id)?.startedByRoomId === roomId) voiceSessions.leave(guild.id);
	} catch (error) {
		console.error("[game-rooms] the closed card could not release Dero's voice", { roomId, error });
	}
}

// Every queued card of the guild at its place now, and a card whose request stopped waiting
// (joined, skipped, removed by an admin, expired) loses its line.
async function redrawQueuedCards(guild: Guild): Promise<void> {
	const waiting = await voiceQueue.ranked(guild.id);
	for (const [roomId, state] of cardVoiceState.queuedIn(guild.id)) {
		const index = waiting.findIndex((request) => request.id === state.requestId);
		if (index === -1) {
			cardVoiceState.clear(roomId);
			await refreshDraft(guild, roomId);
			continue;
		}
		if (state.place === index + 1 && state.total === waiting.length) continue;
		cardVoiceState.set(roomId, { ...state, place: index + 1, total: waiting.length });
		await refreshDraft(guild, roomId);
	}
}

/** voiceQueue.onChange's listener for the cards. Never throws. */
export function afterQueueChange(change: QueueChange): void {
	void redrawQueuedCards(change.request.guild).catch((error: unknown) =>
		console.warn(`[game-rooms] a queued card's voice line did not redraw guild=${change.request.guild.id}`, error)
	);
}
