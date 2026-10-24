import { describe, it, expect } from "vitest";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { generalEventsCopy } from "@base/copy/packs/general-events.pack.js";
import { RULES_EDIT_CUSTOM_ID, carriesRulesEditButton, resolveRulesMarkdown, rulesContent } from "./rulesContent.js";

// ── rulesContent (2026-10 item 247 Phase 2) ─────────────────────────────────
// The rules post shows the owner's saved rules or the pack default, and its Edit
// rules button is also the marker that tells Dero's own post apart from the
// owner's content in an adopted channel. These pin both halves, and the default
// itself: the owner's fourteen rules, in every pack, with no dash in them.

const DEFAULT = rokCommanderCopy.channelContent.rules.defaultMarkdown;
const customIdsOf = (rows: Array<{ toJSON(): unknown }>): string[] =>
	rows.flatMap((row) => ((row.toJSON() as { components: Array<{ custom_id?: string }> }).components ?? []).map((c) => c.custom_id ?? ""));

describe("rulesContent.build", () => {
	it("renders the pack default when the owner never edited", () => {
		const { embed } = rulesContent.build({ customRulesMarkdown: null });
		expect(embed.data.title).toBe(rokCommanderCopy.channelContent.rules.title);
		expect(embed.data.description).toBe(DEFAULT);
	});

	it("renders the owner's saved rules when there are some", () => {
		const { embed } = rulesContent.build({ customRulesMarkdown: "**1. Be kind**" });
		expect(embed.data.description).toBe("**1. Be kind**");
	});

	it("falls back to the default for an empty or whitespace save", () => {
		expect(resolveRulesMarkdown({ customRulesMarkdown: "" })).toBe(DEFAULT);
		expect(resolveRulesMarkdown({ customRulesMarkdown: "  \n " })).toBe(DEFAULT);
		expect(resolveRulesMarkdown(undefined)).toBe(DEFAULT);
	});

	it("attaches the Edit rules button by default, and not when the post is not editable", () => {
		expect(customIdsOf(rulesContent.build(null).components)).toEqual([RULES_EDIT_CUSTOM_ID]);
		expect(rulesContent.build(null, { editable: false }).components).toEqual([]);
	});

	it("uses the neutral pack's title and the same rules on a general-events guild", () => {
		const { embed } = rulesContent.build({ pluginId: "general-events" });
		expect(embed.data.title).toBe(generalEventsCopy.channelContent.rules.title);
		expect(embed.data.description).toBe(DEFAULT);
	});
});

describe("the default rules", () => {
	it("are the owner's fourteen, numbered in order, with the two plan additions last", () => {
		const numbered = [...DEFAULT.matchAll(/^\*\*(\d+)\. /gm)].map((match) => Number(match[1]));
		expect(numbered).toEqual(Array.from({ length: 14 }, (_, index) => index + 1));
		expect(DEFAULT).toContain("**13. 🎭 Don't Impersonate**");
		expect(DEFAULT).toContain("**14. 👤 One Person, One Account**");
		expect(DEFAULT).toContain("**10. 📜 Follow Discord's Terms of Service and Community Guidelines**");
	});

	it("fit the Edit rules modal and an embed description", () => {
		expect(DEFAULT.length).toBeLessThanOrEqual(4000);
	});

	it("carry no em dash, no en dash and no placeholder", () => {
		expect(DEFAULT).not.toMatch(/[\u2013\u2014]/);
		expect(DEFAULT).not.toMatch(/\[[^\]]*\]/);
	});
});

describe("carriesRulesEditButton", () => {
	it("recognizes Dero's own rules post by its button, and nothing else", () => {
		expect(carriesRulesEditButton({ components: rulesContent.build(null).components })).toBe(true);
		expect(carriesRulesEditButton({ components: [] })).toBe(false);
		expect(carriesRulesEditButton({ components: [{ toJSON: () => ({ components: [{ custom_id: "powerup:fortune" }] }) }] })).toBe(false);
	});
});
