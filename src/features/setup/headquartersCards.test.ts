import { describe, it, expect, vi, beforeEach } from "vitest";
import { AttachmentBuilder, ButtonStyle, TextChannel, type Guild } from "discord.js";

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn(), update: vi.fn() } }));
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
	syncHeadquartersChannel,
	type HeadquartersRow,
} from "./headquartersCards.js";

// ── 🏰 DERO HEADQUARTERS steps cards and charts (2026-10 item 257 Phase 2b, owner item 7) ──
// The marks are read from a fixture config; each step's button names the flow it
// opens; the two messages are posted once, pinned where they should be, edited only
// when what they show changed, and redrawn after a change.

const store = guildConfigStore as unknown as { findByGuildId: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
const events = eventStore as unknown as { findByGuildId: ReturnType<typeof vi.fn> };
const voiceStore = deroVoiceConfigStore as unknown as { findByGuildId: ReturnType<typeof vi.fn> };
const render = renderSettingsChart as unknown as ReturnType<typeof vi.fn>;
const copy = setupCopy.headquarters;

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
	it("⚙️dero-config: every step done for a configured voice row, and steps 1 to 3 not done for a fresh one", () => {
		expect(deroConfigView(voiceRow()).steps.map((step) => step.done)).toEqual([true, true, true, true, true]);
		expect(deroConfigView(voiceRow({ enabled: false, allowedVoiceChannelIds: [], allowedRoleIds: [] })).steps.map((step) => step.done)).toEqual([
			false,
			false,
			false,
			true,
			true,
		]);
		expect(deroConfigView(null).steps.every((step) => !step.done)).toBe(true);
	});

	it("⚙️dero-config's chart shows each switch and the priority order the admin chose first", () => {
		const rows = deroConfigView(voiceRow()).chart.rows;
		expect(rows[0]).toEqual({ label: copy.deroConfig.rows.voice, kind: "switch", on: true });
		expect(rows.at(-1)).toMatchObject({ kind: "value", value: expect.stringMatching(/^Arcade Lounge › Meeting Hall/) });
	});

	it("🧭onboarding: step 4 carries no button and its /setup note; the others carry their own flow's customId", () => {
		const view = onboardingView({ communityOn: true, onboardingOn: false, gated: true, memberRoleName: "Members", adoptedPlaced: true });
		expect(view.steps.map((step) => step.done)).toEqual([true, true, false, true]);
		expect(view.steps.map((step) => step.customId)).toEqual([COMMUNITY_CUSTOM_IDS.enable, CHOOSE_BUTTON_ID, COMMUNITY_CUSTOM_IDS.configure, null]);
		const card = buildStepsCard(view);
		expect(card.embeds[0]!.data.description).toContain(copy.onboarding.gatingNote);
		expect(card.components.flatMap((row) => row.components)).toHaveLength(3);
	});

	it("🧭onboarding's chart says unknown, not off, when Onboarding could not be read", () => {
		const rows = onboardingView({ communityOn: true, onboardingOn: null, gated: false, memberRoleName: null, adoptedPlaced: false }).chart.rows;
		expect(rows[1]).toEqual({ label: copy.onboarding.rows.onboarding, kind: "value", value: copy.unknown });
		expect(rows[2]).toMatchObject({ value: copy.notSet });
	});

	it("🎰arcade-control: the arcade off and nothing set marks only the switches that default on", () => {
		const off = arcadeControlView({ gamesCategoryId: null } as HeadquartersRow);
		expect(off.steps.map((step) => step.done)).toEqual([false, true, true, false, false]);
		expect(off.steps.at(-1)?.optional).toBe(true);
		const on = arcadeControlView({ gamesCategoryId: "cat", chipEconomyEnabled: false, challengeReach: "network", blockedNetworkGuildIds: ["x"] } as HeadquartersRow);
		expect(on.steps.map((step) => step.done)).toEqual([true, false, true, true, true]);
	});
});

// ── 🛠️server-config, the fourth domain (2026-10 item 263 Phase 4a) ──

const NOW = Date.parse("2026-10-28T12:00:00Z");
const noEvents = { now: NOW, activeEvents: 0, pausedEvents: 0, weeklySchedules: 0 };

describe("🛠️server-config's steps and chart", () => {
	it("on a fresh server marks only leveling, which ships on, and names every step in order", () => {
		const view = serverConfigView({}, noEvents);
		expect(view.title).toBe(copy.serverConfig.title);
		expect(view.steps.map((step) => step.label)).toEqual(SERVER_CONFIG_STEPS.map((key) => copy.serverConfig.steps[key]));
		expect(view.steps.map((step) => step.done)).toEqual([false, false, false, false, true]);
		expect(view.steps.map((step) => step.customId)).toEqual(SERVER_CONFIG_STEPS.map((_key, index) => stepCustomId("serverConfig", index + 1)));
	});

	it("marks every step done for a configured server", () => {
		const view = serverConfigView(
			{ kvkSeasonEnd: new Date(NOW + 86_400_000), hiddenChannels: ["leaderboardChannelId"], leveling: { enabled: true } },
			{ now: NOW, activeEvents: 3, pausedEvents: 1, weeklySchedules: 1 }
		);
		expect(view.steps.every((step) => step.done)).toBe(true);
	});

	it("reads a past KvK season and switched off leveling as not done", () => {
		const view = serverConfigView({ kvkSeasonEnd: new Date(NOW - 1), leveling: { enabled: false } }, noEvents);
		expect(view.steps[0]?.done).toBe(false);
		expect(view.steps[4]?.done).toBe(false);
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
		arcadeControl: copy.arcadeControl.title,
		serverConfig: copy.serverConfig.title,
	};

	it.each([...HEADQUARTERS_DOMAINS])("%s draws its own card and chart", async (domain) => {
		const view = await readDomainView(guild, {}, domain);
		expect(view.title).toBe(titles[domain]);
		expect(new Set(Object.values(titles)).size).toBe(HEADQUARTERS_DOMAINS.length);
	});

	it("counts the server's events for 🛠️server-config, a weekly stream among them", async () => {
		events.findByGuildId.mockResolvedValueOnce([
			{ type: "recurring", intervalHours: 168, seasonEnd: null, paused: false },
			{ type: "recurring", intervalHours: 36, seasonEnd: new Date(NOW), paused: true },
		]);
		const view = await readDomainView(guild, {}, "serverConfig");
		expect(view.steps.map((step) => step.done).slice(1, 3)).toEqual([true, true]);
		const valueOf = (label: string) => view.chart.rows.find((row) => row.label === label);
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
		expect(marks(card.embeds[0]!.data.description)).toEqual([copy.todo.slice(0, 1), copy.done.slice(0, 1), copy.done.slice(0, 1), copy.done.slice(0, 1), copy.done.slice(0, 1)]);
		const buttons = card.components.flatMap((row) => row.components.map((button) => button.toJSON() as { custom_id: string; label: string }));
		expect(buttons.map((button) => button.custom_id)).toEqual([1, 2, 3, 4, 5].map((step) => stepCustomId("deroConfig", step)));
		expect(buttons.map((button) => button.label)).toEqual(["Step 1", "Step 2", "Step 3", "Step 4", "Step 5"]);
		// Step 1 is open, grey; the rest are done, green (R3-21).
		const styles = card.components.flatMap((row) => row.components.map((button) => (button.toJSON() as { style: ButtonStyle }).style));
		expect(styles).toEqual([ButtonStyle.Secondary, ButtonStyle.Success, ButtonStyle.Success, ButtonStyle.Success, ButtonStyle.Success]);
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
	store.update.mockImplementation(async (_guildId: string, writes: Record<string, string>) => {
		for (const [path, value] of Object.entries(writes)) {
			const [group, key] = path.split(".") as ["setupStepsMessageIds" | "settingsChartMessageIds" | "settingsSwitchesMessageIds", string];
			stored[group] = { ...(stored[group] ?? {}), [key]: value };
		}
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
		const { guild, send, messages, stored } = rig({});
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
		const { guild, send } = rig({});
		await syncHeadquartersChannel(guild, "arcadeControl");
		const chartPayload = send.mock.calls[1]![0] as { files: unknown[]; embeds: Array<{ toJSON(): { image?: { url: string } } }> };
		expect(chartPayload.files).toEqual([attachment]);
		expect(chartPayload.embeds[0]!.toJSON().image?.url).toBe("attachment://settings-chart-x.png");
	});

	it("writes nothing when nothing changed, and redraws after a change", async () => {
		const { guild, send, messages, stored } = rig({});
		await syncHeadquartersChannel(guild, "arcadeControl");
		await syncHeadquartersChannel(guild, "arcadeControl");
		const [steps, chart] = [...messages.values()];
		expect(send).toHaveBeenCalledTimes(2);
		expect(steps!.edit).not.toHaveBeenCalled();
		expect(chart!.edit).not.toHaveBeenCalled();
		expect(render).not.toHaveBeenCalledTimes(2);

		stored.chipEconomyEnabled = false;
		refreshHeadquartersCards(guild, "arcadeControl");
		await vi.waitFor(() => expect(chart!.edit).toHaveBeenCalledOnce());
		expect(steps!.edit).toHaveBeenCalledOnce();
		expect(send).toHaveBeenCalledTimes(2);
	});

	it("reposts a deleted card and adopts one whose stored id was lost", async () => {
		const { guild, send, messages, stored } = rig({});
		await syncHeadquartersChannel(guild, "arcadeControl");
		const [steps] = [...messages.values()];
		messages.delete(steps!.id);
		stored.settingsChartMessageIds = {};
		await syncHeadquartersChannel(guild, "arcadeControl");
		expect(send).toHaveBeenCalledTimes(3);
		expect(stored.settingsChartMessageIds?.arcadeControlChannelId).toBe("msg-2");
	});

	it("posts 🛠️server-config's steps card, then its switches, then its chart, and stores all three ids", async () => {
		const { guild, send, messages, stored } = rig({ arcadeControlChannelId: null, serverConfigChannelId: "ch-arcade" });
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

	it("does nothing for a guild with no such channel, and never throws", async () => {
		const { guild, send } = rig({ arcadeControlChannelId: null });
		await expect(syncHeadquartersChannel(guild, "arcadeControl")).resolves.toBeUndefined();
		expect(send).not.toHaveBeenCalled();
		store.findByGuildId.mockRejectedValue(new Error("mongo down"));
		await expect(syncHeadquartersChannel(guild, "arcadeControl")).resolves.toBeUndefined();
	});
});
