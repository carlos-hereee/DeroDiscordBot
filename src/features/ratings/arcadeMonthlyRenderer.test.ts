import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RenderPayload } from "@features/renderer/index.js";

// ── arcadeMonthlyRenderer ──────────────────────────────────────────────────
// The monthly arcade card drawn by the real canvas library: a PNG 960 wide whose
// height grows with its rows, the same three sections whether full or empty. The
// fallback to the text embed is pinned in monthlyArcadePost.test.ts. S3 is off,
// so nothing reaches the network; platformCards.test.ts reads PNGs the same way.

vi.mock("@utils/config.js", () => ({ discordBotS3Enabled: false }));
vi.mock("@utils/aws/index.js", () => ({ putObject: vi.fn(), getObjectBytes: vi.fn(async () => null) }));

import { clearCardCache } from "@features/renderer/cardCache.js";
import { clearDeroArtCache } from "@features/renderer/deroArt.js";
import { arcadeMonthlyCardHeight, renderArcadeMonthlyCard, type ArcadeMonthlyView } from "./arcadeMonthlyRenderer.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngSize(payload: RenderPayload | null): { width: number; height: number } {
	if (!payload) throw new Error("expected a rendered card, got null");
	const bytes = payload.attachment.attachment;
	if (!Buffer.isBuffer(bytes)) throw new Error("expected the rendered card to be attached as a Buffer");
	expect(bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)).toBe(true);
	// A PNG's IHDR holds width and height big endian at bytes 16 and 20.
	return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const fullView: ArcadeMonthlyView = {
	title: "📜 The arcade in October 2026",
	guildName: "Kingdom 1234",
	sections: [
		{
			heading: "Top winning hands",
			rows: [
				{ lead: "pair of aces", detail: "won 6 showdowns" },
				{ lead: "kings full", detail: "won 2 showdowns" },
				{ lead: "ace high flush", detail: "won 1 showdown" },
			],
			emptyLine: "No Hold'em hand reached a showdown.",
		},
		{
			heading: "Top rated",
			rows: [
				{ lead: "Silent Warrior", detail: "Texas hold em, rated 1180" },
				{ lead: "Admiral Nelson", detail: "Battleship, rated 1095?" },
			],
			emptyLine: "No rated match was finished.",
		},
		{ heading: "Luckiest", rows: [{ lead: "Lady Luck", detail: "+6 above even, 18 of 24 won" }], emptyLine: "Nobody reached 20 decided games of chance." },
	],
	note: "A ? marks a rating still settling, earned in fewer than 10 rated games.",
	footer: "Ask for your own with /rating me.",
};

beforeEach(() => {
	clearCardCache();
	clearDeroArtCache();
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("renderArcadeMonthlyCard", () => {
	it("draws a full month as a 960 wide PNG of its computed height", async () => {
		expect(pngSize(await renderArcadeMonthlyCard(fullView))).toEqual({ width: 960, height: arcadeMonthlyCardHeight(fullView) });
	});

	it("keeps one row's height for an empty section and drops an empty note line", async () => {
		const sparse: ArcadeMonthlyView = {
			...fullView,
			sections: fullView.sections.map((section, index) => (index === 1 ? section : { ...section, rows: [] })),
			note: "",
		};
		expect(arcadeMonthlyCardHeight(sparse)).toBeLessThan(arcadeMonthlyCardHeight(fullView));
		expect(pngSize(await renderArcadeMonthlyCard(sparse))).toEqual({ width: 960, height: arcadeMonthlyCardHeight(sparse) });
	});
});
