import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it, expect, beforeAll } from "vitest";
import { BOT_CONSTANTS } from "./BOT_CONSTANTS.js";

// ── the admin command pin ──────────────────────────────────────────────────
// What:  loads every command module the way main.ts's loader does and pins the
//        admin gate: no command may carry a Discord default permission unless it is
//        in BOT_CONSTANTS.ADMIN_COMMANDS, and no command in that set may carry one.
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

interface CommandShape {
	data: { name: string; toJSON(): { default_member_permissions?: string | null } };
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

let commands: { name: string; hasDefault: boolean }[] = [];

beforeAll(async () => {
	const loaded = await Promise.all(
		commandFiles.map(async (file) => {
			const module: { default?: unknown } = await import(pathToFileURL(file).href);
			// The same fallback main.ts uses: a default export or the module itself.
			return module.default ?? module;
		}),
	);
	commands = loaded.filter(isCommand).map((command) => {
		const permissions = command.data.toJSON().default_member_permissions;
		return { name: command.data.name, hasDefault: permissions !== undefined && permissions !== null };
	});
}, LOAD_TIMEOUT_MS);

describe("the admin command gate", () => {
	it("loads the commands it is meant to check", () => {
		expect(commands.length).toBeGreaterThan(20);
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
			.filter((command) => BOT_CONSTANTS.ADMIN_COMMANDS.has(command.name) && command.hasDefault)
			.map((command) => command.name);
		expect(hidden).toEqual([]);
	});

	it("names only commands that exist, so a typo cannot leave a real command ungated", () => {
		const names = new Set(commands.map((command) => command.name));
		expect([...BOT_CONSTANTS.ADMIN_COMMANDS].filter((name) => !names.has(name))).toEqual([]);
	});

	it("keeps /setup and /self-destruct out of the set, because their own checks are stricter", () => {
		for (const name of OWNER_ONLY) expect(BOT_CONSTANTS.ADMIN_COMMANDS.has(name)).toBe(false);
	});
});
