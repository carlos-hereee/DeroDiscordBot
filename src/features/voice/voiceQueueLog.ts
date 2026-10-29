import { ActionRowBuilder, ButtonBuilder, ButtonStyle, TextChannel, type ButtonInteraction, type Client, type MessageActionRowComponentBuilder } from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { registerButton } from "@handlers/interactionRegistry.js";
import { adminLog, buildAdminLogEmbed, resolveAdminLogAuthor } from "@features/setup/adminLog.js";
import { gateOwnerOrAdmin } from "@utils/permissions.js";
import { showNotice } from "@utils/textModal.js";
import { voiceCopy } from "./voiceCopy.js";
import { voiceQueue, type QueueChange, type QueueExit, type QueuePlace, type VoiceQueue, type VoiceQueueRequest } from "./voiceQueue.js";

// ── voiceQueueLog ─────────────────────────────────────────────────────────
// What:  one 🗒️admin-log entry per request that waits for Dero's voice (2026-10 item 267,
//        decision 12), naming what it is for, who asked and its place, with Move up, Move
//        down and Remove buttons an owner or admin presses to steer the queue.
// Who:   main.ts hands `afterQueueChange` to voiceQueue.onChange and calls
//        `registerVoiceQueueLogHandlers` once at boot. Nothing else posts these entries.
// Does NOT: order the queue or decide who may join; voiceQueue moves and removes, and
//        dero.ts runQueuedJoin runs the head. This only shows the queue and forwards presses.
// Where: the entry's message ids live in memory beside the queue, so a restart forgets both
//        together: the queue is memory only, and an entry left behind by a restart answers
//        its next press with the stale notice, since its request id is gone too.
// How:   every change is applied through one promise chain per guild, so an entry is posted
//        before any redraw of it runs and two quick presses never draw out of order. A press
//        waits for its guild's chain, so the redraw it caused has landed when it returns.

const VOICE_QUEUE_LOG_PREFIX = "voicequeue";

type QueueLogAction = "up" | "down" | "remove";

const QUEUE_LOG_ACTIONS: ReadonlySet<string> = new Set<QueueLogAction>(["up", "down", "remove"]);

/** One posted entry: where it is, and what its embed was first drawn with. */
interface QueueLogEntry {
	guildId: string;
	client: Client;
	channelId: string;
	messageId: string;
	atSeconds: number;
	request: VoiceQueueRequest;
}

const entries = new Map<string, QueueLogEntry>();
const chains = new Map<string, Promise<void>>();

// Runs `task` after every earlier task of the same guild. A failure is logged and never
// breaks the chain, since the next change must still draw (rulebook convention 7).
function schedule(guildId: string, task: () => Promise<void>): Promise<void> {
	const next = (chains.get(guildId) ?? Promise.resolve())
		.then(task)
		.catch((error: unknown) => console.warn(`[dero-voice] an admin log queue entry failed guild=${guildId}`, error));
	chains.set(guildId, next);
	return next;
}

function subjectOf(request: VoiceQueueRequest): string {
	return request.gameVoice?.subject ?? voiceCopy.call.queueSubjectForMember(request.channelId);
}

function controlRow(requestId: string): ActionRowBuilder<MessageActionRowComponentBuilder> {
	const button = (action: QueueLogAction, label: string, emoji: string, style: ButtonStyle): ButtonBuilder =>
		new ButtonBuilder().setCustomId(`${VOICE_QUEUE_LOG_PREFIX}:${action}:${requestId}`).setLabel(label).setEmoji(emoji).setStyle(style);
	const words = voiceCopy.queueAdmin;
	return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
		button("up", words.moveUpLabel, "⬆️", ButtonStyle.Secondary),
		button("down", words.moveDownLabel, "⬇️", ButtonStyle.Secondary),
		button("remove", words.removeLabel, "🗑️", ButtonStyle.Danger)
	);
}

// ── posting and redrawing ──

async function postEntry(request: VoiceQueueRequest, place: QueuePlace): Promise<void> {
	const result = await adminLog.write({
		guild: { id: request.guild.id, client: request.guild.client },
		kind: "voice.queue",
		actor: { userId: request.requesterId },
		payload: { subject: subjectOf(request), detail: voiceCopy.queueAdmin.waiting(request.requesterId, request.channelId, place.place, place.total), requestId: request.id },
		components: [controlRow(request.id)],
	});
	if (!result.message) return;
	entries.set(request.id, {
		guildId: request.guild.id,
		client: request.guild.client,
		...result.message,
		atSeconds: Math.floor(Date.now() / 1000),
		request,
	});
}

// Edits one entry to a new detail line, with its buttons or without them.
async function drawEntry(entry: QueueLogEntry, detail: string, withControls: boolean): Promise<void> {
	const channel = await entry.client.channels.fetch(entry.channelId).catch(() => null);
	if (!(channel instanceof TextChannel)) return;
	const guild = { id: entry.guildId, client: entry.client };
	const actor = { userId: entry.request.requesterId };
	const embed = buildAdminLogEmbed(
		{ kind: "voice.queue", atSeconds: entry.atSeconds, actor: `<@${actor.userId}>`, subject: subjectOf(entry.request), detail },
		await resolveAdminLogAuthor(guild, actor)
	);
	await channel.messages.edit(entry.messageId, { embeds: [embed], components: withControls ? [controlRow(entry.request.id)] : [], allowedMentions: { parse: [] } });
}

// Every still waiting entry of the guild, at its place now: one move shifts its neighbour
// too, and a request that left moves everyone behind it up.
async function redrawWaiting(queue: VoiceQueue, guildId: string): Promise<void> {
	const waiting = await queue.ranked(guildId);
	for (const [index, request] of waiting.entries()) {
		const entry = entries.get(request.id);
		if (entry) await drawEntry(entry, voiceCopy.queueAdmin.waiting(request.requesterId, request.channelId, index + 1, waiting.length), true);
	}
}

async function closeEntry(request: VoiceQueueRequest, exit: QueueExit): Promise<void> {
	const entry = entries.get(request.id);
	if (!entry) return;
	entries.delete(request.id);
	await drawEntry(entry, voiceCopy.queueAdmin.ended(request.requesterId, request.channelId, exit), false);
}

/**
 * voiceQueue.onChange's listener: a request that now waits gets its entry, a move redraws
 * the guild's entries, and a request that stopped waiting has its entry closed (its buttons
 * off, the reason named) and the rest redrawn. Never throws; the chain logs a failure.
 */
export function createQueueChangeListener(queue: VoiceQueue = voiceQueue): (change: QueueChange) => void {
	return (change) => {
		const guildId = change.request.guild.id;
		void schedule(guildId, async () => {
			if (change.kind === "queued") {
				const found = await queue.find(guildId, change.request.id);
				if (found) await postEntry(change.request, found.place);
				await redrawWaiting(queue, guildId);
				return;
			}
			if (change.kind === "left") await closeEntry(change.request, change.exit);
			await redrawWaiting(queue, guildId);
		});
	};
}

export const afterQueueChange = createQueueChangeListener();

// ── the admin presses ──

function refuse(interaction: ButtonInteraction, line: string): Promise<void> {
	return showNotice(interaction, { title: voiceCopy.queueAdmin.noticeTitle, sections: [line] });
}

/**
 * Move up, Move down and Remove on an entry. The presser is re-checked as the owner or an
 * admin on every press, because a log message's buttons are only where the control sits.
 * A press on a request that already ran, was removed or expired is a state, said privately.
 */
export async function handleQueueLogButton(interaction: ButtonInteraction, queue: VoiceQueue = voiceQueue): Promise<void> {
	const [, action, requestId] = interaction.customId.split(":");
	const guildId = interaction.guildId;
	if (!guildId || !action || !requestId || !QUEUE_LOG_ACTIONS.has(action)) {
		await refuse(interaction, voiceCopy.queueAdmin.gone);
		return;
	}
	const config = await guildConfigStore.findByGuildId(guildId);
	if (!(await gateOwnerOrAdmin(interaction, config))) {
		await refuse(interaction, voiceCopy.queueAdmin.adminOnly);
		return;
	}

	if (action === "remove") {
		if (!queue.remove(guildId, requestId)) {
			await refuse(interaction, voiceCopy.queueAdmin.gone);
			return;
		}
	} else {
		const moved = action === "up" ? await queue.moveUp(guildId, requestId) : await queue.moveDown(guildId, requestId);
		if (!moved.ok) {
			const edgeLine = action === "up" ? voiceCopy.queueAdmin.atTop : voiceCopy.queueAdmin.atBottom;
			await refuse(interaction, moved.reason === "gone" ? voiceCopy.queueAdmin.gone : edgeLine);
			return;
		}
	}
	// The entry is the answer: the press is acknowledged quietly and the redraw it caused lands.
	await interaction.deferUpdate();
	await (chains.get(guildId) ?? Promise.resolve());
}

/** Register the entry buttons once at boot, from main.ts. */
export function registerVoiceQueueLogHandlers(): void {
	registerButton(VOICE_QUEUE_LOG_PREFIX, (interaction) => handleQueueLogButton(interaction));
}

/** Test seam: forget every entry and chain between tests. */
export function _resetQueueLog(): void {
	entries.clear();
	chains.clear();
}
