import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it, expect, beforeAll } from "vitest";
import { BOT_CONSTANTS } from "./BOT_CONSTANTS.js";
import { isAdminCommand } from "@utils/permissions.js";

// ── the command surface pin ────────────────────────────────────────────────
// What:  loads every command module the way main.ts's loader does and pins three
//        things. ① The registered command list itself, exactly: 2026-10 item 254
//        Phase 1 grouped fourteen admin and owner commands into eight by job, and a
//        deploy replaces the whole registered set, so a stray file that still exported
//        a retired name would register it again. ② Every old path is reachable under
//        its new one with the same option names. ③ The admin gate: every leaf of every
//        admin command is gated but /events list, and no command may carry a Discord
//        default permission unless it is /setup or /self-destruct.
// Where: a default permission hides a command from members without Discord's own
//        Administrator permission, which is how the /setup admin role lost every
//        admin command. ADMIN_COMMANDS is the runtime gate main.ts checks.
//        /setup, /self-destruct and /platform are outside it on purpose, each behind
//        its own stricter check.

const HERE = dirname(fileURLToPath(import.meta.url));
const COMMANDS = join(HERE, "..", "..", "commands");
const OWNER_ONLY = new Set(["setup", "self-destruct"]);
// Hidden by Manage Server and re-checked in its own handler, never by ADMIN_COMMANDS: live capture
// belongs to an app, so it must work in a server that never ran /setup (2026-11 item 284 Phase 3).
const MANAGE_SERVER_ONLY = new Set(["creator-lab-live-link"]);
// Checked by isPlatformOwner inside its own handlers, never by ADMIN_COMMANDS.
const PLATFORM_OWNER_ONLY = "platform";
// Importing every command pulls in most of the bot, which outlasts the default hook timeout.
const LOAD_TIMEOUT_MS = 120_000;
// Discord's application command option types for a subcommand and a group of them.
const SUBCOMMAND_TYPE = 1;
const SUBCOMMAND_GROUP_TYPE = 2;

// Every command a deploy registers: the eight admin and owner commands, then the members'.
const FINAL_COMMANDS = [
	"setup",
	"self-destruct",
	"events",
	"server",
	"leveling",
	"arcade",
	"dero-config",
	"platform",
	"leaderboard",
	"account",
	"claim",
	"mini-game",
	"rating",
	"secret-code",
	"dero",
	"suggestion-box",
	// Dero: Creator Lab (2026-11 item 283 Phase 4): a member's own account link, open to anyone.
	"creator-lab-connect",
	// Creator Lab live capture (2026-11 item 284 Phase 3): the channel link for Manage Server
	// members, and the two marks any member makes during a linked stream.
	"creator-lab-live-link",
	"highlight",
	"count",
];

// The names the merges and removals retired. None may come back as a command.
const RETIRED_COMMANDS = [
	// 2026-10 item 245 Phase 4b.
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
	// 2026-10 item 254 Phase 1.
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

// Every old path of the regroup, its new path, and the option names it took. A
// `widened` row is the network ban, whose one subcommand per target became one
// subcommand with a target choice: its old options must all still be there, with
// the target and the other target's option beside them.
const MOVED_PATHS: ReadonlyArray<{ from: string; to: string; options: readonly string[]; widened?: true }> = [
	{ from: "schedule pause", to: "events pause", options: ["event", "days"] },
	{ from: "schedule resume", to: "events resume", options: ["event"] },
	{ from: "stream announce", to: "events stream announce", options: ["title", "when", "mention-role", "description"] },
	{ from: "stream soon", to: "events stream soon", options: ["when", "note", "mention-role"] },
	{ from: "stream setup", to: "events stream weekly", options: ["name", "day", "time", "timezone", "mention-role", "description"] },
	{ from: "configure-kvk-season", to: "events kvk-season", options: ["days-remaining", "ruins-date-time", "altar-date-time", "kau-date"] },
	{ from: "configure auto-heal", to: "server auto-heal", options: ["enabled"] },
	{ from: "configure leaderboard-tracking", to: "server leaderboard tracking", options: ["enabled"] },
	{ from: "configure week-start", to: "server leaderboard week-start", options: ["start"] },
	{ from: "channels hide", to: "server channels hide", options: ["channel"] },
	{ from: "channels show", to: "server channels show", options: ["channel"] },
	{ from: "channels list", to: "server channels list", options: [] },
	{ from: "channels rename", to: "server channels rename", options: ["slot", "name"] },
	{ from: "setup-level-system show", to: "leveling settings show", options: [] },
	{ from: "setup-level-system toggle", to: "leveling settings toggle", options: ["enabled"] },
	{ from: "setup-level-system rates", to: "leveling settings rates", options: ["message-cooldown", "reaction-cooldown", "reaction-awards", "voice-per-minute"] },
	{ from: "setup-level-system curve", to: "leveling settings curve", options: ["max-level", "milestones", "every-n"] },
	{ from: "setup-level-system announce", to: "leveling settings announce", options: ["mode", "channel", "emoji"] },
	{ from: "setup-level-system restrictions", to: "leveling settings restrictions", options: ["mode", "add-channel", "remove-channel", "add-role", "remove-role"] },
	{ from: "setup-level-system voice", to: "leveling settings voice", options: ["approve", "unapprove", "min-members", "decay-after", "decay-factor"] },
	{ from: "setup-level-system rewards", to: "leveling settings rewards", options: ["level", "role", "remove-level", "stack"] },
	{ from: "setup-level-system multipliers", to: "leveling settings multipliers", options: ["role", "channel", "multiplier", "stack"] },
	{ from: "xp add", to: "leveling xp add", options: ["member", "amount"] },
	{ from: "xp remove", to: "leveling xp remove", options: ["member", "amount"] },
	{ from: "xp set-xp", to: "leveling xp set-xp", options: ["member", "amount"] },
	{ from: "xp set-level", to: "leveling xp set-level", options: ["member", "level"] },
	{ from: "xp reset-member", to: "leveling xp reset-member", options: ["member"] },
	{ from: "xp reset-server", to: "leveling xp reset-server", options: [] },
	{ from: "xp export", to: "leveling xp export", options: [] },
	{ from: "dero-config arcade on", to: "arcade on", options: [] },
	{ from: "dero-config arcade off", to: "arcade off", options: [] },
	{ from: "dero-config arcade bots", to: "arcade bots", options: ["enabled"] },
	{ from: "dero-config arcade reach", to: "arcade reach", options: ["mode"] },
	{ from: "dero-config arcade monthly-post", to: "arcade monthly-post", options: ["enabled"] },
	{ from: "dero-config arcade block-server", to: "arcade server block", options: ["server"] },
	{ from: "dero-config arcade unblock-server", to: "arcade server unblock", options: ["server"] },
	{ from: "economy status", to: "arcade chips status", options: [] },
	{ from: "economy toggle", to: "arcade chips toggle", options: ["enabled"] },
	{ from: "economy grant", to: "arcade chips grant", options: ["user", "amount"] },
	{ from: "network ban user", to: "platform network ban", options: ["user", "reason"], widened: true },
	{ from: "network ban server", to: "platform network ban", options: ["server", "reason"], widened: true },
	{ from: "network unban user", to: "platform network unban", options: ["user"], widened: true },
	{ from: "network unban server", to: "platform network unban", options: ["server"], widened: true },
	{ from: "render-analytics top10", to: "platform analytics", options: ["surface", "period"] },
];

interface CommandOptionJSON {
	name: string;
	type: number;
	options?: CommandOptionJSON[];
}

interface CommandShape {
	data: { name: string; toJSON(): { default_member_permissions?: string | null; options?: CommandOptionJSON[] } };
	execute: unknown;
}

/** One leaf of a command: its group (or null) and subcommand (or null), and the option names it takes. */
interface Leaf {
	group: string | null;
	subcommand: string | null;
	path: string;
	options: string[];
}

function isCommand(candidate: unknown): candidate is CommandShape {
	if (typeof candidate !== "object" || candidate === null) return false;
	return "data" in candidate && "execute" in candidate;
}

const commandFiles = readdirSync(COMMANDS, { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.flatMap((folder) =>
		readdirSync(join(COMMANDS, folder.name))
			.filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
			.map((file) => join(COMMANDS, folder.name, file)),
	);

let commands: { name: string; hasDefault: boolean; leaves: Leaf[] }[] = [];

const optionNames = (options: CommandOptionJSON[] | undefined): string[] => (options ?? []).map((option) => option.name);

// Every leaf a command declares, groups walked: a command with no subcommands is one leaf.
function leavesOf(name: string, options: CommandOptionJSON[] | undefined): Leaf[] {
	const all = options ?? [];
	const hasSubcommands = all.some((option) => option.type === SUBCOMMAND_TYPE || option.type === SUBCOMMAND_GROUP_TYPE);
	if (!hasSubcommands) return [{ group: null, subcommand: null, path: name, options: optionNames(all) }];
	return all.flatMap((option) => {
		if (option.type === SUBCOMMAND_TYPE) return [{ group: null, subcommand: option.name, path: `${name} ${option.name}`, options: optionNames(option.options) }];
		return (option.options ?? []).map((child) => ({
			group: option.name,
			subcommand: child.name,
			path: `${name} ${option.name} ${child.name}`,
			options: optionNames(child.options),
		}));
	});
}

const allLeaves = (): Leaf[] => commands.flatMap((command) => command.leaves);

beforeAll(async () => {
	const loaded = await Promise.all(
		commandFiles.map(async (file) => {
			const module: { default?: unknown } = await import(pathToFileURL(file).href);
			// The same fallback main.ts uses: a default export or the module itself.
			return module.default ?? module;
		}),
	);
	commands = loaded.filter(isCommand).map((command) => {
		const json = command.data.toJSON();
		const permissions = json.default_member_permissions;
		return {
			name: command.data.name,
			hasDefault: permissions !== undefined && permissions !== null,
			leaves: leavesOf(command.data.name, json.options),
		};
	});
}, LOAD_TIMEOUT_MS);

describe("the registered command list", () => {
	it("is exactly the final command set, every name once", () => {
		expect(commands.map((command) => command.name).sort()).toEqual([...FINAL_COMMANDS].sort());
	});

	it("brings back none of the retired names", () => {
		const names = new Set(commands.map((command) => command.name));
		expect(RETIRED_COMMANDS.filter((name) => names.has(name))).toEqual([]);
	});

	// Discord's ceiling: 25 subcommands and groups at the top of one command.
	it("keeps every command inside Discord's 25 subcommands and groups", () => {
		for (const command of commands) {
			const topLevel = new Set(command.leaves.map((leaf) => leaf.group ?? leaf.subcommand));
			expect(topLevel.size, command.name).toBeLessThanOrEqual(25);
		}
	});
});

describe("every old path, under its new one", () => {
	it.each(MOVED_PATHS)("/$from is /$to with the same options", ({ to, options, widened }) => {
		const leaf = allLeaves().find((candidate) => candidate.path === to);
		expect(leaf, `/${to} is not registered`).toBeDefined();
		if (widened) {
			expect(leaf?.options).toEqual(expect.arrayContaining([...options]));
			expect(leaf?.options[0]).toBe("target");
			return;
		}
		expect(leaf?.options).toEqual([...options]);
	});

	it("names each retired command in the table, so a missed move fails here", () => {
		const movedFrom = new Set(MOVED_PATHS.map((row) => row.from.split(" ")[0]));
		const retiredByPhase = RETIRED_COMMANDS.slice(RETIRED_COMMANDS.indexOf("schedule"));
		expect(retiredByPhase.filter((name) => !movedFrom.has(name))).toEqual([]);
	});
});

describe("the admin command gate", () => {
	it("loads the commands it is meant to check", () => {
		expect(commands.length).toBe(FINAL_COMMANDS.length);
		expect(commands.map((command) => command.name)).toContain("dero-config");
	});

	it("gates every leaf of every admin command, groups included, except /events list", () => {
		const open: string[] = [];
		for (const command of commands.filter((candidate) => BOT_CONSTANTS.ADMIN_COMMANDS.has(candidate.name))) {
			for (const leaf of command.leaves) {
				if (!isAdminCommand(command.name, leaf.subcommand, leaf.group)) open.push(leaf.path);
			}
		}
		expect(open).toEqual(["events list"]);
	});

	it("names only real commands and real member leaves, so a typo cannot leave a real one ungated or opened", () => {
		const names = new Set(commands.map((command) => command.name));
		expect([...BOT_CONSTANTS.ADMIN_COMMANDS].filter((entry) => !names.has(entry))).toEqual([]);
		const paths = new Set(allLeaves().map((leaf) => leaf.path));
		expect([...BOT_CONSTANTS.MEMBER_SUBCOMMANDS].filter((entry) => !paths.has(entry))).toEqual([]);
	});

	it("opens a member leaf only at its own path, never a same named leaf inside a group", () => {
		expect(isAdminCommand("events", "list")).toBe(false);
		expect(isAdminCommand("events", "list", "stream")).toBe(true);
		expect(isAdminCommand("server", "list", "channels")).toBe(true);
	});

	it("leaves the member commands and the three owner commands to their own checks", () => {
		for (const name of ["leaderboard", "account", "claim", "mini-game", "rating", "secret-code", "dero", "suggestion-box", "creator-lab-connect", "highlight", "count", ...OWNER_ONLY, ...MANAGE_SERVER_ONLY, PLATFORM_OWNER_ONLY]) {
			expect(BOT_CONSTANTS.ADMIN_COMMANDS.has(name), name).toBe(false);
		}
	});

	// Without this the two guards below would pass just as happily if reading the
	// default broke and every command looked like it had none.
	it("sees a default where one is set: /setup, /self-destruct and /creator-lab-live-link keep theirs, and /platform has none", () => {
		const withDefault = commands.filter((command) => command.hasDefault).map((command) => command.name);
		expect(withDefault.sort()).toEqual([...OWNER_ONLY, ...MANAGE_SERVER_ONLY].sort());
	});

	it("hides no admin command behind a default, so the /setup admin role can see every one", () => {
		const hidden = commands.filter((command) => BOT_CONSTANTS.ADMIN_COMMANDS.has(command.name) && command.hasDefault).map((command) => command.name);
		expect(hidden).toEqual([]);
	});
});
