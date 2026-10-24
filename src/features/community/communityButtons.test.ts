import { describe, it, expect, vi, beforeEach } from "vitest";
import { ButtonStyle, GuildExplicitContentFilter, GuildVerificationLevel, MessageFlags, type ButtonInteraction } from "discord.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";

// ── communityButtons (2026-10 item 247 Phase 3) ─────────────────────────────
// The admin guide's community row, where it sits on the guide, and the router
// every `community:<action>` press goes through: a stale customId, a guild with no
// config, and a clicker who is neither the owner nor an admin are all refused
// before any flow runs, and Configure Onboarding answers its honest stub line.

const mocks = vi.hoisted(() => ({
	findByGuildId: vi.fn(),
	log: vi.fn(),
	registerButton: vi.fn(),
}));

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findByGuildId } }));
vi.mock("@db/stores/botLogStore.js", () => ({ botLogStore: { log: mocks.log, has: vi.fn(async () => false) } }));
vi.mock("@handlers/interactionRegistry.js", () => ({ registerButton: mocks.registerButton }));

import { buildCommunityControlButtons, handleCommunityButton, registerCommunityHandlers } from "./communityButtons.js";
import { COMMUNITY_CUSTOM_IDS } from "./communityControls.js";
import { communityCopy } from "./communityCopy.js";
import { GuildSetupManager } from "@features/setup/GuildSetupManager.js";
import { buildSelfDestructButton } from "@features/setup/selfDestruct.js";

const OWNER = "owner-1";
const ADMIN = "admin-1";
const MEMBER = "member-1";

function makeGuild() {
	return {
		id: "g1",
		ownerId: OWNER,
		features: [] as string[],
		verificationLevel: GuildVerificationLevel.None,
		explicitContentFilter: GuildExplicitContentFilter.Disabled,
		members: {
			me: { permissions: { has: () => true } },
			cache: new Map([[ADMIN, { roles: { cache: new Set(["role-admin"]) } }]]),
			fetch: vi.fn(async () => null),
		},
		channels: { cache: new Map() },
		edit: vi.fn(async () => undefined),
		client: { rest: { patch: vi.fn(async () => ({})) } },
	};
}

function press(userId: string, customId: string, guild: ReturnType<typeof makeGuild> | null = makeGuild()) {
	return {
		id: "int-1",
		customId,
		guild,
		user: { id: userId },
		showModal: vi.fn(async () => undefined),
		awaitModalSubmit: vi.fn(async () => {
			throw new Error("Collector received no interactions before ending with reason: time");
		}),
		reply: vi.fn(async () => undefined),
		deferReply: vi.fn(async () => undefined),
		editReply: vi.fn(async () => undefined),
	} as unknown as ButtonInteraction & {
		showModal: ReturnType<typeof vi.fn>;
		reply: ReturnType<typeof vi.fn>;
		deferReply: ReturnType<typeof vi.fn>;
	};
}

const replyDescription = (interaction: { reply: ReturnType<typeof vi.fn> }): string | undefined =>
	(interaction.reply.mock.calls[0]![0] as { embeds?: Array<{ data: { description?: string } }> }).embeds?.[0]?.data.description;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.findByGuildId.mockResolvedValue({ guildId: "g1", adminRoleId: "role-admin", customRulesMarkdown: null });
	mocks.log.mockResolvedValue(undefined);
});

describe("buildCommunityControlButtons", () => {
	it("returns one row: Enable Community (Primary), then Configure Onboarding (Secondary)", () => {
		const row = buildCommunityControlButtons().toJSON() as { components: Array<{ custom_id: string; label: string; style: ButtonStyle }> };
		expect(row.components.map((button) => button.custom_id)).toEqual(["community:enable", "community:configure"]);
		expect(row.components.map((button) => button.label)).toEqual([communityCopy.buttons.enable, communityCopy.buttons.configure]);
		expect(row.components.map((button) => button.style)).toEqual([ButtonStyle.Primary, ButtonStyle.Secondary]);
	});

	it("sits on the admin guide above the control row, inside Discord's five rows", () => {
		const internals = GuildSetupManager as unknown as {
			resolveIntroComponents(field: string): Array<{ toJSON(): { components: Array<{ custom_id?: string }> } }> | null;
		};
		const rows = (internals.resolveIntroComponents("adminCommandsChannelId") ?? []).map((row) => row.toJSON().components.map((component) => component.custom_id));
		expect(rows.at(-2)).toEqual([COMMUNITY_CUSTOM_IDS.enable, COMMUNITY_CUSTOM_IDS.configure]);
		expect(rows.at(-1)?.[0]).toBe((buildSelfDestructButton().toJSON() as { custom_id: string }).custom_id);
		expect(rows.length).toBeLessThanOrEqual(5);
	});
});

describe("the community router", () => {
	it("refuses a member who is neither the owner nor an admin, for every action, and runs nothing", async () => {
		for (const customId of Object.values(COMMUNITY_CUSTOM_IDS)) {
			const guild = makeGuild();
			const interaction = press(MEMBER, customId, guild);
			await handleCommunityButton(interaction);
			expect(interaction.showModal, customId).not.toHaveBeenCalled();
			expect(interaction.deferReply, customId).not.toHaveBeenCalled();
			expect(guild.edit, customId).not.toHaveBeenCalled();
			expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral }));
			expect(replyDescription(interaction)).toBe(rokCommanderCopy.responses.noWizardPowers);
		}
	});

	it("lets an admin through to the flow", async () => {
		const interaction = press(ADMIN, COMMUNITY_CUSTOM_IDS.enable);
		await handleCommunityButton(interaction);
		expect(interaction.showModal).toHaveBeenCalledOnce();
	});

	it("answers Configure Onboarding with the next release line, privately, and no error", async () => {
		const interaction = press(OWNER, COMMUNITY_CUSTOM_IDS.configure);
		await handleCommunityButton(interaction);
		expect(interaction.reply).toHaveBeenCalledWith({ content: communityCopy.configureComingSoon, flags: MessageFlags.Ephemeral });
	});

	it("answers a stale customId as retired, before reading anything", async () => {
		const interaction = press(OWNER, "community:somethingold");
		await handleCommunityButton(interaction);
		expect(mocks.findByGuildId).not.toHaveBeenCalled();
		expect(interaction.reply).toHaveBeenCalledWith({ content: communityCopy.errors.controlRetired, flags: MessageFlags.Ephemeral });
	});

	it("refuses a press outside a server, and in a server with no config", async () => {
		const outside = press(OWNER, COMMUNITY_CUSTOM_IDS.enable, null);
		await handleCommunityButton(outside);
		expect(replyDescription(outside)).toBe(communityCopy.errors.notInServer);

		mocks.findByGuildId.mockResolvedValueOnce(null);
		const unconfigured = press(OWNER, COMMUNITY_CUSTOM_IDS.enable);
		await handleCommunityButton(unconfigured);
		expect(unconfigured.showModal).not.toHaveBeenCalled();
		expect(replyDescription(unconfigured)).toBe(communityCopy.errors.notSetUp);
	});
});

describe("registerCommunityHandlers", () => {
	it("routes on the bare prefix the registry slices customIds to", () => {
		registerCommunityHandlers();
		expect(mocks.registerButton).toHaveBeenCalledWith("community", handleCommunityButton);
	});
});
