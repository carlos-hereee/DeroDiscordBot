import { describe, it, expect } from "vitest";
import { ChannelContent } from "./ChannelContent.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { generalEventsCopy } from "@base/copy/packs/general-events.pack.js";

// ── the 📋arcade-rules card ────────────────────────────────────────────────
// The card is the answer to "what can I play, with who, and why bother", and it
// is grouped by PLAYER COUNT so it stays readable as the roster grows. These
// tests pin the structure rather than the prose: wording is the owner's to
// change freely, but a missing section or an ungrouped game is a regression.

const fields = (embed: { data: { fields?: Array<{ name: string; value: string }> } }) => embed.data.fields ?? [];

describe("arcadeRulesIntro", () => {
	const embed = ChannelContent.arcadeRulesIntro();
	const c = rokCommanderCopy.channelContent.arcadeRules;

	it("leads with how to host, join, and level up, before any roster", () => {
		// Reading order is the point. The old card opened with the game list, which
		// is what made it read as a wall; a newcomer needs to know what this place
		// IS before a roster means anything.
		const names = fields(embed).map((f) => f.name);
		expect(names.slice(0, 3)).toEqual([c.hostTitle, c.joinTitle, c.levelingTitle]);
	});

	it("groups the roster by player count", () => {
		const names = fields(embed).map((f) => f.name);
		expect(names).toContain(c.soloTitle);
		expect(names).toContain(c.duelTitle);
		expect(names).toContain(c.partyTitle);
		// Groups come after the explanatory sections, never interleaved with them.
		expect(names.indexOf(c.soloTitle)).toBeGreaterThan(names.indexOf(c.levelingTitle));
	});

	it("lists every game in exactly one group, except blackjack which has two real modes", () => {
		const grouped = [...c.solo, ...c.duel, ...c.party].map((g) => g.name);
		// Solo blackjack and a blackjack TABLE are different games to a member
		// deciding what to open, so both are listed. Everything else appears once.
		expect(grouped).toHaveLength(new Set(grouped).size);
		expect(c.solo.map((g) => g.name)).toContain("🃏 Blackjack");
		expect(c.party.map((g) => g.name)).toContain("🃏 Blackjack table");
	});

	it("renders each group as one field rather than one field per game", () => {
		// This is what keeps the card from growing a field per game as the roster
		// doubles; Discord caps an embed at 25 fields.
		const solo = fields(embed).find((f) => f.name === c.soloTitle);
		for (const game of c.solo) expect(solo?.value).toContain(game.name);
		expect(fields(embed)).toHaveLength(6);
	});

	it("stays inside Discord's field ceiling with room to grow", () => {
		expect(fields(embed).length).toBeLessThan(25);
	});
});

describe("both packs describe the same arcade", () => {
	it("declares the same section keys and the same group sizes", () => {
		// The two packs differ in VOICE, never in structure. A group present in one
		// and missing from the other means a general-events guild silently loses a
		// whole category of games from its card.
		const rok = rokCommanderCopy.channelContent.arcadeRules;
		const general = generalEventsCopy.channelContent.arcadeRules;
		expect(Object.keys(general).sort()).toEqual(Object.keys(rok).sort());
		expect(general.solo).toHaveLength(rok.solo.length);
		expect(general.duel).toHaveLength(rok.duel.length);
		expect(general.party).toHaveLength(rok.party.length);
	});

	it("renders a card in the neutral voice too", () => {
		const neutral = ChannelContent.arcadeRulesIntro({ pluginId: "general-events" } as never);
		expect(neutral.data.title).toBe(generalEventsCopy.channelContent.arcadeRules.title);
		expect(fields(neutral)).toHaveLength(6);
	});
});
