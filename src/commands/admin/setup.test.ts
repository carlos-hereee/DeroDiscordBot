import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatInputCommandInteraction } from "discord.js";

// ── /setup after a self destruct (2026-11 item 285 debug pass) ─────────────────
// Self destruct clears every stored id, so the /setup that follows rebuilds 🏰 DERO
// HEADQUARTERS alone and stores no notice board. The rebuild branch used to prove the
// rebuild by categoryId only, so every such /setup answered "setup failed", left the
// server flagged destroyed and never granted the roles. These pin the fixed check.

const mocks = vi.hoisted(() => ({
	findByGuildId: vi.fn(),
	update: vi.fn(),
	autoSetup: vi.fn(),
	applyAdminRole: vi.fn(),
	send: vi.fn(),
}));

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findByGuildId, update: mocks.update } }));
vi.mock("@features/setup/GuildSetupManager.js", () => ({
	GuildSetupManager: { autoSetup: mocks.autoSetup, applyAdminRole: mocks.applyAdminRole },
	isHeadquartersOnly: () => false,
}));
vi.mock("@utils/answerInChannel.js", () => ({ beginChannelAnswer: vi.fn(async () => ({ send: mocks.send })) }));
vi.mock("@utils/textModal.js", () => ({ showNotice: vi.fn() }));

import { execute } from "./setup.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";

const OWNER = "owner-1";
const HEADQUARTERS = "hq-cat";

function makeInteraction(liveChannelIds: string[]) {
	const roles: Record<string, { id: string }> = { "admin-role": { id: "role-admin" }, "member-role": { id: "role-member" } };
	return {
		guildId: "guild-1",
		user: { id: OWNER },
		guild: { ownerId: OWNER, channels: { fetch: vi.fn(async (id: string) => (liveChannelIds.includes(id) ? { id } : null)) } },
		options: { getRole: (name: string) => roles[name] },
	} as unknown as ChatInputCommandInteraction;
}

const sentTitles = () => mocks.send.mock.calls.map((call) => (call[0] as { embeds: Array<{ data: { title?: string; description?: string } }> }).embeds[0]!.data);

beforeEach(() => {
	vi.clearAllMocks();
	mocks.findByGuildId
		.mockResolvedValueOnce({ guildId: "guild-1", homebaseDestroyed: true, setupComplete: false })
		.mockResolvedValueOnce({ guildId: "guild-1", categoryId: null, headquartersCategoryId: HEADQUARTERS });
});

describe("/setup rebuilding a self destructed server", () => {
	it("proves a Headquarters only rebuild by its Headquarters category, grants the roles and clears the flag", async () => {
		await execute(makeInteraction([HEADQUARTERS]));

		expect(mocks.autoSetup).toHaveBeenCalledWith(expect.anything(), { guildId: "guild-1", ownerId: OWNER }, { force: true });
		expect(mocks.applyAdminRole).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ adminRoleId: "role-admin", memberRoleId: "role-member" }));
		expect(mocks.update).toHaveBeenCalledWith("guild-1", { homebaseDestroyed: false });
		expect(sentTitles()[0]!.description).not.toBe(rokCommanderCopy.responses.setupFailed);
	});

	it("still refuses when the rebuilt category is not there, leaving the flag for a retry", async () => {
		await execute(makeInteraction([]));

		expect(mocks.applyAdminRole).not.toHaveBeenCalled();
		expect(mocks.update).not.toHaveBeenCalled();
	});
});
