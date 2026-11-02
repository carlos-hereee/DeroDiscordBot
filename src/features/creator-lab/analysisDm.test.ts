import { describe, it, expect } from "vitest";
import { buildAnalysisDmEmbed, parseAnalysisSummary } from "./analysisDm.js";

// ── Creator Lab analysis DM (2026-11 item 283 Phase 4) ──
// The guard over the server's summary and the embed it draws.

const theme = (label: string, sentiment = "mixed") => ({ label, summary: `About ${label}.`, sentiment });

describe("parseAnalysisSummary", () => {
	it("keeps a complete summary and at most three themes", () => {
		const parsed = parseAnalysisSummary({
			platform: "twitch",
			videoTitle: "Stream",
			commentCount: 400,
			commentSource: "chat",
			themes: [theme("A"), theme("B"), theme("C"), theme("D")],
		});
		expect(parsed?.themes.map((entry) => entry.label)).toEqual(["A", "B", "C"]);
	});

	it("refuses a summary missing a field or carrying a broken theme", () => {
		expect(parseAnalysisSummary(null)).toBeNull();
		expect(parseAnalysisSummary({ platform: "youtube", videoTitle: "V", commentSource: "comments", themes: [theme("A")] })).toBeNull();
		expect(parseAnalysisSummary({ platform: "youtube", videoTitle: "V", commentCount: 3, commentSource: "comments", themes: [{ label: "" }] })).toBeNull();
	});
});

describe("buildAnalysisDmEmbed", () => {
	it("names the video, what Dero read, and each theme with its sentiment word", () => {
		const embed = buildAnalysisDmEmbed({
			platform: "twitch",
			videoTitle: "Friday stream",
			commentCount: 400,
			commentSource: "chat",
			themes: [theme("Audio too quiet", "critical"), theme("Unknown mood", "weird")],
		}).data;
		expect(embed.title).toBe("📊 Creator Lab read: Friday stream");
		expect(embed.description).toContain("400 chat messages from your Twitch stream");
		expect(embed.fields?.[0]).toMatchObject({ name: "Audio too quiet", value: "🔴 Critical. About Audio too quiet." });
		// An unknown sentiment reads as mixed rather than as a raw token.
		expect(embed.fields?.[1]?.value).toBe("🟡 Mixed. About Unknown mood.");
	});

	it("never passes Discord's title limit", () => {
		const embed = buildAnalysisDmEmbed({ platform: "youtube", videoTitle: "x".repeat(400), commentCount: 10, commentSource: "comments", themes: [theme("A")] }).data;
		expect(embed.title?.length).toBeLessThanOrEqual(256);
	});
});
