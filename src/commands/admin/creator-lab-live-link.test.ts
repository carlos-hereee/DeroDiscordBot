import { describe, it, expect, vi, beforeEach } from "vitest";
import { PermissionFlagsBits, type ChatInputCommandInteraction } from "discord.js";

// ── /creator-lab-live-link (Creator Lab live capture, 2026-11 item 284 Phase 3) ──
// Hidden from members without Manage Server AND re-checked at run time, dark behind its flag, and the
// code it issues is bound to the guild and channel it ran in and shown only privately.

const state = vi.hoisted(() => ({ liveEnabled: true }));

vi.mock("@utils/config.js", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return {
		...actual,
		get creatorLabLiveEnabled() {
			return state.liveEnabled;
		},
	};
});
vi.mock("@db/stores/creatorLabChannelCodeStore.js", () => ({
	creatorLabChannelCodeStore: { issue: vi.fn(), redeem: vi.fn() },
	CREATOR_LAB_CHANNEL_CODE_TTL_MS: 900_000,
}));
vi.mock("@utils/textModal.js", () => ({ showNotice: vi.fn() }));

import { execute, data } from "./creator-lab-live-link.js";
import { creatorLabChannelCodeStore } from "@db/stores/creatorLabChannelCodeStore.js";
import { showNotice } from "@utils/textModal.js";

const issueMock = creatorLabChannelCodeStore.issue as unknown as ReturnType<typeof vi.fn>;

const makeInteraction = ({ canManage = true, inGuild = true } = {}) => {
	const interaction = {
		guildId: "700000000000000001",
		channelId: "700000000000000002",
		guild: { name: "Harbor Discord" },
		channel: { name: "stream-chat" },
		user: { id: "800000000000000001" },
		inGuild: () => inGuild,
		memberPermissions: { has: vi.fn((flag: bigint) => canManage && flag === PermissionFlagsBits.ManageGuild) },
		deferReply: vi.fn(async () => undefined),
		editReply: vi.fn(async () => undefined),
	};
	return interaction as typeof interaction & ChatInputCommandInteraction;
};

describe("/creator-lab-live-link", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		state.liveEnabled = true;
	});

	it("is hidden from members who cannot manage the server", () => {
		const json = data.toJSON();
		expect(json.name).toBe("creator-lab-live-link");
		expect(json.default_member_permissions).toBe(PermissionFlagsBits.ManageGuild.toString());
	});

	it("is dark while the flag is off", async () => {
		state.liveEnabled = false;
		const interaction = makeInteraction();
		await execute(interaction);
		expect(showNotice).toHaveBeenCalledTimes(1);
		expect(issueMock).not.toHaveBeenCalled();
	});

	it("re-checks Manage Server at run time and issues nothing without it", async () => {
		const interaction = makeInteraction({ canManage: false });
		await execute(interaction);
		expect(showNotice).toHaveBeenCalledTimes(1);
		expect(issueMock).not.toHaveBeenCalled();
		expect(interaction.deferReply).not.toHaveBeenCalled();
	});

	it("issues a code for this guild and channel and shows it only privately", async () => {
		issueMock.mockResolvedValue("ABC234");
		const interaction = makeInteraction();
		await execute(interaction);
		expect(interaction.deferReply).toHaveBeenCalledWith({ flags: 64 });
		expect(issueMock).toHaveBeenCalledWith({
			guildId: "700000000000000001",
			channelId: "700000000000000002",
			guildName: "Harbor Discord",
			channelName: "stream-chat",
			discordUserId: "800000000000000001",
		});
		const reply = interaction.editReply.mock.calls[0]?.[0] as unknown as { embeds: Array<{ data: { description?: string } }> };
		expect(reply.embeds[0]?.data.description).toContain("ABC234");
		expect(reply.embeds[0]?.data.description).toContain("15 minutes");
	});
});
