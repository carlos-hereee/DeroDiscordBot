import { describe, it, expect, beforeEach, vi } from "vitest";
import type { RenderPayload } from "@features/renderer/index.js";

// ── the four leveling cards (2026-10 item 243 Phase 2) ─────────────────────
// One describe per renderer: accountRenderer, levelUpRenderer,
// levelsBoardRenderer and achievementUnlockRenderer. Each seeds a fixed view
// model and checks the card comes back as a real image (by its signature and
// header size) drawn by the real canvas library. One file rather than four so
// the byte readers below are written once without a helper module in src/,
// which tsconfig would compile into the deploy.
//
// S3 is switched off, so nothing reaches the network, and avatars are null, so
// nothing is downloaded. The GIF encoder is wrapped so one case can make it
// throw and watch the prime card fall back to its PNG.

const gifSwitch = vi.hoisted(() => ({ fail: false }));

vi.mock("@utils/config.js", () => ({ discordBotS3Enabled: false }));
vi.mock("@utils/aws/index.js", () => ({ putObject: vi.fn(), getObjectBytes: vi.fn(async () => null) }));
vi.mock("@features/renderer/gif.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("@features/renderer/gif.js")>();
	return {
		encodeGif: (frames: Parameters<typeof real.encodeGif>[0]) => {
			if (gifSwitch.fail) throw new Error("simulated GIF encoder failure");
			return real.encodeGif(frames);
		},
	};
});

import { cachedCardCount, clearCardCache } from "@features/renderer/cardCache.js";
import { clearDeroArtCache } from "@features/renderer/deroArt.js";
import { renderAccountCard } from "./accountRenderer.js";
import { renderLevelUpCard } from "./levelUpRenderer.js";
import { renderLevelsBoardCard } from "./levelsBoardRenderer.js";
import { renderAchievementUnlockCard } from "./achievementUnlockRenderer.js";
import type { AccountView, LevelsBoardEntry } from "./levelingEmbeds.js";

// ── reading the bytes ──
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GIF_SIGNATURE = Buffer.from("GIF89a", "ascii");

function attachmentBytes(payload: RenderPayload | null): Buffer {
	if (!payload) throw new Error("expected a rendered card, got null");
	const bytes = payload.attachment.attachment;
	if (!Buffer.isBuffer(bytes)) throw new Error("expected the rendered card to be attached as a Buffer");
	return bytes;
}

const isPng = (bytes: Buffer): boolean => bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
const isGif = (bytes: Buffer): boolean => bytes.subarray(0, GIF_SIGNATURE.length).equals(GIF_SIGNATURE);

// A PNG's IHDR holds width and height big endian at bytes 16 and 20; a GIF's
// logical screen holds them little endian at bytes 6 and 8.
function imageSize(bytes: Buffer): { width: number; height: number } {
	if (isGif(bytes)) return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
	return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

// ── fixtures ──
const ACCOUNT_VIEW: AccountView = {
	displayName: "Silent Warrior",
	avatarUrl: null,
	level: 12,
	totalXp: 18_432,
	xpIntoLevel: 640,
	xpToNext: 360,
	nextLevelIsMilestone: true,
	guildRank: 3,
	guildSize: 1_204,
	weekRank: 1,
	monthRank: null,
	messages: 4_210,
	reactionsGiven: 389,
	voiceMinutes: 1_290,
	games: [{ slug: "rps", record: { played: 20, won: 12, lost: 6, drawn: 2, assists: 0 } }],
	unlocked: [
		{ id: "chatterbox", tier: "bronze", at: new Date("2026-10-01T00:00:00Z"), earnedBy: "sent 53 messages" },
		{ id: "chatterbox", tier: "silver", at: new Date("2026-10-08T00:00:00Z"), earnedBy: "sent 251 messages" },
	],
	avatar: null,
};

const BOARD_ENTRIES: LevelsBoardEntry[] = Array.from({ length: 10 }, (_, index) => ({
	userId: String(100_000 + index),
	username: `Member ${index + 1}`,
	level: 30 - index * 2,
	xp: 90_000 - index * 7_000,
	avatar: null,
}));

const UNLOCKS = [
	{ id: "chatterbox", tier: "bronze", earnedBy: "sent 53 messages" },
	{ id: "chatterbox", tier: "silver", earnedBy: "sent 251 messages" },
	{ id: "chatterbox", tier: "gold", earnedBy: "sent 1,009 messages" },
	{ id: "fan", tier: "diamond", earnedBy: "gave 2,003 reactions" },
];

beforeEach(() => {
	gifSwitch.fail = false;
	clearCardCache();
	clearDeroArtCache();
});

describe("accountRenderer", () => {
	it("renders the seeded profile as a 960 by 540 PNG", async () => {
		const payload = await renderAccountCard(ACCOUNT_VIEW);

		const bytes = attachmentBytes(payload);
		expect(isPng(bytes)).toBe(true);
		expect(imageSize(bytes)).toEqual({ width: 960, height: 540 });
		expect(payload?.ref).toMatch(/^attachment:\/\/account-[a-f0-9]{12}\.png$/);
	});

	it("renders a brand new member: no games, no achievements, no period rank, a capped bar", async () => {
		const payload = await renderAccountCard({ ...ACCOUNT_VIEW, games: [], unlocked: [], weekRank: null, monthRank: null, xpIntoLevel: 0, xpToNext: 0 });
		expect(isPng(attachmentBytes(payload))).toBe(true);
	});

	it("posts but never caches a card drawn with the stand in Dero and a placeholder face", async () => {
		// No Dero v2 pose is usable yet, so every card today is a stand in, and a
		// cached one would be served for a year after the real art deploys.
		await renderAccountCard(ACCOUNT_VIEW);
		expect(cachedCardCount()).toBe(0);
	});
});

describe("levelUpRenderer", () => {
	it("renders a prime level (11) as a looping 900 by 360 GIF", async () => {
		const payload = await renderLevelUpCard({ description: "<@1> reached level 11.", level: 11, milestone: true, displayName: "Silent Warrior", avatar: null });

		const bytes = attachmentBytes(payload);
		expect(isGif(bytes)).toBe(true);
		expect(imageSize(bytes)).toEqual({ width: 900, height: 360 });
		expect(payload?.ref).toMatch(/^attachment:\/\/level-up-[a-f0-9]{12}\.gif$/);
	});

	it("renders a milestone that is not prime (10, a guild on every N levels) as a PNG", async () => {
		const payload = await renderLevelUpCard({ description: "", level: 10, milestone: true, displayName: "Silent Warrior", avatar: null });

		const bytes = attachmentBytes(payload);
		expect(isPng(bytes)).toBe(true);
		expect(imageSize(bytes)).toEqual({ width: 900, height: 360 });
	});

	it("falls back to the PNG card when the GIF encoder throws on a prime level", async () => {
		gifSwitch.fail = true;
		const payload = await renderLevelUpCard({ description: "", level: 11, milestone: true, displayName: "Silent Warrior", avatar: null });

		expect(isPng(attachmentBytes(payload))).toBe(true);
	});

	it("draws without a display name rather than failing", async () => {
		const payload = await renderLevelUpCard({ description: "", level: 13, milestone: true, displayName: null, avatar: null });
		expect(isGif(attachmentBytes(payload))).toBe(true);
	});
});

describe("levelsBoardRenderer", () => {
	it("renders a full top ten as a PNG one row taller per member", async () => {
		const payload = await renderLevelsBoardCard("All time", BOARD_ENTRIES);

		const bytes = attachmentBytes(payload);
		expect(isPng(bytes)).toBe(true);
		// 150 header, 10 rows of 60 plus a 12 gap, 28 below the last row.
		expect(imageSize(bytes)).toEqual({ width: 960, height: 150 + 10 * 72 + 28 });
	});

	it("renders an empty board with its empty state line", async () => {
		const payload = await renderLevelsBoardCard("All time", []);

		const bytes = attachmentBytes(payload);
		expect(isPng(bytes)).toBe(true);
		expect(imageSize(bytes)).toEqual({ width: 960, height: 150 + 72 + 28 });
	});
});

describe("achievementUnlockRenderer", () => {
	it("renders one medallion per tier, up to three, as a 960 by 420 PNG", async () => {
		const payload = await renderAchievementUnlockCard({ userId: "1", displayName: "Silent Warrior", avatar: null, unlocks: UNLOCKS });

		const bytes = attachmentBytes(payload);
		expect(isPng(bytes)).toBe(true);
		expect(imageSize(bytes)).toEqual({ width: 960, height: 420 });
	});

	it("renders a single unlock and a tier name it does not know", async () => {
		const payload = await renderAchievementUnlockCard({
			userId: "1",
			displayName: "Silent Warrior",
			avatar: null,
			unlocks: [{ id: "mystery", tier: "obsidian", earnedBy: "found the secret" }],
		});
		expect(isPng(attachmentBytes(payload))).toBe(true);
	});
});
