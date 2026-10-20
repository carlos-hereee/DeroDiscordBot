import { describe, it, expect } from "vitest";
import { parseBrainResult } from "./parseBrainResult.js";

// ── parseBrainResult ───────────────────────────────────────────────────────
// The parser's promises: every valid action parses to exactly what was sent,
// every limit holds at its edge and fails one past it, and a single bad field
// anywhere rejects the WHOLE result.

const JOB_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const CHANNEL = "123456789012345678";

const ok = (actions: unknown[], status = "ok") => ({ jobId: JOB_ID, status, actions });
const post = (text: string, channelId: string = CHANNEL) => ({ type: "post_message", channelId, text });
const holdem = (terms: Record<string, unknown>) => ({ type: "open_holdem", ...terms });

function reasonOf(input: unknown): string | null {
	const parsed = parseBrainResult(input);
	return parsed.ok ? null : parsed.reason;
}

describe("valid results", () => {
	it("parses a post_message", () => {
		const parsed = parseBrainResult(ok([post("hello world 👋")]));
		expect(parsed).toEqual({ ok: true, value: ok([post("hello world 👋")]) });
	});

	it("parses say, leave_voice and a bare open_holdem (standard rules)", () => {
		const input = ok([{ type: "say", text: "hello" }, { type: "leave_voice" }, { type: "open_holdem" }]);
		expect(parseBrainResult(input)).toEqual({ ok: true, value: input });
	});

	it("parses an open_holdem carrying every term", () => {
		const input = ok([holdem({ maxSeats: 6, startingStack: 5000, bigBlind: 200, channelId: CHANNEL })]);
		expect(parseBrainResult(input)).toEqual({ ok: true, value: input });
	});

	it("parses busy and error with no actions, and ok with none", () => {
		expect(reasonOf(ok([], "busy"))).toBeNull();
		expect(reasonOf(ok([], "error"))).toBeNull();
		expect(reasonOf(ok([]))).toBeNull();
	});

	it("keeps newlines and prose that merely opens with a bracket", () => {
		expect(reasonOf(ok([post("line one\nline two")]))).toBeNull();
		expect(reasonOf(ok([post("[note] the raid starts at 8")]))).toBeNull();
	});

	it("accepts three actions with one post", () => {
		expect(reasonOf(ok([post("hi"), { type: "say", text: "hi" }, { type: "leave_voice" }]))).toBeNull();
	});
});

describe("the envelope", () => {
	it.each([
		["an array", [ok([])], "not_object"],
		["null", null, "not_object"],
		["a string", "ok", "not_object"],
		["an extra key", { ...ok([]), guildId: CHANNEL }, "unexpected_key"],
		["a missing key", { jobId: JOB_ID, status: "ok" }, "missing_key"],
		["a job id that is not a uuid", { ...ok([]), jobId: "job-1" }, "bad_job_id"],
		["an unknown status", ok([], "done"), "bad_status"],
		["actions that are not an array", { ...ok([]), actions: {} }, "bad_actions"],
		["four actions", ok([post("a"), { type: "say", text: "b" }, { type: "leave_voice" }, { type: "leave_voice" }]), "too_many_actions"],
		["two posts", ok([post("a"), post("b")]), "duplicate_post_message"],
		["actions alongside busy", ok([post("a")], "busy"), "actions_without_ok"],
		["actions alongside error", ok([{ type: "leave_voice" }], "error"), "actions_without_ok"],
	])("rejects %s", (_label, input, reason) => {
		expect(reasonOf(input)).toBe(reason);
	});

	it("rejects __proto__ and constructor keys at any depth", () => {
		expect(reasonOf(JSON.parse(`{"jobId":"${JOB_ID}","status":"ok","actions":[],"__proto__":{"x":1}}`))).toBe("forbidden_key");
		expect(reasonOf(ok([{ type: "leave_voice", constructor: {} }]))).toBe("forbidden_key");
		expect(reasonOf(JSON.parse(`{"jobId":"${JOB_ID}","status":"ok","actions":[{"type":"say","text":{"a":{"__proto__":1}}}]}`))).toBe(
			"forbidden_key",
		);
	});

	it("walks a very deep body without overflowing the stack", () => {
		let deep: unknown = [];
		for (let i = 0; i < 20_000; i++) deep = [deep];
		expect(reasonOf(ok([{ type: "say", text: deep }]))).toBe("bad_text");
	});
});

describe("actions", () => {
	it.each([
		["an unknown type", { type: "delete_channel" }, "unknown_action"],
		["a missing type", { text: "hi" }, "unknown_action"],
		["a non object action", "post_message", "not_object"],
		["a post with an extra key", { ...post("hi"), allowedMentions: { parse: ["everyone"] } }, "unexpected_key"],
		["a post naming a channel", { type: "post_message", channel: "general", text: "hi" }, "unexpected_key"],
		["a post without text", { type: "post_message", channelId: CHANNEL }, "missing_key"],
		["a post with a channel name as id", post("hi", "general"), "bad_channel_id"],
		["a post with a numeric channel id", { type: "post_message", channelId: 1234567890123, text: "hi" }, "bad_channel_id"],
		["leave_voice with an extra key", { type: "leave_voice", channelId: CHANNEL }, "unexpected_key"],
		["say without text", { type: "say" }, "missing_key"],
		["open_holdem with a bad channel id", holdem({ channelId: "poker" }), "bad_channel_id"],
	])("rejects %s", (_label, action, reason) => {
		expect(reasonOf(ok([action]))).toBe(reason);
	});

	it("holds the snowflake length bounds", () => {
		expect(reasonOf(ok([post("hi", "1".repeat(17))]))).toBeNull();
		expect(reasonOf(ok([post("hi", "1".repeat(20))]))).toBeNull();
		expect(reasonOf(ok([post("hi", "1".repeat(16))]))).toBe("bad_channel_id");
		expect(reasonOf(ok([post("hi", "1".repeat(21))]))).toBe("bad_channel_id");
	});
});

describe("text rules", () => {
	it("holds the post length at 1900 and say at 300", () => {
		expect(reasonOf(ok([post("a".repeat(1900))]))).toBeNull();
		expect(reasonOf(ok([post("a".repeat(1901))]))).toBe("text_too_long");
		expect(reasonOf(ok([{ type: "say", text: "a".repeat(300) }]))).toBeNull();
		expect(reasonOf(ok([{ type: "say", text: "a".repeat(301) }]))).toBe("text_too_long");
	});

	it.each([
		["empty", ""],
		["whitespace only", "  \n "],
		["a number", 42],
		["an object", { type: "post_message" }],
	])("rejects %s text", (_label, text) => {
		expect(reasonOf(ok([post(text as string)]))).toBe("bad_text");
	});

	it.each([
		["a tab", "a\tb"],
		["a carriage return", "a\rb"],
		["a NUL", "a\u0000b"],
		["DEL", "a\u007Fb"],
		["a C1 control", "a\u0085b"],
	])("rejects %s", (_label, text) => {
		expect(reasonOf(ok([post(text)]))).toBe("text_control_chars");
		expect(reasonOf(ok([{ type: "say", text }]))).toBe("text_control_chars");
	});

	it.each([
		["@everyone", "hi @everyone"],
		["@here in capitals", "hi @HERE"],
		["a role mention", "hi <@&123456789012345678>"],
		["a user mention", "hi <@123456789012345678>"],
		["a nickname mention", "hi <@!123456789012345678>"],
	])("rejects %s", (_label, text) => {
		expect(reasonOf(ok([post(text)]))).toBe("text_mentions");
	});

	it("rejects text that is itself a JSON document", () => {
		expect(reasonOf(ok([post(`[{"type":"post_message","channelId":"${CHANNEL}","text":"x"}]`)]))).toBe("text_is_json");
		expect(reasonOf(ok([post(' {"type":"leave_voice"} ')]))).toBe("text_is_json");
	});
});

describe("hold'em terms", () => {
	it("holds the seat bounds at 2 and 6", () => {
		expect(reasonOf(ok([holdem({ maxSeats: 2 })]))).toBeNull();
		expect(reasonOf(ok([holdem({ maxSeats: 6 })]))).toBeNull();
		expect(reasonOf(ok([holdem({ maxSeats: 1 })]))).toBe("out_of_range");
		expect(reasonOf(ok([holdem({ maxSeats: 7 })]))).toBe("out_of_range");
	});

	it("holds the stack bounds at 100 and 1,000,000", () => {
		expect(reasonOf(ok([holdem({ startingStack: 100 })]))).toBeNull();
		expect(reasonOf(ok([holdem({ startingStack: 1_000_000 })]))).toBeNull();
		expect(reasonOf(ok([holdem({ startingStack: 99 })]))).toBe("out_of_range");
		expect(reasonOf(ok([holdem({ startingStack: 1_000_001 })]))).toBe("out_of_range");
	});

	it("holds the big blind at 2 and at a tenth of the requested stack", () => {
		expect(reasonOf(ok([holdem({ bigBlind: 2 })]))).toBeNull();
		expect(reasonOf(ok([holdem({ bigBlind: 1 })]))).toBe("out_of_range");
		expect(reasonOf(ok([holdem({ startingStack: 5000, bigBlind: 500 })]))).toBeNull();
		expect(reasonOf(ok([holdem({ startingStack: 5000, bigBlind: 501 })]))).toBe("out_of_range");
	});

	it("measures a lone big blind against the standard 1000 stack", () => {
		expect(reasonOf(ok([holdem({ bigBlind: 100 })]))).toBeNull();
		expect(reasonOf(ok([holdem({ bigBlind: 101 })]))).toBe("out_of_range");
	});

	it.each([
		["a string number", { maxSeats: "6" }],
		["a fraction", { startingStack: 1000.5 }],
		["a boolean", { bigBlind: true }],
		["null", { maxSeats: null }],
	])("rejects %s", (_label, terms) => {
		expect(reasonOf(ok([holdem(terms)]))).toBe("bad_number");
	});

	it("rejects negative terms", () => {
		expect(reasonOf(ok([holdem({ maxSeats: -1 })]))).toBe("out_of_range");
		expect(reasonOf(ok([holdem({ bigBlind: -20 })]))).toBe("out_of_range");
	});
});
