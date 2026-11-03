import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

// ── pairing redeem route tests (FUTURE_PLANS item 63, Phase 2) ─────────
// Same mock-first style as events.routes.test.ts: hoist vi.mock for every
// store the route imports BEFORE the route itself is imported, so the
// router grabs the mocked module at load time. Mongoose never spins up,
// the tests stay fast, and the asserts focus on the route's behavior
// (envelope shape, status codes, log call args, miss-collapse).
//
// What we deliberately do NOT test here:
//   - generateCode randomness / single-use atomicity, those are unit
//     tested in pendingPairingStore.test.ts and are properties of Mongo's
//     findOneAndUpdate. The route only consumes the store contract.
//   - verifySignature behavior, covered in verifySignature.test.ts. We
//     mount the router without the signature middleware so each test can
//     send a request without recomputing HMACs, the same pattern
//     events.routes.test.ts uses.

vi.mock("@db/stores/pendingPairingStore.js", () => ({
	pendingPairingStore: {
		redeem: vi.fn(),
		// issue is imported by the route's transitive deps but never called
		// on this surface; declared so the mock shape matches the real store
		// in case a future edit reaches for it without us noticing.
		issue: vi.fn(),
	},
	// generateCode is exported from the same module; declared on the mock
	// so a route refactor that touches it surfaces as a test failure rather
	// than a runtime undefined.
	generateCode: vi.fn(),
}));

vi.mock("@db/stores/botLogStore.js", () => ({
	botLogStore: {
		log: vi.fn(),
	},
}));

import { createPairingRouter } from "./pairing.routes.js";
import { pendingPairingStore } from "@db/stores/pendingPairingStore.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { BOT_LOG_EVENTS } from "@base/constants/BOT_LOG_EVENTS.js";

// Typed aliases for the mocks so each test can reach in to set return
// values without sprinkling `as any` everywhere. Same shape pattern as
// events.routes.test.ts.
const storeMock = pendingPairingStore as unknown as {
	redeem: ReturnType<typeof vi.fn>;
	issue: ReturnType<typeof vi.fn>;
};
const logMock = botLogStore as unknown as {
	log: ReturnType<typeof vi.fn>;
};

function buildApp() {
	const app = express();
	app.use(express.json());
	app.use("/api/pairing", createPairingRouter());
	return app;
}

describe("POST /api/pairing/redeem", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Default: log succeeds. Individual tests override to assert the
		// degrade-analytics-not-redemption contract.
		logMock.log.mockResolvedValue(undefined);
	});

	// ── happy path ─────────────────────────────────────────────────
	it("returns 200 + the bind envelope on a successful redeem", async () => {
		const consumedAt = new Date("2026-06-10T12:00:00Z");
		storeMock.redeem.mockResolvedValue({
			code: "ABC234",
			guildId: "guild-1",
			ownerUserId: "owner-1",
			expiresAt: new Date("2026-06-10T12:15:00Z"),
			consumedAt,
		});

		const res = await request(buildApp()).post("/api/pairing/redeem").send({ code: "abc234" });

		expect(res.status).toBe(200);
		// envelope shape mirrors events / autoHeal: { data: ... }
		expect(res.body).toEqual({
			data: {
				guildId: "guild-1",
				ownerUserId: "owner-1",
				// supertest deserializes JSON, so consumedAt comes back as an
				// ISO string. We compare on the serialized form here rather
				// than rebuilding a Date because the wire format IS the
				// contract the platform server sees.
				consumedAt: consumedAt.toISOString(),
			},
		});
	});

	it("passes the raw caller-supplied code through to the store (store owns normalization)", async () => {
		storeMock.redeem.mockResolvedValue({
			code: "ABC234",
			guildId: "guild-1",
			ownerUserId: "owner-1",
			consumedAt: new Date(),
		});

		await request(buildApp()).post("/api/pairing/redeem").send({ code: "  abc234  " });

		// Trim + uppercase normalization is the store's contract (asserted
		// in pendingPairingStore.test.ts). The route must not pre-normalize
		// or both sides would re-trim in lockstep and drift on the next
		// store change. We pass exactly what the platform server sent.
		expect(storeMock.redeem).toHaveBeenCalledWith("  abc234  ");
	});

	// ── funnel close ───────────────────────────────────────────────
	it("logs PAIRING_REDEEMED with the model's ownerUserId remapped to the ownerId metadata key", async () => {
		storeMock.redeem.mockResolvedValue({
			code: "ABC234",
			guildId: "guild-1",
			ownerUserId: "owner-1",
			consumedAt: new Date(),
		});

		await request(buildApp()).post("/api/pairing/redeem").send({ code: "abc234" });

		expect(logMock.log).toHaveBeenCalledTimes(1);
		// Key is `ownerId` (not ownerUserId) on purpose so the metadata
		// shape matches PAIRING_CODE_SENT and a single funnel query can
		// join the two events on guildId without translating field names.
		expect(logMock.log).toHaveBeenCalledWith("guild-1", BOT_LOG_EVENTS.PAIRING_REDEEMED, {
			ownerId: "owner-1",
		});
	});

	it("still returns 200 with the bind envelope when botLogStore.log throws (degrade analytics, not redemption)", async () => {
		// The atomic redeem already consumed the code; if a log failure
		// turned into a 500 the platform would retry, hit 410 on the now-
		// consumed code, and the user would see "claim failed" for a
		// successful claim. The contract is: redemption is the primary
		// outcome, the funnel row is the secondary outcome, and they MUST
		// be allowed to diverge under failure.
		storeMock.redeem.mockResolvedValue({
			code: "ABC234",
			guildId: "guild-1",
			ownerUserId: "owner-1",
			consumedAt: new Date(),
		});
		logMock.log.mockRejectedValue(new Error("mongo down"));
		// Silence the console.warn so the test output stays clean. Asserting
		// it was called is overkill, the user-visible contract is the 200.
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		const res = await request(buildApp()).post("/api/pairing/redeem").send({ code: "abc234" });

		expect(res.status).toBe(200);
		expect(res.body.data.guildId).toBe("guild-1");
		expect(res.body.data.ownerUserId).toBe("owner-1");

		warnSpy.mockRestore();
	});

	// ── miss collapse ──────────────────────────────────────────────
	it("returns 410 with a single error body for any store miss (invalid, expired, or already-consumed)", async () => {
		storeMock.redeem.mockResolvedValue(null);

		const res = await request(buildApp()).post("/api/pairing/redeem").send({ code: "ZZZZZZ" });

		expect(res.status).toBe(410);
		expect(res.body).toEqual({ error: "Pairing code is invalid or expired" });
		// Critical: no funnel row for a miss. The activation funnel counts
		// real redemptions; failed attempts must not pollute the count.
		expect(logMock.log).not.toHaveBeenCalled();
	});

	it("does not let the caller distinguish invalid vs expired vs consumed (oracle prevention)", async () => {
		// Three sequential calls, all of which the store collapses to null
		// for different reasons. The route must return the byte-identical
		// response shape for each so a probing attacker cannot use response
		// timing or body diffs to enumerate which case fired.
		storeMock.redeem.mockResolvedValue(null);

		const app = buildApp();
		const r1 = await request(app).post("/api/pairing/redeem").send({ code: "AAAAAA" });
		const r2 = await request(app).post("/api/pairing/redeem").send({ code: "BBBBBB" });
		const r3 = await request(app).post("/api/pairing/redeem").send({ code: "CCCCCC" });

		expect(r1.status).toBe(410);
		expect(r2.status).toBe(410);
		expect(r3.status).toBe(410);
		expect(r1.body).toEqual(r2.body);
		expect(r2.body).toEqual(r3.body);
	});

	// ── body validation ────────────────────────────────────────────
	it("returns 400 when the body has no code field", async () => {
		const res = await request(buildApp()).post("/api/pairing/redeem").send({});

		expect(res.status).toBe(400);
		expect(res.body.error).toBe("Invalid body");
		expect(res.body.detail).toMatch(/code/);
		expect(storeMock.redeem).not.toHaveBeenCalled();
		expect(logMock.log).not.toHaveBeenCalled();
	});

	it("returns 400 when code is not a string (number)", async () => {
		const res = await request(buildApp()).post("/api/pairing/redeem").send({ code: 123456 });

		expect(res.status).toBe(400);
		expect(storeMock.redeem).not.toHaveBeenCalled();
	});

	it("returns 400 when code is null", async () => {
		const res = await request(buildApp()).post("/api/pairing/redeem").send({ code: null });

		expect(res.status).toBe(400);
		expect(storeMock.redeem).not.toHaveBeenCalled();
	});

	it("returns 400 when code is an empty string", async () => {
		const res = await request(buildApp()).post("/api/pairing/redeem").send({ code: "" });

		expect(res.status).toBe(400);
		expect(storeMock.redeem).not.toHaveBeenCalled();
	});

	it("returns 400 when code is whitespace only", async () => {
		// Whitespace passes typeof === "string" but the store would normalize
		// it to "" and run findOneAndUpdate against an empty filter value.
		// Reject at the route so a future schema change cannot accidentally
		// turn a whitespace POST into a real lookup.
		const res = await request(buildApp()).post("/api/pairing/redeem").send({ code: "   \t  " });

		expect(res.status).toBe(400);
		expect(storeMock.redeem).not.toHaveBeenCalled();
	});

	// ── error path ─────────────────────────────────────────────────
	it("returns 500 when the store throws (transient Mongo failure)", async () => {
		// A redeem throw means the atomic findOneAndUpdate did not commit,
		// so retrying is safe: either the code is still live (next call
		// succeeds) or the row is already gone (next call returns 410).
		// The bot does not need to retry on behalf of the caller, the
		// signed proxy will, and the 500 body stays sparse so a probing
		// attacker cannot fingerprint the underlying failure.
		storeMock.redeem.mockRejectedValue(new Error("connection reset"));
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

		const res = await request(buildApp()).post("/api/pairing/redeem").send({ code: "abc234" });

		expect(res.status).toBe(500);
		expect(res.body).toEqual({ error: "Failed to redeem pairing code" });
		expect(logMock.log).not.toHaveBeenCalled();

		errSpy.mockRestore();
	});
});
