import { describe, it, expect } from "vitest";
import { createRpsRound, applyPick, closeRound } from "./rpsRound.js";

describe("applyPick, the ordinary path", () => {
	it("records the first pick without revealing", () => {
		const round = createRpsRound("abc");
		expect(applyPick(round, "challenger", "rock")).toEqual({ status: "recorded", reveal: false });
		expect(round.picks.challenger).toBe("rock");
		expect(round.resolved).toBe(false);
	});

	it("reveals on the pick that completes the round", () => {
		const round = createRpsRound("abc");
		applyPick(round, "challenger", "rock");
		expect(applyPick(round, "opponent", "paper")).toEqual({ status: "recorded", reveal: true });
		expect(round.resolved).toBe(true);
	});

	it("does not care which side picks first", () => {
		const round = createRpsRound("abc");
		expect(applyPick(round, "opponent", "scissors")).toEqual({ status: "recorded", reveal: false });
		expect(applyPick(round, "challenger", "paper")).toEqual({ status: "recorded", reveal: true });
	});
});

describe("applyPick, the race", () => {
	it("hands the reveal to EXACTLY ONE caller, however many pile in", () => {
		// This is the invariant the whole pure/impure split exists to protect. Two
		// players clicking in the same tick both land here before either has
		// awaited anything, so the second must be the only one told to reveal and
		// every later click must find the round closed.
		const round = createRpsRound("abc");
		const results = [
			applyPick(round, "challenger", "rock"),
			applyPick(round, "opponent", "paper"),
			applyPick(round, "challenger", "scissors"),
			applyPick(round, "opponent", "rock"),
		];
		const reveals = results.filter((r) => r.status === "recorded" && r.reveal);
		expect(reveals).toHaveLength(1);
	});

	it("rejects a second pick from the same side without overwriting the first", () => {
		// A player must not be able to watch for their opponent's ephemeral and
		// then change their throw. The first choice is final.
		const round = createRpsRound("abc");
		applyPick(round, "challenger", "rock");
		expect(applyPick(round, "challenger", "scissors")).toEqual({ status: "duplicate" });
		expect(round.picks.challenger).toBe("rock");
		expect(round.resolved).toBe(false);
	});

	it("tells a late clicker the round is closed rather than silently ignoring them", () => {
		const round = createRpsRound("abc");
		applyPick(round, "challenger", "rock");
		applyPick(round, "opponent", "paper");
		expect(applyPick(round, "challenger", "scissors")).toEqual({ status: "closed" });
		expect(applyPick(round, "opponent", "rock")).toEqual({ status: "closed" });
	});

	it("keeps both recorded choices intact after the reveal", () => {
		const round = createRpsRound("abc");
		applyPick(round, "challenger", "rock");
		applyPick(round, "opponent", "scissors");
		expect(round.picks).toEqual({ challenger: "rock", opponent: "scissors" });
	});
});

describe("closeRound", () => {
	it("closes an unfinished round exactly once", () => {
		const round = createRpsRound("abc");
		applyPick(round, "challenger", "rock");
		expect(closeRound(round)).toBe(true);
		expect(closeRound(round)).toBe(false);
	});

	it("refuses to close a round that already revealed", () => {
		// The timeout and a just-in-time second pick can fire in the same tick.
		// Whoever gets there first wins, and the loser must post nothing, or the
		// channel gets a reveal and a "nobody committed" contradicting each other.
		const round = createRpsRound("abc");
		applyPick(round, "challenger", "rock");
		applyPick(round, "opponent", "paper");
		expect(closeRound(round)).toBe(false);
	});

	it("blocks any further pick once closed", () => {
		const round = createRpsRound("abc");
		closeRound(round);
		expect(applyPick(round, "challenger", "rock")).toEqual({ status: "closed" });
	});

	it("leaves a lone recorded pick readable, so the timeout can tell who was ready", () => {
		const round = createRpsRound("abc");
		applyPick(round, "opponent", "paper");
		closeRound(round);
		expect(round.picks).toEqual({ opponent: "paper" });
	});
});
