import { describe, it, expect, vi, beforeEach } from "vitest";
import { AttachmentBuilder, ButtonStyle, EmbedBuilder, TextChannel, type Guild } from "discord.js";

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn(), update: vi.fn(), addToList: vi.fn() } }));
vi.mock("@db/stores/deroVoiceConfigStore.js", () => ({ deroVoiceConfigStore: { findByGuildId: vi.fn() } }));
vi.mock("@db/stores/eventStore.js", () => ({ eventStore: { findByGuildId: vi.fn(async () => []) } }));
vi.mock("@features/renderer/settingsChartRenderer.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("@features/renderer/settingsChartRenderer.js")>()),
	renderSettingsChart: vi.fn(),
}));

import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { deroVoiceConfigStore } from "@db/stores/deroVoiceConfigStore.js";
import { eventStore } from "@db/stores/eventStore.js";
import { buildAdminControlButtons } from "@features/power-ups/PowerUps.js";
import { renderSettingsChart } from "@features/renderer/settingsChartRenderer.js";
import { COMMUNITY_CUSTOM_IDS } from "@features/community/communityControls.js";
import { CHOOSE_BUTTON_ID } from "./adoptionChoice.js";
import { setupCopy } from "./setupCopy.js";
import GuildConfigModel from "@db/models/GuildConfig.js";
import { handleSkip } from "./tutorialCards.js";
import {
	HEADQUARTERS_DOMAINS,
	SERVER_CONFIG_STEPS,
	SERVER_SWITCHES,
	arcadeControlView,
	buildStepButton,
	buildStepsCard,
	deroConfigView,
	onboardingView,
	readDomainView,
	refreshHeadquartersCards,
	serverConfigView,
	stepCustomId,
	switchCustomId,
	syncAllHeadquarters,
	syncHeadquartersChannel,
	type HeadquartersRow,
} from "./headquartersCards.js";

// ── 🏰 DERO HEADQUARTERS steps cards and charts (2026-10 item 257 Phase 2b, owner item 7) ──
// The marks are read from a fixture config; each step's button names the flow it
// opens; the two messages are posted once, pinned where they should be, edited only
// when what they show changed, and redrawn after a change.

const store = guildConfigStore as unknown as { findByGuildId: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; addToList: ReturnType<typeof vi.fn> };
const events = eventStore as unknown as { findByGuildId: ReturnType<typeof vi.fn> };
const voiceStore = deroVoiceConfigStore as unknown as { findByGuildId: ReturnType<typeof vi.fn> };
const render = renderSettingsChart as unknown as ReturnType<typeof vi.fn>;
const copy = setupCopy.headquarters;

// Every step of a domain listed, so the domain has finished and its chart and switches post.
const ARCADE_FINISHED = { setupStepsSkipped: ["arcadeControl:chips", "arcadeControl:reach", "arcadeControl:block"] };
const SERVER_FINISHED = { setupStepsSkipped: SERVER_CONFIG_STEPS.map((key) => `serverConfig:${key}`) };

const onboardingFlowSteps = (view: ReturnType<typeof onboardingView>) => view.steps.filter((step) => step.kind === "flow");

const marks = (description: string | undefined): string[] => (description ?? "").split("\n").filter((line) => line.includes("**Step")).map((line) => line.slice(0, 1));

function voiceRow(overrides: Record<string, unknown> = {}) {
	return {
		guildId: "g1",
		enabled: true,
		voiceId: null,
		listenEnabled: true,
		allowedRoleIds: ["role-1"],
		allowedChannelIds: [],
		allowedVoiceChannelIds: ["vc-1"],
		monthlyCapUsd: 5,
		priorityOrder: ["arcade-lounge"],
		...overrides,
	} as never;
}

describe("the step marks, read from a fixture config", () => {
	// Two steps (2026-10 item 263 Phase 4b, owner decision 15): the settings panel and the
	// priority order. The panel is done with the voice on and a channel to join; the task
	// roles are optional, since the owner and the admin role always may.
	it("⚙️dero-config: two steps, the panel done once the voice is on with a channel to join, the order once a row is saved", () => {
		expect(deroConfigView(voiceRow()).steps.map((step) => step.done)).toEqual([true, true]);
		expect(deroConfigView(voiceRow({ allowedRoleIds: [] })).steps.map((step) => step.done)).toEqual([true, true]);
		expect(deroConfigView(voiceRow({ allowedVoiceChannelIds: [] })).steps.map((step) => step.done)).toEqual([false, true]);
		expect(deroConfigView(voiceRow({ enabled: false })).steps.map((step) => step.done)).toEqual([false, true]);
		expect(deroConfigView(null).steps.every((step) => !step.done)).toBe(true);
		expect(deroConfigView(null).steps.map((step) => step.label)).toEqual(copy.deroConfig.steps);
		expect(copy.deroConfig.steps).toHaveLength(2);
	});

	it("⚙️dero-config's chart shows no budget and no text channel list", () => {
		const labels = deroConfigView(voiceRow({ allowedChannelIds: ["t1"], monthlyCapUsd: 9 })).chart.rows.map((row) => row.label);
		expect(labels).toEqual([copy.deroConfig.rows.voice, copy.deroConfig.rows.listen, copy.deroConfig.rows.roles, copy.deroConfig.rows.voiceChannels, copy.deroConfig.rows.priority]);
	});

	it("⚙️dero-config's chart shows each switch and the priority order the admin chose first", () => {
		const rows = deroConfigView(voiceRow()).chart.rows;
		expect(rows[0]).toEqual({ label: copy.deroConfig.rows.voice, kind: "switch", on: true });
		expect(rows.at(-1)).toMatchObject({ kind: "value", value: expect.stringMatching(/^Arcade Lounge › Meeting Hall/) });
	});

	it("🧭onboarding: gating carries no button and its /setup note; the other flows carry their own customId", () => {
		const view = onboardingView({ communityOn: true, onboardingOn: false, gated: true, memberRoleName: "Members", adoptedPlaced: true, adoptedLines: [] }, {});
		const flows = onboardingFlowSteps(view);
		expect(flows.map((step) => step.done)).toEqual([true, true, false, true]);
		expect(flows.map((step) => step.customId)).toEqual([COMMUNITY_CUSTOM_IDS.enable, CHOOSE_BUTTON_ID, COMMUNITY_CUSTOM_IDS.configure, null]);
		const card = buildStepsCard(view);
		expect(card.embeds[0]!.data.description).toContain(copy.onboarding.gatingNote);
		expect(card.components.flatMap((row) => row.components)).toHaveLength(13);
	});

	// 2026-11 item 289: the owner's order, the channels first, each read from the row.
	it("🧭onboarding: lists the ten channels first, then the four flows, each channel marked from its slot", () => {
		const facts = { communityOn: false, onboardingOn: false, gated: false, memberRoleName: null, adoptedPlaced: false, adoptedLines: [] };
		const view = onboardingView(facts, { introChannelId: "c-intro" });
		expect(view.steps.map((step) => step.key)).toEqual([
			"intro",
			"announcements",
			"schedule",
			"welcome",
			"rules",
			"commands",
			"meetingVoice",
			"commandOutput",
			"leaderboard",
			"nextDecree",
			"community",
			"adopted",
			"discordOnboarding",
			"gating",
		]);
		expect(view.steps.slice(0, 10).every((step) => step.kind === "channel")).toBe(true);
		expect(view.steps.slice(0, 2).map((step) => [step.done, step.customId])).toEqual([
			[true, "hqstep:onboarding:tutorial-intro"],
			[false, "hqstep:onboarding:tutorial-announcements"],
		]);
	});

	it("🧭onboarding: three rows of step buttons hold all 13, and every other channel stays at two", () => {
		const facts = { communityOn: false, onboardingOn: false, gated: false, memberRoleName: null, adoptedPlaced: false, adoptedLines: [] };
		const rows = buildStepsCard(onboardingView(facts, {})).components;
		expect(rows.map((row) => row.components.length)).toEqual([5, 5, 3]);
		expect(serverConfigView({}, noEvents).stepRows).toBeUndefined();
		expect(buildStepsCard(serverConfigView({}, noEvents)).components).toHaveLength(2);
	});

	it("🧭onboarding's chart says unknown, not off, when Onboarding could not be read", () => {
		const rows = onboardingView({ communityOn: true, onboardingOn: null, gated: false, memberRoleName: null, adoptedPlaced: false, adoptedLines: [] }, {}).chart!.rows;
		expect(rows[1]).toEqual({ label: copy.onboarding.rows.onboarding, kind: "value", value: copy.unknown });
		expect(rows[2]).toMatchObject({ value: copy.notSet });
	});

	// Chips, the monthly post and the bots share the /arcade panel, so they are one step
	// (2026-10 item 263 Phase 4b, owner decision 15).
	// 2026-11 item 285 debug pass, owner ruling: while the arcade is off the channel shows the
	// enable step alone, with no chart and no Dismantle.
	it("🎰arcade-control while the arcade is off: one Turn the arcade on step, no chart, and only its Skip beside it", () => {
		const off = arcadeControlView({ gamesCategoryId: null } as HeadquartersRow);
		expect(off.title).toBe(copy.arcadeControl.enableTitle);
		expect(off.steps.map((step) => [step.key, step.label, step.done, step.customId])).toEqual([["enable", copy.arcadeControl.steps[0], false, "hqstep:arcadeControl:1"]]);
		expect(off.chart).toBeNull();
		expect(off.ownCardOnly).toBe(true);
		const rows = buildStepsCard(off).components.map((row) => row.toJSON().components.map((button) => (button as { custom_id: string }).custom_id));
		expect(rows).toEqual([["hqstep:arcadeControl:1"], ["hqstep:arcadeControl:skip-enable"]]);
	});

	it("🎰arcade-control while the arcade is off: its Skip goes once the step is skipped", () => {
		const off = arcadeControlView({ gamesCategoryId: null, setupStepsSkipped: ["arcadeControl:enable"] } as HeadquartersRow);
		expect(off.extraButtons).toEqual([]);
		const rows = buildStepsCard(off).components.map((row) => row.toJSON().components.map((button) => (button as { custom_id: string }).custom_id));
		expect(rows).toEqual([["hqstep:arcadeControl:1"]]);
	});

	it("🎰arcade-control while the arcade is on: the remaining three steps, numbered from 1, each keeping its route", () => {
		const on = arcadeControlView({ gamesCategoryId: "cat", chipEconomyEnabled: false, challengeReach: "network", blockedNetworkGuildIds: ["x"] } as HeadquartersRow);
		expect(on.title).toBe(copy.arcadeControl.title);
		expect(on.steps.map((step) => step.label)).toEqual(copy.arcadeControl.steps.slice(1));
		expect(on.steps.map((step) => step.done)).toEqual([false, true, true]);
		expect(on.steps.at(-1)?.optional).toBe(true);
		expect(on.chart?.title).toBe(copy.arcadeControl.chartTitle);
		expect(arcadeControlView({ gamesCategoryId: "cat", botOpponentsEnabled: false } as HeadquartersRow).steps[0]?.done).toBe(false);
		expect(arcadeControlView({ gamesCategoryId: "cat" } as HeadquartersRow).steps[0]?.done).toBe(true);
		expect(marks(buildStepsCard(on).embeds[0]!.data.description)).toHaveLength(3);
		expect(buildStepsCard(on).embeds[0]!.data.description).toContain("**Step 1");
	});

	// Dismantle sits beside the steps on its own row (2026-11 item 285 Phase 4); the retired
	// Enable stub is gone from the card.
	it("🎰arcade-control: Dismantle rides the card on a row of its own, never as a step", () => {
		const view = arcadeControlView({ gamesCategoryId: "cat" } as HeadquartersRow);
		expect(view.extraButtons?.map((button) => (button.toJSON() as { custom_id: string }).custom_id)).toEqual(["hqstep:arcadeControl:dismantle"]);
		const rows = buildStepsCard(view).components.map((row) => row.toJSON().components.map((button) => (button as { custom_id: string }).custom_id));
		expect(rows).toEqual([["hqstep:arcadeControl:2", "hqstep:arcadeControl:3", "hqstep:arcadeControl:4"], ["hqstep:arcadeControl:dismantle"]]);
		expect(buildStepsCard(view).embeds[0]!.data.description).not.toContain("Dismantle");
	});

	// R3-19 (2026-10 item 263 Phase 4b): the choice lives on 🧭onboarding's step 2, which
	// names each adopted channel and its slot, or says there is nothing to choose.
	it("🧭onboarding: step 2 names the channels Dero adopted, or says there is nothing to choose and shows done", () => {
		const lines = ["• <#c-welcome> as the welcome log"];
		const adopted = onboardingView({ communityOn: false, onboardingOn: false, gated: false, memberRoleName: null, adoptedPlaced: false, adoptedLines: lines }, {});
		expect(onboardingFlowSteps(adopted)[1]).toMatchObject({ done: false, note: lines[0], customId: CHOOSE_BUTTON_ID });
		expect(buildStepsCard(adopted).embeds[0]!.data.description).toContain("<#c-welcome> as the welcome log");
		const none = onboardingView({ communityOn: false, onboardingOn: false, gated: false, memberRoleName: null, adoptedPlaced: true, adoptedLines: [] }, {});
		expect(onboardingFlowSteps(none)[1]).toMatchObject({ done: true, note: copy.onboarding.nothingAdopted, customId: CHOOSE_BUTTON_ID });
	});
});

// ── 🛠️server-config, the fourth domain (2026-10 item 263 Phase 4a) ──

const NOW = Date.parse("2026-10-28T12:00:00Z");
const noEvents = { now: NOW, activeEvents: 0, pausedEvents: 0, weeklySchedules: 0 };

// A step's mark by its key, so an inserted step never shifts what a test reads.
const doneOf = (view: { steps: { done: boolean }[] }, key: (typeof SERVER_CONFIG_STEPS)[number]): boolean | undefined =>
	view.steps[SERVER_CONFIG_STEPS.indexOf(key)]?.done;

describe("🛠️server-config's steps and chart", () => {
	it("on a fresh server marks only the template and leveling, which work from the start, and names every step in order", () => {
		const view = serverConfigView({}, noEvents);
		expect(view.title).toBe(copy.serverConfig.title);
		expect(view.steps.map((step) => step.label)).toEqual(SERVER_CONFIG_STEPS.map((key) => copy.serverConfig.steps[key]));
		expect(view.steps.map((step) => step.done)).toEqual([false, true, false, false, false, false, true, false]);
		expect(view.steps.map((step) => step.customId)).toEqual(SERVER_CONFIG_STEPS.map((_key, index) => stepCustomId("serverConfig", index + 1)));
	});

	// 2026-11 item 285 Phase 4: rename is an info step, so it is pending always, optional
	// so it does not nag, and the 8th button.
	it("adds rename as the 8th step: never done, optional, carrying hqstep:serverConfig:8", () => {
		const view = serverConfigView({}, noEvents);
		expect(view.steps).toHaveLength(8);
		expect(view.steps[7]).toMatchObject({ label: copy.serverConfig.steps.rename, done: false, optional: true, customId: "hqstep:serverConfig:8" });
		const configured = serverConfigView({ timezone: "America/New_York", leveling: { enabled: true } }, { now: NOW, activeEvents: 3, pausedEvents: 1, weeklySchedules: 1 });
		expect(doneOf(configured, "rename")).toBe(false);
		const rows = buildStepsCard(view).components;
		expect(rows.map((row) => row.components.length)).toEqual([5, 3]);
	});

	it("marks every step but the info step done for a configured server", () => {
		const view = serverConfigView(
			{ timezone: "America/New_York", kvkSeasonEnd: new Date(NOW + 86_400_000), hiddenChannels: ["leaderboardChannelId"], leveling: { enabled: true } },
			{ now: NOW, activeEvents: 3, pausedEvents: 1, weeklySchedules: 1 }
		);
		expect(view.steps.filter((step) => !step.done).map((step) => step.label)).toEqual([copy.serverConfig.steps.rename]);
	});

	it("reads a past KvK season and switched off leveling as not done", () => {
		const view = serverConfigView({ kvkSeasonEnd: new Date(NOW - 1), leveling: { enabled: false } }, noEvents);
		expect(doneOf(view, "kvkSeason")).toBe(false);
		expect(doneOf(view, "leveling")).toBe(false);
	});

	// ── step 1, the server's timezone (2026-10 item 263 Phase 4c) ──
	it("puts the server's timezone first and Dero's template second, so steps 3 to 7 are the five steps that were 1 to 5, and rename last", () => {
		expect([...SERVER_CONFIG_STEPS]).toEqual(["timezone", "template", "kvkSeason", "streams", "events", "channels", "leveling", "rename"]);
	});

	// ── step 2, Dero's template (2026-10 item 262 Phase 4) ──
	it("shows the server's template on the chart, kingdom for any id but the streamer one", () => {
		const templateRow = (row: HeadquartersRow) => serverConfigView(row, noEvents).chart.rows.find((chartRow) => chartRow.label === copy.serverConfig.rows.template);
		expect(templateRow({ pluginId: "general-events" })).toMatchObject({ value: copy.serverConfig.template.names["general-events"] });
		expect(templateRow({ pluginId: "rok-commander" })).toMatchObject({ value: copy.serverConfig.template.names["rok-commander"] });
		expect(templateRow({})).toMatchObject({ value: copy.serverConfig.template.names["rok-commander"] });
	});

	it("marks the timezone done for a picked zone or a UTC an admin saved, never for the default", () => {
		expect(doneOf(serverConfigView({ timezone: "UTC" }, noEvents), "timezone")).toBe(false);
		expect(doneOf(serverConfigView({ timezone: "America/New_York" }, noEvents), "timezone")).toBe(true);
		expect(doneOf(serverConfigView({ timezone: "UTC", timezoneSetAt: new Date(NOW) }, noEvents), "timezone")).toBe(true);
		// A stored value that is no real zone reads as the UTC default.
		expect(doneOf(serverConfigView({ timezone: "Mars/Olympus" }, noEvents), "timezone")).toBe(false);
	});

	it("shows the zone on the chart, read by name from the hydrated document the store returns", () => {
		const row = GuildConfigModel.hydrate({ guildId: "g1", timezone: "Europe/Berlin" });
		const view = serverConfigView(row as unknown as HeadquartersRow, noEvents);
		expect(view.chart.rows.find((chartRow) => chartRow.label === copy.serverConfig.rows.timezone)).toMatchObject({ value: "Europe/Berlin" });
		expect(doneOf(view, "timezone")).toBe(true);
	});

	it("draws the switches as they stand, each with its button, then Refresh standings", () => {
		const view = serverConfigView({ autoHealEnabled: false, weekStart: "monday" }, noEvents);
		const switches = view.switches!;
		expect(switches.lines).toEqual([
			copy.serverConfig.switches.line(copy.serverConfig.switches.labels.autoHeal, copy.off),
			copy.serverConfig.switches.line(copy.serverConfig.switches.labels.tracking, copy.on),
			copy.serverConfig.switches.line(copy.serverConfig.switches.labels.weekStart, copy.serverConfig.weekStarts.monday),
		]);
		const ids = switches.buttons.map((button) => (button.toJSON() as { custom_id: string }).custom_id);
		const refresh = buildAdminControlButtons().map((button) => (button.toJSON() as { custom_id: string }).custom_id);
		expect(ids).toEqual([...SERVER_SWITCHES.map(switchCustomId), ...refresh]);
		const chartRows = view.chart.rows.map((row) => row.label);
		expect(chartRows).toContain(copy.serverConfig.rows.autoHeal);
		expect(chartRows).toContain(copy.serverConfig.rows.weekStart);
	});
});

// Risk R3 of 2026-10 item 263: the switch over domains is exhaustive, so each domain
// draws its own card and none falls through to another's.
describe("readDomainView", () => {
	const guild = {
		id: "g1",
		features: [] as string[],
		roles: { everyone: { id: "everyone" }, cache: new Map() },
		channels: { cache: new Map() },
	} as unknown as Guild;
	const titles: Record<string, string> = {
		deroConfig: copy.deroConfig.title,
		onboarding: copy.onboarding.title,
		// An empty row has no arcade, so 🎰arcade-control reads as its enable card.
		arcadeControl: copy.arcadeControl.enableTitle,
		serverConfig: copy.serverConfig.title,
	};

	it.each([...HEADQUARTERS_DOMAINS])("%s draws its own card and chart", async (domain) => {
		const view = await readDomainView(guild, {}, domain);
		expect(view.title).toBe(titles[domain]);
		expect(new Set(Object.values(titles)).size).toBe(HEADQUARTERS_DOMAINS.length);
	});

	// 2026-11 item 289: the steps card is the table of contents, and its marks are the one
	// place the skip list meets a view.
	it("marks a skipped step ⏭️ with the word skipped, a pressed Continue ✅ and an open step ⬜", async () => {
		const view = await readDomainView(guild, { setupStepsSkipped: ["serverConfig:timezone", "serverConfig:rename"] }, "serverConfig");
		expect(view.steps.map((step) => step.progress)).toEqual(["skipped", "done", "open", "open", "open", "open", "done", "done"]);
		const lines = buildStepsCard(view).embeds[0]!.data.description!.split("\n");
		expect(lines[0]).toContain(`${copy.skippedMark} **Step 1** ${copy.serverConfig.steps.timezone} ${copy.skippedWord}`);
		expect(lines[2]).toContain(`${copy.todo} **Step 3**`);
		expect(lines[7]).toContain(`${copy.done} **Step 8**`);
		expect(lines[7]).not.toContain(copy.skippedWord);
		const styles = buildStepsCard(view).components.flatMap((row) => row.components.map((button) => (button.toJSON() as { style: ButtonStyle }).style));
		expect(styles[0]).toBe(ButtonStyle.Secondary);
		expect(styles[7]).toBe(ButtonStyle.Success);
	});

	it("says a skipped Turn the arcade on step can be revisited on its own card, the steps card", async () => {
		const view = await readDomainView(guild, { setupStepsSkipped: ["arcadeControl:enable"] }, "arcadeControl");
		const description = buildStepsCard(view).embeds[0]!.data.description!;
		expect(description).toContain(copy.skippedWord);
		expect(description).toContain(copy.stepCards.skippedLine);
	});

	it("leaves the views' own steps alone", async () => {
		const row = { setupStepsSkipped: ["deroConfig:voice"] };
		const view = await readDomainView(guild, row, "deroConfig");
		expect(view.steps[0]).toMatchObject({ done: false, progress: "skipped" });
		expect(deroConfigView(null).steps[0]?.progress).toBeUndefined();
	});

	it("counts the server's events for 🛠️server-config, a weekly stream among them", async () => {
		events.findByGuildId.mockResolvedValueOnce([
			{ type: "recurring", intervalHours: 168, seasonEnd: null, paused: false },
			{ type: "recurring", intervalHours: 36, seasonEnd: new Date(NOW), paused: true },
		]);
		const view = await readDomainView(guild, {}, "serverConfig");
		expect([doneOf(view, "streams"), doneOf(view, "events")]).toEqual([true, true]);
		const valueOf = (label: string) => view.chart?.rows.find((row) => row.label === label);
		expect(valueOf(copy.serverConfig.rows.pausedEvents)).toMatchObject({ value: "1" });
	});
});

describe("the step buttons (2026-10 item 263 Phase 4a, R3-21)", () => {
	it("are green with a ✅ when done and grey when open, both still Step N and still pressable", () => {
		const done = buildStepButton("hqstep:serverConfig:1", 1, true).toJSON() as { style: ButtonStyle; label: string; emoji?: { name?: string }; disabled?: boolean };
		const open = buildStepButton("hqstep:serverConfig:2", 2, false).toJSON() as { style: ButtonStyle; label: string; emoji?: { name?: string }; disabled?: boolean };
		expect(done).toMatchObject({ style: ButtonStyle.Success, label: "Step 1", emoji: { name: copy.done } });
		expect(open).toMatchObject({ style: ButtonStyle.Secondary, label: "Step 2" });
		expect(open.emoji).toBeUndefined();
		expect(done.disabled).toBeFalsy();
	});
});

describe("buildStepsCard", () => {
	it("numbers every step with its mark and gives each routed step a button, in two rows at most", () => {
		const card = buildStepsCard(deroConfigView(voiceRow({ enabled: false })));
		expect(marks(card.embeds[0]!.data.description)).toEqual([copy.todo.slice(0, 1), copy.done.slice(0, 1)]);
		const buttons = card.components.flatMap((row) => row.components.map((button) => button.toJSON() as { custom_id: string; label: string }));
		expect(buttons.map((button) => button.custom_id)).toEqual([1, 2].map((step) => stepCustomId("deroConfig", step)));
		expect(buttons.map((button) => button.label)).toEqual(["Step 1", "Step 2"]);
		// Step 1 is open, grey; step 2 is done, green (R3-21).
		const styles = card.components.flatMap((row) => row.components.map((button) => (button.toJSON() as { style: ButtonStyle }).style));
		expect(styles).toEqual([ButtonStyle.Secondary, ButtonStyle.Success]);
		expect(card.components.length).toBeLessThanOrEqual(2);
	});
});

// ── keeping the messages ──

interface FakeMessage {
	id: string;
	author: { id: string };
	embeds: Array<{ title?: string; data: Record<string, unknown> }>;
	components: unknown[];
	pin: ReturnType<typeof vi.fn>;
	edit: ReturnType<typeof vi.fn>;
	delete: ReturnType<typeof vi.fn>;
}

function rig(row: Partial<HeadquartersRow>) {
	const messages = new Map<string, FakeMessage>();
	let next = 0;
	type Payload = { embeds?: Array<{ toJSON(): Record<string, unknown> }>; components?: unknown[] };
	const makeMessage = (payload: Payload): FakeMessage => {
		const embeds = (payload.embeds ?? []).map((embed) => {
			const data = embed.toJSON();
			return { title: data.title as string | undefined, data };
		});
		const message: FakeMessage = {
			id: `msg-${(next += 1)}`,
			author: { id: "bot" },
			embeds,
			components: payload.components ?? [],
			pin: vi.fn(async () => undefined),
			edit: vi.fn(async (update: Payload) => {
				message.components = update.components ?? [];
				message.embeds = (update.embeds ?? []).map((embed) => ({ title: embed.toJSON().title as string | undefined, data: embed.toJSON() }));
			}),
			delete: vi.fn(async () => void messages.delete(message.id)),
		};
		messages.set(message.id, message);
		return message;
	};
	const channel = Object.create(TextChannel.prototype) as TextChannel;
	const send = vi.fn(async (payload: Payload) => makeMessage(payload));
	Object.assign(channel, {
		id: "ch-arcade",
		send,
		messages: {
			fetch: vi.fn(async (query: string | { limit: number }) => {
				if (typeof query === "string") return messages.get(query) ?? null;
				return { find: (predicate: (message: FakeMessage) => boolean) => [...messages.values()].find(predicate) };
			}),
		},
	});
	const guild = {
		id: "g1",
		client: { user: { id: "bot" } },
		channels: { fetch: vi.fn(async (id: string) => (id === "ch-arcade" ? channel : null)) },
	} as unknown as Guild;
	const stored: HeadquartersRow = { arcadeControlChannelId: "ch-arcade", gamesCategoryId: "cat", ...row };
	store.findByGuildId.mockImplementation(async () => stored);
	store.update.mockImplementation(async (_guildId: string, writes: Record<string, string | null>) => {
		for (const [path, value] of Object.entries(writes)) {
			const [group, key] = path.split(".") as ["setupStepsMessageIds" | "settingsChartMessageIds" | "settingsSwitchesMessageIds" | "tutorialCardMessageIds", string];
			stored[group] = { ...(stored[group] ?? {}), [key]: value };
		}
	});
	store.addToList.mockImplementation(async (_guildId: string, list: "setupStepsSkipped", value: string) => {
		stored[list] = [...new Set([...(stored[list] ?? []), value])];
	});
	return { guild, send, messages, stored };
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	voiceStore.findByGuildId.mockResolvedValue(null);
	render.mockResolvedValue(null);
});

describe("syncHeadquartersChannel", () => {
	it("posts the pinned steps card then the chart, and stores both ids", async () => {
		const { guild, send, messages, stored } = rig(ARCADE_FINISHED);
		await syncHeadquartersChannel(guild, "arcadeControl");

		expect(send).toHaveBeenCalledTimes(2);
		const [steps, chart] = [...messages.values()];
		expect(steps!.embeds[0]!.title).toBe(copy.arcadeControl.title);
		expect(steps!.pin).toHaveBeenCalledOnce();
		expect(chart!.embeds[0]!.title).toBe(copy.arcadeControl.chartTitle);
		expect(chart!.pin).not.toHaveBeenCalled();
		expect(stored.setupStepsMessageIds?.arcadeControlChannelId).toBe(steps!.id);
		expect(stored.settingsChartMessageIds?.arcadeControlChannelId).toBe(chart!.id);
	});

	it("attaches the drawn chart when the canvas draws it", async () => {
		const attachment = new AttachmentBuilder(Buffer.from("png"), { name: "settings-chart-x.png" });
		render.mockResolvedValue({ attachment, ref: "attachment://settings-chart-x.png" });
		const { guild, send } = rig(ARCADE_FINISHED);
		await syncHeadquartersChannel(guild, "arcadeControl");
		const chartPayload = send.mock.calls[1]![0] as { files: unknown[]; embeds: Array<{ toJSON(): { image?: { url: string } } }> };
		expect(chartPayload.files).toEqual([attachment]);
		expect(chartPayload.embeds[0]!.toJSON().image?.url).toBe("attachment://settings-chart-x.png");
	});

	it("writes nothing when nothing changed, and redraws after a change", async () => {
		const { guild, send, messages, stored } = rig(ARCADE_FINISHED);
		await syncHeadquartersChannel(guild, "arcadeControl");
		await syncHeadquartersChannel(guild, "arcadeControl");
		const [steps, chart] = [...messages.values()];
		expect(send).toHaveBeenCalledTimes(2);
		expect(steps!.edit).not.toHaveBeenCalled();
		expect(chart!.edit).not.toHaveBeenCalled();
		expect(render).not.toHaveBeenCalledTimes(2);

		stored.blockedNetworkGuildIds = ["x"];
		refreshHeadquartersCards(guild, "arcadeControl");
		await vi.waitFor(() => expect(chart!.edit).toHaveBeenCalledOnce());
		expect(steps!.edit).toHaveBeenCalledOnce();
		expect(send).toHaveBeenCalledTimes(2);
	});

	it("reposts a deleted card and adopts one whose stored id was lost", async () => {
		const { guild, send, messages, stored } = rig(ARCADE_FINISHED);
		await syncHeadquartersChannel(guild, "arcadeControl");
		const [steps] = [...messages.values()];
		messages.delete(steps!.id);
		stored.settingsChartMessageIds = {};
		await syncHeadquartersChannel(guild, "arcadeControl");
		expect(send).toHaveBeenCalledTimes(3);
		expect(stored.settingsChartMessageIds?.arcadeControlChannelId).toBe("msg-2");
	});

	it("posts 🛠️server-config's steps card, then its switches, then its chart, and stores all three ids", async () => {
		const { guild, send, messages, stored } = rig({ arcadeControlChannelId: null, serverConfigChannelId: "ch-arcade", ...SERVER_FINISHED });
		await syncHeadquartersChannel(guild, "serverConfig");

		expect(send).toHaveBeenCalledTimes(3);
		const [steps, switches, chart] = [...messages.values()];
		expect(steps!.embeds[0]!.title).toBe(copy.serverConfig.title);
		expect(switches!.embeds[0]!.title).toBe(copy.serverConfig.switches.title);
		expect(chart!.embeds[0]!.title).toBe(copy.serverConfig.chartTitle);
		expect(stored.setupStepsMessageIds?.serverConfigChannelId).toBe(steps!.id);
		expect(stored.settingsSwitchesMessageIds?.serverConfigChannelId).toBe(switches!.id);
		expect(stored.settingsChartMessageIds?.serverConfigChannelId).toBe(chart!.id);

		// A second sync with nothing changed writes nothing; a switch flipped edits only what shows it.
		await syncHeadquartersChannel(guild, "serverConfig");
		expect(send).toHaveBeenCalledTimes(3);
		expect(switches!.edit).not.toHaveBeenCalled();
		stored.autoHealEnabled = false;
		await syncHeadquartersChannel(guild, "serverConfig");
		expect(switches!.edit).toHaveBeenCalledOnce();
		expect(send).toHaveBeenCalledTimes(3);
	});

	// 2026-11 item 285 debug pass, owner ruling: the enable card is replaced, not edited,
	// once the arcade is on, and the chart only exists while it is on.
	it("🎰arcade-control while the arcade is off posts the enable card alone, and no chart", async () => {
		const { guild, send, messages, stored } = rig({ gamesCategoryId: null });
		await syncHeadquartersChannel(guild, "arcadeControl");

		expect(send).toHaveBeenCalledOnce();
		expect([...messages.values()].map((message) => message.embeds[0]!.title)).toEqual([copy.arcadeControl.enableTitle]);
		expect(stored.settingsChartMessageIds?.arcadeControlChannelId).toBeUndefined();
	});

	it("turning the arcade on deletes the enable card, then posts the steps card and the chart beneath", async () => {
		const { guild, send, messages, stored } = rig({ gamesCategoryId: null, ...ARCADE_FINISHED });
		await syncHeadquartersChannel(guild, "arcadeControl");
		const [enable] = [...messages.values()];

		stored.gamesCategoryId = "cat";
		await syncHeadquartersChannel(guild, "arcadeControl");

		expect(enable!.delete).toHaveBeenCalledOnce();
		expect(enable!.edit).not.toHaveBeenCalled();
		expect(send).toHaveBeenCalledTimes(3);
		expect([...messages.values()].map((message) => message.embeds[0]!.title)).toEqual([copy.arcadeControl.title, copy.arcadeControl.chartTitle]);
		const [steps, chart] = [...messages.values()];
		expect(steps!.pin).toHaveBeenCalledOnce();
		expect(stored.setupStepsMessageIds?.arcadeControlChannelId).toBe(steps!.id);
		expect(stored.settingsChartMessageIds?.arcadeControlChannelId).toBe(chart!.id);
	});

	it("turning the arcade off swaps back: the steps card and the chart go, the enable card posts", async () => {
		const { guild, messages, stored } = rig(ARCADE_FINISHED);
		await syncHeadquartersChannel(guild, "arcadeControl");
		const [steps, chart] = [...messages.values()];

		stored.gamesCategoryId = null;
		await syncHeadquartersChannel(guild, "arcadeControl");

		expect(steps!.delete).toHaveBeenCalledOnce();
		expect(chart!.delete).toHaveBeenCalledOnce();
		expect([...messages.values()].map((message) => message.embeds[0]!.title)).toEqual([copy.arcadeControl.enableTitle]);
		expect(stored.settingsChartMessageIds?.arcadeControlChannelId).toBeNull();
	});

	it("does nothing for a guild with no such channel, and never throws", async () => {
		const { guild, send } = rig({ arcadeControlChannelId: null });
		await expect(syncHeadquartersChannel(guild, "arcadeControl")).resolves.toBeUndefined();
		expect(send).not.toHaveBeenCalled();
		store.findByGuildId.mockRejectedValue(new Error("mongo down"));
		await expect(syncHeadquartersChannel(guild, "arcadeControl")).resolves.toBeUndefined();
	});
});

// ── the setup walk (2026-11 item 289) ──
// One card at a time in every config channel, read from the row alone: a stored card stays,
// the first unresolved step is the one new card, and the chart and the switches wait for the
// last step unless they are already posted.
describe("the setup walk", () => {
	// The rig's channel serves as 🧭onboarding here, on a guild that is not Community.
	function onboardingRig(row: Partial<HeadquartersRow> = {}) {
		const rigged = rig({ arcadeControlChannelId: null, onboardingConfigChannelId: "ch-arcade", ...row });
		Object.assign(rigged.guild, { features: [], roles: { cache: new Map() } });
		Object.assign(rigged.guild.channels, { cache: new Map() });
		return rigged;
	}
	const deroConfigRig = (row: Partial<HeadquartersRow> = {}) => rig({ arcadeControlChannelId: null, deroConfigChannelId: "ch-arcade", ...row });
	const serverConfigRig = (row: Partial<HeadquartersRow> = {}) => rig({ arcadeControlChannelId: null, serverConfigChannelId: "ch-arcade", ...row });

	const titlesOf = (messages: Map<string, FakeMessage>) => [...messages.values()].map((message) => message.embeds[0]!.title);
	const buttonLabels = (message: FakeMessage) =>
		(message.components as Array<{ toJSON(): { components: Array<{ label: string }> } }>).flatMap((row) => row.toJSON().components.map((button) => button.label));
	const descriptionOf = (message: FakeMessage) => message.embeds[0]!.data.description as string;

	describe("on a fresh row", () => {
		it("shows the Introductions card alone in 🧭onboarding, with no chart", async () => {
			const { guild, messages, stored } = onboardingRig();
			await syncHeadquartersChannel(guild, "onboarding");
			expect(titlesOf(messages)).toEqual([copy.onboarding.title, "📜 Introductions"]);
			expect(Object.keys(stored.tutorialCardMessageIds ?? {})).toEqual(["introChannelId"]);
			expect(stored.settingsChartMessageIds).toBeUndefined();
		});

		it("shows the voice card alone in ⚙️dero-config, with no chart", async () => {
			const { guild, messages, stored } = deroConfigRig();
			await syncHeadquartersChannel(guild, "deroConfig");
			expect(titlesOf(messages)).toEqual([copy.deroConfig.title, copy.deroConfig.steps[0]]);
			expect(Object.keys(stored.tutorialCardMessageIds ?? {})).toEqual(["deroConfig-voice"]);
			expect(stored.settingsChartMessageIds).toBeUndefined();
		});

		it("shows the timezone card alone in 🛠️server-config, with no chart and no switches", async () => {
			const { guild, messages, stored } = serverConfigRig();
			await syncHeadquartersChannel(guild, "serverConfig");
			expect(titlesOf(messages)).toEqual([copy.serverConfig.title, copy.serverConfig.steps.timezone]);
			expect(stored.settingsChartMessageIds).toBeUndefined();
			expect(stored.settingsSwitchesMessageIds).toBeUndefined();
		});

		it("shows only Turn the arcade on in 🎰arcade-control, with no step card", async () => {
			const { guild, messages, stored } = rig({ gamesCategoryId: null });
			await syncHeadquartersChannel(guild, "arcadeControl");
			expect(titlesOf(messages)).toEqual([copy.arcadeControl.enableTitle]);
			expect(stored.tutorialCardMessageIds).toBeUndefined();
			expect(buttonLabels([...messages.values()][0]!)).toEqual(["Step 1", copy.stepCards.skipButton]);
		});
	});

	describe("as a step resolves", () => {
		it("reveals the next card when a flow step finishes, leaving the finished card its Open alone", async () => {
			const { guild, send, messages, stored } = serverConfigRig();
			await syncHeadquartersChannel(guild, "serverConfig");
			const timezoneCard = messages.get(stored.tutorialCardMessageIds!["serverConfig-timezone"]!)!;
			expect(buttonLabels(timezoneCard)).toEqual([copy.stepCards.openButton, copy.stepCards.skipButton]);

			stored.timezone = "Asia/Tokyo";
			await syncHeadquartersChannel(guild, "serverConfig");

			expect(send).toHaveBeenCalledTimes(3);
			expect(titlesOf(messages).at(-1)).toBe(copy.serverConfig.steps.template);
			expect(buttonLabels(timezoneCard)).toEqual([copy.stepCards.openButton]);
		});

		it("holds a needsContinue step that reads done until its Continue, and never calls it skipped", async () => {
			const { guild, send, messages, stored } = serverConfigRig({ timezone: "Asia/Tokyo" });
			await syncHeadquartersChannel(guild, "serverConfig");
			await syncHeadquartersChannel(guild, "serverConfig");
			expect(send).toHaveBeenCalledTimes(2);
			const templateCard = messages.get(stored.tutorialCardMessageIds!["serverConfig-template"]!)!;
			expect(buttonLabels(templateCard)).toEqual([copy.stepCards.openButton, copy.stepCards.continueButton]);

			stored.setupStepsSkipped = ["serverConfig:template"];
			await syncHeadquartersChannel(guild, "serverConfig");

			expect(descriptionOf(templateCard)).toContain(copy.stepCards.continuedLine);
			expect(descriptionOf(templateCard)).not.toContain(copy.stepCards.skippedLine);
			expect(buttonLabels(templateCard)).toEqual([copy.stepCards.openButton]);
			expect(titlesOf(messages).at(-1)).toBe(copy.serverConfig.steps.kvkSeason);
		});

		it("posts the held switches and chart below the cards once the last step resolves", async () => {
			const listed = SERVER_FINISHED.setupStepsSkipped.filter((id) => id !== "serverConfig:rename");
			const { guild, messages, stored } = serverConfigRig({ setupStepsSkipped: listed });
			await syncHeadquartersChannel(guild, "serverConfig");
			expect(titlesOf(messages)).toEqual([copy.serverConfig.title, copy.serverConfig.steps.rename]);

			stored.setupStepsSkipped = SERVER_FINISHED.setupStepsSkipped;
			await syncHeadquartersChannel(guild, "serverConfig");

			expect(titlesOf(messages)).toEqual([copy.serverConfig.title, copy.serverConfig.steps.rename, copy.serverConfig.switches.title, copy.serverConfig.chartTitle]);
		});
	});

	// The real press, through the real queue: an owner's Skip lists the step and redraws.
	describe("a press walks the tutorial", () => {
		const pressBy = (guild: Guild) => {
			Object.assign(guild, { ownerId: "owner" });
			return { guild, user: { id: "owner" }, deferUpdate: vi.fn(async () => undefined) } as unknown as Parameters<typeof handleSkip>[0];
		};

		it("posts the next card once on a Skip, and the skipped card says so and keeps Add this channel", async () => {
			const { guild, send, messages, stored } = onboardingRig();
			await syncHeadquartersChannel(guild, "onboarding");
			const press = pressBy(guild);

			await handleSkip(press, "onboarding:intro");

			expect(press.deferUpdate).toHaveBeenCalledOnce();
			expect(send).toHaveBeenCalledTimes(3);
			expect(titlesOf(messages)).toEqual([copy.onboarding.title, "📜 Introductions", "📢 Announcements"]);
			const introCard = messages.get(stored.tutorialCardMessageIds!.introChannelId!)!;
			expect(descriptionOf(introCard)).toContain(copy.stepCards.skippedLine);
			expect(buttonLabels(introCard)).toEqual(["Add this channel"]);
		});

		it("posts the next card once on a double Skip, pressed in turn or at the same moment", async () => {
			const { guild, send } = onboardingRig();
			await syncHeadquartersChannel(guild, "onboarding");
			const press = pressBy(guild);

			await handleSkip(press, "onboarding:intro");
			await handleSkip(press, "onboarding:intro");
			expect(send).toHaveBeenCalledTimes(3);

			await Promise.all([handleSkip(press, "onboarding:announcements"), handleSkip(press, "onboarding:announcements")]);
			expect(send).toHaveBeenCalledTimes(4);
		});

		it("survives a redraw with the same state, as a restart would read it", async () => {
			const { guild, send, messages, stored } = onboardingRig();
			await syncHeadquartersChannel(guild, "onboarding");
			await handleSkip(pressBy(guild), "onboarding:intro");
			const introCard = messages.get(stored.tutorialCardMessageIds!.introChannelId!)!;
			const edits = introCard.edit.mock.calls.length;

			await syncHeadquartersChannel(guild, "onboarding");

			expect(send).toHaveBeenCalledTimes(3);
			expect(introCard.edit).toHaveBeenCalledTimes(edits);
			expect(stored.setupStepsSkipped).toEqual(["onboarding:intro"]);
		});

		it("moves past a needsContinue step on its Continue, which is the same press", async () => {
			const { guild, messages, stored } = serverConfigRig({ timezone: "Asia/Tokyo" });
			await syncHeadquartersChannel(guild, "serverConfig");
			await handleSkip(pressBy(guild), "serverConfig:template");
			const templateCard = messages.get(stored.tutorialCardMessageIds!["serverConfig-template"]!)!;
			expect(descriptionOf(templateCard)).toContain(copy.stepCards.continuedLine);
			expect(titlesOf(messages).at(-1)).toBe(copy.serverConfig.steps.kvkSeason);
		});

		it("leaves a skipped step skipped until its flow really finishes", async () => {
			const { guild, messages, stored } = serverConfigRig();
			await syncHeadquartersChannel(guild, "serverConfig");
			await handleSkip(pressBy(guild), "serverConfig:timezone");
			const timezoneCard = messages.get(stored.tutorialCardMessageIds!["serverConfig-timezone"]!)!;
			expect(descriptionOf(timezoneCard)).toContain(copy.stepCards.skippedLine);

			stored.timezone = "Asia/Tokyo";
			await syncHeadquartersChannel(guild, "serverConfig");

			expect(descriptionOf(timezoneCard)).not.toContain(copy.stepCards.skippedLine);
			expect(stored.setupStepsSkipped).toEqual(["serverConfig:timezone"]);
		});

		// Set up Dero's order (GuildSetupManager.buildHeadquartersAwaitingSetup): a build queues
		// its channel's fresh post, then setup awaits a plain sync that finds those cards.
		it("posts each card once when a fresh sync and a plain sync follow one another", async () => {
			const { guild, send, messages } = serverConfigRig();
			await Promise.all([syncHeadquartersChannel(guild, "serverConfig", { forcePost: true }), syncAllHeadquarters(guild)]);
			expect(send).toHaveBeenCalledTimes(2);
			expect(titlesOf(messages)).toEqual([copy.serverConfig.title, copy.serverConfig.steps.timezone]);
		});

		it("takes the arcade's Skip off its card, and arms no step card", async () => {
			const { guild, send, messages } = rig({ gamesCategoryId: null });
			await syncHeadquartersChannel(guild, "arcadeControl");
			await handleSkip(pressBy(guild), "arcadeControl:enable");
			expect(send).toHaveBeenCalledOnce();
			const card = [...messages.values()][0]!;
			expect(buttonLabels(card)).toEqual(["Step 1"]);
			expect(descriptionOf(card)).toContain(copy.stepCards.skippedLine);
		});
	});

	describe("on an existing row", () => {
		// A server set up before the walk: what it already holds is stored, so it is kept.
		async function seed(send: ReturnType<typeof rig>["send"], title: string): Promise<string> {
			const posted = await send({ embeds: [new EmbedBuilder().setTitle(title)] as never, components: [] });
			return posted.id;
		}
		const SEVEN_FIELDS = ["introChannelId", "announcementsChannelId", "scheduleChannelId", "welcomeChannelId", "rulesChannelId", "commandsChannelId", "meetingVoiceChannelId"] as const;
		const THREE_FIELDS = ["commandOutputChannelId", "leaderboardChannelId", "nextDecreeChannelId"] as const;
		const allChannels = Object.fromEntries([...SEVEN_FIELDS, ...THREE_FIELDS].map((field) => [field, `c-${field}`]));

		it("keeps every stored card and its chart, gains Remove, the three new cards and one flow card", async () => {
			const { guild, send, messages, stored } = onboardingRig(allChannels);
			const cardIds: Record<string, string> = {};
			for (const field of SEVEN_FIELDS) cardIds[field] = await seed(send, field);
			const chartId = await seed(send, copy.onboarding.chartTitle);
			const stepsId = await seed(send, copy.onboarding.title);
			Object.assign(stored, { tutorialCardMessageIds: cardIds, settingsChartMessageIds: { onboardingConfigChannelId: chartId }, setupStepsMessageIds: { onboardingConfigChannelId: stepsId } });
			const before = [...messages.values()];

			await syncHeadquartersChannel(guild, "onboarding");

			for (const message of before) expect(message.delete).not.toHaveBeenCalled();
			expect(titlesOf(messages).slice(before.length)).toEqual(["💬 Dero Commands", "🏆 Leaderboard", "🔜 Upcoming Events", copy.onboarding.steps[0]]);
			expect(buttonLabels(messages.get(cardIds.introChannelId!)!)).toEqual(["Channel ready", copy.stepCards.removeButton]);
			expect(stored.settingsChartMessageIds?.onboardingConfigChannelId).toBe(chartId);
		});

		it("gives a stored card past the frontier its Skip, and never takes it away", async () => {
			const { guild, send, messages, stored } = onboardingRig();
			const announcementsId = await seed(send, "📢 Announcements");
			stored.tutorialCardMessageIds = { announcementsChannelId: announcementsId };

			await syncHeadquartersChannel(guild, "onboarding");

			expect(buttonLabels(messages.get(announcementsId)!)).toEqual(["Add this channel", copy.stepCards.skipButton]);
			expect(titlesOf(messages)).toEqual(["📢 Announcements", copy.onboarding.title, "📜 Introductions"]);
		});

		it("keeps updating a stored chart and switches while the walk is unfinished", async () => {
			const { guild, send, messages, stored } = serverConfigRig();
			const chartId = await seed(send, copy.serverConfig.chartTitle);
			const switchesId = await seed(send, copy.serverConfig.switches.title);
			Object.assign(stored, { settingsChartMessageIds: { serverConfigChannelId: chartId }, settingsSwitchesMessageIds: { serverConfigChannelId: switchesId } });

			await syncHeadquartersChannel(guild, "serverConfig");

			expect(messages.get(chartId)!.delete).not.toHaveBeenCalled();
			expect(messages.get(chartId)!.edit).toHaveBeenCalledOnce();
			expect(messages.get(switchesId)!.edit).toHaveBeenCalledOnce();
			expect(titlesOf(messages)).toEqual([copy.serverConfig.chartTitle, copy.serverConfig.switches.title, copy.serverConfig.title, copy.serverConfig.steps.timezone]);
		});

		it("gains no flow card on a fully set up row", async () => {
			const { guild, send } = serverConfigRig({
				timezone: "Asia/Tokyo",
				kvkSeasonEnd: new Date(Date.now() + 86_400_000),
				hiddenChannels: ["x"],
				setupStepsSkipped: ["serverConfig:template", "serverConfig:leveling", "serverConfig:rename"],
			});
			events.findByGuildId.mockResolvedValue([{ type: "recurring", intervalHours: 168, seasonEnd: null, paused: false }]);
			await syncHeadquartersChannel(guild, "serverConfig");
			const titles = send.mock.calls.map((call) => (call[0] as { embeds: Array<{ toJSON(): { title: string } }> }).embeds[0]!.toJSON().title);
			expect(titles).toEqual([copy.serverConfig.title, copy.serverConfig.switches.title, copy.serverConfig.chartTitle]);
			events.findByGuildId.mockResolvedValue([]);
		});
	});

	describe("in 🎰arcade-control", () => {
		it("gives each arcade step a card once the arcade is on, Dismantle staying on the steps card", async () => {
			const { guild, messages, stored } = rig({});
			await syncHeadquartersChannel(guild, "arcadeControl");
			expect(titlesOf(messages)).toEqual([copy.arcadeControl.title, copy.arcadeControl.steps[1]]);
			expect(Object.keys(stored.tutorialCardMessageIds ?? {})).toEqual(["arcadeControl-chips"]);
			expect(buttonLabels([...messages.values()][0]!)).toContain(copy.arcadeControl.dismantleButton);
		});

		it("deletes the stored step cards while the arcade is off, clears their ids and keeps the skip list", async () => {
			const { guild, messages, stored } = rig({ setupStepsSkipped: ["arcadeControl:chips"] });
			await syncHeadquartersChannel(guild, "arcadeControl");
			const reachId = stored.tutorialCardMessageIds!["arcadeControl-reach"]!;
			const reachCard = messages.get(reachId)!;

			stored.gamesCategoryId = null;
			await syncHeadquartersChannel(guild, "arcadeControl");

			expect(reachCard.delete).toHaveBeenCalledOnce();
			expect(stored.tutorialCardMessageIds!["arcadeControl-reach"]).toBeNull();
			expect(stored.setupStepsSkipped).toEqual(["arcadeControl:chips"]);
			expect(titlesOf(messages)).toEqual([copy.arcadeControl.enableTitle]);
		});

		it("posts no step card and deletes nothing it was not asked to while the arcade stays off", async () => {
			const { guild, send } = rig({ gamesCategoryId: null, setupStepsSkipped: ["arcadeControl:enable"] });
			await syncHeadquartersChannel(guild, "arcadeControl");
			expect(send).toHaveBeenCalledOnce();
		});
	});

	it("keeps no step card when a stored id's message is gone but a lost id's title still stands", async () => {
		const { guild, send, stored } = serverConfigRig();
		await syncHeadquartersChannel(guild, "serverConfig");
		stored.tutorialCardMessageIds = {};
		await syncHeadquartersChannel(guild, "serverConfig");
		expect(send).toHaveBeenCalledTimes(2);
		expect(stored.tutorialCardMessageIds?.["serverConfig-timezone"]).toBeTruthy();
	});
});

// ── the step model at its views (2026-11 item 289) ──
// A step that can read done with nobody acting on it waits for a Continue; every other step
// reads not done on a fresh row, which is what lets the walk start at one card.
describe("the steps of a fresh row", () => {
	const facts = { communityOn: false, onboardingOn: false, gated: false, memberRoleName: null, adoptedPlaced: true, adoptedLines: [] };
	const fresh = { now: 0, activeEvents: 0, pausedEvents: 0, weeklySchedules: 0 };

	it("mark exactly the seven steps that need a Continue", () => {
		const views = { deroConfig: deroConfigView(null), onboarding: onboardingView(facts, {}), arcadeControl: arcadeControlView({ gamesCategoryId: "cat" }), serverConfig: serverConfigView({}, fresh) };
		const continued = Object.entries(views).flatMap(([domain, view]) => view.steps.filter((step) => step.needsContinue).map((step) => `${domain}:${step.key}`));
		expect(continued).toEqual(["deroConfig:priority", "onboarding:adopted", "onboarding:gating", "arcadeControl:chips", "serverConfig:template", "serverConfig:leveling", "serverConfig:rename"]);
	});

	it("read done only on a step that needs a Continue, so no walk jumps two cards", () => {
		const views = [deroConfigView(null), onboardingView(facts, {}), arcadeControlView({ gamesCategoryId: "cat" }), serverConfigView({}, fresh)];
		for (const view of views) expect(view.steps.filter((step) => step.done && !step.needsContinue).map((step) => step.key)).toEqual([]);
	});

	it("teach every flow step from setupCopy in one or two sentences, and say nothing the flows do not", () => {
		const views = [deroConfigView(null), { steps: onboardingFlowSteps(onboardingView(facts, {})) }, arcadeControlView({ gamesCategoryId: "cat" }), serverConfigView({}, fresh)];
		const steps = views.flatMap((view) => view.steps);
		expect(steps).toHaveLength(17);
		for (const step of steps) {
			expect(step.teaching.length, step.key).toBeGreaterThan(30);
			expect(step.teaching.split(/[.!?](?:\s|$)/).filter(Boolean).length, step.key).toBeLessThanOrEqual(2);
			expect(step.teaching, step.key).not.toMatch(/always on|brain/i);
		}
	});
});
