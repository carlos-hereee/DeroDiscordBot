import type { Guild } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { deroVoiceConfigStore } from "@db/stores/deroVoiceConfigStore.js";
import { voiceSessions, type SessionEndReason } from "./voiceSessions.js";
import { normalizePriorityOrder, type VoicePriorityCategory } from "./voicePriority.js";

// ── voiceQueue ──────────────────────────────────────────────────────────────
// What:  the requests waiting for Dero's voice while he is in a call, per guild, in
//        the priority order an admin set (2026-10 item 257, owner item 22, decision
//        13). A request waits; it never moves Dero out of the call he is in.
// Who:   /dero join and the voice rooms' Join button enqueue (dero.ts); Phase 4b's
//        referee sends match requests through `requestVoice`, the one entry point that
//        joins at once when Dero is free; /dero status lists the queue; main.ts wires
//        `afterCallEnded` to voiceSessions.onEnd and hands over the runner.
// When:  a request is checked again only when it reaches the head, at the end of a
//        call: the runner skips one whose member left that voice channel, and the
//        queue drops one older than DERO_VOICE_QUEUE_EXPIRY_MS without asking.
// Where: in memory beside voiceSessions, so a deploy empties it (Risk R8, accepted:
//        calls themselves end on a deploy, and nobody waits for a call that ended).
// How:   ordered by the category's rank in the stored order, then first come. The
//        runner is registered by main.ts rather than imported, because the join flow
//        lives in the /dero command and a feature must not import a command.

/** One request for Dero's voice, waiting for the call he is in to end. */
export interface VoiceQueueRequest {
	guild: Guild;
	requesterId: string;
	// The voice channel the requester wants Dero in.
	channelId: string;
	// The text channel the join notice posts in when the request runs.
	controlChannelId: string;
	category: VoicePriorityCategory;
	requestedAt: number;
}

/** What the runner did with a request at the head of the queue. */
export type QueuedJoinOutcome =
	// Dero is in the request's call now; the queue stops until that call ends.
	| "joined"
	// The request no longer holds (its member left, voice switched off, a gate refused,
	// the join failed); it is dropped and the next one runs.
	| "skipped"
	// Dero is in a call again (another join won the race); the request keeps its place.
	| "busy";

export type QueuedJoinRunner = (request: VoiceQueueRequest) => Promise<QueuedJoinOutcome>;

/** A request's place, counted from 1, and how many wait in all. */
export interface QueuePlace {
	place: number;
	total: number;
}

export interface VoiceQueueDeps {
	now(): number;
	/** The voice channel Dero is in for this guild, or null when he is free. */
	sessionChannelId(guildId: string): string | null;
	/** The guild's stored order, made whole. */
	loadOrder(guildId: string): Promise<VoicePriorityCategory[]>;
}

export const defaultVoiceQueueDeps: VoiceQueueDeps = {
	now: () => Date.now(),
	sessionChannelId: (guildId) => voiceSessions.get(guildId)?.channelId ?? null,
	loadOrder: async (guildId) => normalizePriorityOrder((await deroVoiceConfigStore.findByGuildId(guildId))?.priorityOrder),
};

// A call that ended because the bot is shutting down hands Dero to nobody: the
// process is going away, and a join now would be cut a moment later.
const ENDINGS_THAT_DRAIN_NOTHING: ReadonlySet<SessionEndReason> = new Set<SessionEndReason>(["shutdown"]);

export function createVoiceQueue(deps: VoiceQueueDeps = defaultVoiceQueueDeps) {
	const queues = new Map<string, VoiceQueueRequest[]>();
	const draining = new Set<string>();
	let runner: QueuedJoinRunner | null = null;

	function isExpired(request: VoiceQueueRequest): boolean {
		return deps.now() - request.requestedAt >= BOT_CONSTANTS.DERO_VOICE_QUEUE_EXPIRY_MS;
	}

	// Drops every expired request for good, then ranks the rest: category first, then
	// first come. The sort is on a copy, so the stored list keeps arrival order.
	function live(guildId: string, order: ReadonlyArray<VoicePriorityCategory>): VoiceQueueRequest[] {
		const waiting = (queues.get(guildId) ?? []).filter((request) => !isExpired(request));
		if (waiting.length === 0) queues.delete(guildId);
		else queues.set(guildId, waiting);
		const rank = (category: VoicePriorityCategory): number => order.indexOf(category);
		return [...waiting].sort((a, b) => rank(a.category) - rank(b.category) || a.requestedAt - b.requestedAt);
	}

	function removeRequest(request: VoiceQueueRequest): void {
		const remaining = (queues.get(request.guild.id) ?? []).filter((entry) => entry !== request);
		if (remaining.length === 0) queues.delete(request.guild.id);
		else queues.set(request.guild.id, remaining);
	}

	/** The guild's waiting requests, best placed first. Expired ones are dropped on the way. */
	function list(guildId: string, order: ReadonlyArray<VoicePriorityCategory>): VoiceQueueRequest[] {
		return live(guildId, order);
	}

	/**
	 * Add one request and say where it stands. A member holds one place at a time: a
	 * second request from them replaces the first, so pressing Join twice cannot
	 * queue Dero for the same member twice.
	 */
	function enqueue(input: Omit<VoiceQueueRequest, "requestedAt">, order: ReadonlyArray<VoicePriorityCategory>): QueuePlace {
		const guildId = input.guild.id;
		const others = (queues.get(guildId) ?? []).filter((entry) => entry.requesterId !== input.requesterId);
		const request: VoiceQueueRequest = { ...input, requestedAt: deps.now() };
		queues.set(guildId, [...others, request]);
		const ranked = live(guildId, order);
		return { place: ranked.indexOf(request) + 1, total: ranked.length };
	}

	/**
	 * Run the head of the queue while Dero is free: a skipped request is dropped and
	 * the next one runs, a joined one stops the drain, a busy one goes back in its
	 * place. One drain per guild at a time, so two calls ending close together cannot
	 * send Dero to two requests.
	 */
	async function drain(guildId: string): Promise<void> {
		if (!runner || draining.has(guildId)) return;
		draining.add(guildId);
		try {
			while (!deps.sessionChannelId(guildId)) {
				const order = await deps.loadOrder(guildId);
				const head = live(guildId, order)[0];
				if (!head) return;
				removeRequest(head);
				const outcome = await runner(head).catch((error: unknown): QueuedJoinOutcome => {
					console.warn(`[dero-voice] a queued join failed guild=${guildId} channel=${head.channelId}`, error);
					return "skipped";
				});
				if (outcome === "joined") return;
				if (outcome === "busy") {
					queues.set(guildId, [head, ...(queues.get(guildId) ?? [])]);
					return;
				}
			}
		} finally {
			draining.delete(guildId);
		}
	}

	/**
	 * The one entry point for a request that is not a typed /dero join (Phase 4b's
	 * referee): queued in its place, and run at once when Dero is in no call here.
	 * Returns its place, or null when it ran straight away.
	 */
	async function requestVoice(input: Omit<VoiceQueueRequest, "requestedAt">): Promise<QueuePlace | null> {
		const guildId = input.guild.id;
		const order = await deps.loadOrder(guildId);
		const place = enqueue(input, order);
		if (deps.sessionChannelId(guildId)) return place;
		await drain(guildId);
		return null;
	}

	/** voiceSessions.onEnd's listener: the call this guild had is over, so the next request runs. */
	function afterCallEnded(ended: { guildId: string; reason: SessionEndReason }): void {
		if (ENDINGS_THAT_DRAIN_NOTHING.has(ended.reason)) return;
		void drain(ended.guildId);
	}

	/** Register how a queued request joins; main.ts hands over the /dero join flow once at boot. */
	function useRunner(next: QueuedJoinRunner): void {
		runner = next;
	}

	return { enqueue, list, drain, requestVoice, afterCallEnded, useRunner };
}

export type VoiceQueue = ReturnType<typeof createVoiceQueue>;

export const voiceQueue: VoiceQueue = createVoiceQueue();
