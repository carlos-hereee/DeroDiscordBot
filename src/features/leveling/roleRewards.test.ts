import { describe, it, expect, vi, beforeEach } from "vitest";
import { PermissionFlagsBits } from "discord.js";
import type { Client, GuildMember, Role } from "discord.js";

// ── roleRewards ────────────────────────────────────────────────────────────
// The most failure prone part of any leveling bot, and almost every failure is
// SILENT: the API returns one opaque 50013 for five different causes, and a
// reward that never lands looks exactly like a reward nobody earned. So the
// refusals and the error taxonomy get the coverage, not the happy path.

const mocks = vi.hoisted(() => ({ getLevelingConfig: vi.fn(), invalidate: vi.fn(), update: vi.fn() }));

vi.mock("./levelingConfig.js", () => ({
	getLevelingConfig: mocks.getLevelingConfig,
	invalidateLevelingConfig: mocks.invalidate,
}));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { update: mocks.update } }));

import { _clearRewardReports, computeDesiredRoles, reconcileRewards, refuseReason } from "./roleRewards.js";

const REWARDS = [
	{ level: 5, roleId: "role-bronze" },
	{ level: 10, roleId: "role-silver" },
	{ level: 20, roleId: "role-gold" },
];

// ── the pure half ──────────────────────────────────────────────────────────

describe("computeDesiredRoles", () => {
	it("grants nothing below the first reward level", () => {
		const { desired, earned } = computeDesiredRoles(["role-member"], REWARDS, 4, true);
		expect(desired).toEqual(["role-member"]);
		expect(earned).toEqual([]);
	});

	it("STACK keeps every reward earned along the way", () => {
		const { desired } = computeDesiredRoles(["role-member"], REWARDS, 20, true);
		expect(desired.sort()).toEqual(["role-bronze", "role-gold", "role-member", "role-silver"]);
	});

	it("REPLACE keeps only the highest, which is what a role LADDER means", () => {
		const { desired } = computeDesiredRoles(["role-member"], REWARDS, 20, false);
		expect(desired.sort()).toEqual(["role-gold", "role-member"]);
	});

	it("strips a lower reward the member is still holding under replace", () => {
		// The whole reason the function starts by deleting EVERY reward role: this
		// is how a member moves up a ladder rather than accumulating rungs.
		const { desired } = computeDesiredRoles(["role-bronze", "role-member"], REWARDS, 10, false);
		expect(desired.sort()).toEqual(["role-member", "role-silver"]);
	});

	it("drops a reward role the member holds but no longer qualifies for", () => {
		// Reachable through /xp set-level downward, and through an admin lowering a
		// reward's level.
		const { desired } = computeDesiredRoles(["role-gold", "role-member"], REWARDS, 5, true);
		expect(desired.sort()).toEqual(["role-bronze", "role-member"]);
	});

	it("leaves non reward roles completely alone", () => {
		// A member's own roles are not this feature's business, and stripping one
		// would be the single most damaging bug it could have.
		const { desired } = computeDesiredRoles(["role-mod", "role-vip"], REWARDS, 20, false);
		expect(desired).toContain("role-mod");
		expect(desired).toContain("role-vip");
	});

	it("reports earned ascending, so the HIGHEST is the newly gained one", () => {
		const { earned } = computeDesiredRoles([], REWARDS, 20, true);
		expect(earned.map((reward) => reward.level)).toEqual([5, 10, 20]);
	});

	it("is a no op with no rewards configured", () => {
		const { desired } = computeDesiredRoles(["role-member"], [], 50, true);
		expect(desired).toEqual(["role-member"]);
	});
});

// ── the five refusals ──────────────────────────────────────────────────────

const role = (overrides: Partial<{ managed: boolean; permissions: bigint; position: number }> = {}): Role =>
	({
		id: "role-1",
		managed: overrides.managed ?? false,
		permissions: { has: (flag: bigint) => ((overrides.permissions ?? 0n) & flag) === flag },
	}) as unknown as Role;

const botMember = (options: { manageRoles?: boolean; above?: boolean } = {}): GuildMember =>
	({
		permissions: {
			has: (flag: bigint) => (flag === PermissionFlagsBits.ManageRoles ? (options.manageRoles ?? true) : true),
		},
		roles: { highest: { comparePositionTo: () => (options.above ?? true ? 1 : -1) } },
	}) as unknown as GuildMember;

describe("refuseReason, and every branch is a different cause of the SAME opaque 50013", () => {
	it("allows an ordinary role the bot outranks", () => {
		expect(refuseReason(role(), botMember())).toBeNull();
	});

	it("refuses when the bot lacks ManageRoles", () => {
		expect(refuseReason(role(), botMember({ manageRoles: false }))).toBe("botMissingManageRoles");
	});

	it("refuses a managed role, which no bot can ever assign", () => {
		// Integration roles and the Nitro booster role.
		expect(refuseReason(role({ managed: true }), botMember())).toBe("managed");
	});

	it("refuses a role at or above the bot's own", () => {
		// ⚠️ ADMINISTRATOR DOES NOT BYPASS ROLE HIERARCHY. This bot ships with the
		// Administrator permission integer and still cannot touch a role dragged
		// above its own in Server Settings.
		expect(refuseReason(role(), botMember({ above: false }))).toBe("hierarchy");
	});

	it("REFUSES an Administrator role", () => {
		// A security refusal, not a convenience check. A leveling bot handing out
		// admin because somebody chatted a lot is an incident, not a bug.
		expect(refuseReason(role({ permissions: PermissionFlagsBits.Administrator }), botMember())).toBe("administrator");
	});

	it("REFUSES a Manage Server role", () => {
		expect(refuseReason(role({ permissions: PermissionFlagsBits.ManageGuild }), botMember())).toBe("manageGuild");
	});

	it("checks hierarchy BEFORE the permission refusals", () => {
		// Order matters for the log line an operator reads: a role that is both too
		// high AND carries Administrator is most usefully reported as too high,
		// because that is the one an admin can fix by dragging a role.
		const privileged = role({ permissions: PermissionFlagsBits.Administrator });
		expect(refuseReason(privileged, botMember({ above: false }))).toBe("hierarchy");
	});
});

// ── reconcileRewards ───────────────────────────────────────────────────────

interface Harness {
	client: Client;
	rolesSet: ReturnType<typeof vi.fn>;
	warn: ReturnType<typeof vi.spyOn>;
}

function harness(options: { memberRoles?: string[]; roleOverrides?: Partial<{ managed: boolean; permissions: bigint }>; above?: boolean; missingRole?: boolean } = {}): Harness {
	const rolesSet = vi.fn(async () => undefined);
	const guildRoles = new Map<string, Role>();
	if (!options.missingRole) {
		for (const reward of REWARDS) {
			guildRoles.set(reward.roleId, { ...role(options.roleOverrides), id: reward.roleId } as unknown as Role);
		}
	}

	const guild = {
		id: "g1",
		members: {
			me: botMember({ above: options.above }),
			cache: new Map([
				[
					"u1",
					{
						id: "u1",
						roles: { cache: new Map((options.memberRoles ?? ["role-member"]).map((id) => [id, {}])), set: rolesSet },
					},
				],
			]),
		},
		roles: { cache: guildRoles },
	};

	const client = { guilds: { cache: new Map([["g1", guild]]) } } as unknown as Client;
	const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	return { client, rolesSet, warn };
}

const context = (overrides: Record<string, unknown> = {}) => ({
	settings: { enabled: true, rewards: REWARDS, stackRewards: true, ...overrides },
});

beforeEach(() => {
	_clearRewardReports();
	mocks.getLevelingConfig.mockReset().mockResolvedValue(context());
	mocks.invalidate.mockReset();
	mocks.update.mockReset().mockResolvedValue(undefined);
});

describe("reconcileRewards applies ONE atomic write", () => {
	it("calls roles.set exactly once with the full desired set", async () => {
		// ⚠️ NOT add() then remove(). Sequential calls leave a window in which the
		// member holds both roles or neither, and two close level ups can interleave
		// so the first's removal strips the role the second just granted.
		const { client, rolesSet, warn } = harness();
		await reconcileRewards(client, "g1", "u1", 10);

		expect(rolesSet).toHaveBeenCalledTimes(1);
		expect((rolesSet.mock.calls[0][0] as string[]).sort()).toEqual(["role-bronze", "role-member", "role-silver"]);
		warn.mockRestore();
	});

	it("names the level in the audit reason an admin will read", async () => {
		const { client, rolesSet, warn } = harness();
		await reconcileRewards(client, "g1", "u1", 10);
		expect(rolesSet.mock.calls[0][1]).toBe("Level 10");
		warn.mockRestore();
	});

	it("returns the newly gained role so the level up can name it in the SAME message", async () => {
		const { client, warn } = harness({ memberRoles: ["role-member", "role-bronze"] });
		const earned = await reconcileRewards(client, "g1", "u1", 10);
		expect(earned).toBe("role-silver");
		warn.mockRestore();
	});

	it("does NOT call the API when nothing would change", async () => {
		// /account reconciles on every profile view, and the overwhelming majority
		// are no-ops. Paying an API call for each would be the mass assign this
		// feature exists to avoid, spread out over time.
		const { client, rolesSet, warn } = harness({ memberRoles: ["role-member", "role-bronze"] });
		await reconcileRewards(client, "g1", "u1", 5);
		expect(rolesSet).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	it("does nothing when no rewards are configured", async () => {
		mocks.getLevelingConfig.mockResolvedValue(context({ rewards: [] }));
		const { client, rolesSet, warn } = harness();
		await reconcileRewards(client, "g1", "u1", 50);
		expect(rolesSet).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	it("does nothing when leveling is disabled", async () => {
		mocks.getLevelingConfig.mockResolvedValue(context({ enabled: false }));
		const { client, rolesSet, warn } = harness();
		await reconcileRewards(client, "g1", "u1", 20);
		expect(rolesSet).not.toHaveBeenCalled();
		warn.mockRestore();
	});
});

describe("a refused role is dropped, not fatal", () => {
	it("skips an unassignable role and still applies the rest", async () => {
		const { client, rolesSet, warn } = harness({ above: false });
		await reconcileRewards(client, "g1", "u1", 20);

		// Every reward was refused on hierarchy, so the desired set holds only the
		// member's own roles and no reward is granted.
		if (rolesSet.mock.calls.length > 0) {
			expect(rolesSet.mock.calls[0][0]).toEqual(["role-member"]);
		}
		warn.mockRestore();
	});

	it("logs a refusal ONCE per guild plus role, not once per member", async () => {
		// A broken reward in a large guild would otherwise write the same line
		// thousands of times into Railway's logs and bury everything else.
		const { client, warn } = harness({ above: false });

		await reconcileRewards(client, "g1", "u1", 20);
		const afterFirst = warn.mock.calls.length;
		await reconcileRewards(client, "g1", "u1", 20);
		await reconcileRewards(client, "g1", "u1", 20);

		expect(warn.mock.calls.length).toBe(afterFirst);
		warn.mockRestore();
	});

	it("reports a SECOND broken role in the same guild", async () => {
		// Keyed on guild AND role, so silencing one does not silence the next.
		const { client, warn } = harness({ above: false });
		await reconcileRewards(client, "g1", "u1", 20);
		expect(warn.mock.calls.length).toBeGreaterThanOrEqual(2);
		warn.mockRestore();
	});
});

describe("self healing a deleted reward role", () => {
	it("removes the entry from the config rather than failing forever", async () => {
		// 10011 by another name. A reward pointing at a role that no longer exists
		// can never be granted, so the config stops describing it.
		const { client, warn } = harness({ missingRole: true });
		await reconcileRewards(client, "g1", "u1", 20);

		expect(mocks.update).toHaveBeenCalled();
		expect(mocks.invalidate).toHaveBeenCalledWith("g1");
		warn.mockRestore();
	});
});

describe("it never throws", () => {
	it("swallows a rejecting config read", async () => {
		mocks.getLevelingConfig.mockRejectedValue(new Error("mongo is down"));
		const { client, warn } = harness();
		await expect(reconcileRewards(client, "g1", "u1", 10)).resolves.toBeNull();
		warn.mockRestore();
	});

	it("swallows a rejecting roles.set", async () => {
		const { client, rolesSet, warn } = harness();
		rolesSet.mockRejectedValue(new Error("discord is down"));
		await expect(reconcileRewards(client, "g1", "u1", 10)).resolves.toBeNull();
		warn.mockRestore();
	});

	it("returns null rather than throwing when the guild is not cached", async () => {
		const client = { guilds: { cache: new Map(), fetch: async () => null } } as unknown as Client;
		await expect(reconcileRewards(client, "g-unknown", "u1", 10)).resolves.toBeNull();
	});
});
