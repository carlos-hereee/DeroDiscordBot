import { describe, expect, it } from "vitest";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { getPluginCopy } from "@base/copy/index.js";
import type { IMeeting } from "@db/models/Meeting.js";
import { buildFailedNotesCard, buildSummaryCard } from "./notesCard.js";

// The filled notes card stays under Discord's 4096 character embed description even at every
// cap, counting what it cannot show, and a failure says why (2026-11 item 388 Phase 4).

const copy = getPluginCopy(null);
const M = BOT_CONSTANTS.MEETINGS;
const meeting = (summary: IMeeting["summary"]): IMeeting =>
	({
		meetingId: "meeting00001",
		guildId: "guild",
		title: "Planning",
		startedAt: new Date("2026-11-21T18:00:00.000Z"),
		endedAt: new Date("2026-11-21T18:30:00.000Z"),
		speakerIds: ["a", "b"],
		summary,
	}) as unknown as IMeeting;

const descriptionOf = (payload: ReturnType<typeof buildSummaryCard>): string => (payload.embeds?.[0] as { data: { description?: string } }).data.description ?? "";

describe("buildSummaryCard", () => {
	it("draws the summary, the decisions, the items with their assignee and the todos pointer", () => {
		const text = descriptionOf(
			buildSummaryCard(meeting({ text: "We planned.", decisions: ["March"], actionItems: [{ text: "Book rooms", assigneeName: "Ben", assigneeId: "b" }] }), copy, "todos")
		);
		expect(text).toContain("We planned.");
		expect(text).toContain("• March");
		expect(text).toContain("• Book rooms (<@b>)");
		expect(text).toContain("<#todos>");
	});

	it("stays under the embed limit at every cap and says how many lines it left out", () => {
		const long = (n: number) => `${String(n).padStart(3, "0")} ${"x".repeat(M.ITEM_MAX_CHARS - 4)}`;
		const summary = {
			text: "s".repeat(M.SUMMARY_MAX_CHARS),
			decisions: Array.from({ length: M.MAX_DECISIONS }, (_, i) => long(i)),
			actionItems: Array.from({ length: M.MAX_ACTION_ITEMS }, (_, i) => ({ text: long(i), assigneeName: null, assigneeId: null })),
		};
		const text = descriptionOf(buildSummaryCard(meeting(summary), copy, "todos"));
		expect(text.length).toBeLessThanOrEqual(4096);
		expect(text).toMatch(/And \d+ more/);
		expect(text).toContain("<#todos>");
	});
});

describe("buildFailedNotesCard", () => {
	it("gives each failure its own honest line", () => {
		const of = (code: string) => (buildFailedNotesCard(meeting(null), copy, code).embeds?.[0] as { data: { description?: string } }).data.description;
		expect(of("transcript_expired")).toContain("expired");
		expect(of("transcript_empty")).toContain("asked to stop being recorded");
		expect(of("model_error")).toContain("could not write the summary");
	});
});
