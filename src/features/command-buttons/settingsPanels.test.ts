import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Guild } from "discord.js";

// ── the admin settings panels ────────────────────────────────────────────────
// Each panel is read from mocked stores and pinned on what an admin sees: the
// current values preset, the owner only gate on /server channels, and the leaf every
// change runs, keyed by panel id. The last block is the drift guard: a leaf a panel
// names that its command no longer has would fail only at a live submit, so it fails here.

const mocks = vi.hoisted(() => ({
	findConfig: vi.fn(),
	findVoice: vi.fn(),
	getLevelingConfig: vi.fn(),
}));

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findConfig } }));
vi.mock("@db/stores/deroVoiceConfigStore.js", () => ({ deroVoiceConfigStore: { findByGuildId: mocks.findVoice } }));
vi.mock("@features/leveling/levelingConfig.js", async (original) => ({
	...(await original<typeof import("@features/leveling/levelingConfig.js")>()),
	getLevelingConfig: mocks.getLevelingConfig,
}));

import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { normalizeLevelingSettings } from "@features/leveling/levelingConfig.js";
import { LAUNCHABLE_COMMANDS } from "./adminCommandLauncher.js";
import { findLeaf, listLeaves } from "./commandForm.js";
import { SETTINGS_PANELS } from "./settingsPanels.js";
import type { LeafCall, PanelControl, SettingsPanel } from "./settingsPanel.js";

const OWNER_ID = "owner";

const guild = {
	id: "g1",
	ownerId: OWNER_ID,
	roles: { cache: new Map([["r1", { id: "r1" }]]) },
	channels: { cache: new Map([["t1", { id: "t1" }]]) },
} as unknown as Guild;

async function load(panelId: string, userId = OWNER_ID): Promise<SettingsPanel | null> {
	const definition = SETTINGS_PANELS.get(panelId);
	if (!definition) throw new Error(`no panel ${panelId}`);
	return definition.load({ guild, userId });
}

const control = (panel: SettingsPanel | null, id: string): PanelControl => {
	const found = panel?.controls.find((entry) => entry.id === id);
	if (!found) throw new Error(`no control ${id}`);
	return found;
};

// Every call a control can make, each switch both ways and each choice to every value.
function everyCall(entry: PanelControl): LeafCall[] {
	switch (entry.kind) {
		case "switches":
			return entry.switches.flatMap((item) => [...item.callsFor(true), ...item.callsFor(false)]);
		case "choice":
			return entry.choices.flatMap((choice) => entry.callsFor(choice.value));
		case "roles":
		case "channels": {
			const sample = [...entry.current.values()];
			return entry.callsFor({ added: sample, removed: sample });
		}
		case "number":
			return entry.callsFor(entry.min);
	}
}

beforeEach(() => {
	mocks.findConfig.mockReset().mockResolvedValue({
		guildId: "g1",
		categoryId: "cat",
		commandsChannelId: "c1",
		leaderboardChannelId: "c2",
		hiddenChannels: ["leaderboardChannelId"],
		arcadeMonthlyPost: false,
		botOpponentsEnabled: false,
		chipEconomyEnabled: false,
	});
	mocks.findVoice.mockReset().mockResolvedValue({
		enabled: true,
		listenEnabled: false,
		monthlyCapUsd: 12,
		// r-gone is a role Discord no longer has: it cannot be shown, so it is not preset.
		allowedRoleIds: ["r1", "r-gone"],
		allowedChannelIds: ["t1"],
		allowedVoiceChannelIds: [],
	});
	mocks.getLevelingConfig.mockReset().mockResolvedValue({ settings: normalizeLevelingSettings({ curve: "linear", announceMode: "off" }), weekStart: "sunday" });
});

describe("the panel ids", () => {
	it("are the five the guide opens, each naming the command it calls", () => {
		expect([...SETTINGS_PANELS.entries()].map(([id, definition]) => [id, definition.command, definition.group])).toEqual([
			["server", "server", null],
			["server-channels", "server", "channels"],
			["leveling", "leveling", null],
			["dero-config", "dero-config", null],
			["arcade", "arcade", null],
		]);
	});
});

describe("/dero-config", () => {
	it("presets the voice switches, the three lists and the budget, and holds no arcade switch", async () => {
		const panel = await load("dero-config");
		const switches = control(panel, "switches");
		expect(switches.kind === "switches" && switches.switches.map((item) => [item.value, item.on])).toEqual([
			["voice", true],
			["listen", false],
		]);
		const roles = control(panel, "roles");
		expect(roles.kind === "roles" && [...roles.current.keys()]).toEqual(["r1"]);
		const cap = control(panel, "cap");
		expect(cap.kind === "number" && [cap.current, cap.min, cap.max]).toEqual([12, 0, BOT_CONSTANTS.DERO_VOICE_MAX_CAP_USD]);
	});

	it("turns the voice switch into enable or disable, the kill switch that ends a call", async () => {
		const switches = control(await load("dero-config"), "switches");
		if (switches.kind !== "switches") throw new Error("not switches");
		const voice = switches.switches.find((item) => item.value === "voice");
		expect(voice?.callsFor(false).map((call) => call.path)).toEqual(["disable"]);
		expect(voice?.callsFor(true).map((call) => call.path)).toEqual(["enable"]);
	});

	it("turns a list change into one add or remove per entry", async () => {
		const roles = control(await load("dero-config"), "roles");
		if (roles.kind !== "roles") throw new Error("not roles");
		const added = { kind: "role" as const, value: { id: "r9" } as never };
		const calls = roles.callsFor({ added: [added], removed: [...roles.current.values()] });
		expect(calls.map((call) => call.path)).toEqual(["role add", "role remove"]);
	});
});

// The arcade panel: the chip switch, the monthly post and bot opponents (2026-10 item 250
// Phase 5), which left the /dero-config panel with the arcade's own command.
describe("/arcade", () => {
	it("presets the chip, monthly post and bots switches from the server", async () => {
		const switches = control(await load("arcade"), "switches");
		if (switches.kind !== "switches") throw new Error("not switches");
		expect(switches.switches.map((item) => [item.value, item.on])).toEqual([
			["economy", false],
			["monthly-post", false],
			["bots", false],
		]);
	});

	it("runs each switch through its /arcade leaf with the value it sets", async () => {
		const switches = control(await load("arcade"), "switches");
		if (switches.kind !== "switches") throw new Error("not switches");
		expect(switches.switches.map((item) => item.callsFor(true).map((call) => [call.path, call.values.get("enabled")]))).toEqual([
			[["chips toggle", { kind: "boolean", value: true }]],
			[["monthly-post", { kind: "boolean", value: true }]],
			[["bots", { kind: "boolean", value: true }]],
		]);
	});
});

describe("/server channels", () => {
	it("is the owner's: an admin who is not the owner gets the pick instead", async () => {
		expect(await load("server-channels", "admin")).toBeNull();
	});

	it("runs a visibility change through the channels group", async () => {
		const visible = control(await load("server-channels"), "visible");
		if (visible.kind !== "switches") throw new Error("not switches");
		expect(visible.switches[0]?.callsFor(false).map((call) => call.path)).toEqual(["channels hide"]);
	});

	it("shows each provisioned channel selected when members can see it", async () => {
		const visible = control(await load("server-channels"), "visible");
		expect(visible.kind === "switches" && visible.switches.map((item) => [item.value, item.on])).toEqual([
			["commandsChannelId", true],
			["leaderboardChannelId", false],
		]);
	});
});

describe("/leveling and /server", () => {
	it("preset leveling's switches and choices from the stored settings, run through the settings group", async () => {
		const panel = await load("leveling");
		expect(control(panel, "curve")).toMatchObject({ kind: "choice", current: "linear" });
		expect(control(panel, "announce")).toMatchObject({ kind: "choice", current: "off" });
		const curve = control(panel, "curve");
		expect(curve.kind === "choice" && curve.callsFor("flat").map((call) => call.path)).toEqual(["settings curve"]);
	});

	it("runs the server switches through auto-heal and the leaderboard group", async () => {
		const switches = control(await load("server"), "switches");
		if (switches.kind !== "switches") throw new Error("not switches");
		expect(switches.switches.map((item) => item.callsFor(true)[0]?.path)).toEqual(["auto-heal", "leaderboard tracking"]);
	});

	it("give the pick instead to a server that never ran /setup", async () => {
		mocks.findConfig.mockResolvedValue(null);
		for (const panelId of SETTINGS_PANELS.keys()) expect(await load(panelId), panelId).toBeNull();
	});
});

describe("every panel names only leaves its command has", () => {
	it.each([...SETTINGS_PANELS.keys()])("the %s panel", async (panelId) => {
		const definition = SETTINGS_PANELS.get(panelId);
		const command = definition ? LAUNCHABLE_COMMANDS.get(definition.command) : undefined;
		const panel = await load(panelId);
		const commandName = definition?.command ?? panelId;
		if (!command || !definition || !panel) throw new Error(`the ${panelId} panel did not load`);
		const leaves = listLeaves(command.data.toJSON());
		for (const path of definition.covered) expect(findLeaf(leaves, path), `${commandName} covers ${path}`).not.toBeNull();
		for (const entry of panel.controls) {
			for (const call of everyCall(entry)) {
				const leaf = findLeaf(leaves, call.path);
				expect(leaf, `${commandName} runs ${call.path}`).not.toBeNull();
				const optionNames = leaf?.fields.map((field) => field.name) ?? [];
				for (const option of call.values.keys()) expect(optionNames, `${commandName} ${call.path} reads ${option}`).toContain(option);
			}
		}
	});
});
