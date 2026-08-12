import { describe, it, expect } from "vitest";
import { buildRoomChannelName, resolveRoomChannelName } from "./roomNaming.js";

describe("buildRoomChannelName", () => {
	it("slugifies an ordinary display name", () => {
		expect(buildRoomChannelName("hangman", "Qwerty", "847291039284710")).toBe("hangman-qwerty");
	});

	it("collapses every run of unsafe characters into ONE hyphen", () => {
		// The naive `.replace(/[^a-z0-9]/g, "-")` (no +) yields "sir--reginald---",
		// which Discord accepts and which reads as a bug in a channel list.
		expect(buildRoomChannelName("rps", "Sir  Reginald!!!", "1234")).toBe("rps-sir-reginald");
	});

	it("strips accents rather than passing them through", () => {
		// Accented latin is NOT in [a-z0-9], so it slugifies out. "José" becoming
		// "jos" is deliberate: Discord lowercases and rewrites channel names server
		// side anyway, and a predictable local rule beats a surprising remote one.
		expect(buildRoomChannelName("coinflip", "José", "1234")).toBe("coinflip-jos");
	});

	// ⚠️ THE CASE THE PLAN SAYS SHIPS BROKEN. Every one of these display names contains
	// zero characters in [a-z0-9], so the host segment slugifies to empty and the naive
	// implementation produces "<game>-" for ALL of them. Two such hosts on the same game
	// would then generate the identical name and collide forever.
	it.each([
		["entirely non-latin script", "日本語"],
		["entirely emoji", "🎮🎮🎮"],
		["entirely punctuation", "!!!"],
		["empty string", ""],
		["whitespace only", "   "],
	])("falls back to the user id when the display name is %s", (_label, displayName) => {
		expect(buildRoomChannelName("hangman", displayName, "847291039284710")).toBe("hangman-player4710");
	});

	it("gives two different non-ASCII hosts two DIFFERENT names", () => {
		// The whole point of the fallback. If this ever returns the same name twice,
		// the fallback has stopped keying on the user id.
		const first = buildRoomChannelName("hangman", "🎮", "111111111111111111");
		const second = buildRoomChannelName("hangman", "🎲", "222222222222222222");
		expect(first).not.toBe(second);
	});

	it("caps the host segment and leaves no trailing hyphen from the cut", () => {
		const name = buildRoomChannelName("hangman", "a".repeat(60), "1234");
		expect(name).toBe(`hangman-${"a".repeat(24)}`);
	});

	it("never exceeds the 90 character budget, leaving headroom under Discord's 100", () => {
		// Discord's real limit is 100. The 10 character gap is what lets a collision
		// suffix be appended without re-truncating into a different name.
		const name = buildRoomChannelName("diceroll", "word ".repeat(40), "1234");
		expect(name.length).toBeLessThanOrEqual(90);
	});

	it("never leaves a leading or trailing hyphen", () => {
		expect(buildRoomChannelName("rps", "---edge---", "1234")).toBe("rps-edge");
	});
});

describe("resolveRoomChannelName", () => {
	it("returns the base name untouched when nothing is taken", () => {
		expect(resolveRoomChannelName("hangman-qwerty", () => false)).toBe("hangman-qwerty");
	});

	it("suffixes -2 on the first collision", () => {
		// The ordinary "play again" path: F11 stops a host holding two LIVE rooms, but a
		// finished room keeps its channel for four hours, so the second game of the
		// evening lands here rather than in an edge case.
		const taken = new Set(["hangman-qwerty"]);
		expect(resolveRoomChannelName("hangman-qwerty", (name) => taken.has(name))).toBe("hangman-qwerty-2");
	});

	it("walks past a run of taken suffixes", () => {
		const taken = new Set(["hangman-qwerty", "hangman-qwerty-2", "hangman-qwerty-3"]);
		expect(resolveRoomChannelName("hangman-qwerty", (name) => taken.has(name))).toBe("hangman-qwerty-4");
	});

	it("keeps a maximum length candidate legal after the suffix is added", () => {
		// Regression guard for the obvious implementation, which appends the suffix to
		// the full-length base and produces a 92 character name Discord rejects.
		const base = buildRoomChannelName("hangman", "a".repeat(200), "1234");
		const resolved = resolveRoomChannelName(base, (name) => name === base);
		expect(resolved.length).toBeLessThanOrEqual(90);
		expect(resolved.endsWith("-2")).toBe(true);
	});

	it("throws rather than returning a name it knows is taken", () => {
		// Returning the base would have Discord create a SECOND channel with a duplicate
		// name, which is legal there and leaves any adopt-by-name logic with two
		// candidates and no way to choose.
		expect(() => resolveRoomChannelName("hangman-qwerty", () => true)).toThrow(/exhausted collision suffixes/);
	});
});
