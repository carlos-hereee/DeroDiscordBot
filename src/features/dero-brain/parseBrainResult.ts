import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import {
	BRAIN_ACTION_TYPES,
	type BrainAction,
	type BrainActionType,
	type BrainResult,
	type BrainResultStatus,
	type OpenHoldemAction,
} from "./brainTypes.js";

// ── parseBrainResult ──────────────────────────────────────────────────────
// What:  the ONE gate that turns the brain's untrusted JSON into a BrainResult.
//        Hand written (no schema dependency, by plan), closed, and all or
//        nothing: a single bad field anywhere rejects the WHOLE result, so a
//        half valid answer can never execute its valid half.
// Who:   the POST /brain/result route, after the signature check and the raw
//        body size check. Nothing else parses brain output.
// When:  once per result body.
// Where: structure only. Whether a channel id is allowlisted, resolves, and may
//        be posted in is the executor's job, against the live guild; this file
//        never sees a guild.
// How:   ① refuse __proto__ and constructor keys anywhere, iteratively (a deep
//        nested body must not be able to overflow the stack); ② the top level
//        keys exactly; ③ each action's keys exactly, its types and its limits;
//        ④ the cross action rules (at most 3, at most one post_message, no
//        actions unless status is "ok").
//
// ⚠️ A reason is a CODE, never an echo of the input. Reasons are logged and a
// brain's text is never logged.

export type BrainRejectReason =
	| "forbidden_key"
	| "not_object"
	| "unexpected_key"
	| "missing_key"
	| "bad_job_id"
	| "bad_status"
	| "bad_actions"
	| "too_many_actions"
	| "duplicate_post_message"
	| "actions_without_ok"
	| "unknown_action"
	| "bad_channel_id"
	| "bad_text"
	| "text_too_long"
	| "text_control_chars"
	| "text_mentions"
	| "text_is_json"
	| "bad_number"
	| "out_of_range";

export type ParseBrainResult = { ok: true; value: BrainResult } | { ok: false; reason: BrainRejectReason };

type Fail = { ok: false; reason: BrainRejectReason };

// A Discord snowflake. The brain names channels by id only; a name like
// "general" fails here, so nothing downstream can ever resolve a channel by name.
const SNOWFLAKE_PATTERN = /^\d{17,20}$/;
// crypto.randomUUID output. A job id is the only handle the brain holds.
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Pings are refused outright rather than only defused at send time: a brain that
// writes one has been steered, and the plan wants that result thrown out whole.
// "<@" with digits covers user, nickname and role mentions.
const MASS_MENTION_PATTERN = /@(everyone|here)/i;
const MENTION_SYNTAX_PATTERN = /<@[!&]?\d+>/;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor"]);
const RESULT_KEYS = ["jobId", "status", "actions"] as const;
const STATUSES: readonly BrainResultStatus[] = ["ok", "busy", "error"];
const NEWLINE_CODE = 0x0a;
const C0_CONTROL_END = 0x1f;
const DELETE_CODE = 0x7f;
const C1_CONTROL_END = 0x9f;

// Allowed keys per action, "type" included. Required keys are checked per action.
const ACTION_KEYS: Record<BrainActionType, readonly string[]> = {
	post_message: ["type", "channelId", "text"],
	say: ["type", "text"],
	open_holdem: ["type", "maxSeats", "startingStack", "bigBlind", "channelId"],
	leave_voice: ["type"],
};

const fail = (reason: BrainRejectReason): Fail => ({ ok: false, reason });

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/**
 * True when any object anywhere in the value owns a __proto__ or constructor key.
 * JSON.parse creates "__proto__" as an OWN key, so Object.keys sees it. Walked
 * with an explicit stack because a 16 KB body of "[" is 16 thousand levels deep.
 */
function hasForbiddenKey(root: unknown): boolean {
	const pending: unknown[] = [root];
	while (pending.length > 0) {
		const value = pending.pop();
		if (typeof value !== "object" || value === null) continue;
		for (const key of Object.keys(value)) {
			if (FORBIDDEN_KEYS.has(key)) return true;
			pending.push((value as Record<string, unknown>)[key]);
		}
	}
	return false;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

// Control characters other than newline: C0 (tab and carriage return included),
// DEL and C1. A loop rather than a regex because the lint config refuses control
// characters inside a regex literal.
function hasForbiddenControlChar(text: string): boolean {
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		if (code === NEWLINE_CODE) continue;
		if (code <= C0_CONTROL_END || (code >= DELETE_CODE && code <= C1_CONTROL_END)) return true;
	}
	return false;
}

// A text that is itself a JSON object or array is the model echoing structure
// (an action list smuggled into a post) instead of writing prose.
function isJsonDocument(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		return typeof parsed === "object" && parsed !== null;
	}
	catch {
		// Not JSON, so it is prose that happens to open with a bracket.
		return false;
	}
}

function checkText(value: unknown, maxChars: number): BrainRejectReason | null {
	if (typeof value !== "string" || value.trim().length === 0) return "bad_text";
	if (value.length > maxChars) return "text_too_long";
	if (hasForbiddenControlChar(value)) return "text_control_chars";
	if (MASS_MENTION_PATTERN.test(value) || MENTION_SYNTAX_PATTERN.test(value)) return "text_mentions";
	if (isJsonDocument(value)) return "text_is_json";
	return null;
}

function isSnowflake(value: unknown): value is string {
	return typeof value === "string" && SNOWFLAKE_PATTERN.test(value);
}

// A real integer: a JSON number with no fraction. "6" (a string) and 6.5 both fail.
function isInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value);
}

// An optional integer term: absent is fine, present must be an integer in range.
function checkOptionalInteger(value: unknown, min: number, max: number): BrainRejectReason | null {
	if (value === undefined) return null;
	if (!isInteger(value)) return "bad_number";
	if (value < min || value > max) return "out_of_range";
	return null;
}

// ── per action parsers ──

function parsePostMessage(raw: Record<string, unknown>): BrainAction | Fail {
	if (!("channelId" in raw) || !("text" in raw)) return fail("missing_key");
	if (!isSnowflake(raw.channelId)) return fail("bad_channel_id");
	const textProblem = checkText(raw.text, BOT_CONSTANTS.DERO_BRAIN_POST_MAX_CHARS);
	if (textProblem) return fail(textProblem);
	return { type: "post_message", channelId: raw.channelId, text: raw.text as string };
}

function parseSay(raw: Record<string, unknown>): BrainAction | Fail {
	if (!("text" in raw)) return fail("missing_key");
	const textProblem = checkText(raw.text, BOT_CONSTANTS.DERO_BRAIN_SAY_MAX_CHARS);
	if (textProblem) return fail(textProblem);
	return { type: "say", text: raw.text as string };
}

// Terms bounds from the plan: seats 2 to 6, a stack of 100 to 1,000,000, and a
// big blind of at least 2 and at most a tenth of the stack. The stack the blind
// is measured against is the requested one, or the standard 1000 when absent.
function parseOpenHoldem(raw: Record<string, unknown>): BrainAction | Fail {
	const seatsProblem = checkOptionalInteger(raw.maxSeats, BOT_CONSTANTS.HOLDEM_MIN_SEATS, BOT_CONSTANTS.HOLDEM_MAX_SEATS);
	if (seatsProblem) return fail(seatsProblem);
	const stackProblem = checkOptionalInteger(
		raw.startingStack,
		BOT_CONSTANTS.HOLDEM_TERMS_MIN_STACK,
		BOT_CONSTANTS.HOLDEM_TERMS_MAX_STACK,
	);
	if (stackProblem) return fail(stackProblem);
	const stack = (raw.startingStack as number | undefined) ?? BOT_CONSTANTS.HOLDEM_STARTING_STACK;
	const maxBigBlind = Math.floor(stack / BOT_CONSTANTS.HOLDEM_TERMS_STACK_TO_BIG_BLIND);
	const blindProblem = checkOptionalInteger(raw.bigBlind, BOT_CONSTANTS.HOLDEM_TERMS_MIN_BIG_BLIND, maxBigBlind);
	if (blindProblem) return fail(blindProblem);
	if (raw.channelId !== undefined && !isSnowflake(raw.channelId)) return fail("bad_channel_id");

	const action: OpenHoldemAction = { type: "open_holdem" };
	if (raw.maxSeats !== undefined) action.maxSeats = raw.maxSeats as number;
	if (raw.startingStack !== undefined) action.startingStack = raw.startingStack as number;
	if (raw.bigBlind !== undefined) action.bigBlind = raw.bigBlind as number;
	if (raw.channelId !== undefined) action.channelId = raw.channelId as string;
	return action;
}

function isActionType(value: unknown): value is BrainActionType {
	return typeof value === "string" && (BRAIN_ACTION_TYPES as readonly string[]).includes(value);
}

function parseAction(raw: unknown): BrainAction | Fail {
	if (!isPlainObject(raw)) return fail("not_object");
	if (!isActionType(raw.type)) return fail("unknown_action");
	if (!hasOnlyKeys(raw, ACTION_KEYS[raw.type])) return fail("unexpected_key");
	if (raw.type === "post_message") return parsePostMessage(raw);
	if (raw.type === "say") return parseSay(raw);
	if (raw.type === "open_holdem") return parseOpenHoldem(raw);
	return { type: "leave_voice" };
}

function isFail(value: BrainAction | Fail): value is Fail {
	return "ok" in value;
}

/**
 * Parse one brain result body. Returns the typed result, or the first reason it
 * was refused. Any refusal means NOTHING in the body may execute.
 */
export function parseBrainResult(input: unknown): ParseBrainResult {
	// ① before any field is read, so a poisoned key never reaches a property access
	if (hasForbiddenKey(input)) return fail("forbidden_key");

	// ② the envelope
	if (!isPlainObject(input)) return fail("not_object");
	if (!hasOnlyKeys(input, RESULT_KEYS)) return fail("unexpected_key");
	if (!RESULT_KEYS.every((key) => key in input)) return fail("missing_key");
	if (typeof input.jobId !== "string" || !JOB_ID_PATTERN.test(input.jobId)) return fail("bad_job_id");
	if (!STATUSES.includes(input.status as BrainResultStatus)) return fail("bad_status");
	if (!Array.isArray(input.actions)) return fail("bad_actions");
	if (input.actions.length > BOT_CONSTANTS.DERO_BRAIN_MAX_ACTIONS) return fail("too_many_actions");
	const status = input.status as BrainResultStatus;
	// A busy or failed brain has nothing to do; actions alongside one are a
	// contradiction, and the safe reading of a contradiction is "do nothing".
	if (status !== "ok" && input.actions.length > 0) return fail("actions_without_ok");

	// ③ every action, all or nothing
	const actions: BrainAction[] = [];
	for (const raw of input.actions) {
		const parsed = parseAction(raw);
		if (isFail(parsed)) return parsed;
		actions.push(parsed);
	}

	// ④ one post per task: "send hello world" is one message, and a result that
	// posts twice is either a loop or a spray
	if (actions.filter((action) => action.type === "post_message").length > 1) return fail("duplicate_post_message");

	return { ok: true, value: { jobId: input.jobId, status, actions } };
}
