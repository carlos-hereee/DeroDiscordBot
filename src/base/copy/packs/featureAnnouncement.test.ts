import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { rokCommanderCopy } from "./rok-commander.pack.js";
import { generalEventsCopy } from "./general-events.pack.js";

// ── the release announcement ───────────────────────────────────────────────
// postFeatureAnnouncement posts this block once per guild on the first boot at
// a new version, a patch included, so a mistake in it reaches every set up guild
// at once and cannot be taken back. Guarded here for every release: the two packs
// carry it verbatim (owner decision 2026-07-04, which the pack comments say
// nothing else catches); each embed fits Discord's limits with the version the
// poster appends to the title; no long dash; every slash command it names really
// exists; and the copy stays professional (owner decision 2026-10-21): it never
// says where Dero's brain runs or that Dero can be offline, and it never promises
// always on voice either (2026-10 item 216, risk R9). A release may carry no public
// block (null), which posts the inner-sanctum embed alone, so every check walks only
// the embeds the release has. The last block pins the current release's own content
// and is rewritten with it.

const HERE = dirname(fileURLToPath(import.meta.url));
const COMMANDS = join(HERE, "..", "..", "..", "commands");

// Discord's embed limits. The poster appends " (v<version>)" to each title.
const EMBED_TITLE_MAX = 256;
const EMBED_DESCRIPTION_MAX = 4096;
const LONGEST_VERSION_SUFFIX = " (v99.99.99)";
// A patch note reads in one glance; 2.0.0's launch post sat at 4093.
const PATCH_NOTE_MAX = 1500;
const LONG_DASH = /[\u2013\u2014]/;
const NAMED_COMMAND = /`\/([a-z][a-z-]*)/g;
// The names Phase 4b folded into /schedule, /stream, /configure, /events, /channels
// and /account, or removed, and the fourteen admin and owner commands 2026-10 item 254
// Phase 1 grouped by job into eight. A deploy unregisters them, so naming one is a dead end.
const RETIRED_COMMANDS = [
	"pause-schedule",
	"continue-schedule",
	"pause-all-schedules",
	"continue-all-schedules",
	"announce-stream",
	"go-live-soon",
	"configure-stream-schedule",
	"configure-auto-heal",
	"configure-leaderboard-tracking",
	"configure-leaderboard-week-start",
	"list-events",
	"delete-event",
	"rename-channel",
	"levels",
	"achievements",
	"ping",
	"user",
	"schedule",
	"stream",
	"configure-kvk-season",
	"configure",
	"channels",
	"setup-level-system",
	"xp",
	"economy",
	"network",
	"render-analytics",
];
// Wording that tells a client the service depends on one person's machine.
const UNPREPARED = /computer|\bPC\b|when it sleeps|when I am offline|is offline|my creator is online|honest word/i;
// Wording that promises more than the service can keep.
const OVERPROMISE = /always on|always available|24\/7|around the clock|any time, day or night/i;

const PACKS = [
	{ name: "rok-commander", copy: rokCommanderCopy },
	{ name: "general-events", copy: generalEventsCopy },
] as const;

const EMBEDS = PACKS.flatMap(({ name, copy }) => {
	const { public: members, innerSanctum: admins } = copy.featureAnnouncement;
	const memberEmbeds = members ? [{ label: `${name} public`, ...members }] : [];
	return [...memberEmbeds, { label: `${name} inner sanctum`, ...admins }];
});

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

	// A release may name no command at all (the item 367 note points at a button), so this
	// checks only that every command it does name is registered.
	it.each(EMBEDS)("$label names only commands that exist", ({ description }) => {
		const named = [...description.matchAll(NAMED_COMMAND)].map((match) => match[1]);
		expect(named.filter((command) => !registeredCommands.has(command))).toEqual([]);
	});

	it.each(EMBEDS)("$label names none of the retired commands", ({ description }) => {
		const named = [...description.matchAll(NAMED_COMMAND)].map((match) => match[1]);
		expect(named.filter((command) => RETIRED_COMMANDS.includes(command))).toEqual([]);
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

	it("is the item 367 hotfix's admin only note: no public block, the apology, the fix and where to press", () => {
		const { public: members, innerSanctum: admins } = rokCommanderCopy.featureAnnouncement;
		expect(members).toBeNull();
		expect(admins.title).toBe("🧭 CONFIGURE ONBOARDING IS FIXED");
		expect(admins.description.split("\n\n")).toEqual([
			"Sorry to anyone who hit this.",
			"Configure Onboarding is fixed. If it stopped you before by asking you to add more channels, it no longer dead ends: Dero now offers to open some of your own channels to everyone or create new ones, then carries straight on with your Onboarding questions.",
			"Press Configure Onboarding in 🧭onboarding to pick up where you left off.",
		]);
		expect(`${admins.title}\n${admins.description}`).not.toMatch(UNPREPARED);
		expect(admins.description.length).toBeLessThan(PATCH_NOTE_MAX);
	});
});
