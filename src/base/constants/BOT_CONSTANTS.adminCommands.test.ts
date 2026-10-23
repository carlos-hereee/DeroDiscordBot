import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it, expect, beforeAll } from "vitest";
import { BOT_CONSTANTS } from "./BOT_CONSTANTS.js";
import { isAdminCommand } from "@utils/permissions.js";

// ── the command surface pin ────────────────────────────────────────────────
// What:  loads every command module the way main.ts's loader does and pins two
//        things. ① The registered command list itself, exactly: 2026-10 item 245
//        Phase 4b retired seventeen names (fifteen folded into /schedule, /stream,
//        /configure, /events, /channels and /account, and /ping and /user removed),
//        and a deploy replaces the whole registered set, so a stray file that still
//        exported one of them would register it again. ② The admin gate: no command
//        may carry a Discord default permission unless it is in
//        BOT_CONSTANTS.ADMIN_COMMANDS, and no command in that set may carry one.
// Where: a default permission hides a command from members without Discord's own
//        Administrator permission, which is how the /setup admin role lost every
//        admin command. ADMIN_COMMANDS is the runtime gate main.ts checks, so a
//        command with a default and no entry would be hidden and ungated at once.
//        /setup and /self-destruct are the two exceptions: server owner only by
//        their own checks, and outside the set on purpose.

const HERE = dirname(fileURLToPath(import.meta.url));
const COMMANDS = join(HERE, "..", "..", "commands");
const OWNER_ONLY = new Set(["setup", "self-destruct"]);
// Importing every command pulls in most of the bot, which outlasts the default hook timeout.
const LOAD_TIMEOUT_MS = 120_000;
// Discord's application command option types for a subcommand and a group of them.
const SUBCOMMAND_TYPE = 1;
const SUBCOMMAND_GROUP_TYPE = 2;

// Every command a deploy registers, after the Phase 4b merges.
const FINAL_COMMANDS = [
	"account",
	"channels",
	"configure",
	"configure-kvk-season",
	"dero",
	"dero-config",
	"events",
	"leaderboard",
	"mini-game",
	"rating",
	"render-analytics",
	"schedule",
	"secret-code",
	"self-destruct",
	"setup",
	"setup-level-system",
	"stream",
	"suggestion-box",
	"xp",
];

// The names the merges and removals retired. None may come back as a command.
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

let commands: { name: string; hasDefault: boolean; subcommands: string[] }[] = [];

// Every subcommand a command declares, groups flattened, by its own name.
function subcommandsOf(options: CommandOptionJSON[] | undefined): string[] {
	return (options ?? []).flatMap((option) => {
		if (option.type === SUBCOMMAND_TYPE) return [option.name];
		if (option.type === SUBCOMMAND_GROUP_TYPE) return subcommandsOf(option.options);
		return [];
	});
}

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
			subcommands: subcommandsOf(json.options),
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

	it("keeps the merged commands' subcommands", () => {
		const subcommandsOfCommand = (name: string) => commands.find((command) => command.name === name)?.subcommands.sort();
		expect(subcommandsOfCommand("schedule")).toEqual(["pause", "resume"]);
		expect(subcommandsOfCommand("stream")).toEqual(["announce", "setup", "soon"]);
		expect(subcommandsOfCommand("configure")).toEqual(["auto-heal", "leaderboard-tracking", "week-start"]);
		expect(subcommandsOfCommand("events")).toEqual(["delete", "list"]);
		expect(subcommandsOfCommand("channels")).toEqual(["hide", "list", "rename", "show"]);
	});
});

describe("the admin command gate", () => {
	it("loads the commands it is meant to check", () => {
		expect(commands.length).toBe(FINAL_COMMANDS.length);
		expect(commands.map((command) => command.name)).toContain("dero-config");
	});

	// Without this the two guards below would pass just as happily if reading the
	// default broke and every command looked like it had none.
	it("sees a default where one is set: /setup and /self-destruct keep theirs", () => {
		const withDefault = commands.filter((command) => command.hasDefault).map((command) => command.name);
		expect(withDefault.sort()).toEqual([...OWNER_ONLY].sort());
	});

	it("lets no command carry a Discord default permission outside ADMIN_COMMANDS, /setup and /self-destruct aside", () => {
		const ungated = commands
			.filter((command) => command.hasDefault)
			.filter((command) => !BOT_CONSTANTS.ADMIN_COMMANDS.has(command.name) && !OWNER_ONLY.has(command.name))
			.map((command) => command.name);
		expect(ungated).toEqual([]);
	});

	it("hides no admin command behind a default, so the /setup admin role can see every one", () => {
		const hidden = commands
			.filter((command) => isAdminCommand(command.name, null) && command.hasDefault)
			.map((command) => command.name);
		expect(hidden).toEqual([]);
	});

	it("names only commands and subcommands that exist, so a typo cannot leave a real one ungated", () => {
		// An entry is "command" or "command subcommand" (BOT_CONSTANTS.ADMIN_COMMANDS).
		const known = new Set(commands.flatMap((command) => [command.name, ...command.subcommands.map((sub) => `${command.name} ${sub}`)]));
		expect([...BOT_CONSTANTS.ADMIN_COMMANDS].filter((entry) => !known.has(entry))).toEqual([]);
	});

	it("gates /events delete while /events list stays a member view", () => {
		expect(isAdminCommand("events", "delete")).toBe(true);
		expect(isAdminCommand("events", "list")).toBe(false);
		expect(isAdminCommand("schedule", "pause")).toBe(true);
		expect(isAdminCommand("account", null)).toBe(false);
	});

	it("keeps /setup and /self-destruct out of the set, because their own checks are stricter", () => {
		for (const name of OWNER_ONLY) expect(BOT_CONSTANTS.ADMIN_COMMANDS.has(name)).toBe(false);
	});
});
