import { describe, it, expect } from "vitest";
import { HOMEBASE_CHANNEL_FIELDS, MANAGED_CATEGORY_FIELDS } from "./selfDestruct.js";
import { GuildSetupManager } from "./GuildSetupManager.js";

// ── selfDestruct ───────────────────────────────────────────────────────────
// ⚠️ THIS FILE EXISTS FOR RISK R13, and the failure it guards is PERMANENT
// rather than merely untidy. demolishHomebase sets homebaseDestroyed BEFORE it
// deletes anything, so that the boot sweep and the realtime watcher do not race
// the teardown and resurrect channels. The consequence is that any channel this
// demolition MISSES survives, and that same flag then stops ensureHomebase from
// ever touching it again. There is no self heal for a leftover, and no error is
// raised, so the only thing standing between "we added a channel" and "every
// guild that self destructs keeps a stray one forever" is a list somebody has to
// remember to extend.
//
// So the assertion below is deliberately a COMPLETENESS check against the
// canonical spec list rather than a behavioural test of the deletes. A
// behavioural test would pass happily while the list was one short; this one
// cannot.

describe("self-destruct demolishes every managed channel", () => {
	it("covers exactly the channels GuildSetupManager declares", () => {
		// The invariant: what setup BUILDS and what self-destruct REMOVES are the
		// same set. Add an 11th channel spec and this goes red until selfDestruct
		// learns about it, which is the entire point.
		expect([...HOMEBASE_CHANNEL_FIELDS].sort()).toEqual([...GuildSetupManager.CHANNEL_FIELDS].sort());
	});

	it("includes both ARCADE GAMES channels", () => {
		// Named explicitly as well as covered by the set equality above, because
		// this pair is the reason R13 was raised in the first place: they were the
		// first managed channels to live outside the homebase category.
		expect(HOMEBASE_CHANNEL_FIELDS).toContain("arcadeRulesChannelId");
		expect(HOMEBASE_CHANNEL_FIELDS).toContain("arcadeChallengesChannelId");
	});
});

describe("self-destruct demolishes every managed category", () => {
	it("covers both categories, not just the homebase", () => {
		// An orphan CATEGORY is the worse half of R13: it survives, it is visible
		// at the top of the server, and homebaseDestroyed guarantees nothing will
		// ever clean it up.
		expect([...MANAGED_CATEGORY_FIELDS].sort()).toEqual(["categoryId", "gamesCategoryId"]);
	});

	it("names a category for every categoryField the specs use", () => {
		// The two lists are maintained in different files, so this ties them
		// together: a third category would otherwise be built by setup and left
		// standing by self-destruct.
		const declared = new Set(GuildSetupManager.CHANNEL_SPECS.map((spec) => spec.categoryField));
		for (const field of declared) {
			expect(MANAGED_CATEGORY_FIELDS).toContain(field);
		}
	});
});
