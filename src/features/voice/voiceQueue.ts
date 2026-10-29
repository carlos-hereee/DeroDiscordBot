import { randomUUID } from "node:crypto";
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
// Where: in memory beside voiceSessions, so a deploy or a restart empties it, admin
//        moves included (Risk R8, accepted: calls themselves end on a deploy, and nobody
//        waits for a call that ended; 2026-10 item 267 keeps it memory only on purpose).
// How:   ordered by an admin's pinned places first (Move up and Move down in 🗒️admin-log,
//        2026-10 item 267 decision 12), then the category's rank in the stored order, then
//        first come. The runner is registered by main.ts rather than imported, because the
//        join flow lives in the /dero command and a feature must not import a command; the
//        change listeners (the admin log entries, the challenge card's line) are registered
//        the same way, so this module imports neither.

/**
 * A request a game made rather than a member (2026-10 item 267 decision 11): a challenge
 * card with Dero voice on, or a room's referee. Narrating a game is not a task, so the
 * runner skips the task speaker list for it, but never the voice switch or the channel
 * allow list, and a join it could not make is said on its text channel.
 */
export interface GameVoiceRequest {
	// The GameRoom row the request is for; the voice session keeps it as its starter.
	roomId: string;
	// True when the target is the host's own call, which the host must still be in when the
	// request runs; false for 🎮 Arcade Lounge, which nobody has to be in.
	followsHost: boolean;
	// What the request is for, as the admin log names it (the card's link).
	subject: string;
}

/** Why a game's join could not happen, each said on the game's text channel by voiceCopy.gameVoice. */
export type GameVoiceSkipReason = "notSetUp" | "switchedOff" | "channelNotAllowed" | "botLacksPermission" | "hostLeft" | "channelGone" | "connectFailed";

/** One request for Dero's voice, waiting for the call he is in to end. */
export interface VoiceQueueRequest {
	// Stable for the request's whole wait, so an admin log button can name it.
	id: string;
	guild: Guild;
	requesterId: string;
	// The voice channel the requester wants Dero in.
	channelId: string;
	// The text channel the join notice posts in when the request runs.
	controlChannelId: string;
	category: VoicePriorityCategory;
	requestedAt: number;
	// The place an admin's move pinned it at (0 first), ahead of every unpinned request.
	pinnedPlace?: number | null;
	gameVoice?: GameVoiceRequest | null;
}

/** What a caller hands in: the queue stamps the id, the time and any pin itself. */
export type VoiceQueueInput = Omit<VoiceQueueRequest, "id" | "requestedAt" | "pinnedPlace">;

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

/** How a request stopped waiting, for the change listeners. */
export type QueueExit = "joined" | "skipped" | "removed" | "expired" | "replaced";

/**
 * What changed in a guild's queue. `queued`: a request now waits while Dero is in a call.
 * `moved`: an admin reordered it. `left`: it stopped waiting, and why.
 */
export type QueueChange =
	| { kind: "queued"; request: VoiceQueueRequest }
	| { kind: "moved"; request: VoiceQueueRequest }
	| { kind: "left"; request: VoiceQueueRequest; exit: QueueExit };

export type QueueChangeListener = (change: QueueChange) => void;

/** What an admin move did: the request's new place, or why nothing moved. */
export type QueueMoveResult = { ok: true; place: QueuePlace } | { ok: false; reason: "gone" | "edge" };

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
	const changeListeners: QueueChangeListener[] = [];

	// A listener is told after the queue already changed, and its failure never reaches the
	// caller (rulebook convention 7): an admin log entry and a card redraw are side effects.
	function tell(change: QueueChange): void {
		for (const listener of changeListeners) {
			try {
				listener(change);
			} catch (error) {
				console.warn(`[dero-voice] a queue change listener failed guild=${change.request.guild.id}`, error);
			}
		}
	}

	function isExpired(request: VoiceQueueRequest): boolean {
		return deps.now() - request.requestedAt >= BOT_CONSTANTS.DERO_VOICE_QUEUE_EXPIRY_MS;
	}

	// Drops every expired request for good, then ranks the rest: an admin's pinned places
	// first, then category, then first come. The sort is on a copy, so the stored list keeps
	// arrival order.
	function live(guildId: string, order: ReadonlyArray<VoicePriorityCategory>): VoiceQueueRequest[] {
		const stored = queues.get(guildId) ?? [];
		const waiting = stored.filter((request) => !isExpired(request));
		if (waiting.length === 0) queues.delete(guildId);
		else queues.set(guildId, waiting);
		for (const request of stored) if (isExpired(request)) tell({ kind: "left", request, exit: "expired" });
		return [...waiting].sort((a, b) => compareRequests(a, b, order));
	}

	function compareRequests(a: VoiceQueueRequest, b: VoiceQueueRequest, order: ReadonlyArray<VoicePriorityCategory>): number {
		const pinA = a.pinnedPlace ?? null;
		const pinB = b.pinnedPlace ?? null;
		if (pinA !== null && pinB !== null) return pinA - pinB;
		// A pinned request stands ahead of every unpinned one: the admin's move outranks the
		// category order, which is the point of moving it.
		if (pinA !== null) return -1;
		if (pinB !== null) return 1;
		return order.indexOf(a.category) - order.indexOf(b.category) || a.requestedAt - b.requestedAt;
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
	function enqueue(input: VoiceQueueInput, order: ReadonlyArray<VoicePriorityCategory>): QueuePlace {
		const request = add(input, order);
		return placeOf(request, live(input.guild.id, order));
	}

	// The write behind enqueue: a request is told to the listeners as queued only when it
	// really waits, which is while Dero is in a call here; one requestVoice runs at once is not.
	function add(input: VoiceQueueInput, order: ReadonlyArray<VoicePriorityCategory>): VoiceQueueRequest {
		const guildId = input.guild.id;
		const stored = queues.get(guildId) ?? [];
		const replaced = stored.filter((entry) => entry.requesterId === input.requesterId);
		const request: VoiceQueueRequest = { ...input, id: randomUUID(), requestedAt: deps.now(), pinnedPlace: null };
		queues.set(guildId, [...stored.filter((entry) => entry.requesterId !== input.requesterId), request]);
		for (const old of replaced) tell({ kind: "left", request: old, exit: "replaced" });
		live(guildId, order);
		if (deps.sessionChannelId(guildId)) tell({ kind: "queued", request });
		return request;
	}

	function placeOf(request: VoiceQueueRequest, inOrder: VoiceQueueRequest[]): QueuePlace {
		return { place: inOrder.indexOf(request) + 1, total: inOrder.length };
	}

	/** The guild's waiting requests in place order, reading the stored category order itself. */
	async function ranked(guildId: string): Promise<VoiceQueueRequest[]> {
		return live(guildId, await deps.loadOrder(guildId));
	}

	/** One waiting request by its id, with its place, or null once it stopped waiting. */
	async function find(guildId: string, id: string): Promise<{ request: VoiceQueueRequest; place: QueuePlace } | null> {
		const waiting = await ranked(guildId);
		const request = waiting.find((entry) => entry.id === id);
		return request ? { request, place: placeOf(request, waiting) } : null;
	}

	/**
	 * The place a new request of `category` would take now, for the Queue Dero modal: after
	 * every pinned request, then where its category ranks among the rest, after its equals.
	 */
	async function placeFor(guildId: string, category: VoicePriorityCategory): Promise<QueuePlace> {
		const order = await deps.loadOrder(guildId);
		const waiting = live(guildId, order);
		const rank = order.indexOf(category);
		const ahead = waiting.filter((entry) => (entry.pinnedPlace ?? null) !== null || order.indexOf(entry.category) <= rank).length;
		return { place: ahead + 1, total: waiting.length + 1 };
	}

	// An admin's move: swap the request with its neighbour, then pin EVERY waiting request at
	// its new place, so the order an admin built stays put when the next request arrives.
	async function move(guildId: string, id: string, step: -1 | 1): Promise<QueueMoveResult> {
		const waiting = await ranked(guildId);
		const from = waiting.findIndex((entry) => entry.id === id);
		if (from === -1) return { ok: false, reason: "gone" };
		const to = from + step;
		if (to < 0 || to >= waiting.length) return { ok: false, reason: "edge" };
		const reordered = [...waiting];
		[reordered[from], reordered[to]] = [reordered[to], reordered[from]];
		reordered.forEach((entry, index) => {
			entry.pinnedPlace = index;
		});
		const request = reordered[to];
		tell({ kind: "moved", request });
		return { ok: true, place: placeOf(request, reordered) };
	}

	/** Move a waiting request one place toward the head. */
	function moveUp(guildId: string, id: string): Promise<QueueMoveResult> {
		return move(guildId, id, -1);
	}

	/** Move a waiting request one place toward the back. */
	function moveDown(guildId: string, id: string): Promise<QueueMoveResult> {
		return move(guildId, id, 1);
	}

	/** Take a waiting request out of the queue. Answers it, or null once it had stopped waiting. */
	function remove(guildId: string, id: string): VoiceQueueRequest | null {
		const request = (queues.get(guildId) ?? []).find((entry) => entry.id === id && !isExpired(entry));
		if (!request) return null;
		removeRequest(request);
		tell({ kind: "left", request, exit: "removed" });
		return request;
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
				if (outcome === "busy") {
					queues.set(guildId, [head, ...(queues.get(guildId) ?? [])]);
					return;
				}
				tell({ kind: "left", request: head, exit: outcome });
				if (outcome === "joined") return;
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
	async function requestVoice(input: VoiceQueueInput): Promise<QueuePlace | null> {
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

	/** Be told of every change to any guild's queue. main.ts registers the admin log entries and the challenge cards. */
	function onChange(listener: QueueChangeListener): void {
		changeListeners.push(listener);
	}

	return { enqueue, list, ranked, find, placeFor, moveUp, moveDown, remove, drain, requestVoice, afterCallEnded, useRunner, onChange };
}

export type VoiceQueue = ReturnType<typeof createVoiceQueue>;

export const voiceQueue: VoiceQueue = createVoiceQueue();
