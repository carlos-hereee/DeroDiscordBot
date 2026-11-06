import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync } from "node:fs";
import { GuildExplicitContentFilter, GuildVerificationLevel, type ButtonInteraction, type Client, type ModalBuilder } from "discord.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";

// ── communityButtons (2026-10 item 247 Phase 3) ─────────────────────────────
// The router every `community:<action>` press goes through, and the listener that
// redraws 🧭onboarding when Community changes (2026-10 item 263 Phase 4a, R3-14: the
// admin guide's community row retired with 🎛️admin-controls). The router refuses a stale customId, a guild with no
// config, and a clicker who is neither the owner nor an admin are all refused
// before any flow runs, and Configure Onboarding reaches its real flow (Phase 4
// deleted the stub that stood in for it). A refusal is a notice modal, not a
// message left to dismiss (post-launch plan item 9).

const mocks = vi.hoisted(() => ({
	findByGuildId: vi.fn(),
	log: vi.fn(),
	registerButton: vi.fn(),
	registerSelectMenu: vi.fn(),
	refresh: vi.fn(),
}));

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findByGuildId } }));
vi.mock("@db/stores/botLogStore.js", () => ({ botLogStore: { log: mocks.log, has: vi.fn(async () => false) } }));
vi.mock("@handlers/interactionRegistry.js", () => ({ registerButton: mocks.registerButton, registerSelectMenu: mocks.registerSelectMenu, registerModal: vi.fn() }));
vi.mock("@features/setup/headquartersCards.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("@features/setup/headquartersCards.js")>()),
	refreshHeadquartersCards: mocks.refresh,
}));

import { handleCommunityButton, registerCommunityHandlers, registerCommunityStateSync } from "./communityButtons.js";
import { COMMUNITY_CUSTOM_IDS, COMMUNITY_SELECT_ACTIONS, type CommunityAction } from "./communityControls.js";
import { communityCopy } from "./communityCopy.js";
import { GuildSetupManager } from "@features/setup/GuildSetupManager.js";
import { onboardingView } from "@features/setup/headquartersCards.js";

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

// The two Community flows open from 🧭onboarding's Community and Discord Onboarding steps
// alone (R3-14): no managed channel's intro carries a community row any more.
describe("where the Community buttons live", () => {
	it("are 🧭onboarding's Community and Discord Onboarding steps, on the flows' own customIds", () => {
		const view = onboardingView({ communityOn: false, onboardingOn: false, gated: false, memberRoleName: null, adoptedPlaced: true, adoptedLines: [] }, {});
		const customIdOf = (key: string) => view.steps.find((step) => step.key === key)?.customId;
		expect(customIdOf("community")).toBe(COMMUNITY_CUSTOM_IDS.enable);
		expect(customIdOf("discordOnboarding")).toBe(COMMUNITY_CUSTOM_IDS.configure);
	});

	it("are on no channel's intro", () => {
		const internals = GuildSetupManager as unknown as {
			resolveIntroComponents(field: string): Array<{ toJSON(): { components: Array<{ custom_id?: string }> } }> | null;
		};
		for (const field of GuildSetupManager.CHANNEL_FIELDS) {
			const ids = (internals.resolveIntroComponents(field) ?? []).flatMap((row) => row.toJSON().components.map((component) => component.custom_id ?? ""));
			expect(ids.filter((id) => id.startsWith("community:")), field).toEqual([]);
		}
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

// ── 🧭onboarding follows a Community switch (2026-10 item 263 Phase 4a, R3-14) ──

describe("registerCommunityStateSync", () => {
	it("redraws 🧭onboarding when the Community feature changes, and only then", () => {
		const on = vi.fn();
		registerCommunityStateSync({ on } as unknown as Client);
		expect(on.mock.calls[0]?.[0]).toBe("guildUpdate");
		const listener = on.mock.calls[0]![1] as (before: { features: string[] }, after: { id: string; features: string[] }) => void;
		listener({ features: [] }, { id: "g1", features: ["NEWS"] });
		expect(mocks.refresh).not.toHaveBeenCalled();
		const after = { id: "g1", features: ["COMMUNITY"] };
		listener({ features: [] }, after);
		expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith(after, "onboarding");
		listener({ features: ["COMMUNITY"] }, { id: "g1", features: [] });
		expect(mocks.refresh).toHaveBeenCalledTimes(2);
	});
});

describe("registerCommunityHandlers", () => {
	it("routes on the bare prefix the registry slices customIds to", () => {
		registerCommunityHandlers();
		expect(mocks.registerButton).toHaveBeenCalledWith("community", handleCommunityButton);
		expect(mocks.registerSelectMenu).toHaveBeenCalledWith("community", handleCommunityButton);
	});
});
