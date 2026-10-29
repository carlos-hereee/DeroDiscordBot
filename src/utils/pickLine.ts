// ── pickLine ─────────────────────────────────────────────────────────
// What:  one entry of a hand written variant list, at random, so Dero says the same moment a
//        few different ways instead of one line forever (the owner's ask for more flavor).
// Who:   every copy list of variants: the dealer's announcements, the turn lines, the market
//        quips, and matchOutcome.pickFlavor's post match shelves.
// Does NOT: write a line. Every variant is hand written in the copy files and never brain
//        generated; this only chooses one.

/**
 * One of `lines`, at random. `random` is a seam for a test that needs a known pick. The list
 * must not be empty: every variant list is a literal in a copy file, so an empty one is a bug.
 */
export function pickLine<Line>(lines: readonly Line[], random: () => number = Math.random): Line {
	const line = lines[Math.floor(random() * lines.length)] ?? lines[0];
	if (line === undefined) throw new Error("pickLine was handed an empty variant list");
	return line;
}
