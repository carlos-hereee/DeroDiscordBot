import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { rokCommanderCopy } from "./rok-commander.pack.js";
import { generalEventsCopy } from "./general-events.pack.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { HANGMAN_CATEGORIES } from "@features/games/hangmanWords.js";
import { RATED_GAMES, type RatedGame } from "@features/ratings/ratingEngine.js";

// ── the release announcement ───────────────────────────────────────────────
// postFeatureAnnouncement posts this block once per guild on the first boot at
// a new version, so a mistake in it reaches every set up guild at once and
// cannot be taken back. Guarded here: the two packs carry it verbatim (owner
// decision 2026-07-04, which the pack comments say nothing else catches); each
// embed fits Discord's limits with the version the poster appends to the
// title; no long dash; every slash command it names really exists; and the
// copy stays professional (owner decision 2026-10-21): it never says where
// Dero's brain runs or that Dero can be offline, and it never promises always
// on voice either (2026-10 item 216, risk R9). Monopoly rides this release
// (2026-10 item 241), so both embeds name it and its voice referee, and the
// referee is promised only behind the host's toggle and a call Dero is already in.
// The 1.7.0 test fixes (2026-10 item 245) ride it too: the copy names the merged
// commands, never the seventeen names Phase 4b retired, and states the fixes'
// numbers, which these pins hold to the code: BOT_CONSTANTS, the hangman word
// bank's shelves and ratingEngine's rated games.

const HERE = dirname(fileURLToPath(import.meta.url));
const COMMANDS = join(HERE, "..", "..", "..", "commands");

// Discord's embed limits. The poster appends " (v<version>)" to each title.
const EMBED_TITLE_MAX = 256;
const EMBED_DESCRIPTION_MAX = 4096;
const LONGEST_VERSION_SUFFIX = " (v99.99.99)";
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

// The copy spells the shelf count as a word ("one of ten shelves"). A bank with a
// count this list does not reach yields "undefined", which fails the pin on purpose:
// the copy then needs rewording, not only the number.
const COUNT_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

// How the copy names each rated game. A Record over RatedGame, so a game newly rated
// in ratingEngine fails to compile here until the copy is checked for it.
const RATED_GAME_NAMES: Record<RatedGame, string> = { holdem: "Hold'em", battleship: "Battleship", monopoly: "Monopoly" };

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

	it("promises voice only where it was switched on, and says it is off by default to admins", () => {
		const { public: members, innerSanctum: admins } = rokCommanderCopy.featureAnnouncement;
		expect(members.description).toContain("Where your keepers switch it on");
		expect(admins.description).toContain("My voice is switched off here");
	});

	it.each(EMBEDS)("$label names Monopoly and its voice referee", ({ description }) => {
		expect(description).toContain("Monopoly");
		expect(description).toContain("voice referee");
	});

	it("gives members Monopoly's doorway, and ties the referee to the host's toggle and a call Dero is already in", () => {
		const { public: members, innerSanctum: admins } = rokCommanderCopy.featureAnnouncement;
		expect(members.description).toContain("`/mini-game monopoly`");
		expect(members.description).toContain("turns on the voice referee at its challenge card");
		expect(members.description).toContain("while I sit in a call with one of its players");
		expect(admins.description).toContain("it speaks only into a call someone has already brought me into");
	});

	it("tells admins every drawn card falls back to its text, and bounds the weekly digest DM (2026-10 item 243)", () => {
		const { public: members, innerSanctum: admins } = rokCommanderCopy.featureAnnouncement;
		expect(members.description).toContain("**Pictures.**");
		expect(admins.description).toContain("each falls back to the text you know whenever a picture cannot be drawn");
		expect(admins.description).toContain("up to 25 of the week's most present members");
		expect(admins.description).toContain("where level up announcements are off");
	});

	it("carries the 1.7.0 test fixes, with the numbers BOT_CONSTANTS runs (2026-10 item 245)", () => {
		const { public: members, innerSanctum: admins } = rokCommanderCopy.featureAnnouncement;
		const leveling = BOT_CONSTANTS.LEVELING;
		// XP: one a message or reaction, and the daily cap over messages, reactions and solo games.
		for (const text of [members.description, admins.description]) {
			expect(text).toContain(`A message or a reaction ${text === members.description ? "earns" : "pays"} ${leveling.MESSAGE_XP}`);
			expect(text).toContain(`at most ${leveling.DAILY_XP_CAP} a day`);
		}
		expect(leveling.MESSAGE_XP).toBe(leveling.REACTION_XP);
		// The games channel, the solo games' XP, the hangman shelves, rematch and the idle close.
		expect(members.description).toContain("🕹️games");
		expect(members.description).toContain(`${leveling.SOLO_LUCK_WIN_XP} renown for a win, ${leveling.SOLO_LUCK_OTHER_XP} for anything else`);
		expect(members.description).toContain(`one of ${COUNT_WORDS[HANGMAN_CATEGORIES.length]} shelves`);
		expect(members.description).toContain("**Rematch** starts the next one in the same room");
		expect(members.description).toContain(`${BOT_CONSTANTS.GAME_ROOM_IDLE_ABANDON_MS / 60_000} minutes without a move`);
		// Hold'em's clock and the way out of a table.
		expect(members.description).toContain(`${BOT_CONSTANTS.HOLDEM_TURN_TIMEOUT_MS / 60_000} minutes on a live clock`);
		expect(members.description).toContain("**Leave table** gives up your seat and its chips");
		// holdemTable.leaveTable zeroes the leaver's stack, because chips exist only for
		// their table, so neither embed may promise a cash out the engine never pays.
		for (const text of [members.description, admins.description]) expect(text).not.toMatch(/cash/i);
		// The voice rooms' Join button, by the rooms' own names in the pack.
		const { meetingVoice, arcadeVoice } = rokCommanderCopy.setup.channels;
		expect(members.description).toContain(`the Join button in ${meetingVoice} and ${arcadeVoice}`);
		// /rating and the games it rates, in ratingEngine's order.
		const rated = RATED_GAMES.map((game) => RATED_GAME_NAMES[game]);
		expect(members.description).toContain(`\`/rating\` shows where you stand in ${rated.slice(0, -1).join(", ")} and ${rated[rated.length - 1]}`);
		// George is the voice, with no step to choose one.
		expect(admins.description).toContain("George's voice");
		expect(admins.description).toContain("`/dero-config enable` is the only step");
		// The merged commands and the buttons that open them.
		for (const merged of ["`/events pause`", "`/events stream announce`", "`/server`", "`/events`", "`/server channels rename`"]) {
			expect(admins.description).toContain(merged);
		}
		expect(admins.description).toContain("Every admin command also has a button");
		expect(members.description).toContain("`/account view:levels`");
	});
});
