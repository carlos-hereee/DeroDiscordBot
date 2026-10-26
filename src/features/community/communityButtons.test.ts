import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync } from "node:fs";
import { ButtonStyle, GuildExplicitContentFilter, GuildVerificationLevel, TextChannel, type ButtonInteraction, type Client, type Guild, type ModalBuilder } from "discord.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";

// ── communityButtons (2026-10 item 247 Phase 3) ─────────────────────────────
// The admin guide's community row, where it sits on the guide, and the router
// every `community:<action>` press goes through: a stale customId, a guild with no
// config, and a clicker who is neither the owner nor an admin are all refused
// before any flow runs, and Configure Onboarding reaches its real flow (Phase 4
// deleted the stub that stood in for it). A refusal is a notice modal, not a
// message left to dismiss (post-launch plan item 9), and the row shows one button,
// the one the server's Community state calls for (item 8).

const mocks = vi.hoisted(() => ({
	findByGuildId: vi.fn(),
	log: vi.fn(),
	registerButton: vi.fn(),
	registerSelectMenu: vi.fn(),
}));

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findByGuildId } }));
vi.mock("@db/stores/botLogStore.js", () => ({ botLogStore: { log: mocks.log, has: vi.fn(async () => false) } }));
vi.mock("@handlers/interactionRegistry.js", () => ({ registerButton: mocks.registerButton, registerSelectMenu: mocks.registerSelectMenu, registerModal: vi.fn() }));

import { buildCommunityControlButtons, handleCommunityButton, registerCommunityGuideSync, registerCommunityHandlers, syncCommunityGuideRow } from "./communityButtons.js";
import { COMMUNITY_CUSTOM_IDS, COMMUNITY_SELECT_ACTIONS, type CommunityAction } from "./communityControls.js";
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
		deferred: false,
		replied: false,
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

type ModalJson = { custom_id: string; components: Array<{ content?: string }> };
const modalsOf = (interaction: { showModal: ReturnType<typeof vi.fn> }): ModalJson[] =>
	interaction.showModal.mock.calls.map((call) => (call[0] as ModalBuilder).toJSON() as unknown as ModalJson);
// The notice modal's text: every refusal and stale control answers with one.
const noticeText = (interaction: { showModal: ReturnType<typeof vi.fn> }): string | undefined =>
	modalsOf(interaction)
		.find((modal) => modal.custom_id.startsWith("notice:"))
		?.components.map((component) => component.content)
		.join("\n");
// The flow's own modals (Enable Community's picks), never a notice.
const flowModals = (interaction: { showModal: ReturnType<typeof vi.fn> }): ModalJson[] =>
	modalsOf(interaction).filter((modal) => !modal.custom_id.startsWith("notice:"));

beforeEach(() => {
	vi.clearAllMocks();
	mocks.findByGuildId.mockResolvedValue({ guildId: "g1", adminRoleId: "role-admin", customRulesMarkdown: null });
	mocks.log.mockResolvedValue(undefined);
});

type RowJson = { components: Array<{ custom_id: string; label: string; style: ButtonStyle }> };

describe("buildCommunityControlButtons", () => {
	it("shows Enable Community alone while Community is off", () => {
		const row = buildCommunityControlButtons(false).toJSON() as RowJson;
		expect(row.components.map((button) => button.custom_id)).toEqual([COMMUNITY_CUSTOM_IDS.enable]);
		expect(row.components.map((button) => button.label)).toEqual([communityCopy.buttons.enable]);
		expect(row.components.map((button) => button.style)).toEqual([ButtonStyle.Primary]);
	});

	it("shows Configure Onboarding alone once Community is on", () => {
		const row = buildCommunityControlButtons(true).toJSON() as RowJson;
		expect(row.components.map((button) => button.custom_id)).toEqual([COMMUNITY_CUSTOM_IDS.configure]);
		expect(row.components.map((button) => button.label)).toEqual([communityCopy.buttons.configure]);
	});

	it("sits on the admin guide above the control row, inside Discord's five rows, showing the button the guild's state calls for", () => {
		const internals = GuildSetupManager as unknown as {
			resolveIntroComponents(field: string, config?: null, guild?: { features: string[] }): Array<{ toJSON(): { components: Array<{ custom_id?: string }> } }> | null;
		};
		const rowsFor = (guild?: { features: string[] }) =>
			(internals.resolveIntroComponents("adminCommandsChannelId", null, guild) ?? []).map((row) => row.toJSON().components.map((component) => component.custom_id));
		const off = rowsFor({ features: [] });
		expect(off.at(-2)).toEqual([COMMUNITY_CUSTOM_IDS.enable]);
		expect(off.at(-1)?.[0]).toBe((buildSelfDestructButton().toJSON() as { custom_id: string }).custom_id);
		expect(off.length).toBeLessThanOrEqual(5);
		expect(rowsFor({ features: ["COMMUNITY"] }).at(-2)).toEqual([COMMUNITY_CUSTOM_IDS.configure]);
		// A first build has no live guild to read, and reads as Community off.
		expect(rowsFor().at(-2)).toEqual([COMMUNITY_CUSTOM_IDS.enable]);
	});
});

describe("the community router", () => {
	it("refuses a member who is neither the owner nor an admin, for every action, and runs nothing", async () => {
		for (const [action, customId] of Object.entries(COMMUNITY_CUSTOM_IDS) as Array<[CommunityAction, string]>) {
			const guild = makeGuild();
			// The review's two selects arrive as select presses, which carry their values.
			const interaction = COMMUNITY_SELECT_ACTIONS.has(action) ? Object.assign(press(MEMBER, customId, guild), { values: ["0"] }) : press(MEMBER, customId, guild);
			await handleCommunityButton(interaction);
			expect(flowModals(interaction), customId).toEqual([]);
			expect(interaction.deferReply, customId).not.toHaveBeenCalled();
			expect(guild.edit, customId).not.toHaveBeenCalled();
			expect(interaction.reply, customId).not.toHaveBeenCalled();
			expect(noticeText(interaction)).toBe(rokCommanderCopy.responses.noWizardPowers);
		}
	});

	it("lets an admin through to the flow", async () => {
		const interaction = press(ADMIN, COMMUNITY_CUSTOM_IDS.enable);
		await handleCommunityButton(interaction);
		expect(interaction.showModal).toHaveBeenCalledOnce();
	});

	it("routes Configure Onboarding to the real flow, whose first precondition answers a server without Community", async () => {
		const interaction = press(OWNER, COMMUNITY_CUSTOM_IDS.configure);
		await handleCommunityButton(interaction);
		expect(noticeText(interaction)).toBe(communityCopy.onboarding.preconditions.communityOff);
	});

	it("has no Configure Onboarding stub left beside the real flow", () => {
		expect(existsSync(new URL("./onboardingDraftStub.ts", import.meta.url))).toBe(false);
	});

	it("answers an argument on an action that takes none as retired", async () => {
		const interaction = press(OWNER, `${COMMUNITY_CUSTOM_IDS.enable}:extra`);
		await handleCommunityButton(interaction);
		expect(flowModals(interaction)).toEqual([]);
		expect(noticeText(interaction)).toBe(communityCopy.errors.controlRetired);
	});

	it("answers a stale customId as retired, before reading anything", async () => {
		const interaction = press(OWNER, "community:somethingold");
		await handleCommunityButton(interaction);
		expect(mocks.findByGuildId).not.toHaveBeenCalled();
		expect(noticeText(interaction)).toBe(communityCopy.errors.controlRetired);
	});

	it("refuses a press outside a server, and in a server with no config", async () => {
		const outside = press(OWNER, COMMUNITY_CUSTOM_IDS.enable, null);
		await handleCommunityButton(outside);
		expect(noticeText(outside)).toBe(communityCopy.errors.notInServer);

		mocks.findByGuildId.mockResolvedValueOnce(null);
		const unconfigured = press(OWNER, COMMUNITY_CUSTOM_IDS.enable);
		await handleCommunityButton(unconfigured);
		expect(flowModals(unconfigured)).toEqual([]);
		expect(noticeText(unconfigured)).toBe(communityCopy.errors.notSetUp);
	});
});

// ── keeping the guide's row on the live state (post-launch plan item 8) ──

describe("syncCommunityGuideRow", () => {
	function guideRig(rowIds: string[][], features: string[] = []) {
		const rows = rowIds.map((ids) => ({ toJSON: () => ({ type: 1, components: ids.map((id) => ({ type: 2, style: 1, label: id, custom_id: id })) }) }));
		const guide = { components: rows, edit: vi.fn(async () => undefined) };
		const channel = Object.assign(Object.create(TextChannel.prototype) as TextChannel, { messages: { fetch: vi.fn(async () => guide) } });
		const guild = { id: "g1", features, client: { channels: { fetch: vi.fn(async () => channel) } } } as unknown as Guild;
		mocks.findByGuildId.mockResolvedValue({ guildId: "g1", adminCommandsChannelId: "ch-guide", introMessageIds: { adminCommandsChannelId: "guide-msg" } });
		return { guide, guild };
	}
	const editedIds = (guide: { edit: ReturnType<typeof vi.fn> }): string[][] =>
		(guide.edit.mock.calls[0]![0] as { components: Array<{ components: Array<{ custom_id?: string }> }> }).components.map((row) =>
			row.components.map((component) => component.custom_id ?? "")
		);

	it("swaps Enable Community for Configure Onboarding once Community is on, and leaves every other row as it was", async () => {
		const { guide, guild } = guideRig([["admin_cmd:events"], [COMMUNITY_CUSTOM_IDS.enable], ["self_destruct:prompt"]], ["COMMUNITY"]);
		await expect(syncCommunityGuideRow(guild)).resolves.toBe(true);
		expect(editedIds(guide)).toEqual([["admin_cmd:events"], [COMMUNITY_CUSTOM_IDS.configure], ["self_destruct:prompt"]]);
	});

	it("swaps back to Enable Community when Community is switched off", async () => {
		const { guide, guild } = guideRig([[COMMUNITY_CUSTOM_IDS.configure], ["self_destruct:prompt"]]);
		await syncCommunityGuideRow(guild);
		expect(editedIds(guide)).toEqual([[COMMUNITY_CUSTOM_IDS.enable], ["self_destruct:prompt"]]);
	});

	it("edits nothing when the guide already shows the right button, or carries no community row", async () => {
		const right = guideRig([[COMMUNITY_CUSTOM_IDS.enable]]);
		await expect(syncCommunityGuideRow(right.guild)).resolves.toBe(false);
		expect(right.guide.edit).not.toHaveBeenCalled();
		const none = guideRig([["self_destruct:prompt"]], ["COMMUNITY"]);
		await expect(syncCommunityGuideRow(none.guild)).resolves.toBe(false);
		expect(none.guide.edit).not.toHaveBeenCalled();
	});

	it("never throws when the edit is refused", async () => {
		const { guide, guild } = guideRig([[COMMUNITY_CUSTOM_IDS.enable]], ["COMMUNITY"]);
		guide.edit.mockRejectedValueOnce(new Error("Missing Access"));
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		await expect(syncCommunityGuideRow(guild)).resolves.toBe(false);
	});

	it("listens to GuildUpdate and syncs only when the Community feature changed", async () => {
		const on = vi.fn();
		registerCommunityGuideSync({ on } as unknown as Client);
		const listener = on.mock.calls[0]![1] as (before: { features: string[] }, after: { id: string; features: string[]; client: unknown }) => void;
		mocks.findByGuildId.mockClear();
		listener({ features: [] }, { id: "g1", features: ["NEWS"], client: {} });
		expect(mocks.findByGuildId).not.toHaveBeenCalled();
		listener({ features: [] }, { id: "g1", features: ["COMMUNITY"], client: { channels: { fetch: vi.fn(async () => null) } } });
		expect(mocks.findByGuildId).toHaveBeenCalledWith("g1");
	});
});

describe("registerCommunityHandlers", () => {
	it("routes on the bare prefix the registry slices customIds to", () => {
		registerCommunityHandlers();
		expect(mocks.registerButton).toHaveBeenCalledWith("community", handleCommunityButton);
		expect(mocks.registerSelectMenu).toHaveBeenCalledWith("community", handleCommunityButton);
	});
});
