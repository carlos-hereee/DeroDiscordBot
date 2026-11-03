import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ButtonInteraction, ModalSubmitInteraction } from "discord.js";

const mocks = vi.hoisted(() => ({
	openAdminLaunch: vi.fn(),
	openAdminLeaf: vi.fn(),
	gate: vi.fn(),
	upsert: vi.fn(),
	findVoice: vi.fn(),
	findConfig: vi.fn(),
	updateConfig: vi.fn(),
	refresh: vi.fn(),
	emitFor: vi.fn(),
	showNotice: vi.fn(),
	showModalOrReply: vi.fn(),
	switchTemplate: vi.fn(),
	buttons: new Map<string, (interaction: ButtonInteraction) => Promise<void>>(),
	modals: new Map<string, (interaction: ModalSubmitInteraction) => Promise<void>>(),
}));

vi.mock("@features/command-buttons/adminCommandLauncher.js", () => ({ openAdminLaunch: mocks.openAdminLaunch, openAdminLeaf: mocks.openAdminLeaf }));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findConfig, update: mocks.updateConfig } }));
vi.mock("@db/stores/deroVoiceConfigStore.js", () => ({ deroVoiceConfigStore: { findByGuildId: mocks.findVoice, upsert: mocks.upsert } }));
vi.mock("@utils/permissions.js", () => ({ gateOwnerOrAdmin: mocks.gate }));
vi.mock("@utils/textModal.js", () => ({ showNotice: mocks.showNotice, showModalOrReply: mocks.showModalOrReply }));
vi.mock("./adminLog.js", () => ({ adminLog: { emitFor: mocks.emitFor } }));
vi.mock("./headquartersCards.js", () => ({
	HEADQUARTERS_STEP_PREFIX: "hqstep",
	SERVER_CONFIG_STEPS: ["timezone", "template", "kvkSeason", "streams", "events", "channels", "leveling"],
	SWITCH_STEP_TAIL: "switch-",
	refreshHeadquartersCards: mocks.refresh,
}));
// The switch itself is switchTemplate.test.ts's; here only the step around it.
vi.mock("./switchTemplate.js", () => ({
	TEMPLATE_PLUGIN_IDS: ["rok-commander", "general-events"],
	isTemplatePluginId: (value: unknown) => value === "rok-commander" || value === "general-events",
	switchTemplate: mocks.switchTemplate,
}));
vi.mock("@handlers/interactionRegistry.js", () => ({
	registerButton: (prefix: string, handler: (interaction: ButtonInteraction) => Promise<void>) => mocks.buttons.set(prefix, handler),
	registerModal: (prefix: string, handler: (interaction: ModalSubmitInteraction) => Promise<void>) => mocks.modals.set(prefix, handler),
}));

import {
	buildPriorityModal,
	buildTemplateModal,
	buildTimezoneModal,
	orderFromPicks,
	pickedTimezone,
	registerHeadquartersStepHandlers,
	stepTarget,
	templateAnswerLines,
} from "./headquartersSteps.js";
import { TIMEZONE_OPTIONS } from "@utils/tzParser.js";
import GuildConfigModel from "@db/models/GuildConfig.js";
import { SERVER_CONFIG_STEPS } from "./headquartersCards.js";
import { DEFAULT_VOICE_PRIORITY_ORDER } from "@features/voice/voicePriority.js";
import { voiceCopy } from "@features/voice/voiceCopy.js";
import { setupCopy } from "./setupCopy.js";
import { getPluginCopy } from "@base/copy/getCopy.js";
import { deroBrainCopy } from "@features/dero-brain/deroBrainCopy.js";

// ── the step buttons and the voice priority step (2026-10 item 257 Phase 2b) ──

registerHeadquartersStepHandlers();
const pressStep = mocks.buttons.get("hqstep")!;
const submitPriority = mocks.modals.get("hqsteppriority")!;
const submitTimezone = mocks.modals.get("hqsteptimezone")!;
const submitTemplate = mocks.modals.get("hqsteptemplate")!;

const press = (customId: string) => ({ customId, guild: { id: "g1" } }) as unknown as ButtonInteraction;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.gate.mockResolvedValue(true);
	mocks.findVoice.mockResolvedValue(null);
	mocks.findConfig.mockResolvedValue({ guildId: "g1" });
});

describe("the step to flow map", () => {
	it.each([
		// ⚙️dero-config's two steps and 🎰arcade-control's one panel step (2026-10 item 263 Phase 4b).
		["hqstep:deroConfig:1", { kind: "launch", launchId: "dero-config" }],
		["hqstep:deroConfig:2", { kind: "priority" }],
		["hqstep:arcadeControl:1", { kind: "leaf", command: "arcade", path: "on" }],
		["hqstep:arcadeControl:2", { kind: "launch", launchId: "arcade" }],
		["hqstep:arcadeControl:3", { kind: "leaf", command: "arcade", path: "reach" }],
		["hqstep:arcadeControl:4", { kind: "leaf", command: "arcade", path: "server block" }],
		// 🛠️server-config (2026-10 item 263 Phase 4a): every step an existing /events, /server or /leveling flow.
		// Step 1 is the server's timezone (2026-10 item 263 Phase 4c), step 2 Dero's template
		// (2026-10 item 262 Phase 4); 3 to 7 open what 1 to 5 did before both.
		["hqstep:serverConfig:1", { kind: "timezone" }],
		["hqstep:serverConfig:2", { kind: "template" }],
		["hqstep:serverConfig:3", { kind: "leaf", command: "events", path: "kvk-season" }],
		["hqstep:serverConfig:4", { kind: "leaf", command: "events", path: "stream weekly" }],
		["hqstep:serverConfig:5", { kind: "launch", launchId: "events" }],
		["hqstep:serverConfig:6", { kind: "launch", launchId: "server-channels" }],
		["hqstep:serverConfig:7", { kind: "launch", launchId: "leveling" }],
		// The server switches message.
		["hqstep:serverConfig:switch-autoHeal", { kind: "leaf", command: "server", path: "auto-heal" }],
		["hqstep:serverConfig:switch-tracking", { kind: "leaf", command: "server", path: "leaderboard tracking" }],
		["hqstep:serverConfig:switch-weekStart", { kind: "leaf", command: "server", path: "leaderboard week-start" }],
	])("%s opens its mapped flow", (customId, target) => {
		expect(stepTarget(customId)).toEqual(target);
	});

	// R3-15 (2026-10 item 263 Phase 4b): no two steps of one card open the same flow.
	it.each([
		["deroConfig", 2],
		["arcadeControl", 4],
		["serverConfig", SERVER_CONFIG_STEPS.length],
	])("%s opens a different flow from each of its %i steps", (domain, steps) => {
		const targets = Array.from({ length: steps }, (_unused, index) => JSON.stringify(stepTarget(`hqstep:${domain}:${index + 1}`)));
		expect(targets).not.toContain("null");
		expect(new Set(targets).size).toBe(steps);
	});

	it("knows no step past the card, and no onboarding step (those carry their flow's own customId)", () => {
		expect(stepTarget("hqstep:deroConfig:3")).toBeNull();
		expect(stepTarget("hqstep:arcadeControl:5")).toBeNull();
		expect(stepTarget("hqstep:onboarding:1")).toBeNull();
		expect(stepTarget("hqstep:serverConfig:8")).toBeNull();
		// A switch exists only on 🛠️server-config, and only by its own name.
		expect(stepTarget("hqstep:serverConfig:switch-nope")).toBeNull();
		expect(stepTarget("hqstep:serverConfig:switch-toString")).toBeNull();
		expect(stepTarget("hqstep:arcadeControl:switch-autoHeal")).toBeNull();
	});

	it("opens a panel through the launcher, a leaf through the launcher, and answers a stale step", async () => {
		await pressStep(press("hqstep:deroConfig:1"));
		expect(mocks.openAdminLaunch).toHaveBeenCalledWith(expect.anything(), "dero-config");
		await pressStep(press("hqstep:arcadeControl:4"));
		expect(mocks.openAdminLeaf).toHaveBeenCalledWith(expect.anything(), "arcade", "server block");
		await pressStep(press("hqstep:arcadeControl:9"));
		// A stale step is a state, a notice titled Setup (owner rule 1, 2026-10 item 263 Phase 1c).
		expect(mocks.showNotice).toHaveBeenCalledWith(expect.anything(), { title: getPluginCopy(null).notice.setup, sections: [setupCopy.headquarters.staleStep] });
	});
});

describe("step 2, the voice priority order", () => {
	it("opens a modal of four selects preset to the stored order, for an admin", async () => {
		await pressStep(press("hqstep:deroConfig:2"));
		expect(mocks.showModalOrReply).toHaveBeenCalledOnce();
		const modal = buildPriorityModal([...DEFAULT_VOICE_PRIORITY_ORDER]).toJSON();
		expect(modal.title).toBe(voiceCopy.priority.modalTitle);
		expect(modal.components).toHaveLength(5);
	});

	it("refuses a member before any modal opens", async () => {
		mocks.gate.mockResolvedValue(false);
		await pressStep(press("hqstep:deroConfig:2"));
		expect(mocks.showModalOrReply).not.toHaveBeenCalled();
		expect(mocks.showNotice).toHaveBeenCalledWith(expect.anything(), { title: deroBrainCopy.noticeTitle, sections: [voiceCopy.priority.notAdmin] });
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
		expect(mocks.showNotice).toHaveBeenCalledWith(expect.anything(), { title: deroBrainCopy.noticeTitle, sections: [voiceCopy.priority.duplicate] });

		mocks.gate.mockResolvedValue(false);
		await submitPriority(submit(["arcade-lounge", "meeting-hall", "other", "rated-match"]));
		expect(mocks.upsert).not.toHaveBeenCalled();
	});
});

// ── 🛠️server-config step 1, the server's timezone (2026-10 item 263 Phase 4c) ──
describe("step 1 of 🛠️server-config, the server's timezone", () => {
	const words = setupCopy.headquarters.serverConfig.timezone;

	it("opens a modal of the shared 25 zones with the server's zone picked, read by name from the hydrated document", async () => {
		mocks.findConfig.mockResolvedValue(GuildConfigModel.hydrate({ guildId: "g1", timezone: "America/New_York" }));
		await pressStep(press("hqstep:serverConfig:1"));
		expect(mocks.showModalOrReply).toHaveBeenCalledOnce();
		const modal = mocks.showModalOrReply.mock.calls[0][1] as ReturnType<typeof buildTimezoneModal>;
		const json = JSON.stringify(modal.toJSON());
		expect(json).toContain(`"value":"America/New_York","description":"America/New_York","default":true`);
		expect(json.match(/"default":true/g)).toHaveLength(1);
	});

	it("offers exactly the decree editor's 25 zones from tzParser", () => {
		const json = JSON.stringify(buildTimezoneModal("UTC").toJSON());
		expect(TIMEZONE_OPTIONS).toHaveLength(25);
		for (const option of TIMEZONE_OPTIONS) expect(json).toContain(`"value":"${option.value}"`);
		expect(buildTimezoneModal("UTC").toJSON().title).toBe(words.modalTitle);
	});

	it("refuses a member before any modal opens, with a Server notice", async () => {
		mocks.gate.mockResolvedValue(false);
		await pressStep(press("hqstep:serverConfig:1"));
		expect(mocks.showModalOrReply).not.toHaveBeenCalled();
		expect(mocks.showNotice).toHaveBeenCalledWith(expect.anything(), { title: getPluginCopy(null).notice.server, sections: [words.notAdmin] });
	});

	it("takes only a zone from the list", () => {
		expect(pickedTimezone("Europe/Berlin")).toBe("Europe/Berlin");
		expect(pickedTimezone("Mars/Olympus")).toBeNull();
		expect(pickedTimezone(undefined)).toBeNull();
	});

	function submit(zone: string) {
		return {
			guild: { id: "g1" },
			fields: { getStringSelectValues: () => [zone] },
			reply: vi.fn(async () => undefined),
		} as unknown as ModalSubmitInteraction & { reply: ReturnType<typeof vi.fn> };
	}

	it("saves the zone with the moment it was set, logs it, answers, and redraws 🛠️server-config's card", async () => {
		const interaction = submit("UTC");
		await submitTimezone(interaction);
		expect(mocks.updateConfig).toHaveBeenCalledWith("g1", { timezone: "UTC", timezoneSetAt: expect.any(Date) });
		expect(mocks.emitFor).toHaveBeenCalledWith(interaction, "g1", "config.change", { subject: words.auditSubject, detail: "UTC" });
		expect(interaction.reply).toHaveBeenCalledOnce();
		expect(mocks.refresh).toHaveBeenCalledWith(interaction.guild, "serverConfig");
	});

	it("saves nothing for a zone off the list, and re-checks the admin on Submit", async () => {
		await submitTimezone(submit("Mars/Olympus"));
		expect(mocks.updateConfig).not.toHaveBeenCalled();
		expect(mocks.showNotice).toHaveBeenCalledWith(expect.anything(), { title: getPluginCopy(null).notice.server, sections: [setupCopy.headquarters.staleStep] });

		mocks.gate.mockResolvedValue(false);
		await submitTimezone(submit("Europe/Berlin"));
		expect(mocks.updateConfig).not.toHaveBeenCalled();
	});
});

// ── 🛠️server-config step 2, Dero's template (2026-10 item 262 Phase 4) ──
describe("step 2 of 🛠️server-config, Dero's template", () => {
	const words = setupCopy.headquarters.serverConfig.template;
	const serverNotice = getPluginCopy(null).notice.server;

	it("opens a modal of the two templates with the server's own picked", async () => {
		mocks.findConfig.mockResolvedValue(GuildConfigModel.hydrate({ guildId: "g1", pluginId: "general-events" }));
		await pressStep(press("hqstep:serverConfig:2"));
		expect(mocks.showModalOrReply).toHaveBeenCalledOnce();
		const json = JSON.stringify((mocks.showModalOrReply.mock.calls[0][1] as ReturnType<typeof buildTemplateModal>).toJSON());
		expect(json).toContain(`"label":"${words.names["general-events"]}","value":"general-events","description":"${words.descriptions["general-events"]}","default":true`);
		expect(json.match(/"default":true/g)).toHaveLength(1);
		expect(buildTemplateModal("rok-commander").toJSON().title).toBe(words.modalTitle);
	});

	it("refuses a member before any modal opens, with a Server notice", async () => {
		mocks.gate.mockResolvedValue(false);
		await pressStep(press("hqstep:serverConfig:2"));
		expect(mocks.showModalOrReply).not.toHaveBeenCalled();
		expect(mocks.showNotice).toHaveBeenCalledWith(expect.anything(), { title: serverNotice, sections: [words.notAdmin] });
	});

	function submit(picked: string) {
		return {
			guild: { id: "g1" },
			client: {},
			fields: { getStringSelectValues: () => [picked] },
			deferReply: vi.fn(async () => undefined),
			editReply: vi.fn(async () => undefined),
		} as unknown as ModalSubmitInteraction & { deferReply: ReturnType<typeof vi.fn>; editReply: ReturnType<typeof vi.fn> };
	}

	it("re-checks the admin on Submit and switches nothing for a member", async () => {
		mocks.gate.mockResolvedValue(false);
		await submitTemplate(submit("general-events"));
		expect(mocks.switchTemplate).not.toHaveBeenCalled();
		expect(mocks.showNotice).toHaveBeenCalledWith(expect.anything(), { title: serverNotice, sections: [words.notAdmin] });
	});

	it("answers the template the server already uses with a notice, and switches nothing", async () => {
		mocks.findConfig.mockResolvedValue({ guildId: "g1", pluginId: "rok-commander" });
		await submitTemplate(submit("rok-commander"));
		expect(mocks.switchTemplate).not.toHaveBeenCalled();
		expect(mocks.showNotice).toHaveBeenCalledWith(expect.anything(), { title: serverNotice, sections: [words.unchanged(words.names["rok-commander"])] });
	});

	it("reads a row with no pluginId as kingdom, so picking kingdom there is the same notice", async () => {
		await submitTemplate(submit("rok-commander"));
		expect(mocks.switchTemplate).not.toHaveBeenCalled();
	});

	it("switches nothing for a value that is not one of the two templates", async () => {
		await submitTemplate(submit("toString"));
		expect(mocks.switchTemplate).not.toHaveBeenCalled();
		expect(mocks.showNotice).toHaveBeenCalledWith(expect.anything(), { title: serverNotice, sections: [setupCopy.headquarters.staleStep] });
	});

	it("acknowledges first, switches, answers with the counts and logs the change", async () => {
		const order: string[] = [];
		const interaction = submit("general-events");
		interaction.deferReply.mockImplementation(async () => void order.push("acknowledged"));
		mocks.switchTemplate.mockImplementation(async () => {
			order.push("switched");
			return { changed: true, previousPluginId: "rok-commander", renamed: ["adminChannelId"], kept: [], failed: [] };
		});
		await submitTemplate(interaction);

		expect(order).toEqual(["acknowledged", "switched"]);
		expect(mocks.switchTemplate).toHaveBeenCalledWith(interaction.client, interaction.guild, expect.objectContaining({ guildId: "g1" }), "general-events");
		// No 🛠️server-config stored here, so the answer takes the sanctioned private fallback.
		expect(interaction.editReply).toHaveBeenCalledOnce();
		expect(JSON.stringify(interaction.editReply.mock.calls[0])).toContain(words.renamed(1));
		expect(mocks.emitFor).toHaveBeenCalledWith(interaction, "g1", "config.change", { subject: words.auditSubject, detail: "Kingdom to Streamer" });
	});

	it("words the answer from the counts, and says nothing changed when another admin switched first", () => {
		const base = { changed: true, previousPluginId: "rok-commander" as const, renamed: [], kept: [], failed: [] };
		expect(templateAnswerLines(base, "Streamer")).toEqual([words.saved("Streamer")]);
		expect(templateAnswerLines({ ...base, renamed: ["a", "b"], kept: ["c"], failed: ["d"] }, "Streamer")).toEqual([
			words.saved("Streamer"),
			words.renamed(2),
			words.kept(1),
			words.failed(1),
		]);
		expect(templateAnswerLines({ ...base, changed: false }, "Streamer")).toEqual([words.unchanged("Streamer")]);
	});
});
