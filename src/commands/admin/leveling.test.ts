import { describe, it, expect } from "vitest";
import { PermissionFlagsBits } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";

import { XP_SUBCOMMANDS } from "@features/leveling/xpSubcommands.js";
import { data as levelingData } from "./leveling.js";
import { data as accountData } from "@commands/fun/account.js";

// ── the /leveling command surface ──────────────────────────────────────────
// Two things are pinned here, and both fail SILENTLY when wrong.
//
// ① Subcommand drift. A subcommand declared on the builder with no branch
//    behind it is a command that does nothing when a member picks it, with no
//    error anywhere. mini-game.test.ts guards the same class of mistake against
//    its dispatch table.
//
// ② Admin gating, which is TWO INDEPENDENT MECHANISMS. Getting one and not the
//    other produces no error and looks fine in testing:
//      • .setDefaultMemberPermissions(Administrator) is what HIDES a command in
//        a non-admin's picker. Missing it means every member SEES /leveling.
//      • BOT_CONSTANTS.ADMIN_COMMANDS is the runtime gate in main.ts. Missing it
//        means anyone who reaches the command anyway (a permission overwrite, a
//        stale client) can RUN it.
//    And the inverse matters just as much: /account, whose views include the
//    levels standings and the achievements since 2026-10 item 245 Phase 4b, is
//    public on purpose, so putting it in the admin set would hide the whole point
//    of the feature from the members it exists for.

type BuilderJSON = {
	name: string;
	description?: string;
	default_member_permissions?: string | null;
	options?: Array<{ name: string; type: number; description?: string; options?: Array<{ name: string; type: number }> }>;
};

// One group of /leveling, shaped like a builder so the helpers below read it the same way.
const groupOf = (name: string): { toJSON: () => unknown } => ({
	toJSON: () => (levelingData.toJSON() as BuilderJSON).options?.find((option) => option.name === name),
});
const xpData = groupOf("xp");
const setupData = groupOf("settings");

// Discord's application command option type 1 is SUB_COMMAND.
const SUB_COMMAND_TYPE = 1;

const subcommandsOf = (builder: { toJSON: () => unknown }): string[] =>
	((builder.toJSON() as BuilderJSON).options ?? [])
		.filter((option) => option.type === SUB_COMMAND_TYPE)
		.map((option) => option.name)
		.sort();

const hasAdminDefault = (builder: { toJSON: () => unknown }): boolean => {
	const permissions = (builder.toJSON() as BuilderJSON).default_member_permissions;
	if (!permissions) return false;
	return (BigInt(permissions) & PermissionFlagsBits.Administrator) === PermissionFlagsBits.Administrator;
};

describe("/leveling xp declares exactly the subcommands it handles", () => {
	it("declares every name in XP_SUBCOMMANDS", () => {
		expect(subcommandsOf(xpData)).toEqual([...XP_SUBCOMMANDS].sort());
	});

	it("declares nothing beyond them", () => {
		// The other direction. A builder entry with no branch is a subcommand that
		// silently does nothing when picked.
		for (const declared of subcommandsOf(xpData)) {
			expect([...XP_SUBCOMMANDS], `${declared} is declared but not in XP_SUBCOMMANDS`).toContain(declared);
		}
	});

	it("keeps both destructive subcommands, which are the only ones in the feature", () => {
		// Nothing else in leveling deletes anything: turning the feature off,
		// changing a curve, or restricting a channel all leave every row intact.
		expect(XP_SUBCOMMANDS).toContain("reset-member");
		expect(XP_SUBCOMMANDS).toContain("reset-server");
	});

	it("ships the export, which is a real wedge against the market leader", () => {
		// Arcane has no export at all, and the community workaround scrapes their
		// web leaderboard and drops everyone past the first 100 members.
		expect(XP_SUBCOMMANDS).toContain("export");
	});

	it("stays inside Discord's 25 option ceiling", () => {
		expect(XP_SUBCOMMANDS.length).toBeLessThanOrEqual(25);
		expect(subcommandsOf(setupData).length).toBeLessThanOrEqual(25);
	});
});

// The runtime gate is the one gate. A Discord default would hide these from the
// /setup admin role, which is exactly who they are for (see ADMIN_COMMANDS).
describe("the admin commands are gated at runtime and visible to the admin role", () => {
	it.each([["leveling", levelingData]])("%s is in the runtime gate and hides behind no Discord default", (name, builder) => {
		expect(hasAdminDefault(builder), `${name} must not carry setDefaultMemberPermissions`).toBe(false);
		expect(BOT_CONSTANTS.ADMIN_COMMANDS.has(name), `${name} is missing from ADMIN_COMMANDS`).toBe(true);
	});
});

describe("the member commands are PUBLIC, in neither mechanism", () => {
	it.each([["account", accountData]])("%s is visible to every member", (name, builder) => {
		// Deliberately public, like /leaderboard and /events list. Members seeing
		// their own standing is the entire point of the feature, so an accidental
		// admin gate here would hide it from exactly the audience it is for.
		expect(hasAdminDefault(builder), `${name} must not be admin gated`).toBe(false);
		expect(BOT_CONSTANTS.ADMIN_COMMANDS.has(name), `${name} must not be in ADMIN_COMMANDS`).toBe(false);
	});
});

describe("/leveling settings says what it does NOT do", () => {
	it("states in its description that it creates nothing", () => {
		// /setup provisions channels and roles; an admin who reads "settings" for the
		// leveling system could expect the same of it, so the group says it builds nothing.
		const description = (setupData.toJSON() as { description: string }).description.toLowerCase();
		expect(description).toContain("creates no");
	});

	it("covers every group of settings the feature has", () => {
		expect(subcommandsOf(setupData)).toEqual(
			["announce", "curve", "multipliers", "rates", "restrictions", "rewards", "show", "toggle", "voice"].sort()
		);
	});

	it("offers the toggle, which is the no-deploy rollback path", () => {
		// Leveling ships ON in every guild. This subcommand is the cheapest rung of
		// the rollback ladder and the one the admin notice points at by name.
		expect(subcommandsOf(setupData)).toContain("toggle");
	});
});
