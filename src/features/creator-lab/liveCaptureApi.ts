import { serverApi, ServerResponseError } from "@utils/serverApi.js";

// ── Creator Lab live capture, the bot's half of the wire (2026-11 item 284 Phase 3) ──
// What:  the two signed calls /highlight and /count make to nexious-server, and the one place their
//        answers are read. Bot to server (the Platform to bot contract, Direction B):
//          POST /api/creator-lab/live/highlights     { guildId, channelId, discordUserId, note? }
//            → 201 { data: { highlightUid, offsetSeconds } }
//          POST /api/creator-lab/live/counter-events { guildId, channelId, discordUserId, counterName, note? }
//            → 201 { data: { counterName, count, offsetSeconds } }
//        A refusal carries a code (CREATOR_LAB_LIVE_*), which this file turns into one reason the
//        commands can voice.
// Who:   commands/utility/highlight.ts and commands/utility/count.ts.
// Why:   the server decides everything (which app the channel feeds, whether the stream is live, the
//        cooldowns and caps) and writes the row before it answers, so a "saved" here always means a
//        saved row. The bot only reports what it was told; it never guesses an offset or a count.
//        Never logs a note, a counter name or a Discord id.

export const LIVE_HIGHLIGHTS_PATH = "/api/creator-lab/live/highlights";
export const LIVE_COUNTER_EVENTS_PATH = "/api/creator-lab/live/counter-events";
// The server's own bounds (LIVE_NOTE_MAX_CHARS and COUNTER_NAME_MAX_CHARS), hand mirrored so the
// command options let Discord refuse an over long value before anything is sent.
export const LIVE_NOTE_MAX_CHARS = 300;
export const COUNTER_NAME_MAX_CHARS = 40;

export interface LiveCommandContext {
	guildId: string;
	channelId: string;
	discordUserId: string;
}

export type LiveRefusal = "disabled" | "notLinked" | "notLive" | "cooldown" | "capReached" | "invalid" | "unreachable";

export type LiveHighlightOutcome = { kind: "saved"; offsetSeconds: number } | { kind: "refused"; reason: LiveRefusal; retryAfterSeconds: number | null };

export type LiveCountOutcome =
	| { kind: "counted"; counterName: string; count: number; offsetSeconds: number }
	| { kind: "refused"; reason: LiveRefusal; retryAfterSeconds: number | null };

// The server's codes (LIVE_CAPTURE_ERROR_CODES in its live-capture/liveCaptureConstants.ts), hand
// mirrored like every contract field here. An unknown code reads as "unreachable", the honest answer
// when Dero cannot tell what went wrong.
const REFUSAL_BY_CODE: Record<string, LiveRefusal> = {
	CREATOR_LAB_LIVE_DISABLED: "disabled",
	CREATOR_LAB_LIVE_NOT_LINKED: "notLinked",
	CREATOR_LAB_LIVE_NOT_LIVE: "notLive",
	CREATOR_LAB_LIVE_COOLDOWN: "cooldown",
	CREATOR_LAB_LIVE_CAP_REACHED: "capReached",
	CREATOR_LAB_LIVE_INVALID_BODY: "invalid",
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const isWholeNumber = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

/** The `data` of a `{ data }` envelope, or null. */
const dataOf = (answer: unknown): Record<string, unknown> | null => (isRecord(answer) && isRecord(answer.data) ? answer.data : null);

/** Reads any failure of a live call as one refusal; never throws. */
const refusalOf = (error: unknown): { kind: "refused"; reason: LiveRefusal; retryAfterSeconds: number | null } => {
	if (!(error instanceof ServerResponseError) || !isRecord(error.body)) return { kind: "refused", reason: "unreachable", retryAfterSeconds: null };
	const code = typeof error.body.code === "string" ? error.body.code : "";
	const retryAfter = isWholeNumber(error.body.retryAfterSeconds) ? error.body.retryAfterSeconds : null;
	return { kind: "refused", reason: REFUSAL_BY_CODE[code] ?? "unreachable", retryAfterSeconds: retryAfter };
};

/** Logs one live highlight for the channel's linked app. The server writes it before it answers. */
export async function logLiveHighlight(context: LiveCommandContext, note: string | null): Promise<LiveHighlightOutcome> {
	try {
		const answer = dataOf(await serverApi.post<unknown>(LIVE_HIGHLIGHTS_PATH, { ...context, ...(note ? { note } : {}) }));
		if (!answer || !isWholeNumber(answer.offsetSeconds)) return { kind: "refused", reason: "unreachable", retryAfterSeconds: null };
		return { kind: "saved", offsetSeconds: answer.offsetSeconds };
	}
	catch (error) {
		return refusalOf(error);
	}
}

/** Counts one occurrence for the channel's linked app and answers the stream's new total. */
export async function logLiveCount(context: LiveCommandContext, counterName: string, note: string | null): Promise<LiveCountOutcome> {
	try {
		const answer = dataOf(await serverApi.post<unknown>(LIVE_COUNTER_EVENTS_PATH, { ...context, counterName, ...(note ? { note } : {}) }));
		if (!answer || typeof answer.counterName !== "string" || !isWholeNumber(answer.count) || !isWholeNumber(answer.offsetSeconds)) {
			return { kind: "refused", reason: "unreachable", retryAfterSeconds: null };
		}
		return { kind: "counted", counterName: answer.counterName, count: answer.count, offsetSeconds: answer.offsetSeconds };
	}
	catch (error) {
		return refusalOf(error);
	}
}

/** "1:02:05" or "2:05": a stream offset the way the logger's time picker writes it. */
export function formatStreamOffset(totalSeconds: number): string {
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	const twoDigits = (value: number): string => String(value).padStart(2, "0");
	return hours > 0 ? `${hours}:${twoDigits(minutes)}:${twoDigits(seconds)}` : `${minutes}:${twoDigits(seconds)}`;
}
