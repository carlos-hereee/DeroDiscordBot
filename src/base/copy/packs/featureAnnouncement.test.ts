import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { rokCommanderCopy } from "./rok-commander.pack.js";
import { generalEventsCopy } from "./general-events.pack.js";

// ── the release announcement ───────────────────────────────────────────────
// postFeatureAnnouncement posts this block once per guild on the first boot at
// a new version, so a mistake in it reaches every set up guild at once and
// cannot be taken back. Guarded here: the two packs carry it verbatim (owner
// decision 2026-07-04, which the pack comments say nothing else catches); each
// embed fits Discord's limits with the version the poster appends to the
// title; no long dash; every slash command it names really exists; and the
// copy stays professional (owner decision 2026-10-21): it never says where
// Dero's brain runs or that Dero can be offline, and it never promises always
// on voice either (2026-10 item 216, risk R9).

const HERE = dirname(fileURLToPath(import.meta.url));
const COMMANDS = join(HERE, "..", "..", "..", "commands");

// Discord's embed limits. The poster appends " (v<version>)" to each title.
const EMBED_TITLE_MAX = 256;
const EMBED_DESCRIPTION_MAX = 4096;
const LONGEST_VERSION_SUFFIX = " (v99.99.99)";
const LONG_DASH = /[\u2013\u2014]/;
const NAMED_COMMAND = /`\/([a-z][a-z-]*)/g;
// Wording that tells a client the service depends on one person's machine.
const UNPREPARED = /computer|\bPC\b|when it sleeps|when I am offline|is offline|my creator is online|honest word/i;
// Wording that promises more than the service can keep.
const OVERPROMISE = /always on|always available|24\/7|around the clock|any time, day or night/i;

const PACKS = [
	{ name: "rok-commander", copy: rokCommanderCopy },
	{ name: "general-events", copy: generalEventsCopy },
] as const;

const EMBEDS = PACKS.flatMap(({ name, copy }) => [
	{ label: `${name} public`, ...copy.featureAnnouncement.public },
	{ label: `${name} inner sanctum`, ...copy.featureAnnouncement.innerSanctum },
]);

const registeredCommands = new Set(
	readdirSync(COMMANDS, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.flatMap((folder) => readdirSync(join(COMMANDS, folder.name)))
		.filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
		.map((file) => file.replace(/\.ts$/, "")),
);

describe("the release announcement", () => {
	it("is identical in both packs", () => {
		expect(generalEventsCopy.featureAnnouncement).toEqual(rokCommanderCopy.featureAnnouncement);
	});

	it.each(EMBEDS)("$label fits Discord's embed limits", ({ title, description }) => {
		expect(`${title}${LONGEST_VERSION_SUFFIX}`.length).toBeLessThanOrEqual(EMBED_TITLE_MAX);
		expect(description.length).toBeLessThanOrEqual(EMBED_DESCRIPTION_MAX);
	});

	it.each(EMBEDS)("$label has no long dash", ({ title, description }) => {
		expect(LONG_DASH.test(`${title}\n${description}`)).toBe(false);
	});

	it.each(EMBEDS)("$label names only commands that exist", ({ description }) => {
		const named = [...description.matchAll(NAMED_COMMAND)].map((match) => match[1]);
		expect(named.length).toBeGreaterThan(0);
		expect(named.filter((command) => !registeredCommands.has(command))).toEqual([]);
	});

	it.each(EMBEDS)("$label stays professional: nothing about where Dero runs or being offline", ({ title, description }) => {
		expect(`${title}\n${description}`).not.toMatch(UNPREPARED);
	});

	it.each(EMBEDS)("$label promises no always on service", ({ title, description }) => {
		expect(`${title}\n${description}`).not.toMatch(OVERPROMISE);
	});

	it.each(["the creator's computer is mentioned", "when it sleeps, I cannot", "Dero is offline", "Dero answers 24/7", "always available"])(
		"the guard catches %j",
		(fixture) => {
			expect(UNPREPARED.test(fixture) || OVERPROMISE.test(fixture)).toBe(true);
		},
	);

	it("promises voice only where it was switched on, and says it is off by default to admins", () => {
		const { public: members, innerSanctum: admins } = rokCommanderCopy.featureAnnouncement;
		expect(members.description).toContain("Where your keepers switch it on");
		expect(admins.description).toContain("My voice is switched off here");
	});
});
