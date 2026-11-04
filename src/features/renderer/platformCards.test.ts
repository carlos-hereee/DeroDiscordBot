import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RenderPayload } from "./index.js";

// ── the six platform cards (2026-10 item 243 Phase 4) ──────────────────────
// One describe per surface: voice presence, welcome, role unlock, fortune scene,
// challenge picture and weekly digest. Each seeds a fixed view model and checks
// the card comes back as a real PNG of the right size, drawn by the real canvas
// library. One file for the six, beside the pipeline they all share, so the byte
// readers below are written once for this phase. The call site fallbacks are
// pinned in each surface's own test (joinNotice, welcomeNewMember,
// levelUpAnnouncer, respondWithFortune, challengeBoard, weeklyDigest).
//
// S3 is switched off, so nothing reaches the network, and avatars are null, so
// nothing is downloaded.

vi.mock("@utils/config.js", () => ({ discordBotS3Enabled: false }));
vi.mock("@utils/aws/index.js", () => ({ putObject: vi.fn(), getObjectBytes: vi.fn(async () => null) }));

import { cachedCardCount, clearCardCache } from "./cardCache.js";
import { clearDeroArtCache } from "./deroArt.js";
import { liveVoicePresenceState, renderVoicePresenceCard } from "@features/voice/voicePresenceRenderer.js";
import { renderWelcomeCard } from "@features/greeter/welcomeCardRenderer.js";
import { renderRoleUnlockCard } from "@features/leveling/roleUnlockRenderer.js";
import { renderWeeklyDigestCard } from "@features/leveling/weeklyDigestRenderer.js";
import { renderFortuneScene, verdictLines } from "@features/fortune/fortuneSceneRenderer.js";
import { challengeCardStatus, renderChallengeCard } from "@features/game-rooms/challengeCardRenderer.js";
import type { OpenerCardState } from "@features/game-rooms/challengeBoardEmbeds.js";

// ── reading the bytes ──
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngSize(payload: RenderPayload | null): { width: number; height: number } {
	if (!payload) throw new Error("expected a rendered card, got null");
	const bytes = payload.attachment.attachment;
	if (!Buffer.isBuffer(bytes)) throw new Error("expected the rendered card to be attached as a Buffer");
	expect(bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)).toBe(true);
	// A PNG's IHDR holds width and height big endian at bytes 16 and 20.
	return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const face = (name: string) => ({ name, avatar: null });

beforeEach(() => {
	clearCardCache();
	clearDeroArtCache();
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("voicePresenceRenderer", () => {
	it.each(["joined", "listening", "speaking"] as const)("draws the %s state as a 900 by 300 PNG", async (state) => {
		expect(pngSize(await renderVoicePresenceCard({ state, channelName: "War Council" }))).toEqual({ width: 900, height: 300 });
	});

	it("reads SPEAKING only while the speaker is playing", () => {
		expect(liveVoicePresenceState("playing")).toBe("speaking");
		expect(liveVoicePresenceState("idle")).toBe("listening");
	});
});

describe("welcomeCardRenderer", () => {
	it("draws the welcome as a 960 by 340 PNG", async () => {
		const card = await renderWelcomeCard({
			kicker: "A NEW SOUL ARRIVES",
			title: "Welcome, Silent Warrior",
			subtitle: "The gates of Kingdom 1234 swing open",
			memberCount: "Warrior number 1,205",
			displayName: "Silent Warrior",
			avatar: null,
		});
		expect(pngSize(card)).toEqual({ width: 960, height: 340 });
	});

	it("never caches a welcome drawn with the placeholder face", async () => {
		await renderWelcomeCard({ kicker: "NEW MEMBER", title: "Welcome, Ana", subtitle: "Glad you found us", memberCount: null, displayName: "Ana", avatar: null });
		expect(cachedCardCount()).toBe(0);
	});
});

describe("roleUnlockRenderer", () => {
	it("draws the unlock as a 960 by 320 PNG", async () => {
		const card = await renderRoleUnlockCard({
			userId: "u1",
			roleId: "r1",
			roleName: "Knight of the Realm",
			roleColor: "#e11d48",
			level: 11,
			displayName: "Silent Warrior",
			avatar: null,
		});
		expect(pngSize(card)).toEqual({ width: 960, height: 320 });
	});
});

describe("fortuneSceneRenderer", () => {
	it.each(["common", "ultra"] as const)("draws the %s scene as a 720 by 520 PNG", async (tier) => {
		const card = await renderFortuneScene({ tier, verdict: "SIGNS POINT TO YES", displayName: "Silent Warrior", avatar: null });
		expect(pngSize(card)).toEqual({ width: 720, height: 520 });
	});

	it("wraps the verdict two words to a line, so the longest die line fits the window", () => {
		expect(verdictLines("SIGNS POINT TO YES")).toEqual(["SIGNS POINT", "TO YES"]);
		expect(verdictLines("UNCLEAR")).toEqual(["UNCLEAR"]);
		expect(verdictLines("  DON'T  COUNT ON IT ")).toEqual(["DON'T COUNT", "ON IT"]);
	});
});

describe("challengeCardRenderer", () => {
	it("draws a full open table, more joiners than faces, as a 960 by 380 PNG", async () => {
		const card = await renderChallengeCard({
			game: "holdem",
			status: "open",
			badge: "rated",
			host: face("Host"),
			challengers: ["Ana", "Ben", "Cleo", "Dax", "Eve", "Finn"].map(face),
			hiddenCount: 3,
		});
		expect(pngSize(card)).toEqual({ width: 960, height: 380 });
	});

	it("draws a card nobody has joined yet", async () => {
		const card = await renderChallengeCard({ game: "coinflip", status: "choosing", badge: "casual", host: face("Host"), challengers: [], hiddenCount: 0 });
		expect(pngSize(card)).toEqual({ width: 960, height: 380 });
	});

	// The art band (2026-10 item 245 Phase 3b) adds 240 pixels above the faces for
	// a game with a logo; battleship's band also carries the admiral. rps took its logo in
	// 2026-10 item 254 Phase 5a.
	it.each(["battleship", "hangman", "rps"] as const)("leads a %s card with its art, 240 pixels taller", async (game) => {
		const card = await renderChallengeCard({ game, status: "open", badge: game === "battleship" ? "rated" : "casual", host: face("Host"), challengers: [face("Ana")], hiddenCount: 0 });
		expect(pngSize(card)).toEqual({ width: 960, height: 620 });
	});

	it("names the draft's state the way the text card does", () => {
		const base: OpenerCardState = { game: "rps", hostId: "h", visibility: null, pool: [] };
		expect(challengeCardStatus(base)).toBe("choosing");
		expect(challengeCardStatus({ ...base, visibility: "invite" })).toBe("invite");
		expect(challengeCardStatus({ ...base, visibility: "public" })).toBe("open");
		expect(challengeCardStatus({ ...base, visibility: "public", startedChannelId: "c" })).toBe("started");
		expect(challengeCardStatus({ ...base, visibility: "public", startedChannelId: "c", cancelled: true })).toBe("cancelled");
	});
});

describe("weeklyDigestRenderer", () => {
	it("draws the digest as a 960 by 380 PNG", async () => {
		const card = await renderWeeklyDigestCard({
			guildName: "Kingdom 1234",
			displayName: "Silent Warrior",
			avatar: null,
			weekXp: 1840,
			weekRank: 3,
			activeMembers: 212,
			level: 14,
		});
		expect(pngSize(card)).toEqual({ width: 960, height: 380 });
	});
});
