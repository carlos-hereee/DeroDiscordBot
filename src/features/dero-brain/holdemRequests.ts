import { randomBytes } from "node:crypto";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { HoldemTerms } from "@features/games/holdemTable.js";
import type { BrainJobSource } from "./brainTypes.js";

// ── holdemRequests ────────────────────────────────────────────────────────
// What:  the in memory list of hold em tables a member asked Dero for and has
//        not yet opened or cancelled: who asked, where the card lives, the rules
//        in effect, and who is invited.
// Who:   the executor creates one per open_holdem; the rules card reads and
//        updates it on every press; /dero tell and the voice turn loop present
//        it. Nothing else touches it.
// When:  a request lives DERO_HOLDEM_REQUEST_TTL_MS (two minutes) from the ask.
// Where: memory only, on purpose. A request is a question waiting on a button,
//        and a restart drops it the same way it drops a brain job: the member
//        asks again. Nothing here is a table, a chip or a balance.
// How:   ① one request per speaker per guild, so a second ask replaces the
//        first and an old card answers "expired"; ② every read checks expiry,
//        so a stale request is never handed out even before it is pruned;
//        ③ expired requests are pruned whenever a new one is made, which keeps
//        the map bounded by the members asking in the last two minutes.

export type HoldemVisibilityChoice = "public" | "invite";

/** One table request waiting on its rules card. */
export interface HoldemRequest {
	id: string;
	guildId: string;
	speakerId: string;
	/** Where the ask came from. The voice turn loop flips it to "voice" when it posts the card in the call's channel. */
	source: BrainJobSource;
	/** The text channel the card is in; null for a text ask, whose card is a private reply. */
	controlChannelId: string | null;
	terms: HoldemTerms;
	visibility: HoldemVisibilityChoice;
	invitedIds: string[];
	createdAt: number;
	expiresAt: number;
}

export interface CreateHoldemRequestInput {
	guildId: string;
	speakerId: string;
	terms: HoldemTerms;
	now?: number;
}

// The id rides in a customId (100 characters at most), so 16 hex characters:
// unguessable enough that a forged press cannot land on someone else's request,
// and the speaker check behind it is the real gate anyway.
const REQUEST_ID_BYTES = 8;

const requests = new Map<string, HoldemRequest>();
const latestBySpeaker = new Map<string, string>();

const speakerKey = (guildId: string, speakerId: string): string => `${guildId}:${speakerId}`;

function prune(now: number): void {
	for (const [id, request] of requests) {
		if (request.expiresAt > now) continue;
		requests.delete(id);
		const key = speakerKey(request.guildId, request.speakerId);
		if (latestBySpeaker.get(key) === id) latestBySpeaker.delete(key);
	}
}

/** Make a request for this speaker, replacing any request they already had. */
export function createHoldemRequest({ guildId, speakerId, terms, now = Date.now() }: CreateHoldemRequestInput): HoldemRequest {
	// ③ then ①
	prune(now);
	const key = speakerKey(guildId, speakerId);
	const previous = latestBySpeaker.get(key);
	if (previous) requests.delete(previous);

	const request: HoldemRequest = {
		id: randomBytes(REQUEST_ID_BYTES).toString("hex"),
		guildId,
		speakerId,
		source: "text",
		controlChannelId: null,
		terms: { ...terms },
		visibility: "public",
		invitedIds: [],
		createdAt: now,
		expiresAt: now + BOT_CONSTANTS.DERO_HOLDEM_REQUEST_TTL_MS,
	};
	requests.set(request.id, request);
	latestBySpeaker.set(key, request.id);
	return request;
}

/** The live request with this id, or null when it never existed, was replaced, or expired. */
export function getHoldemRequest(id: string, now = Date.now()): HoldemRequest | null {
	const request = requests.get(id);
	// ②
	if (!request || request.expiresAt <= now) return null;
	return request;
}

/** Drop a request once it opened a table or was cancelled. */
export function dropHoldemRequest(id: string): void {
	const request = requests.get(id);
	if (!request) return;
	requests.delete(id);
	const key = speakerKey(request.guildId, request.speakerId);
	if (latestBySpeaker.get(key) === id) latestBySpeaker.delete(key);
}

/** Test seam: forget every request. */
export function _clearHoldemRequests(): void {
	requests.clear();
	latestBySpeaker.clear();
}
