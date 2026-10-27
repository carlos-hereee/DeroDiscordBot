import { describe, it, expect } from "vitest";
import { categoryForChannel, DEFAULT_VOICE_PRIORITY_ORDER, normalizePriorityOrder } from "./voicePriority.js";

// ── the voice priority order (2026-10 item 257 Phase 2b, owner item 22) ──

describe("normalizePriorityOrder", () => {
	it("gives the default order to a row that stored none", () => {
		expect(normalizePriorityOrder(undefined)).toEqual(["meeting-hall", "rated-match", "casual-match", "arcade-lounge", "other"]);
		expect(normalizePriorityOrder([])).toEqual([...DEFAULT_VOICE_PRIORITY_ORDER]);
	});

	it("keeps an admin's choice, drops unknown names and repeats, and appends what is missing in its default place", () => {
		expect(normalizePriorityOrder(["arcade-lounge", "bogus", "arcade-lounge", "other"])).toEqual([
			"arcade-lounge",
			"other",
			"meeting-hall",
			"rated-match",
			"casual-match",
		]);
	});
});

describe("categoryForChannel", () => {
	const rooms = { meetingVoiceChannelId: "vc-meeting", arcadeVoiceChannelId: "vc-lounge" };

	it("reads the Meeting Hall and the Arcade Lounge by their stored ids, anything else as other", () => {
		expect(categoryForChannel("vc-meeting", rooms)).toBe("meeting-hall");
		expect(categoryForChannel("vc-lounge", rooms)).toBe("arcade-lounge");
		expect(categoryForChannel("vc-elsewhere", rooms)).toBe("other");
		expect(categoryForChannel("vc-meeting", null)).toBe("other");
	});
});
