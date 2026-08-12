import { describe, it, expect } from "vitest";
import { isRestricted, resolveMultiplier, rollXp } from "./xpRules.js";

// The half of the earn path that is impossible to test through a Discord
// listener, and the half where a mistake is silent: a wrong restriction reads as
// "leveling is broken", and a wrong multiplier reads as "that member is
// cheating". Neither throws.

describe("isRestricted, exclude mode", () => {
	it("earns everywhere when nothing is listed, which is the shipped default", () => {
		// The first mitigation for shipping leveling on by default: an unconfigured
		// guild must not silently earn zero.
		expect(isRestricted("exclude", [], ["c-general"])).toBe(false);
	});

	it("blocks only what is listed", () => {
		expect(isRestricted("exclude", ["c-bots"], ["c-bots"])).toBe(true);
		expect(isRestricted("exclude", ["c-bots"], ["c-general"])).toBe(false);
	});

	it("blocks when ANY candidate matches, which is how a category excludes its children", () => {
		// The caller passes the channel and its parent category together, so one
		// entry can exclude a whole category instead of one per channel.
		expect(isRestricted("exclude", ["cat-games"], ["c-duels", "cat-games"])).toBe(true);
	});
});

describe("isRestricted, only mode", () => {
	it("earns ONLY where listed", () => {
		expect(isRestricted("only", ["c-general"], ["c-general"])).toBe(false);
		expect(isRestricted("only", ["c-general"], ["c-bots"])).toBe(true);
	});

	it("earns NOWHERE when the list is empty, and that is the honest reading", () => {
		// "only these channels" with no channels named means only nothing. It is a
		// real state an admin can reach, which is why /setup-level-system echoes a
		// live preview rather than letting them discover it from a complaint.
		expect(isRestricted("only", [], ["c-general"])).toBe(true);
	});

	it("is the exact inverse of exclude for the same inputs", () => {
		// The property that makes one mode plus one list safe: the two modes cannot
		// both be half configured and disagree, because there is only one list.
		for (const candidate of ["c-general", "c-bots"]) {
			expect(isRestricted("only", ["c-general"], [candidate])).toBe(
				!isRestricted("exclude", ["c-general"], [candidate])
			);
		}
	});
});

describe("resolveMultiplier", () => {
	const rules = [
		{ id: "role-vip", multiplier: 2 },
		{ id: "role-boost", multiplier: 3 },
		{ id: "c-lounge", multiplier: 1.5 },
	];

	it("returns 1 when nothing matches", () => {
		expect(resolveMultiplier(rules, ["role-nobody"], false)).toBe(1);
		expect(resolveMultiplier([], ["role-vip"], true)).toBe(1);
	});

	it("takes the HIGHEST single multiplier when stacking is off, which is the default", () => {
		// Default off deliberately: under stacking a member holding three boosted
		// roles earns a surprising multiple of everyone else, and the surprise lands
		// on the admin rather than on a setting they remember choosing.
		expect(resolveMultiplier(rules, ["role-vip", "role-boost"], false)).toBe(3);
	});

	it("multiplies every applicable multiplier when stacking is on", () => {
		expect(resolveMultiplier(rules, ["role-vip", "role-boost"], true)).toBe(6);
	});

	it("combines role and channel rules under one rule, not two", () => {
		// The two lists are resolved together so a member who matches both a boosted
		// role and a boosted channel gets an answer an admin can predict.
		expect(resolveMultiplier(rules, ["role-boost", "c-lounge"], false)).toBe(3);
		expect(resolveMultiplier(rules, ["role-boost", "c-lounge"], true)).toBe(4.5);
	});

	it("ignores a rule that would zero or invert earning", () => {
		// One bad row edited straight into Mongo must not be able to stop a guild
		// earning, or to run it backwards.
		const bad = [
			{ id: "role-a", multiplier: 0 },
			{ id: "role-b", multiplier: -5 },
			{ id: "role-c", multiplier: Number.NaN },
		];
		expect(resolveMultiplier(bad, ["role-a", "role-b", "role-c"], false)).toBe(1);
		expect(resolveMultiplier(bad, ["role-a", "role-b", "role-c"], true)).toBe(1);
	});
});

describe("rollXp", () => {
	// rng is injectable exactly as duelResolve's is, so a test pins the award
	// rather than asserting a range and hoping.
	const lowest = () => 0;
	const highest = () => 0.999999;

	it("stays inside the configured range", () => {
		expect(rollXp(15, 40, 1, lowest)).toBe(15);
		expect(rollXp(15, 40, 1, highest)).toBe(40);
	});

	it("applies the multiplier and floors", () => {
		// Awards FLOOR where the curve ROUNDS. Different on purpose: the curve's
		// rounding is a pricing decision copied from Arcane, an award is a payout.
		expect(rollXp(15, 15, 1.5, lowest)).toBe(22); // 22.5 floors to 22
		expect(rollXp(10, 10, 2, lowest)).toBe(20);
	});

	it("never pays zero, however small the multiplier", () => {
		// A member who sees "you earned 0" reads the whole feature as broken.
		expect(rollXp(15, 40, 0.001, lowest)).toBe(1);
	});

	it("survives a misconfigured range rather than producing NaN", () => {
		// NaN would propagate straight into a $inc and poison a member's total.
		expect(rollXp(40, 15, 1, lowest)).toBe(40); // max below min collapses to min
		expect(rollXp(Number.NaN, Number.NaN, 1, lowest)).toBe(1);
		expect(rollXp(15, 40, Number.NaN, lowest)).toBe(15);
	});

	it("takes no message text parameter at all", () => {
		// The structural guarantee behind "leveling never reads message content".
		// Length based xp would need a deliberate signature change, not a one line
		// edit, and it is the only thing here that would require the privileged
		// MessageContent intent.
		expect(rollXp.length).toBeLessThanOrEqual(4);
	});
});
