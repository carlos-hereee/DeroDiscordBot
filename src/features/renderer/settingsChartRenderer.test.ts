import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RenderPayload } from "./index.js";

// ── the settings chart (2026-10 item 257 Phase 2b, owner item 7) ──
// Drawn by the real canvas library, with S3 off so nothing reaches the network, the
// way platformCards.test.ts draws its cards. The text twin carries every row.

vi.mock("@utils/config.js", () => ({ discordBotS3Enabled: false }));
vi.mock("@utils/aws/index.js", () => ({ putObject: vi.fn(), getObjectBytes: vi.fn(async () => null) }));

import { clearCardCache } from "./cardCache.js";
import { renderSettingsChart, settingsChartEmbed, settingsChartHeight, type SettingsChartView } from "./settingsChartRenderer.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngSize(payload: RenderPayload | null): { width: number; height: number } {
	if (!payload) throw new Error("expected a rendered chart, got null");
	const bytes = payload.attachment.attachment;
	if (!Buffer.isBuffer(bytes)) throw new Error("expected the chart to be attached as a Buffer");
	expect(bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)).toBe(true);
	return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const VIEW: SettingsChartView = {
	title: "⚙️ Dero's voice settings",
	subtitle: "Every switch and setting of Dero's voice in this server.",
	onLabel: "ON",
	offLabel: "OFF",
	rows: [
		{ label: "Dero's voice", kind: "switch", on: true },
		{ label: "Listen buttons", kind: "switch", on: false },
		{ label: "Monthly speech budget", kind: "value", value: "$5 a month" },
	],
};

beforeEach(() => clearCardCache());

describe("renderSettingsChart", () => {
	it("draws a PNG as tall as its rows need", async () => {
		const payload = await renderSettingsChart(VIEW);
		expect(pngSize(payload)).toEqual({ width: 900, height: settingsChartHeight(VIEW.rows.length) });
		expect(payload?.ref).toMatch(/^attachment:\/\/settings-chart-/);
	});

	it("draws a taller chart for more rows, and a different card when a switch flips", async () => {
		expect(settingsChartHeight(6)).toBeGreaterThan(settingsChartHeight(3));
		const before = await renderSettingsChart(VIEW);
		const after = await renderSettingsChart({ ...VIEW, rows: [{ label: "Dero's voice", kind: "switch", on: false }, ...VIEW.rows.slice(1)] });
		expect(after?.ref).not.toBe(before?.ref);
	});
});

describe("settingsChartEmbed, the text twin", () => {
	it("carries every row as an inline field with its pill word or value", () => {
		const embed = settingsChartEmbed(VIEW).toJSON();
		expect(embed.title).toBe(VIEW.title);
		expect(embed.fields?.map((field) => [field.name, field.value, field.inline])).toEqual([
			["Dero's voice", "ON", true],
			["Listen buttons", "OFF", true],
			["Monthly speech budget", "$5 a month", true],
		]);
	});
});
