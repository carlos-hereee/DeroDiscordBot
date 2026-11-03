import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ButtonInteraction } from "discord.js";

// ── the Phase 4 routes (2026-11 item 285) ──
// `hqstep:arcadeControl:dismantle` and `:enableStub` reach arcadeControlCards, and
// 🛠️server-config's 8th step reaches renameInfoStep. The numbered arcade steps still open
// the flows they always did.

const mocks = vi.hoisted(() => ({
	handleDismantle: vi.fn(),
	handleRenameInfo: vi.fn(),
	openAdminLaunch: vi.fn(),
	openAdminLeaf: vi.fn(),
	buttons: new Map<string, (interaction: ButtonInteraction) => Promise<void>>(),
}));

vi.mock("./arcadeControlCards.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./arcadeControlCards.js")>()),
	handleDismantle: mocks.handleDismantle,
}));
vi.mock("./renameInfoStep.js", () => ({ handleOpen: mocks.handleRenameInfo }));
vi.mock("@features/command-buttons/adminCommandLauncher.js", () => ({ openAdminLaunch: mocks.openAdminLaunch, openAdminLeaf: mocks.openAdminLeaf }));
vi.mock("@handlers/interactionRegistry.js", () => ({
	registerButton: (prefix: string, handler: (interaction: ButtonInteraction) => Promise<void>) => mocks.buttons.set(prefix, handler),
	registerModal: vi.fn(),
}));

import { registerHeadquartersStepHandlers, stepTarget } from "./headquartersSteps.js";
import { SERVER_CONFIG_STEPS, stepCustomId } from "./headquartersCards.js";

const press = (customId: string): ButtonInteraction => ({ customId }) as unknown as ButtonInteraction;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.buttons.clear();
	registerHeadquartersStepHandlers();
});

describe("stepTarget for the arcade control buttons", () => {
	it("routes Dismantle, and the retired Enable stub to the enable step (2026-11 item 285 debug pass)", () => {
		expect(stepTarget("hqstep:arcadeControl:dismantle")).toEqual({ kind: "arcadeControl", action: "dismantle" });
		expect(stepTarget("hqstep:arcadeControl:enableStub")).toEqual(stepTarget("hqstep:arcadeControl:1"));
	});

	it("leaves the four numbered steps and every other word where they were", () => {
		expect(stepTarget("hqstep:arcadeControl:1")).toEqual({ kind: "leaf", command: "arcade", path: "on" });
		expect(stepTarget("hqstep:arcadeControl:5")).toBeNull();
		expect(stepTarget("hqstep:arcadeControl:toString")).toBeNull();
		expect(stepTarget("hqstep:serverConfig:dismantle")).toBeNull();
		expect(stepTarget("hqstep:deroConfig:enableStub")).toBeNull();
	});
});

describe("stepTarget for 🛠️server-config's rename step", () => {
	it("routes the 8th step, whose customId follows its position, to the explainer", () => {
		expect(SERVER_CONFIG_STEPS.at(-1)).toBe("rename");
		expect(stepTarget(stepCustomId("serverConfig", SERVER_CONFIG_STEPS.length))).toEqual({ kind: "renameInfo" });
		expect(stepTarget("hqstep:serverConfig:8")).toEqual({ kind: "renameInfo" });
		expect(stepTarget("hqstep:serverConfig:9")).toBeNull();
	});
});

describe("a press", () => {
	it("on Dismantle Arcade goes to handleDismantle alone", async () => {
		const interaction = press("hqstep:arcadeControl:dismantle");

		await mocks.buttons.get("hqstep")!(interaction);

		expect(mocks.handleDismantle).toHaveBeenCalledWith(interaction);
		expect(mocks.openAdminLeaf).not.toHaveBeenCalled();
	});

	it("on an older card's Enable Arcade opens the enable step, /arcade on, and never Dismantle", async () => {
		const interaction = press("hqstep:arcadeControl:enableStub");

		await mocks.buttons.get("hqstep")!(interaction);

		expect(mocks.openAdminLeaf).toHaveBeenCalledOnce();
		expect(mocks.openAdminLeaf.mock.calls[0]).toEqual(expect.arrayContaining(["arcade", "on"]));
		expect(mocks.handleDismantle).not.toHaveBeenCalled();
	});

	it("on the rename step goes to the explainer and opens no command", async () => {
		const interaction = press("hqstep:serverConfig:8");

		await mocks.buttons.get("hqstep")!(interaction);

		expect(mocks.handleRenameInfo).toHaveBeenCalledWith(interaction);
		expect(mocks.openAdminLaunch).not.toHaveBeenCalled();
		expect(mocks.openAdminLeaf).not.toHaveBeenCalled();
	});
});
