import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ButtonInteraction } from "discord.js";

// ── the notice board tutorial's buttons (2026-11 item 285 Phase 3) ──
// Each tutorial card's `hqstep:onboarding:tutorial-<key>` reaches handleAddChannel with its
// key, and nothing else on 🧭onboarding is routed here.

const mocks = vi.hoisted(() => ({
	handleAddChannel: vi.fn(),
	openAdminLaunch: vi.fn(),
	buttons: new Map<string, (interaction: ButtonInteraction) => Promise<void>>(),
}));

vi.mock("./tutorialCards.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./tutorialCards.js")>()),
	handleAddChannel: mocks.handleAddChannel,
}));
vi.mock("@features/command-buttons/adminCommandLauncher.js", () => ({ openAdminLaunch: mocks.openAdminLaunch, openAdminLeaf: vi.fn() }));
vi.mock("@handlers/interactionRegistry.js", () => ({
	registerButton: (prefix: string, handler: (interaction: ButtonInteraction) => Promise<void>) => mocks.buttons.set(prefix, handler),
	registerModal: vi.fn(),
}));

import { registerHeadquartersStepHandlers, stepTarget } from "./headquartersSteps.js";
import { TUTORIAL_CHANNELS, tutorialCustomId, type TutorialChannelKey } from "./tutorialCards.js";

const KEYS = Object.keys(TUTORIAL_CHANNELS) as TutorialChannelKey[];

beforeEach(() => {
	vi.clearAllMocks();
	mocks.handleAddChannel.mockResolvedValue(undefined);
});

describe("stepTarget for the tutorial cards", () => {
	it.each(KEYS)("routes %s's card to the tutorial", (key) => {
		expect(stepTarget(tutorialCustomId(key))).toEqual({ kind: "tutorial", key });
	});

	it("routes nothing else on 🧭onboarding, and no tutorial tail on another domain", () => {
		expect(stepTarget("hqstep:onboarding:1")).toBeNull();
		expect(stepTarget("hqstep:onboarding:tutorial-arcade")).toBeNull();
		expect(stepTarget("hqstep:onboarding:tutorial-toString")).toBeNull();
		expect(stepTarget("hqstep:arcadeControl:tutorial-intro")).toBeNull();
	});
});

// 2026-11 item 289: both tails read before the onboarding branch, which answers null to any
// tail but a tutorial's, and before the number lookup.
describe("stepTarget for Skip, Continue and Remove", () => {
	it("routes a skip tail on every domain, the onboarding domain among them", () => {
		expect(stepTarget("hqstep:onboarding:skip-intro")).toEqual({ kind: "skip", stepId: "onboarding:intro" });
		expect(stepTarget("hqstep:onboarding:skip-gating")).toEqual({ kind: "skip", stepId: "onboarding:gating" });
		expect(stepTarget("hqstep:deroConfig:skip-priority")).toEqual({ kind: "skip", stepId: "deroConfig:priority" });
		expect(stepTarget("hqstep:arcadeControl:skip-enable")).toEqual({ kind: "skip", stepId: "arcadeControl:enable" });
		expect(stepTarget("hqstep:serverConfig:skip-timezone")).toEqual({ kind: "skip", stepId: "serverConfig:timezone" });
	});

	it.each(KEYS)("routes %s's Remove", (key) => {
		expect(stepTarget(`hqstep:onboarding:remove-${key}`)).toEqual({ kind: "remove", key });
	});

	it("refuses an unknown key, a channel key off 🧭onboarding, and a Remove on any other domain", () => {
		expect(stepTarget("hqstep:onboarding:skip-nope")).toBeNull();
		expect(stepTarget("hqstep:serverConfig:skip-intro")).toBeNull();
		expect(stepTarget("hqstep:onboarding:skip-toString")).toBeNull();
		expect(stepTarget("hqstep:onboarding:remove-nope")).toBeNull();
		expect(stepTarget("hqstep:onboarding:remove-toString")).toBeNull();
		expect(stepTarget("hqstep:serverConfig:remove-intro")).toBeNull();
	});
});

describe("a tutorial card's press", () => {
	it("goes to handleAddChannel with the card's key and opens no other flow", async () => {
		registerHeadquartersStepHandlers();
		const press = { customId: tutorialCustomId("welcome") } as unknown as ButtonInteraction;

		await mocks.buttons.get("hqstep")!(press);

		expect(mocks.handleAddChannel).toHaveBeenCalledWith(press, "welcome");
		expect(mocks.openAdminLaunch).not.toHaveBeenCalled();
	});
});
