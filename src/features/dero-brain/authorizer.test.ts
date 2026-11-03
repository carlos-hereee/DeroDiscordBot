import { describe, it, expect } from "vitest";
import { isAuthorizedSpeaker, type AuthorizableMember } from "./authorizer.js";

// ── authorizer ─────────────────────────────────────────────────────────────
// The whole matrix: the guild owner, the guild's admin role (post-launch plan
// item 12) and an allowlisted role pass; no role, a missing member and a member of
// another guild do not.

const GUILD = "g1";
const OWNER = "owner";
const ALLOWED_ROLE = "role-taskers";
const ADMIN_ROLE = "role-admin";

const config = { guildId: GUILD, allowedRoleIds: [ALLOWED_ROLE] };

function member(id: string, roleIds: string[], guildId: string = GUILD): AuthorizableMember {
	return { id, guild: { id: guildId }, roles: { cache: new Set(roleIds) } };
}

const allowed = (who: AuthorizableMember | null, voiceConfig = config, adminRoleId: string | null = ADMIN_ROLE) =>
	isAuthorizedSpeaker({ member: who, guildOwnerId: OWNER, adminRoleId, voiceConfig });

describe("isAuthorizedSpeaker", () => {
	it("allows the guild owner with no roles at all", () => {
		expect(allowed(member(OWNER, []))).toBe(true);
	});

	it("allows a member holding an allowlisted role", () => {
		expect(allowed(member("u1", ["other", ALLOWED_ROLE]))).toBe(true);
	});

	it("refuses a member with no allowlisted role", () => {
		expect(allowed(member("u1", ["other"]))).toBe(false);
		expect(allowed(member("u1", []))).toBe(false);
	});

	it("allows a member holding the guild's admin role, even when that role is not on the allowlist", () => {
		expect(allowed(member("admin", [ADMIN_ROLE]))).toBe(true);
		expect(allowed(member("admin", [ADMIN_ROLE]), { guildId: GUILD, allowedRoleIds: [] })).toBe(true);
	});

	it("falls back to the allowlist when the guild has no admin role yet", () => {
		expect(allowed(member("admin", [ADMIN_ROLE]), config, null)).toBe(false);
		expect(allowed(member("u1", [ALLOWED_ROLE]), config, null)).toBe(true);
	});

	it("refuses an admin of another guild, whose role id merely matches", () => {
		expect(allowed(member("admin", [ADMIN_ROLE], "g2"))).toBe(false);
	});

	it("refuses everyone but the owner and the admin role when the allowlist is empty", () => {
		const empty = { guildId: GUILD, allowedRoleIds: [] };
		expect(allowed(member("u1", [ALLOWED_ROLE]), empty)).toBe(false);
		expect(allowed(member(OWNER, []), empty)).toBe(true);
	});

	it("refuses a missing member", () => {
		expect(allowed(null)).toBe(false);
	});

	it("refuses a member of another guild, even the same id holding a matching role id", () => {
		expect(allowed(member("u1", [ALLOWED_ROLE], "g2"))).toBe(false);
		expect(allowed(member(OWNER, [], "g2"))).toBe(false);
	});
});
