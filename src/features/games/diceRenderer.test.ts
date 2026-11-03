import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RenderPayload } from "@features/renderer/index.js";

// ── the Dero die card (2026-10 item 250 Phase 5, item 15) ───────────────────
// Drawn by the real canvas library with S3 off, so nothing reaches the network. The
// faces wrap the six Dero variants in token order, and the card is a 960 by 400 PNG.

vi.mock("@utils/config.js", () => ({ discordBotS3Enabled: false }));
vi.mock("@utils/aws/index.js", () => ({ putObject: vi.fn(), getObjectBytes: vi.fn(async () => null) }));

import { clearCardCache } from "@features/renderer/cardCache.js";
import { DERO_VARIANTS } from "@base/copy/brand.js";
import { renderDiceCard, variantForFace } from "./diceRenderer.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngSize(payload: RenderPayload | null): { width: number; height: number } {
	if (!payload) throw new Error("expected a rendered card, got null");
	const bytes = payload.attachment.attachment;
	if (!Buffer.isBuffer(bytes)) throw new Error("expected a Buffer attachment");
	expect(bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)).toBe(true);
	return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

beforeEach(() => clearCardCache());

describe("variantForFace", () => {
	it("wraps the twenty faces over the six variants in token order", () => {
		expect(variantForFace(1)).toBe(DERO_VARIANTS[0]);
		expect(variantForFace(6)).toBe(DERO_VARIANTS[5]);
		expect(variantForFace(7)).toBe(DERO_VARIANTS[0]);
		expect(variantForFace(20)).toBe(DERO_VARIANTS[1]);
		expect(variantForFace(0)).toBe(DERO_VARIANTS[5]);
	});
});

describe("renderDiceCard", () => {
	it("draws a win as a 960 by 400 PNG the embed can point at", async () => {
		const card = await renderDiceCard({ left: { name: "Silent Warrior", roll: 17 }, right: { name: "Dero", roll: 4 }, winner: "left" });
		expect(pngSize(card)).toEqual({ width: 960, height: 400 });
		expect(card?.ref).toMatch(/^attachment:\/\/dice-[0-9a-f]+\.png$/);
	});

	it("draws a tie and a name too long for the panel without failing", async () => {
		const card = await renderDiceCard({ left: { name: "A".repeat(80), roll: 9 }, right: { name: "Dero", roll: 9 }, winner: "tie" });
		expect(pngSize(card)).toEqual({ width: 960, height: 400 });
	});
});
