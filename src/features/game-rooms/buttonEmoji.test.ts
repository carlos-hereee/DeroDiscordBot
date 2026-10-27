import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ── buttonEmoji ──────────────────────────────────────────────────────
// What:  walks every source file that builds an arcade button and asserts each emoji it
//        names is one Discord accepts (2026-10 item 257 Log 2, risk R16). Discord refuses a
//        component whose emoji is not a unicode emoji with an emoji presentation, with
//        50035 COMPONENT_INVALID_EMOJI, and it refuses the WHOLE edit, so one bad glyph
//        froze every Hold'em table redraw.
// How:   "accepted" is the Unicode RGI_Emoji set (Recommended for General Interchange),
//        the set Discord's own emoji picker draws from, matched with the regex engine's
//        `v` flag property. The scan reads every single glyph string literal in the two
//        folders that own the arcade buttons, so a button helper that takes its emoji as an
//        argument (roomMonopoly's `button`, challengeBoardEmbeds' GAME_EMOJI map) is covered
//        without listing each helper.

const ROOT = join(__dirname, "..");
const SCANNED_FOLDERS = [join(ROOT, "game-rooms"), join(ROOT, "games")];

// Built from a string because the `v` flag is newer than the compiler's regex literal target.
const ACCEPTED_EMOJI = new RegExp("^\\p{RGI_Emoji}$", "v");
const PICTOGRAPH = /\p{Extended_Pictographic}/u;
const GRAPHEMES = new Intl.Segmenter("en", { granularity: "grapheme" });
// The card suits are plain text symbols the hand formatter prints (holdemHand.formatCard), never a
// button emoji, so they are not subject to the emoji set. A suit passed to setEmoji would be a bug
// this literal scan cannot tell from them, which is why the list stays this short.
const CARD_SUIT_TEXT = new Set(["♠", "♥", "♦", "♣"]);

function sourceFilesIn(folder: string): string[] {
	return readdirSync(folder, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))
		.map((entry) => join(folder, entry.name));
}

// A string literal that is exactly one glyph: the shape every button emoji takes.
function singleGlyphLiterals(source: string): string[] {
	const literals = [...source.matchAll(/"([^"\\\n]+)"/g)].map((match) => match[1]);
	return literals.filter((text) => !CARD_SUIT_TEXT.has(text) && PICTOGRAPH.test(text) && [...GRAPHEMES.segment(text)].length === 1);
}

describe("every arcade button emoji is one Discord accepts", () => {
	it("rejects the card back that froze the Hold'em table", () => {
		expect(ACCEPTED_EMOJI.test("\u{1F0A0}")).toBe(false);
		expect(ACCEPTED_EMOJI.test("🃏")).toBe(true);
		expect(ACCEPTED_EMOJI.test("🗺️")).toBe(true);
	});

	it("finds the glyphs the arcade builds its buttons from", () => {
		const found = SCANNED_FOLDERS.flatMap(sourceFilesIn).flatMap((file) => singleGlyphLiterals(readFileSync(file, "utf8")));
		expect(found.length).toBeGreaterThan(40);
	});

	for (const folder of SCANNED_FOLDERS) {
		for (const file of sourceFilesIn(folder)) {
			const glyphs = singleGlyphLiterals(readFileSync(file, "utf8"));
			if (glyphs.length === 0) continue;
			it(`${file.slice(ROOT.length + 1).replace(/\\/g, "/")} names only accepted emoji`, () => {
				const refused = glyphs.filter((glyph) => !ACCEPTED_EMOJI.test(glyph));
				expect(refused).toEqual([]);
			});
		}
	}
});
