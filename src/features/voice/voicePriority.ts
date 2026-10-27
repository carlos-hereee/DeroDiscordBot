// ── the voice priority order ────────────────────────────────────────────────
// What:  the categories a request for Dero's voice falls into, their default order,
//        and the two pure readings every caller needs: a stored order made whole, and
//        the category a voice channel puts a plain /dero join in (2026-10 item 257,
//        owner item 22).
// Who:   voiceQueue (orders the waiting requests), DeroVoiceConfig (stores the order
//        an admin set), the ⚙️dero-config priority step (sets it) and its chart.
// Where: pure and import free on purpose, so the Mongoose model can read the default
//        without loading the voice stack.
// How:   a match request names its own category (Phase 4b sends rated and casual
//        matches); every other request takes the category of its channel.

/** Every kind of request for Dero's voice, in the default priority order. */
export const VOICE_PRIORITY_CATEGORIES = ["meeting-hall", "rated-match", "casual-match", "arcade-lounge", "other"] as const;

export type VoicePriorityCategory = (typeof VOICE_PRIORITY_CATEGORIES)[number];

/** The order a server starts with: the Meeting Hall first, any other allowed channel last. */
export const DEFAULT_VOICE_PRIORITY_ORDER: readonly VoicePriorityCategory[] = VOICE_PRIORITY_CATEGORIES;

export function isVoicePriorityCategory(value: unknown): value is VoicePriorityCategory {
	return typeof value === "string" && (VOICE_PRIORITY_CATEGORIES as readonly string[]).includes(value);
}

/**
 * A stored order made whole: unknown names and repeats dropped, and any category the
 * stored list lacks appended in its default place. A row saved before a category
 * existed therefore still ranks every request, and nothing an admin chose moves.
 */
export function normalizePriorityOrder(stored: ReadonlyArray<string> | null | undefined): VoicePriorityCategory[] {
	const order: VoicePriorityCategory[] = [];
	for (const entry of stored ?? []) {
		if (isVoicePriorityCategory(entry) && !order.includes(entry)) order.push(entry);
	}
	for (const category of DEFAULT_VOICE_PRIORITY_ORDER) {
		if (!order.includes(category)) order.push(category);
	}
	return order;
}

/** The ids of Dero's own voice rooms, from GuildConfig. */
export interface VoiceRoomIds {
	meetingVoiceChannelId?: string | null;
	arcadeVoiceChannelId?: string | null;
}

/** The category a /dero join from this voice channel falls into. */
export function categoryForChannel(channelId: string, rooms: VoiceRoomIds | null): VoicePriorityCategory {
	if (rooms?.meetingVoiceChannelId && rooms.meetingVoiceChannelId === channelId) return "meeting-hall";
	if (rooms?.arcadeVoiceChannelId && rooms.arcadeVoiceChannelId === channelId) return "arcade-lounge";
	return "other";
}
