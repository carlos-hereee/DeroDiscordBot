import { describe, it, expect } from "vitest";
import { cleanListenText, prepareListenText, readListenSource, truncateAtSentence } from "./listenText.js";

// ── Listen text ────────────────────────────────────────────────────────────
// What a member hears is exactly what survives these functions, so each rule
// that keeps a token, an id or a URL out of Dero's mouth is pinned here.

const post = (content: string, description: string | null = null) => ({
	content,
	embeds: description === null ? [] : [{ description }],
});

describe("readListenSource", () => {
	it("reads the message content when there is any", () => {
		expect(readListenSource(post("Welcome to the kingdom.", "ignored"))).toBe("Welcome to the kingdom.");
	});

	it("falls back to the first embed's description when the content is empty", () => {
		expect(readListenSource(post("", "The stars say yes."))).toBe("The stars say yes.");
	});

	it("returns empty when there is neither", () => {
		expect(readListenSource(post("   "))).toBe("");
		expect(readListenSource({ content: "", embeds: [{ description: null }] })).toBe("");
	});
});

describe("cleanListenText", () => {
	it("says someone for a member mention, in every mention form", () => {
		expect(cleanListenText("Welcome, <@123456789012345678>.")).toBe("Welcome, someone.");
		expect(cleanListenText("Welcome, <@!123456789012345678>.")).toBe("Welcome, someone.");
	});

	it("says someone for a role mention", () => {
		expect(cleanListenText("Ask <@&987654321098765432> for help.")).toBe("Ask someone for help.");
	});

	it("drops custom emoji tokens, animated ones included", () => {
		expect(cleanListenText("Well met <:dero:112233445566778899> and <a:spin:112233445566778899> friend.")).toBe(
			"Well met and friend."
		);
	});

	it("drops unicode emoji, which speech would read by name or skip", () => {
		expect(cleanListenText("⚔️ A new challenger approaches. 🏰")).toBe("A new challenger approaches.");
	});

	it("drops bare links and keeps a markdown link's label", () => {
		expect(cleanListenText("Read https://www.companyuno.com/rules now.")).toBe("Read now.");
		expect(cleanListenText("Read <https://www.companyuno.com/rules> now.")).toBe("Read now.");
		expect(cleanListenText("Read [the rules](https://www.companyuno.com/rules) now.")).toBe("Read the rules now.");
	});

	it("drops channel mentions and timestamps, and speaks a command mention as its name", () => {
		expect(cleanListenText("Post in <#123456789012345678> before <t:1760000000:R>.")).toBe("Post in before.");
		expect(cleanListenText("Try </fortune:123456789012345678> today.")).toBe("Try /fortune today.");
	});

	it("strips markdown markers but keeps the words", () => {
		expect(cleanListenText("**Bold** and *soft* and __under__ and ~~gone~~ and ||hidden|| and `code`.")).toBe(
			"Bold and soft and under and gone and hidden and code."
		);
		expect(cleanListenText("> quoted line\n# Heading\n- a point")).toBe("quoted line Heading a point");
	});

	it("keeps an underscore inside a word and drops one used as italics", () => {
		expect(cleanListenText("Set snake_case and _this_ please.")).toBe("Set snake_case and this please.");
	});

	it("collapses whitespace and leaves nothing for a post of only tokens", () => {
		expect(cleanListenText("<:dero:112233445566778899>  https://x.y/z  <@1>")).toBe("someone");
		expect(cleanListenText("<:dero:112233445566778899>  https://x.y/z")).toBe("");
	});

	it("says everyone rather than reading a mass mention as a symbol", () => {
		expect(cleanListenText("Hear ye, @everyone.")).toBe("Hear ye, everyone.");
	});
});

describe("truncateAtSentence", () => {
	it("leaves text within the limit alone", () => {
		expect(truncateAtSentence("One. Two.", 50)).toEqual({ text: "One. Two.", truncated: false });
	});

	it("cuts at the last sentence end that fits", () => {
		const text = "The first sentence. The second sentence! The third sentence runs long.";
		expect(truncateAtSentence(text, 45)).toEqual({ text: "The first sentence. The second sentence!", truncated: true });
	});

	it("does not treat a decimal point as a sentence end", () => {
		const text = "Blinds rise by 1.5 each round and keep rising until the end";
		const result = truncateAtSentence(text, 20);
		expect(result.text).toBe("Blinds rise by 1.5");
		expect(result.truncated).toBe(true);
	});

	it("falls back to the last whole word when no sentence ends inside the limit", () => {
		expect(truncateAtSentence("one two three four five six", 12)).toEqual({ text: "one two", truncated: true });
	});

	it("keeps a closing quote with its sentence", () => {
		const text = 'Dero said "go." Then he left the hall for good.';
		expect(truncateAtSentence(text, 20).text).toBe('Dero said "go."');
	});
});

describe("prepareListenText", () => {
	it("reads, cleans and cuts in one pass", () => {
		const long = `${"A full sentence here. ".repeat(40)}`;
		const result = prepareListenText(post(long), 100);
		expect(result.truncated).toBe(true);
		expect(result.text.length).toBeLessThanOrEqual(100);
		expect(result.text.endsWith(".")).toBe(true);
	});

	it("returns empty text for a post with nothing speakable", () => {
		expect(prepareListenText(post("", "<:dero:112233445566778899>")).text).toBe("");
	});
});
