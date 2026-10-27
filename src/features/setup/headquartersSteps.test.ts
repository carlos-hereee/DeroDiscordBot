import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ButtonInteraction, ModalSubmitInteraction } from "discord.js";

const mocks = vi.hoisted(() => ({
	openAdminLaunch: vi.fn(),
	openAdminLeaf: vi.fn(),
	gate: vi.fn(),
	upsert: vi.fn(),
	findVoice: vi.fn(),
	refresh: vi.fn(),
	emitFor: vi.fn(),
	showErrorNotice: vi.fn(),
	showModalOrReply: vi.fn(),
	buttons: new Map<string, (interaction: ButtonInteraction) => Promise<void>>(),
	modals: new Map<string, (interaction: ModalSubmitInteraction) => Promise<void>>(),
}));

vi.mock("@features/command-buttons/adminCommandLauncher.js", () => ({ openAdminLaunch: mocks.openAdminLaunch, openAdminLeaf: mocks.openAdminLeaf }));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn(async () => ({ guildId: "g1" })) } }));
vi.mock("@db/stores/deroVoiceConfigStore.js", () => ({ deroVoiceConfigStore: { findByGuildId: mocks.findVoice, upsert: mocks.upsert } }));
vi.mock("@utils/permissions.js", () => ({ gateOwnerOrAdmin: mocks.gate }));
vi.mock("@utils/textModal.js", () => ({ showErrorNotice: mocks.showErrorNotice, showModalOrReply: mocks.showModalOrReply }));
vi.mock("./adminLog.js", () => ({ adminLog: { emitFor: mocks.emitFor } }));
vi.mock("./headquartersCards.js", () => ({ HEADQUARTERS_STEP_PREFIX: "hqstep", refreshHeadquartersCards: mocks.refresh }));
vi.mock("@handlers/interactionRegistry.js", () => ({
	registerButton: (prefix: string, handler: (interaction: ButtonInteraction) => Promise<void>) => mocks.buttons.set(prefix, handler),
	registerModal: (prefix: string, handler: (interaction: ModalSubmitInteraction) => Promise<void>) => mocks.modals.set(prefix, handler),
}));

import { buildPriorityModal, orderFromPicks, registerHeadquartersStepHandlers, stepTarget } from "./headquartersSteps.js";
import { DEFAULT_VOICE_PRIORITY_ORDER } from "@features/voice/voicePriority.js";
import { voiceCopy } from "@features/voice/voiceCopy.js";
import { setupCopy } from "./setupCopy.js";

// ── the step buttons and the voice priority step (2026-10 item 257 Phase 2b) ──

registerHeadquartersStepHandlers();
const pressStep = mocks.buttons.get("hqstep")!;
const submitPriority = mocks.modals.get("hqsteppriority")!;

const press = (customId: string) => ({ customId, guild: { id: "g1" } }) as unknown as ButtonInteraction;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.gate.mockResolvedValue(true);
	mocks.findVoice.mockResolvedValue(null);
});

describe("the step to flow map", () => {
	it.each([
		["hqstep:deroConfig:1", { kind: "launch", launchId: "dero-config" }],
		["hqstep:deroConfig:4", { kind: "launch", launchId: "dero-config" }],
		["hqstep:deroConfig:5", { kind: "priority" }],
		["hqstep:arcadeControl:1", { kind: "leaf", command: "arcade", path: "on" }],
		["hqstep:arcadeControl:2", { kind: "launch", launchId: "arcade" }],
		["hqstep:arcadeControl:3", { kind: "launch", launchId: "arcade" }],
		["hqstep:arcadeControl:4", { kind: "leaf", command: "arcade", path: "reach" }],
		["hqstep:arcadeControl:5", { kind: "leaf", command: "arcade", path: "server block" }],
	])("%s opens its mapped flow", (customId, target) => {
		expect(stepTarget(customId)).toEqual(target);
	});

	it("knows no step past the card, and no onboarding step (those carry their flow's own customId)", () => {
		expect(stepTarget("hqstep:deroConfig:6")).toBeNull();
		expect(stepTarget("hqstep:onboarding:1")).toBeNull();
	});

	it("opens a panel through the launcher, a leaf through the launcher, and answers a stale step", async () => {
		await pressStep(press("hqstep:deroConfig:2"));
		expect(mocks.openAdminLaunch).toHaveBeenCalledWith(expect.anything(), "dero-config");
		await pressStep(press("hqstep:arcadeControl:5"));
		expect(mocks.openAdminLeaf).toHaveBeenCalledWith(expect.anything(), "arcade", "server block");
		await pressStep(press("hqstep:arcadeControl:9"));
		expect(mocks.showErrorNotice).toHaveBeenCalledWith(expect.anything(), setupCopy.headquarters.staleStep);
	});
});

describe("step 5, the voice priority order", () => {
	it("opens a modal of four selects preset to the stored order, for an admin", async () => {
		await pressStep(press("hqstep:deroConfig:5"));
		expect(mocks.showModalOrReply).toHaveBeenCalledOnce();
		const modal = buildPriorityModal([...DEFAULT_VOICE_PRIORITY_ORDER]).toJSON();
		expect(modal.title).toBe(voiceCopy.priority.modalTitle);
		expect(modal.components).toHaveLength(5);
	});

	it("refuses a member before any modal opens", async () => {
		mocks.gate.mockResolvedValue(false);
		await pressStep(press("hqstep:deroConfig:5"));
		expect(mocks.showModalOrReply).not.toHaveBeenCalled();
		expect(mocks.showErrorNotice).toHaveBeenCalledWith(expect.anything(), voiceCopy.priority.notAdmin);
	});

	it("builds the whole order from four picks, the fifth category last, and refuses a repeat", () => {
		expect(orderFromPicks(["arcade-lounge", "meeting-hall", "other", "rated-match"])).toEqual(["arcade-lounge", "meeting-hall", "other", "rated-match", "casual-match"]);
		expect(orderFromPicks(["arcade-lounge", "arcade-lounge", "other", "rated-match"])).toBeNull();
	});

	function submit(picks: string[]) {
		return {
			guild: { id: "g1" },
			fields: { getStringSelectValues: (id: string) => [picks[Number(id.split("-")[1])]] },
			reply: vi.fn(async () => undefined),
		} as unknown as ModalSubmitInteraction & { reply: ReturnType<typeof vi.fn> };
	}

	it("saves the order, logs it, answers, and redraws ⚙️dero-config's card", async () => {
		const interaction = submit(["arcade-lounge", "meeting-hall", "other", "rated-match"]);
		await submitPriority(interaction);
		expect(mocks.upsert).toHaveBeenCalledWith("g1", { priorityOrder: ["arcade-lounge", "meeting-hall", "other", "rated-match", "casual-match"] });
		expect(mocks.emitFor).toHaveBeenCalledWith(interaction, "g1", "config.change", expect.objectContaining({ subject: voiceCopy.priority.auditSubject }));
		expect(interaction.reply).toHaveBeenCalledOnce();
		expect(mocks.refresh).toHaveBeenCalledWith(interaction.guild, "deroConfig");
	});

	it("saves nothing when two places share a category, and re-checks the admin on Submit", async () => {
		await submitPriority(submit(["other", "other", "meeting-hall", "rated-match"]));
		expect(mocks.upsert).not.toHaveBeenCalled();
		expect(mocks.showErrorNotice).toHaveBeenCalledWith(expect.anything(), voiceCopy.priority.duplicate);

		mocks.gate.mockResolvedValue(false);
		await submitPriority(submit(["arcade-lounge", "meeting-hall", "other", "rated-match"]));
		expect(mocks.upsert).not.toHaveBeenCalled();
	});
});
