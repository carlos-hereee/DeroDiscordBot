import { describe, it, expect } from "vitest";
import { scheduleBoardEmbed, reminderEmbed, IScheduleField } from "./embedBuilder.js";
import type { IGameEvent } from "../features/events/event.types.js";
// Relative path to dodge a vitest+vite-tsconfig-paths bug where `@`-aliased
// imports in TEST files fail with "Cannot find package" even though the
// same imports resolve fine in source files. Pre-existing project config
// issue affecting several other test suites too.
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";

// ── helpers ─────────────────────────────────────────────────────────
// Build the toJSON() shape Discord wire-encodes from the embed. The tests
// assert against the JSON because EmbedBuilder's internal `data` holds the
// same payload but going through toJSON pins the public contract.
type EmbedJSON = ReturnType<ReturnType<typeof scheduleBoardEmbed>["toJSON"]>;

function makeActiveRecurring(name: string, nextTs: number, firstTs: number): IScheduleField {
	return {
		name,
		type: "recurring",
		nextOccurrenceTs: nextTs,
		intervalHours: 40,
		seasonEndTs: 1893456000, // 2030-01-01, doesn't matter for this layout
		paused: false,
		firstOccurrenceTs: firstTs,
		isCompleted: false,
	};
}

function makeActiveOneTime(name: string, nextTs: number, firstTs: number): IScheduleField {
	return {
		name,
		type: "one-time",
		nextOccurrenceTs: nextTs,
		intervalHours: null,
		seasonEndTs: 1893456000,
		paused: false,
		firstOccurrenceTs: firstTs,
		isCompleted: false,
	};
}

function makeCompletedOneTime(name: string, firstTs: number): IScheduleField {
	return {
		name,
		type: "one-time",
		// past one-time events have no future occurrence, null is the
		// canonical signal. The completed block ignores nextOccurrenceTs
		// and renders firstOccurrenceTs as "Concluded".
		nextOccurrenceTs: null,
		intervalHours: null,
		seasonEndTs: 1893456000,
		paused: false,
		firstOccurrenceTs: firstTs,
		isCompleted: true,
	};
}

describe("scheduleBoardEmbed layout", () => {
	const guildSeasonEndTs = 1893456000; // 2030-01-01 00:00 UTC

	it("renders the bolded season-end banner exactly once at the top of the description", () => {
		const fields = [makeActiveRecurring("Ancient Ruins", 1700000000, 1690000000)];

		const embed = scheduleBoardEmbed(fields, "ch-announcements", { guildSeasonEndTs });
		const json = embed.toJSON() as EmbedJSON;

		// description includes exactly one "**Season ends:**" occurrence with the
		// correct unix timestamp wrapped in a Discord <t:…:D> tag.
		const description = json.description ?? "";
		const matches = description.match(/\*\*Season ends:\*\*/g) ?? [];
		expect(matches).toHaveLength(1);
		expect(description).toContain(`<t:${guildSeasonEndTs}:D>`);
	});

	it("partitions fields into active and completed blocks with completed appearing AFTER active", () => {
		const activeRuins = makeActiveRecurring("Ancient Ruins", 1700001000, 1690000000);
		const activeAltar = makeActiveRecurring("Altar of Darkness", 1700002000, 1690000500);
		const activeKauHard = makeActiveOneTime("Trial of Kau Karuak, Hard", 1700003000, 1700003000);

		const completedKauEasy = makeCompletedOneTime("Trial of Kau Karuak, Easy", 1690100000);
		const completedKauNormal = makeCompletedOneTime("Trial of Kau Karuak, Normal", 1690200000);

		const fields = [activeRuins, activeAltar, activeKauHard, completedKauEasy, completedKauNormal];

		const embed = scheduleBoardEmbed(fields, "ch-announcements", { guildSeasonEndTs });
		const json = embed.toJSON() as EmbedJSON;
		const fieldsOut = json.fields ?? [];

		// 3 active + 1 collapsed completed section = 4 fields total. The
		// completed entries no longer each get their own field: the heading and
		// every completed entry are folded into ONE field (name = heading,
		// value = the entries), see the single-field completed-section builder
		// in embedBuilder.ts for the rationale.
		expect(fieldsOut).toHaveLength(4);

		// active block: order matches the input array (sorted ascending by
		// the caller in ScheduleBoard.refreshSchedule, but the embed builder
		// preserves whatever order it receives).
		expect(fieldsOut[0]?.name).toContain("Ancient Ruins");
		expect(fieldsOut[1]?.name).toContain("Altar of Darkness");
		expect(fieldsOut[2]?.name).toContain("Trial of Kau Karuak, Hard");

		// the single completed field carries the section heading as its name and
		// sits AFTER the active block.
		expect(fieldsOut[3]?.name).toBe(rokCommanderCopy.scheduleBoard.completedSectionTitle);

		// completed entries now live inside that one field's value, descending
		// by firstOccurrenceTs (most recent first). kauNormal.firstTs
		// (1690200000) > kauEasy.firstTs (1690100000), so Normal must appear
		// before Easy in the rendered value.
		const completedValue = fieldsOut[3]?.value ?? "";
		expect(completedValue).toContain("Trial of Kau Karuak, Normal");
		expect(completedValue).toContain("Trial of Kau Karuak, Easy");
		expect(completedValue.indexOf("Trial of Kau Karuak, Normal")).toBeLessThan(
			completedValue.indexOf("Trial of Kau Karuak, Easy")
		);
	});

	it("omits the completed-section heading when no fields are completed", () => {
		const fields = [
			makeActiveRecurring("Ancient Ruins", 1700001000, 1690000000),
			makeActiveRecurring("Altar of Darkness", 1700002000, 1690000500),
		];

		const embed = scheduleBoardEmbed(fields, "ch-announcements", { guildSeasonEndTs });
		const json = embed.toJSON() as EmbedJSON;
		const fieldsOut = json.fields ?? [];

		// 2 active + 0 heading + 0 completed = 2 fields. The heading must NOT
		// render when the completed array is empty, an empty section with a
		// heading would look like a bug to readers.
		expect(fieldsOut).toHaveLength(2);
		const names = fieldsOut.map((f) => f.name);
		expect(names).not.toContain(rokCommanderCopy.scheduleBoard.completedSectionTitle);
	});

	it("omits the season-end banner when guildSeasonEndTs is null (regular-announcements-only guild)", () => {
		const fields = [makeActiveRecurring("Daily ping", 1700001000, 1690000000)];

		const embed = scheduleBoardEmbed(fields, "ch-announcements", { guildSeasonEndTs: null });
		const json = embed.toJSON() as EmbedJSON;

		const description = json.description ?? "";
		expect(description).not.toContain("Season ends");
	});

	it("renders the season-ended state without active or completed blocks", () => {
		// when every KvK event has expired, the caller passes seasonEnded:true
		// and the embed short-circuits to a stand-down message. No field rows
		// render in this state regardless of what's in the fields array.
		const embed = scheduleBoardEmbed([], "ch-announcements", { seasonEnded: true });
		const json = embed.toJSON() as EmbedJSON;

		expect(json.description).toBe(rokCommanderCopy.scheduleBoard.seasonEnded);
		expect(json.fields ?? []).toHaveLength(0);
	});
});

describe("reminderEmbed image", () => {
	// Minimal event, reminderEmbed only reads name + prepSteps. Cast keeps the
	// fixture small without spelling out every IGameEvent field.
	const event = {
		name: "Ancient Ruins",
		prepSteps: [{ id: "1", label: "Activate stats token", order: 1 }],
	} as IGameEvent;
	const occurrence = new Date("2026-06-20T12:00:00Z");

	it("sets a corner thumbnail (not a banner image) when an image url is provided", () => {
		const url = "https://cdn.example.com/ruins.png";
		const json = reminderEmbed(event, occurrence, 30, url).toJSON() as EmbedJSON;
		expect(json.thumbnail?.url).toBe(url);
		// Reminders deliberately use the small thumbnail slot, never the large
		// banner image (which is reserved for go-live and decree posts).
		expect(json.image).toBeUndefined();
	});

	it("renders no thumbnail when the image url is null", () => {
		const json = reminderEmbed(event, occurrence, 30, null).toJSON() as EmbedJSON;
		expect(json.thumbnail).toBeUndefined();
	});

	it("renders no thumbnail when the image url is omitted (legacy callers)", () => {
		const json = reminderEmbed(event, occurrence, 30).toJSON() as EmbedJSON;
		expect(json.thumbnail).toBeUndefined();
	});
});
