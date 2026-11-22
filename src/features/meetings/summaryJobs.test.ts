import { describe, expect, it } from "vitest";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { buildSummaryJobBody, isTranscriptExpired, type JobSegment, type SummaryJobInput } from "./summaryJobs.js";

// The job body the launcher reads: order by offset, labels by first speech, and the byte cap
// that drops the OLDEST segments and says trimmed (2026-11 item 388 Phase 4).

const base = (segments: JobSegment[], maxBytes: number = BOT_CONSTANTS.MEETINGS.SUMMARY_JOB_MAX_BYTES): SummaryJobInput => ({
	jobId: "job000000001",
	leaseId: "lease0000001",
	title: "Planning",
	startedAt: new Date("2026-11-21T18:00:00.000Z"),
	durationMs: 600_000,
	segments,
	names: new Map([
		["a", "Ava"],
		["b", "Ben"],
	]),
	maxBytes,
});

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

describe("buildSummaryJobBody", () => {
	it("orders segments by offset and labels speakers by first speech", () => {
		const body = buildSummaryJobBody(
			base([
				{ speakerId: "a", offsetMs: 50, text: "second" },
				{ speakerId: "b", offsetMs: 10, text: "first" },
			])
		);
		expect(body.trimmed).toBe(false);
		expect(body.speakers).toEqual([
			{ label: "S1", name: "Ben" },
			{ label: "S2", name: "Ava" },
		]);
		expect(body.segments.map((segment) => [segment.label, segment.text])).toEqual([
			["S1", "first"],
			["S2", "second"],
		]);
	});

	it("names a speaker Discord no longer returns by their label alone", () => {
		const body = buildSummaryJobBody(base([{ speakerId: "gone", offsetMs: 0, text: "hello" }]));
		expect(body.speakers).toEqual([{ label: "S1", name: "S1" }]);
	});

	it("drops the oldest segments to fit the cap, keeps the newest, relabels and says trimmed", () => {
		const segments: JobSegment[] = [
			{ speakerId: "a", offsetMs: 0, text: "a".repeat(400) },
			{ speakerId: "a", offsetMs: 1, text: "b".repeat(400) },
			{ speakerId: "b", offsetMs: 2, text: "c".repeat(400) },
		];
		const full = buildSummaryJobBody(base(segments));
		const cap = bytes(full) - 300;
		const body = buildSummaryJobBody(base(segments, cap));
		expect(body.trimmed).toBe(true);
		expect(bytes(body)).toBeLessThanOrEqual(cap);
		expect(body.segments.at(-1)?.text).toBe("c".repeat(400));
		expect(body.segments[0].text).toBe("b".repeat(400));
		expect(body.speakers).toEqual([
			{ label: "S1", name: "Ava" },
			{ label: "S2", name: "Ben" },
		]);

		const tighter = buildSummaryJobBody(base(segments, bytes(full) - 700));
		expect(tighter.segments.map((segment) => segment.label)).toEqual(["S1"]);
		expect(tighter.speakers).toEqual([{ label: "S1", name: "Ben" }]);
	});
});

describe("isTranscriptExpired", () => {
	const ended = new Date("2026-10-01T00:00:00.000Z");
	it("reads the TTL from the meeting's end", () => {
		const ttl = BOT_CONSTANTS.MEETINGS.TRANSCRIPT_TTL_DAYS * 86_400_000;
		expect(isTranscriptExpired({ endedAt: ended, startedAt: null }, new Date(ended.getTime() + ttl - 1))).toBe(false);
		expect(isTranscriptExpired({ endedAt: ended, startedAt: null }, new Date(ended.getTime() + ttl))).toBe(true);
		expect(isTranscriptExpired({ endedAt: null, startedAt: null }, new Date())).toBe(false);
	});
});
