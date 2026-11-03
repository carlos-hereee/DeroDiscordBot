import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatInputCommandInteraction } from "discord.js";

// ── /setup after a self destruct (2026-11 item 285 debug pass) ─────────────────
// Self destruct rebuilds Headquarters itself, so this branch runs only when that rebuild
// did not stand. It asks the same GuildSetupManager.rebuildDestroyedHomebase (whose own
// tests pin the Headquarters only proof), grants the roles only on a rebuild that stood,
// and clears the flag last.

const mocks = vi.hoisted(() => ({
	findByGuildId: vi.fn(),
	update: vi.fn(),
	rebuildDestroyedHomebase: vi.fn(),
	applyAdminRole: vi.fn(),
	send: vi.fn(),
}));

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findByGuildId, update: mocks.update } }));
vi.mock("@features/setup/GuildSetupManager.js", () => ({
	GuildSetupManager: { rebuildDestroyedHomebase: mocks.rebuildDestroyedHomebase, applyAdminRole: mocks.applyAdminRole },
	isHeadquartersOnly: () => false,
}));
vi.mock("@utils/answerInChannel.js", () => ({ beginChannelAnswer: vi.fn(async () => ({ send: mocks.send })) }));
vi.mock("@utils/textModal.js", () => ({ showNotice: vi.fn() }));

import { execute } from "./setup.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";

const OWNER = "owner-1";

function makeInteraction() {
	const roles: Record<string, { id: string }> = { "admin-role": { id: "role-admin" }, "member-role": { id: "role-member" } };
	return {
		guildId: "guild-1",
		user: { id: OWNER },
		guild: { ownerId: OWNER },
		options: { getRole: (name: string) => roles[name] },
	} as unknown as ChatInputCommandInteraction;
}

const sentTitles = () => mocks.send.mock.calls.map((call) => (call[0] as { embeds: Array<{ data: { title?: string; description?: string } }> }).embeds[0]!.data);

beforeEach(() => {
	vi.clearAllMocks();
	mocks.findByGuildId.mockResolvedValueOnce({ guildId: "guild-1", homebaseDestroyed: true, setupComplete: false });
});

describe("/setup rebuilding a self destructed server", () => {
	it("rebuilds through the shared helper, grants the roles and clears the flag after them", async () => {
		mocks.rebuildDestroyedHomebase.mockResolvedValue(true);
		await execute(makeInteraction());

		expect(mocks.rebuildDestroyedHomebase).toHaveBeenCalledWith(expect.objectContaining({ ownerId: OWNER }));
		expect(mocks.applyAdminRole).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ adminRoleId: "role-admin", memberRoleId: "role-member" }));
		expect(mocks.update).toHaveBeenCalledWith("guild-1", { homebaseDestroyed: false });
		expect(mocks.applyAdminRole.mock.invocationCallOrder[0]!).toBeLessThan(mocks.update.mock.invocationCallOrder[0]!);
		expect(sentTitles()[0]!.description).not.toBe(rokCommanderCopy.responses.setupFailed);
	});

	it("still refuses when the rebuild does not stand, leaving the flag for a retry", async () => {
		mocks.rebuildDestroyedHomebase.mockResolvedValue(false);
		await execute(makeInteraction());

		expect(mocks.applyAdminRole).not.toHaveBeenCalled();
		expect(mocks.update).not.toHaveBeenCalled();
	});
});
