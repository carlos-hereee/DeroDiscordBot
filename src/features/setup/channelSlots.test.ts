import { describe, it, expect } from "vitest";
import { GuildSetupManager } from "@features/setup/GuildSetupManager.js";
import { HIDEABLE_CHANNELS } from "./channelVisibilitySubcommands.js";
import { SLOT_LABELS } from "@features/setup/renameChannel.js";

// ── the two admin slot lists ───────────────────────────────────────────────
// ⚠️ THESE ARE DELIBERATE SUBSETS OF CHANNEL_SPECS, NOT MIRRORS, which makes
// them the exception to the rule the rest of this phase established. The intro
// anchor map and the admin-role grant were BUGS precisely because they had to
// cover every channel and silently did not; these two have to cover a CHOICE,
// so a completeness assertion would be wrong here and deriving them from the
// specs would delete the choice.
//
// What can still rot is the other direction: an entry naming a configField that
// does not exist. That is a silent dead option in an autocomplete, so it is what
// these tests pin, alongside the exclusions being intentional.

const SPEC_FIELDS = new Set<string>(GuildSetupManager.CHANNEL_SPECS.map((spec) => spec.configField));

describe("HIDEABLE_CHANNELS", () => {
	it("names only real channel slots", () => {
		// A typo here is a dead autocomplete entry: the admin picks it and the
		// command no-ops against a field nothing reads.
		for (const entry of HIDEABLE_CHANNELS) expect(SPEC_FIELDS.has(entry.value), `${entry.value} is not a spec`).toBe(true);
	});

	it("offers both ARCADE GAMES channels, because both are member facing", () => {
		const values = HIDEABLE_CHANNELS.map((entry) => entry.value);
		expect(values).toContain("arcadeRulesChannelId");
		expect(values).toContain("arcadeChallengesChannelId");
	});

	it("still EXCLUDES introductions and both admin channels, on purpose", () => {
		// Introductions is where new members are pointed, so hiding it defeats the
		// greeter. Both admin channels are already invisible to members, so a
		// "hide" option there is a no-op with a confusing label. If a future change
		// adds any of these three, it is a decision, not a tidy-up.
		const values = HIDEABLE_CHANNELS.map((entry) => entry.value);
		for (const excluded of ["introChannelId", "adminChannelId", "adminCommandsChannelId"]) {
			expect(values).not.toContain(excluded);
		}
	});
});

describe("SLOT_LABELS", () => {
	it("names only real channel slots", () => {
		for (const slot of SLOT_LABELS) expect(SPEC_FIELDS.has(slot.configField), `${slot.configField} is not a spec`).toBe(true);
	});

	it("covers EVERY managed channel, unlike the hide list", () => {
		// Renaming is the one operation that genuinely applies to all ten: an
		// admin may want any channel called something else, and repairOneChannel
		// honors the stored override across rebuilds. This list was missing
		// adminCommandsChannelId until 2026-08-12, so the channel an admin is most
		// likely to rename was the one slot they could not pick.
		expect(SLOT_LABELS.map((slot) => slot.configField).sort()).toEqual([...SPEC_FIELDS].sort());
	});

	it("gives every slot a distinct human label", () => {
		const labels = SLOT_LABELS.map((slot) => slot.label);
		expect(new Set(labels).size).toBe(labels.length);
	});
});
