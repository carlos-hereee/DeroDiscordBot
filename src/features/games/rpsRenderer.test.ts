import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RenderPayload } from "@features/renderer/index.js";

// ── the rock paper scissors reveal card (2026-10 item 254 Phase 5a, Arcade 3) ──
// Drawn by the real canvas library from the owner's art in assets/games/rps, with S3
// off so nothing reaches the network. deroPoseFor is pinned on its own because it is
// the one decision the card makes: which of Dero's poses an outcome shows, from
// Dero's side of the table.

vi.mock("@utils/config.js", () => ({ discordBotS3Enabled: false }));
vi.mock("@utils/aws/index.js", () => ({ putObject: vi.fn(), getObjectBytes: vi.fn(async () => null) }));

import { clearCardCache } from "@features/renderer/cardCache.js";
import { deroPoseFor, renderRpsCard, type RpsCardView } from "./rpsRenderer.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngSize(payload: RenderPayload | null): { width: number; height: number } {
	if (!payload) throw new Error("expected a rendered card, got null");
	const bytes = payload.attachment.attachment;
	if (!Buffer.isBuffer(bytes)) throw new Error("expected a Buffer attachment");
	expect(bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)).toBe(true);
	return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const member = (name: string, choice: RpsCardView["left"]["choice"]) => ({ name, choice, isDero: false });
const dero = (choice: RpsCardView["left"]["choice"]) => ({ name: "Dero", choice, isDero: true });

beforeEach(() => clearCardCache());

describe("deroPoseFor", () => {
	it("draws no pose for a match between two members", () => {
		expect(deroPoseFor({ left: member("A", "rock"), right: member("B", "paper"), winner: "right" })).toBeNull();
	});

	it("reads the outcome from Dero's side, wherever Dero sits", () => {
		expect(deroPoseFor({ left: member("A", "rock"), right: dero("paper"), winner: "right" })).toBe("rpsDeroWin");
		expect(deroPoseFor({ left: member("A", "paper"), right: dero("rock"), winner: "left" })).toBe("rpsDeroLose");
		expect(deroPoseFor({ left: dero("scissors"), right: member("A", "paper"), winner: "left" })).toBe("rpsDeroWin");
		expect(deroPoseFor({ left: member("A", "rock"), right: dero("rock"), winner: "tie" })).toBe("rpsDeroDraw");
	});
});

describe("renderRpsCard", () => {
	it.each([
		["a member's win over Dero", { left: member("Silent Warrior", "rock"), right: dero("scissors"), winner: "left" }],
		["Dero's win", { left: member("Silent Warrior", "rock"), right: dero("paper"), winner: "right" }],
		["a draw with Dero", { left: member("Silent Warrior", "paper"), right: dero("paper"), winner: "tie" }],
		["a room match between two members", { left: member("Silent Warrior", "scissors"), right: member("Iron Duke", "paper"), winner: "left" }],
		["a tie between two members", { left: member("Silent Warrior", "rock"), right: member("Iron Duke", "rock"), winner: "tie" }],
	] as const)("draws %s as a 960 by 400 PNG the embed can point at", async (_label, view) => {
		const card = await renderRpsCard(view);
		expect(pngSize(card)).toEqual({ width: 960, height: 400 });
		expect(card?.ref).toMatch(/^attachment:\/\/rps-[0-9a-f]+\.png$/);
	});

	it("draws a name too long for the panel without failing", async () => {
		const card = await renderRpsCard({ left: member("A".repeat(80), "rock"), right: dero("paper"), winner: "right" });
		expect(pngSize(card)).toEqual({ width: 960, height: 400 });
	});
});
