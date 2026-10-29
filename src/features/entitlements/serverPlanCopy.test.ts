import { describe, it, expect } from "vitest";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { voiceCopy } from "@features/voice/voiceCopy.js";
import { deroBrainCopy } from "@features/dero-brain/deroBrainCopy.js";
import { gameRoomsCopy } from "@features/game-rooms/gameRoomsCopy.js";
import { serverPlanCommandCopy, serverPlanLine } from "./serverPlanCopy.js";

// ── the Dero server plan lines (2026-10 item 262) ─────────────────────────
// Every limit a server can hit tells an UNCOVERED server about the plan with its link, and a
// covered one only that the budget comes back (risk R14: a covered server is never sold the
// plan). Speech never reads a link aloud, and no line still says an admin can raise the cap.

const URL = BOT_CONSTANTS.DERO_SERVER_PLAN_URL;
const VC = "100000000000000001";
// The em dash, the en dash and a spaced hyphen used as a dash (platform rule 1).
const DASHES = /\u2014|\u2013| - /;

const budgetLines = (covered: boolean): string[] => [
	voiceCopy.listen.capReached(covered),
	voiceCopy.call.joined.capReached(VC, covered),
	voiceCopy.turn.text.capReached(covered),
	deroBrainCopy.result.sayCapReached(covered),
];

describe("the voice budget lines", () => {
	it("name the Dero server plan and its link for an uncovered server", () => {
		for (const line of budgetLines(false)) {
			expect(line).toContain("Dero server plan");
			expect(line).toContain(URL);
		}
	});

	it("pitch nothing to a covered server", () => {
		for (const line of budgetLines(true)) {
			expect(line).not.toContain("Dero server plan");
			expect(line).not.toContain("http");
		}
	});

	it("never put a link in the spoken line", () => {
		expect(voiceCopy.turn.spoken.capReached(false)).toContain("Dero server plan");
		expect(voiceCopy.turn.spoken.capReached(false)).not.toContain("http");
		expect(voiceCopy.turn.spoken.capReached(true)).not.toContain("http");
	});

	it("no longer say an admin can raise the cap", () => {
		for (const line of [...budgetLines(false), ...budgetLines(true)]) expect(line).not.toMatch(/raises the cap/);
	});
});

describe("the private room limit", () => {
	it("adds the plan line for a server nothing covers", () => {
		const line = gameRoomsCopy.errors.privateQuotaHit(5, "unsubscribed");
		expect(line).toContain("private room limit (5) for the free plan");
		expect(line).toContain(serverPlanLine());
	});

	it("leaves a subscribed or plan covered server without the pitch", () => {
		expect(gameRoomsCopy.errors.privateQuotaHit(25, "pro")).not.toContain(URL);
		expect(gameRoomsCopy.errors.privateQuotaHit(10, "serverPlan")).toContain("private room limit (10) for the Dero server plan. Wait");
		expect(gameRoomsCopy.board.privateQuotaStatus(3, 10, gameRoomsCopy.tierName("serverPlan"))).toBe("Your server has 3/10 private rooms open on the Dero server plan.");
		expect(gameRoomsCopy.errors.privateQuotaHit(10, "serverPlan")).not.toContain(URL);
	});

	it("names the server plan tier", () => {
		expect(gameRoomsCopy.tierName("serverPlan")).toBe("Dero server plan");
	});
});

describe("no dashes in any of it", () => {
	it("holds for every new or changed line", () => {
		const lines = [
			...budgetLines(false),
			...budgetLines(true),
			voiceCopy.turn.spoken.capReached(false),
			voiceCopy.turn.spoken.capReached(true),
			gameRoomsCopy.errors.privateQuotaHit(5, "unsubscribed"),
			serverPlanLine(),
			serverPlanCommandCopy.title,
			serverPlanCommandCopy.notInGuild,
			serverPlanCommandCopy.ownerOnly,
			serverPlanCommandCopy.code("ABC234", 15),
			serverPlanCommandCopy.covered,
			serverPlanCommandCopy.failed,
			deroBrainCopy.command.plan,
		];
		for (const line of lines) expect(line).not.toMatch(DASHES);
	});
});
