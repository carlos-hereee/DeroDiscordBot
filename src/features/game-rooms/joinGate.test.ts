import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@db/stores/playerRatingStore.js", () => ({ playerRatingStore: { findForPlayers: vi.fn() } }));
vi.mock("@db/stores/networkConsentStore.js", () => ({ networkConsentStore: { findByUserId: vi.fn() } }));

import { judgeJoin, fitsRoomBand, isKicked, type JoinGateRoom } from "./joinGate.js";
import { asChallengeReach, isChallengeReach, isWithinReach } from "./challengeReach.js";
import { playerRatingStore } from "@db/stores/playerRatingStore.js";
import { networkConsentStore } from "@db/stores/networkConsentStore.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";

// ── the join gate and the reach ceiling (2026-10 item 244 Phase 4) ─────────
// What:  the one answer every door into a room reads (removed, outside the band,
//        asked to wait, or in), and the predicate that caps a server's reach.

const ratingsMock = playerRatingStore.findForPlayers as unknown as ReturnType<typeof vi.fn>;

const HOST = "host-1";
const JOINER = "joiner-1";
const SETTLED = BOT_CONSTANTS.RATINGS.PROVISIONAL_GAMES;

const room = (overrides: Partial<JoinGateRoom> = {}): JoinGateRoom => ({
	guildId: "guild-1",
	roomId: "room-1",
	game: "holdem",
	hostId: HOST,
	ratingBand: "any",
	requireApproval: false,
	kickedIds: [],
	...overrides,
});

const rated = (userId: string, displayRating: number, ratedGames = SETTLED) => ({ userId, game: "holdem", mu: 25, sigma: 1, displayRating, ratedGames, lastRatedAt: new Date() });

beforeEach(() => {
	vi.clearAllMocks();
	ratingsMock.mockResolvedValue([]);
});

describe("judgeJoin", () => {
	it("refuses a member the host removed, even one the room had let in", async () => {
		const removed = room({ kickedIds: [JOINER] });
		expect(await judgeJoin(removed, JOINER, { alreadyApproved: false })).toEqual({ kind: "refuse", reason: "kicked" });
		expect(await judgeJoin(removed, JOINER, { alreadyApproved: true })).toEqual({ kind: "refuse", reason: "kicked" });
	});

	it("admits a member the room already let in without asking twice or reading a rating", async () => {
		const strict = room({ ratingBand: "tight", requireApproval: true });
		expect(await judgeJoin(strict, JOINER, { alreadyApproved: true })).toEqual({ kind: "admit" });
		expect(ratingsMock).not.toHaveBeenCalled();
	});

	it("refuses a settled rating outside the band, before ever asking the host", async () => {
		ratingsMock.mockResolvedValue([rated(HOST, 1200), rated(JOINER, 1000)]);
		const banded = room({ ratingBand: "close", requireApproval: true });
		expect(await judgeJoin(banded, JOINER, { alreadyApproved: false })).toEqual({ kind: "refuse", reason: "outsideBand" });
	});

	it("asks the host when the band fits and approval is on", async () => {
		ratingsMock.mockResolvedValue([rated(HOST, 1100), rated(JOINER, 1000)]);
		expect(await judgeJoin(room({ ratingBand: "close", requireApproval: true }), JOINER, { alreadyApproved: false })).toEqual({ kind: "ask" });
	});

	it("admits everybody into an open door: any band, no approval, nobody removed", async () => {
		expect(await judgeJoin(room(), JOINER, { alreadyApproved: false })).toEqual({ kind: "admit" });
		expect(ratingsMock).not.toHaveBeenCalled();
	});

	it("reads an older row with none of the fields as that open door", async () => {
		const legacy = { guildId: "guild-1", roomId: "room-1", game: "holdem", hostId: HOST } as unknown as JoinGateRoom;
		expect(isKicked(legacy, JOINER)).toBe(false);
		expect(await judgeJoin(legacy, JOINER, { alreadyApproved: false })).toEqual({ kind: "admit" });
	});
});

describe("the rating band", () => {
	it("admits a joiner within Close and refuses one past Tight", async () => {
		ratingsMock.mockResolvedValue([rated(HOST, 1100), rated(JOINER, 1000)]);
		expect(await fitsRoomBand(room({ ratingBand: "close" }), JOINER)).toBe(true);
		expect(await fitsRoomBand(room({ ratingBand: "tight" }), JOINER)).toBe(false);
	});

	it("lets a provisional joiner past any band: their number does not yet say where they belong", async () => {
		ratingsMock.mockResolvedValue([rated(HOST, 1500), rated(JOINER, 900, SETTLED - 1)]);
		expect(await fitsRoomBand(room({ ratingBand: "tight" }), JOINER)).toBe(true);
	});

	it("lets anybody past when the host is provisional, and a joiner with no rating at all", async () => {
		ratingsMock.mockResolvedValue([rated(HOST, 1500, 2)]);
		expect(await fitsRoomBand(room({ ratingBand: "tight" }), JOINER)).toBe(true);
		ratingsMock.mockResolvedValue([rated(HOST, 1500)]);
		expect(await fitsRoomBand(room({ ratingBand: "tight" }), JOINER)).toBe(true);
	});

	it("ignores a band on a game that is not rated, without a read", async () => {
		expect(await fitsRoomBand(room({ game: "rps", ratingBand: "tight" }), JOINER)).toBe(true);
		expect(ratingsMock).not.toHaveBeenCalled();
	});

	it("admits the joiner when the ratings read fails: a band is a preference, not a lock", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		ratingsMock.mockRejectedValue(new Error("atlas down"));
		expect(await fitsRoomBand(room({ ratingBand: "tight" }), JOINER)).toBe(true);
		warn.mockRestore();
	});
});

describe("the challenge reach ceiling", () => {
	it("lets invite and solo rooms through at every reach", () => {
		for (const reach of ["invite-only", "server", "network"] as const) {
			expect(isWithinReach(reach, "invite")).toBe(true);
			expect(isWithinReach(reach, "solo")).toBe(true);
		}
	});

	it("allows a public room at Server and Network, and refuses it at Invite only", () => {
		expect(isWithinReach("server", "public")).toBe(true);
		expect(isWithinReach("network", "public")).toBe(true);
		expect(isWithinReach("invite-only", "public")).toBe(false);
	});

	it("reads an older or unknown stored value as Server, and knows a real reach from a forged one", () => {
		expect(asChallengeReach(undefined)).toBe("server");
		expect(asChallengeReach("everywhere")).toBe("server");
		expect(asChallengeReach("invite-only")).toBe("invite-only");
		expect(isChallengeReach("network")).toBe(true);
		expect(isChallengeReach("everywhere")).toBe(false);
	});
});

// ── a network table's consent step (2026-10 item 244 Phase 5b) ─────────────
describe("judgeJoin at a network table", () => {
	const consentMock = networkConsentStore.findByUserId as unknown as ReturnType<typeof vi.fn>;

	it("refuses a member without network consent, even one the room already let in", async () => {
		consentMock.mockResolvedValue(null);
		expect(await judgeJoin(room({ network: true }), JOINER, { alreadyApproved: false })).toEqual({ kind: "refuse", reason: "noConsent" });
		expect(await judgeJoin(room({ network: true }), JOINER, { alreadyApproved: true })).toEqual({ kind: "refuse", reason: "noConsent" });
	});

	it("refuses a removed member as removed before asking about consent", async () => {
		consentMock.mockResolvedValue(null);
		expect(await judgeJoin(room({ network: true, kickedIds: [JOINER] }), JOINER, { alreadyApproved: false })).toEqual({ kind: "refuse", reason: "kicked" });
	});

	it("admits a consenting member and goes on to the band and approval as before", async () => {
		consentMock.mockResolvedValue({ userId: JOINER, version: BOT_CONSTANTS.NETWORK.CONSENT_VERSION });
		expect(await judgeJoin(room({ network: true }), JOINER, { alreadyApproved: false })).toEqual({ kind: "admit" });
		expect(await judgeJoin(room({ network: true, requireApproval: true }), JOINER, { alreadyApproved: false })).toEqual({ kind: "ask" });
	});

	it("never reads consent for a server room", async () => {
		consentMock.mockClear();
		expect(await judgeJoin(room(), JOINER, { alreadyApproved: false })).toEqual({ kind: "admit" });
		expect(consentMock).not.toHaveBeenCalled();
	});
});
