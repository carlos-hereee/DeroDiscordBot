import { describe, it, expect } from "vitest";
import { rokCommanderCopy } from "./rok-commander.pack.js";
import { generalEventsCopy } from "./general-events.pack.js";

// ── the pinned member command guide ────────────────────────────────────────
// This guide is the ONLY surface that tells a member which commands exist. Four
// games shipped under one command that nothing advertises would be four games
// nobody plays, so the entry naming them is worth a regression guard: a pack edit
// that drops the field would make them silently undiscoverable again, with no
// test failure and no visible breakage anywhere else.
//
// It also guards the pairing. /secret-code buffs the fortune subcommand while
// living OUTSIDE the command that holds it, so the two only make sense named
// together, and this guide is the one place that can say so.

const PACKS = [
	{ name: "rok-commander", copy: rokCommanderCopy },
	{ name: "general-events", copy: generalEventsCopy },
] as const;

const guideText = (copy: (typeof PACKS)[number]["copy"]): string =>
	copy.channelContent.commandGuide.fields.map((field) => `${field.name}\n${field.value}`).join("\n");

describe("member command guide", () => {
	it.each(PACKS)("$name names /mini-game", ({ copy }) => {
		expect(guideText(copy)).toContain("`/mini-game`");
	});

	it.each(PACKS)("$name names /secret-code, which had never appeared in any guide before", ({ copy }) => {
		expect(guideText(copy)).toContain("`/secret-code`");
	});

	it.each(PACKS)("$name names the two together in ONE field, so the pairing is legible", ({ copy }) => {
		const paired = copy.channelContent.commandGuide.fields.filter(
			(field) => field.value.includes("`/mini-game`") && field.value.includes("`/secret-code`")
		);
		expect(paired).toHaveLength(1);
	});

	it.each(PACKS)("$name names /account, the leveling profile", ({ copy }) => {
		// This guide is the ONLY surface that tells a member a command exists. A
		// leveling system nothing advertises is a leveling system nobody checks.
		expect(guideText(copy)).toContain("`/account`");
	});

	it.each(PACKS)("$name names /account view:levels, the standings", ({ copy }) => {
		// /levels became a view of /account in 2026-10 item 245 Phase 4b; the guide
		// names the view, because naming a command Discord no longer knows sends a
		// member to a dead end.
		expect(guideText(copy)).toContain("`/account view:levels`");
	});

	it.each(PACKS)("$name names /account view:achievements", ({ copy }) => {
		expect(guideText(copy)).toContain("`/account view:achievements`");
	});

	it.each(PACKS)("$name no longer advertises /levels, /achievements or /list-events", ({ copy }) => {
		// All three were folded into /account and /events in Phase 4b and their
		// registrations are removed at deploy.
		for (const retired of ["`/levels`", "`/achievements`", "`/list-events`"]) expect(guideText(copy)).not.toContain(retired);
	});

	it.each(PACKS)("$name no longer advertises the retired /fortune command", ({ copy }) => {
		// /fortune was absorbed into /mini-game fortune and its command file is
		// deleted, so a guide still pointing at it would send members to a command
		// Discord no longer knows.
		expect(guideText(copy)).not.toContain("`/fortune`");
	});

	it("lists the SAME command set in both packs, so the two voices cannot drift apart", () => {
		// The packs differ in voice, never in which commands exist. A command added
		// to one guide and forgotten in the other is invisible to half the guilds.
		const commandsIn = (copy: (typeof PACKS)[number]["copy"]): string[] =>
			[...guideText(copy).matchAll(/`(\/[a-z-]+)`/g)].map((match) => match[1]).sort();
		expect(commandsIn(rokCommanderCopy)).toEqual(commandsIn(generalEventsCopy));
	});

	it("keeps the guide inside Discord's embed field limits", () => {
		// Silent truncation: Discord drops fields past 25 and rejects a value over
		// 1024 characters, neither with an error the bot would notice.
		for (const { copy } of PACKS) {
			expect(copy.channelContent.commandGuide.fields.length).toBeLessThanOrEqual(25);
			for (const field of copy.channelContent.commandGuide.fields) {
				expect(field.name.length).toBeLessThanOrEqual(256);
				expect(field.value.length).toBeLessThanOrEqual(1024);
			}
		}
	});
});
