import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, TextChannel, type Guild, type Message } from "discord.js";
import { COLORS } from "@base/copy/brand.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { deroVoiceConfigStore } from "@db/stores/deroVoiceConfigStore.js";
import type { IDeroVoiceConfig } from "@db/models/DeroVoiceConfig.js";
import { isRenderPayload, withRenderFallback } from "@features/renderer/index.js";
import { renderSettingsChart, settingsChartEmbed, type SettingsChartRow, type SettingsChartView } from "@features/renderer/settingsChartRenderer.js";
import { isCommunityEnabled } from "@features/community/enableCommunity.js";
import { COMMUNITY_CUSTOM_IDS } from "@features/community/communityControls.js";
import { fetchOnboardingSnapshot } from "@features/community/onboardingChannels.js";
import { normalizePriorityOrder } from "@features/voice/voicePriority.js";
import { voiceCopy } from "@features/voice/voiceCopy.js";
import { eventStore } from "@db/stores/eventStore.js";
import { normalizeLevelingSettings } from "@features/leveling/levelingConfig.js";
import { buildAdminControlButtons } from "@features/power-ups/PowerUps.js";
import { CHOOSE_BUTTON_ID, adoptedChannelLines, choosableAdoptedChannels, type IAdoptionChoiceRow } from "./adoptionChoice.js";
import { readAdoptionChoice } from "./adoption.js";
import { isMemberRoleGated } from "./communityOverwrites.js";
import { setupCopy } from "./setupCopy.js";
import { buildButtons as buildArcadeControlButtons } from "./arcadeControlCards.js";
import { buildCards as buildStepCards, buildSkipButton, cardKeyOf, channelSteps, progressOf, revealedSteps, stepIdOf, type StepProgress, type TutorialRow } from "./tutorialCards.js";
import { getPluginCopy, type ICopyConfig } from "@base/copy/getCopy.js";
import { DEFAULT_SERVER_TIMEZONE, resolveServerTimezone } from "@utils/tzParser.js";
import { createGuildQueue } from "@utils/guildQueue.js";

// ── headquartersCards ───────────────────────────────────────────────────────
// What:  the messages each 🏰 DERO HEADQUARTERS config channel holds under its
//        intro (2026-10 item 257 Phase 2b, owner item 7): the pinned steps card, the
//        table of contents, whose marks are read from the server as it stands and
//        whose buttons jump to each step's existing flow, and the drawn settings chart of
//        every switch in that channel's domain. 🛠️server-config (2026-10 item 263
//        Phase 4a) keeps a third, the server switches. Beneath the steps card sit the step
//        cards (2026-11 item 289, tutorialCards.ts), revealed one at a time, and the chart
//        and the switches wait below them until every step is resolved.
// Who:   GuildSetupManager after a full build and on every boot (refreshIntroEmbeds);
//        after every change in a domain, fire and forget: the /dero-config and /arcade
//        commands (the settings panels run them), the voice priority step, the
//        Community and Onboarding confirms and the adoption choice.
// Where: one step button per step. A step that is a flow with its own customId (the
//        Community buttons, the adoption Choose) carries that very customId; the rest
//        share a settings panel or a command leaf, and Discord wants every customId on
//        a message unique, so they carry `hqstep:<domain>:<step>` and
//        headquartersSteps.ts routes them. Nothing here opens a flow of its own.
// How:   each message is kept like 🕹️games' Challenge Board (maintainGamesBoard): the
//        stored id first, then adopted by its embed title among Dero's recent
//        messages, edited in place only when what it shows changed, and posted fresh
//        beneath a freshly posted intro so the order stays intro, steps, cards, chart. One
//        guild's syncs run one after another, each reading the row inside the queue, so a
//        double press cannot post a card twice. Every failure logs one line and never
//        throws (rulebook convention 7).

/** The four Headquarters config channels, by the domain each one sets up. */
export const HEADQUARTERS_DOMAINS = ["deroConfig", "onboarding", "arcadeControl", "serverConfig"] as const;
export type HeadquartersDomain = (typeof HEADQUARTERS_DOMAINS)[number];

/** The GuildConfig field holding each domain's channel, which also keys its message ids. */
export const DOMAIN_CHANNEL_FIELDS: Record<HeadquartersDomain, "deroConfigChannelId" | "onboardingConfigChannelId" | "arcadeControlChannelId" | "serverConfigChannelId"> = {
	deroConfig: "deroConfigChannelId",
	onboarding: "onboardingConfigChannelId",
	arcadeControl: "arcadeControlChannelId",
	serverConfig: "serverConfigChannelId",
};

// 🛠️server-config's steps by key, in card order (2026-10 item 263 Phase 4a). Each key
// carries its label (setupCopy), its mark (serverConfigView) and its route
// (headquartersSteps.ts), so a step inserted anywhere moves its number, its mark and
// its button together; Phase 4c's timezone came in at the front that way, and Dero's
// template after it (2026-10 item 262 Phase 4). The 8th, rename, is an info step that
// teaches /server channels rename and changes nothing (2026-11 item 285 Phase 4).
export const SERVER_CONFIG_STEPS = ["timezone", "template", "kvkSeason", "streams", "events", "channels", "leveling", "rename"] as const;
export type ServerConfigStep = (typeof SERVER_CONFIG_STEPS)[number];

// The server switches message's buttons by key, in order; Refresh standings follows them.
export const SERVER_SWITCHES = ["autoHeal", "tracking", "weekStart"] as const;
export type ServerSwitch = (typeof SERVER_SWITCHES)[number];

/** The customId prefix of a step that headquartersSteps.ts routes. */
export const HEADQUARTERS_STEP_PREFIX = "hqstep";

export function stepCustomId(domain: HeadquartersDomain, step: number): string {
	return `${HEADQUARTERS_STEP_PREFIX}:${domain}:${step}`;
}

// A switch button shares the step prefix so headquartersSteps.ts routes it, and is told
// apart from a numbered step by its `switch-` tail.
export const SWITCH_STEP_TAIL = "switch-";

export function switchCustomId(name: ServerSwitch): string {
	return `${HEADQUARTERS_STEP_PREFIX}:serverConfig:${SWITCH_STEP_TAIL}${name}`;
}

// Discord fits five buttons in a row; the owner asked for two rows at most.
const BUTTONS_PER_ROW = 5;
const MAX_STEP_ROWS = 2;
// How far back the adopt scan looks for a card whose stored id was lost, the same
// window maintainGamesBoard reads.
const ADOPT_SCAN_LIMIT = 20;

const copy = setupCopy.headquarters;

// ── state ────────────────────────────────────────────────────────────────────

/** The GuildConfig fields this module reads. */
export interface HeadquartersRow extends IAdoptionChoiceRow, TutorialRow {
	deroConfigChannelId?: string | null;
	onboardingConfigChannelId?: string | null;
	arcadeControlChannelId?: string | null;
	serverConfigChannelId?: string | null;
	gamesCategoryId?: string | null;
	chipEconomyEnabled?: boolean | null;
	arcadeMonthlyPost?: boolean | null;
	botOpponentsEnabled?: boolean | null;
	challengeReach?: string | null;
	blockedNetworkGuildIds?: string[] | null;
	setupStepsMessageIds?: Partial<Record<string, string | null>> | null;
	settingsChartMessageIds?: Partial<Record<string, string | null>> | null;
	settingsSwitchesMessageIds?: Partial<Record<string, string | null>> | null;
	tutorialCardMessageIds?: Partial<Record<string, string | null>> | null;
	// 🛠️server-config's reads, all off the row.
	timezone?: string | null;
	timezoneSetAt?: Date | string | null;
	// Dero's template, the copy pack id (the schema default is rok-commander).
	pluginId?: string | null;
	kvkSeasonEnd?: Date | string | null;
	autoHealEnabled?: boolean | null;
	leaderboardTrackingEnabled?: boolean | null;
	weekStart?: string | null;
	hiddenChannels?: string[] | null;
	channelNames?: Map<string, string> | Record<string, string> | null;
	leveling?: unknown;
}

/** One numbered step of a steps card. A step with no customId shows its mark only. */
export interface SetupStep {
	// With its domain, the step's id (tutorialCards.stepIdOf) and its card's key.
	key: string;
	// A channel step builds a notice board channel; a flow step opens an existing flow.
	kind: "channel" | "flow";
	label: string;
	done: boolean;
	// True when `done` can read true with nobody acting on it, so the step waits for Continue.
	needsContinue: boolean;
	teaching: string;
	optional?: boolean;
	note?: string;
	customId: string | null;
	// Filled in by readDomainView, the one place the skip list meets a view, so views stay pure.
	progress?: StepProgress;
}

/** One message of buttons kept between a domain's steps card and its chart. */
export interface SwitchesView {
	title: string;
	lines: string[];
	buttons: ButtonBuilder[];
}

/**
 * What one domain shows: its steps, its chart and, for 🛠️server-config, its switches.
 * `extraButtons` are buttons that sit beside the numbered steps on their own row without
 * being a step (🎰arcade-control's Dismantle and Enable, 2026-11 item 285 Phase 4).
 */
export interface DomainView {
	title: string;
	steps: SetupStep[];
	// Null when the channel shows its steps card alone (🎰arcade-control while the arcade
	// is off); a chart already posted is then deleted.
	chart: SettingsChartView | null;
	switches?: SwitchesView;
	extraButtons?: ButtonBuilder[];
	// How many rows the step buttons may fill, when it is not MAX_STEP_ROWS.
	stepRows?: number;
	// The steps card is the one step's own card, so no step card posts beneath it.
	ownCardOnly?: boolean;
}

// The steps whose done mark can read true with nobody acting on it (2026-11 item 289): a
// saved voice row, nothing adopted, a gate that follows on its own, the arcade switches, a
// template, leveling, and the rename step, which has nothing to finish. Each waits for a
// Continue, or the walk would jump past a card nobody saw.
const CONTINUE_STEPS: ReadonlySet<string> = new Set([
	"deroConfig:priority",
	"onboarding:adopted",
	"onboarding:gating",
	"arcadeControl:chips",
	"serverConfig:template",
	"serverConfig:leveling",
	"serverConfig:rename",
]);

/** The fields of a flow step a view decides; the rest follow from its domain and key. */
type FlowStepFields = Pick<SetupStep, "label" | "done" | "customId" | "optional" | "note">;

function flowStep(domain: HeadquartersDomain, key: string, fields: FlowStepFields): SetupStep {
	const teaching = (copy.stepTeaching[domain] as Record<string, string>)[key] ?? "";
	return { ...fields, key, kind: "flow", needsContinue: CONTINUE_STEPS.has(stepIdOf(domain, key)), teaching };
}

const onOff = { onLabel: copy.on, offLabel: copy.off };
const toggle = (label: string, on: boolean): SettingsChartRow => ({ label, kind: "switch", on });
const value = (label: string, text: string): SettingsChartRow => ({ label, kind: "value", value: text });

const DERO_CONFIG_STEP_KEYS = ["voice", "priority"] as const;

/** ⚙️dero-config: Dero's voice row, or its defaults when no admin saved one yet. */
export function deroConfigView(voice: IDeroVoiceConfig | null): DomainView {
	const domain = copy.deroConfig;
	const order = normalizePriorityOrder(voice?.priorityOrder);
	// Two steps (2026-10 item 263 Phase 4b, owner decision 15): the settings panel is done
	// once the voice is on with a channel to join (the task roles are optional, since the
	// owner and the admin role always may), and the order, which has a working default,
	// once a row is saved. The marks, the labels and the routes are index based, so the
	// three lists move together.
	const done = [voice?.enabled === true && voice.allowedVoiceChannelIds.length > 0, voice !== null];
	return {
		title: domain.title,
		steps: domain.steps.map((label, index) => flowStep("deroConfig", DERO_CONFIG_STEP_KEYS[index] ?? "", { label, done: done[index] ?? false, customId: stepCustomId("deroConfig", index + 1) })),
		chart: {
			title: domain.chartTitle,
			subtitle: domain.chartSubtitle,
			...onOff,
			rows: [
				toggle(domain.rows.voice, voice?.enabled ?? false),
				toggle(domain.rows.listen, voice?.listenEnabled ?? true),
				value(domain.rows.roles, copy.count(voice?.allowedRoleIds.length ?? 0)),
				value(domain.rows.voiceChannels, copy.count(voice?.allowedVoiceChannelIds.length ?? 0)),
				// Hidden by the owner's decision of 2026-10-27 (2026-10 item 263 Phase 4b); returns later.
				// value(domain.rows.cap, voice ? copy.dollars(voice.monthlyCapUsd) : copy.notSet),
				value(domain.rows.priority, order.map((category) => voiceCopy.priority.label(category)).join(" › ")),
			],
		},
	};
}

/** What the 🧭onboarding view reads beyond the row: the live guild and its Onboarding switch. */
export interface OnboardingFacts {
	communityOn: boolean;
	// null when Discord refused the read (Dero lacks Manage Server, or the server is not Community).
	onboardingOn: boolean | null;
	gated: boolean;
	memberRoleName: string | null;
	// Every adopted channel an admin may place has an answer; true when there is none to place.
	adoptedPlaced: boolean;
	// One line per adopted channel an admin may place ("#spawn-point as the welcome log"); empty when there is none.
	adoptedLines: string[];
}

/**
 * 🧭onboarding: the ten channel steps first, then Community, the server's own channels,
 * Discord Onboarding and gating (2026-11 item 289). The own channels step names the channels
 * Dero adopted, so the choice lives here and no card posts in 🔒inner-sanctum (2026-10 item
 * 263 Phase 4b, R3-19); with none adopted it stays in place as done, its line saying there is
 * nothing to choose. Gating carries no button: /setup names the member role (option A).
 */
export function onboardingView(facts: OnboardingFacts, row: HeadquartersRow): DomainView {
	const domain = copy.onboarding;
	const [community, adopted, onboarding, gating] = domain.steps;
	return {
		title: domain.title,
		// Past the owner's two row limit on this one channel: its 13 buttons, one per channel it
		// can build and one per flow, cannot fit in two rows of five.
		stepRows: 3,
		steps: [
			...channelSteps(row, getPluginCopy(row as unknown as ICopyConfig)),
			flowStep("onboarding", "community", { label: community, done: facts.communityOn, customId: COMMUNITY_CUSTOM_IDS.enable }),
			flowStep("onboarding", "adopted", { label: adopted, done: facts.adoptedPlaced, note: facts.adoptedLines.length > 0 ? facts.adoptedLines.join("\n") : domain.nothingAdopted, customId: CHOOSE_BUTTON_ID }),
			flowStep("onboarding", "discordOnboarding", { label: onboarding, done: facts.onboardingOn === true, customId: COMMUNITY_CUSTOM_IDS.configure }),
			flowStep("onboarding", "gating", { label: gating, done: facts.gated, note: domain.gatingNote, customId: null }),
		],
		chart: {
			title: domain.chartTitle,
			subtitle: domain.chartSubtitle,
			...onOff,
			rows: [
				toggle(domain.rows.community, facts.communityOn),
				facts.onboardingOn === null ? value(domain.rows.onboarding, copy.unknown) : toggle(domain.rows.onboarding, facts.onboardingOn),
				value(domain.rows.memberRole, facts.memberRoleName ?? copy.notSet),
				toggle(domain.rows.gating, facts.gated),
				toggle(domain.rows.adoptedPlaced, facts.adoptedPlaced),
			],
		},
	};
}

const ARCADE_CONTROL_STEP_KEYS = ["enable", "chips", "reach", "block"] as const;

/** 🎰arcade-control, read from the row alone. The daily claim rides the chip switch. */
export function arcadeControlView(row: HeadquartersRow): DomainView {
	const domain = copy.arcadeControl;
	const arcadeOn = Boolean(row.gamesCategoryId);
	// A row that never stored a switch reads as on, the schema default and what the
	// arcade build writes (2026-10 item 257, owner item 11).
	const chipsOn = row.chipEconomyEnabled !== false;
	const monthlyPost = row.arcadeMonthlyPost !== false;
	const bots = row.botOpponentsEnabled !== false;
	const reach = row.challengeReach ?? "server";
	const blocked = row.blockedNetworkGuildIds?.length ?? 0;
	// Chips, the monthly post and the bots are one step since they share the /arcade panel
	// (2026-10 item 263 Phase 4b, owner decision 15); marks, labels and routes stay index based.
	const done = [arcadeOn, chipsOn && monthlyPost && bots, reach === "network", blocked > 0];
	const steps = domain.steps.map((label, index) =>
		flowStep("arcadeControl", ARCADE_CONTROL_STEP_KEYS[index] ?? "", {
			label,
			done: done[index] ?? false,
			// Blocking a server is never required, so its step says so rather than nagging.
			optional: index === domain.steps.length - 1,
			customId: stepCustomId("arcadeControl", index + 1),
		})
	);
	// While the arcade is off the channel shows one card, the enable step alone, with no
	// chart and no Dismantle (2026-11 item 285 debug pass, owner ruling). That card is the
	// step's own, so it carries the step's Skip until the step is skipped (2026-11 item 289).
	// Once the arcade is on that card is replaced by the rest of the steps, which keep their
	// routes (step 2 is still hqstep:arcadeControl:2) while the card numbers them from 1.
	if (!arcadeOn) {
		const enableSkipped = (row.setupStepsSkipped ?? []).includes(stepIdOf("arcadeControl", "enable"));
		return { title: domain.enableTitle, steps: steps.slice(0, 1), chart: null, ownCardOnly: true, extraButtons: enableSkipped ? [] : [buildSkipButton("arcadeControl", "enable")] };
	}
	return {
		title: domain.title,
		steps: steps.slice(1),
		chart: {
			title: domain.chartTitle,
			subtitle: domain.chartSubtitle,
			...onOff,
			rows: [
				toggle(domain.rows.arcade, arcadeOn),
				toggle(domain.rows.chips, chipsOn),
				toggle(domain.rows.monthlyPost, monthlyPost),
				toggle(domain.rows.bots, bots),
				value(domain.rows.reach, domain.reach[reach] ?? reach),
				value(domain.rows.blocked, copy.count(blocked)),
			],
		},
		extraButtons: buildArcadeControlButtons(),
	};
}

/** What the 🛠️server-config view reads beyond the row: the server's active events. */
export interface ServerConfigFacts {
	now: number;
	activeEvents: number;
	pausedEvents: number;
	// Recurring every week with no season: what /events stream weekly writes.
	weeklySchedules: number;
}

const WEEK_HOURS = 168;

function countOverrides(names: HeadquartersRow["channelNames"]): number {
	if (!names) return 0;
	return names instanceof Map ? names.size : Object.keys(names).length;
}

function seasonEndOf(row: HeadquartersRow): Date | null {
	if (!row.kvkSeasonEnd) return null;
	const end = new Date(row.kvkSeasonEnd);
	return Number.isNaN(end.getTime()) ? null : end;
}

/** 🛠️server-config, the server's own configs (2026-10 item 263 Phase 4a, owner decision 13). */
export function serverConfigView(row: HeadquartersRow, facts: ServerConfigFacts): DomainView {
	const domain = copy.serverConfig;
	const seasonEnd = seasonEndOf(row);
	const hidden = row.hiddenChannels?.length ?? 0;
	const renamed = countOverrides(row.channelNames);
	const leveling = normalizeLevelingSettings(row.leveling).enabled;
	// A row that never stored a switch reads as the schema default: both on, Sunday.
	const autoHeal = row.autoHealEnabled !== false;
	const tracking = row.leaderboardTrackingEnabled !== false;
	const weekStart = row.weekStart === "monday" ? "monday" : "sunday";
	const timezone = resolveServerTimezone(row.timezone);
	// Any id but the streamer one reads as the kingdom template, as getPluginCopy reads it.
	const template = row.pluginId === "general-events" ? "general-events" : "rok-commander";
	const done: Record<ServerConfigStep, boolean> = {
		// Every row reads UTC by default, so UTC alone is done only once an admin saved it.
		timezone: timezone !== DEFAULT_SERVER_TIMEZONE || Boolean(row.timezoneSetAt),
		// Either template is a working answer, so the step is done from the start; it shows
		// which one in the chart rather than nag for a choice.
		template: true,
		kvkSeason: seasonEnd !== null && seasonEnd.getTime() > facts.now,
		streams: facts.weeklySchedules > 0,
		events: facts.activeEvents > 0,
		channels: hidden + renamed > 0,
		leveling,
		// An info step has nothing to finish, so it never reads done; it says optional
		// below so the open mark does not nag.
		rename: false,
	};
	// Not every server runs a KvK season, streams or custom channel names, so those
	// steps say they are optional rather than nag.
	const optional: Record<ServerConfigStep, boolean> = { timezone: false, template: false, kvkSeason: true, streams: true, events: false, channels: true, leveling: false, rename: true };
	return {
		title: domain.title,
		steps: SERVER_CONFIG_STEPS.map((key, index) =>
			flowStep("serverConfig", key, { label: domain.steps[key], done: done[key], optional: optional[key], customId: stepCustomId("serverConfig", index + 1) })
		),
		chart: {
			title: domain.chartTitle,
			subtitle: domain.chartSubtitle,
			...onOff,
			rows: [
				value(domain.rows.timezone, timezone),
				value(domain.rows.template, domain.template.names[template]),
				value(domain.rows.kvkSeason, seasonEnd ? domain.seasonEnds(seasonEnd) : copy.notSet),
				value(domain.rows.weeklySchedules, copy.count(facts.weeklySchedules)),
				value(domain.rows.activeEvents, copy.count(facts.activeEvents)),
				value(domain.rows.pausedEvents, copy.count(facts.pausedEvents)),
				value(domain.rows.hiddenChannels, copy.count(hidden)),
				value(domain.rows.renamedChannels, copy.count(renamed)),
				toggle(domain.rows.leveling, leveling),
				toggle(domain.rows.autoHeal, autoHeal),
				toggle(domain.rows.tracking, tracking),
				value(domain.rows.weekStart, domain.weekStarts[weekStart]),
			],
		},
		switches: {
			title: domain.switches.title,
			lines: [
				domain.switches.line(domain.switches.labels.autoHeal, autoHeal ? copy.on : copy.off),
				domain.switches.line(domain.switches.labels.tracking, tracking ? copy.on : copy.off),
				domain.switches.line(domain.switches.labels.weekStart, domain.weekStarts[weekStart]),
			],
			buttons: [
				...SERVER_SWITCHES.map((name) => new ButtonBuilder().setCustomId(switchCustomId(name)).setLabel(domain.switches.labels[name]).setStyle(ButtonStyle.Secondary)),
				// Refresh standings keeps its own customId, so PowerUps still answers it.
				...buildAdminControlButtons(),
			],
		},
	};
}

// The server's active events, read once per redraw. A failed read shows zeroes rather
// than failing the card, like every other read here.
async function readServerConfigFacts(guildId: string): Promise<ServerConfigFacts> {
	const events = await eventStore.findByGuildId(guildId).catch(() => []);
	const rows = events as unknown as Array<{ type?: string; intervalHours?: number; seasonEnd?: Date | null; paused?: boolean }>;
	return {
		now: Date.now(),
		activeEvents: rows.length,
		pausedEvents: rows.filter((event) => event.paused === true).length,
		weeklySchedules: rows.filter((event) => event.type === "recurring" && event.intervalHours === WEEK_HOURS && !event.seasonEnd).length,
	};
}

// Onboarding can be read only from a Community server with Manage Server; any refusal
// reads as unknown rather than off, so the card never claims a setting it could not see.
async function readOnboardingOn(guild: Guild, communityOn: boolean): Promise<boolean | null> {
	if (!communityOn) return false;
	try {
		return (await fetchOnboardingSnapshot(guild)).enabled;
	} catch {
		return null;
	}
}

async function readOnboardingFacts(guild: Guild, row: HeadquartersRow): Promise<OnboardingFacts> {
	const communityOn = isCommunityEnabled(guild);
	const choosable = choosableAdoptedChannels(guild, row);
	return {
		communityOn,
		onboardingOn: await readOnboardingOn(guild, communityOn),
		gated: isMemberRoleGated(guild, row.memberRoleId),
		memberRoleName: row.memberRoleId ? (guild.roles.cache.get(row.memberRoleId)?.name ?? null) : null,
		adoptedPlaced: choosable.every((entry) => readAdoptionChoice(row, entry.channel.id) !== null),
		adoptedLines: adoptedChannelLines(choosable),
	};
}

/**
 * A view with each step's progress read from the skip list, the one place the two meet so
 * the views stay pure. The enable step has no card beneath the steps card, so the line a
 * skipped step's own card carries sits on its step there instead.
 */
function withProgress(view: DomainView, domain: HeadquartersDomain, skipped: readonly string[]): DomainView {
	const steps = view.steps.map((step) => {
		const progress = progressOf(step, domain, skipped);
		const note = view.ownCardOnly && progress === "skipped" ? copy.stepCards.skippedLine : step.note;
		return { ...step, progress, note };
	});
	return { ...view, steps };
}

/** One domain's view as the server stands now, each step carrying its progress. */
export async function readDomainView(guild: Guild, row: HeadquartersRow, domain: HeadquartersDomain): Promise<DomainView> {
	return withProgress(await readPlainView(guild, row, domain), domain, row.setupStepsSkipped ?? []);
}

/**
 * One domain's view before the skip list. An exhaustive switch (risk R3 of 2026-10 item
 * 263): a domain added without its own branch is a compile error at `never`, never a
 * channel that silently draws another domain's card.
 */
async function readPlainView(guild: Guild, row: HeadquartersRow, domain: HeadquartersDomain): Promise<DomainView> {
	switch (domain) {
		case "deroConfig":
			return deroConfigView(await deroVoiceConfigStore.findByGuildId(guild.id));
		case "onboarding":
			return onboardingView(await readOnboardingFacts(guild, row), row);
		case "arcadeControl":
			return arcadeControlView(row);
		case "serverConfig":
			return serverConfigView(row, await readServerConfigFacts(guild.id));
		default: {
			const unknownDomain: never = domain;
			throw new Error(`[headquarters] no view for the domain ${String(unknownDomain)}`);
		}
	}
}

// ── the steps card ───────────────────────────────────────────────────────────

const PROGRESS_MARKS: Record<StepProgress, string> = { done: copy.done, skipped: copy.skippedMark, open: copy.todo };

// A view read straight from a view builder has met no skip list, so its marks are its own.
function shownProgress(step: SetupStep): StepProgress {
	return step.progress ?? (step.done ? "done" : "open");
}

function stepLine(step: SetupStep, number: number): string {
	const progress = shownProgress(step);
	const line = copy.stepLine(PROGRESS_MARKS[progress], number, step.label);
	const skipped = progress === "skipped" ? ` ${copy.skippedWord}` : "";
	const optional = step.optional ? ` ${copy.optional}` : "";
	const note = step.note ? `\n${step.note}` : "";
	return `${line}${skipped}${optional}${note}`;
}

/**
 * One step's button (2026-10 item 263 Phase 4a, R3-21): a done step is green with a ✅,
 * an open one grey, both labelled "Step N". A done step still opens its flow, so a
 * setting can be changed again. shapeOfRows compares styles, so existing cards re-edit.
 */
export function buildStepButton(customId: string, number: number, done: boolean): ButtonBuilder {
	const button = new ButtonBuilder().setCustomId(customId).setLabel(copy.buttonLabel(number)).setStyle(done ? ButtonStyle.Success : ButtonStyle.Secondary);
	return done ? button.setEmoji(copy.done) : button;
}

/** The steps card, the table of contents: every step with its mark, and a button per step that jumps straight to it. */
export function buildStepsCard(view: DomainView): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
	const embed = new EmbedBuilder()
		.setTitle(view.title)
		.setDescription(view.steps.map((step, index) => stepLine(step, index + 1)).join("\n"))
		.setColor(COLORS.ADMIN)
		.setFooter({ text: copy.footer });
	const buttons = view.steps.flatMap((step, index) => (step.customId ? [buildStepButton(step.customId, index + 1, shownProgress(step) === "done")] : []));
	const components: ActionRowBuilder<ButtonBuilder>[] = [];
	const maxRows = view.stepRows ?? MAX_STEP_ROWS;
	for (let start = 0; start < buttons.length && components.length < maxRows; start += BUTTONS_PER_ROW) {
		components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(start, start + BUTTONS_PER_ROW)));
	}
	// Beside the steps, never among them, so a button that is no step keeps its own row and
	// a step number never shifts when one is added.
	if (view.extraButtons?.length) components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(view.extraButtons.slice(0, BUTTONS_PER_ROW)));
	return { embeds: [embed], components };
}

/** The server switches message: each switch as it stands, and a button per switch. */
export function buildSwitchesMessage(switches: SwitchesView): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
	const embed = new EmbedBuilder().setTitle(switches.title).setDescription(switches.lines.join("\n")).setColor(COLORS.ADMIN).setFooter({ text: copy.switchesFooter });
	return { embeds: [embed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(switches.buttons.slice(0, BUTTONS_PER_ROW))] };
}

// ── keeping the messages ─────────────────────────────────────────────────────

/** What a kept message shows, compared before an edit so an unchanged card is never rewritten. */
interface MessageShape {
	description: string;
	fields: string;
	buttons: string;
}

function shapeOfEmbed(embed: { description?: string | null; fields?: Array<{ name: string; value: string }> } | undefined): Pick<MessageShape, "description" | "fields"> {
	return {
		description: embed?.description ?? "",
		fields: JSON.stringify((embed?.fields ?? []).map((field) => [field.name, field.value])),
	};
}

function shapeOfRows(rows: ReadonlyArray<{ toJSON(): unknown }>): string {
	return JSON.stringify(
		rows.map((row) => ((row.toJSON() as { components?: Array<{ custom_id?: string; label?: string; style?: number }> }).components ?? []).map((button) => [button.custom_id, button.label, button.style]))
	);
}

function shapeOfMessage(message: Message): MessageShape {
	return { ...shapeOfEmbed(message.embeds[0]?.data), buttons: shapeOfRows(message.components) };
}

function sameShape(a: MessageShape, b: MessageShape): boolean {
	return a.description === b.description && a.fields === b.fields && a.buttons === b.buttons;
}

interface KeptMessageInput {
	channel: TextChannel;
	storedId: string | null | undefined;
	title: string;
	selfId: string | undefined;
	forcePost: boolean;
	pin: boolean;
	shape: MessageShape;
	send: () => Promise<Message>;
	edit: (message: Message) => Promise<unknown>;
	// A stored message with another title is deleted and posted fresh rather than edited,
	// so a card that changed what it is (🎰arcade-control's enable card and its steps card)
	// lands below the channel's other messages instead of keeping the old one's place.
	replaceWhenRetitled?: boolean;
}

// The message by its stored id, else Dero's recent message with the same title, so a
// lost id never duplicates the card.
async function findKeptMessage(input: KeptMessageInput): Promise<Message | null> {
	const stored = input.storedId ? await input.channel.messages.fetch(input.storedId).catch(() => null) : null;
	if (stored) return stored;
	const recent = await input.channel.messages.fetch({ limit: ADOPT_SCAN_LIMIT }).catch(() => null);
	return recent?.find((message) => (!input.selfId || message.author.id === input.selfId) && message.embeds[0]?.title === input.title) ?? null;
}

/** Keep one message present and current; the id to store, or the stored one when a write failed. */
async function keepMessage(input: KeptMessageInput): Promise<string | null> {
	let existing = input.forcePost ? null : await findKeptMessage(input);
	try {
		if (existing && input.replaceWhenRetitled && existing.embeds[0]?.title !== input.title) {
			await existing.delete().catch((error) => console.warn(`[headquarters] could not delete the replaced "${existing?.embeds[0]?.title}" in channel ${input.channel.id}`, error));
			existing = null;
		}
		if (existing) {
			if (!sameShape(shapeOfMessage(existing), input.shape)) await input.edit(existing);
			return existing.id;
		}
		const posted = await input.send();
		// Best effort, like every intro pin: a missing pin leaves a working card.
		if (input.pin) await posted.pin().catch(() => undefined);
		return posted.id;
	} catch (error) {
		console.warn(`[headquarters] keeping "${input.title}" in channel ${input.channel.id} failed`, error);
		return input.storedId ?? null;
	}
}

/**
 * Delete a message the view no longer has, by its stored id. Answers the id still to store:
 * null once it is gone (or there was none), the stored id when the delete failed so the
 * next sync tries again.
 */
async function dropMessage(channel: TextChannel, storedId: string | null | undefined): Promise<string | null> {
	if (!storedId) return null;
	const message = await channel.messages.fetch(storedId).catch(() => null);
	if (!message) return null;
	try {
		await message.delete();
		return null;
	} catch (error) {
		console.warn(`[headquarters] could not delete message ${storedId} in channel ${channel.id}`, error);
		return storedId;
	}
}

/**
 * Keep every revealed step card, in step order, beneath whatever the channel already holds.
 * Answers the card ids to store: the channel slot for a channel card, <domain>-<key> for a flow.
 */
async function keepStepCards(
	channel: TextChannel,
	row: HeadquartersRow,
	steps: readonly SetupStep[],
	domain: HeadquartersDomain,
	placement: { selfId: string | undefined; forcePost: boolean }
): Promise<Record<string, string | null>> {
	const writes: Record<string, string | null> = {};
	for (const card of buildStepCards(steps, domain, row)) {
		const storedCardId = row.tutorialCardMessageIds?.[card.key];
		const cardId = await keepMessage({
			channel,
			storedId: storedCardId,
			title: card.title,
			...placement,
			pin: false,
			shape: { ...shapeOfEmbed(card.message.embeds[0]?.data), buttons: shapeOfRows(card.message.components) },
			send: () => channel.send(card.message),
			edit: (message) => message.edit(card.message),
		});
		if (cardId && cardId !== storedCardId) writes[`tutorialCardMessageIds.${card.key}`] = cardId;
	}
	return writes;
}

/**
 * The one case a posted step card is deleted (2026-11 item 289): the arcade's cards have no
 * flow to open while the arcade is off. The skip list stays, so turning the arcade on again
 * resumes the walk where it stood. A card whose delete failed keeps its id for the next sync.
 */
async function dropArcadeStepCards(channel: TextChannel, row: HeadquartersRow): Promise<Record<string, string | null>> {
	const writes: Record<string, string | null> = {};
	for (const key of Object.keys(copy.stepTeaching.arcadeControl)) {
		const cardKey = cardKeyOf({ key, kind: "flow" }, "arcadeControl");
		const storedCardId = row.tutorialCardMessageIds?.[cardKey];
		if (!storedCardId) continue;
		const remainingId = await dropMessage(channel, storedCardId);
		if (remainingId !== storedCardId) writes[`tutorialCardMessageIds.${cardKey}`] = remainingId;
	}
	return writes;
}

/** Options for one sync. `forcePost` posts every message fresh beneath an intro that was just posted. */
export interface SyncOptions {
	forcePost?: boolean;
}

// One press at a time now moves a walk, so syncs run far more often than boot ever did. Two
// at once would each read a row with no stored card and post that card twice, so a guild's
// syncs queue. This queue is the sync's own: a build awaiting a sync on a shared one would
// wait on itself (utils/guildQueue.ts).
const syncQueue = createGuildQueue();

/**
 * Bring one config channel's steps card, step cards and chart up to date with the server,
 * and store their ids. Queued per guild, the row read inside the queue. Never throws.
 */
export async function syncHeadquartersChannel(guild: Guild, domain: HeadquartersDomain, options: SyncOptions = {}): Promise<void> {
	await syncQueue.run(guild.id, () => syncChannelNow(guild, domain, options));
}

async function syncChannelNow(guild: Guild, domain: HeadquartersDomain, options: SyncOptions): Promise<void> {
	try {
		const row = (await guildConfigStore.findByGuildId(guild.id)) as unknown as HeadquartersRow | null;
		const field = DOMAIN_CHANNEL_FIELDS[domain];
		const channelId = row?.[field];
		if (!row || !channelId) return;
		const channel = await guild.channels.fetch(channelId).catch(() => null);
		if (!(channel instanceof TextChannel)) return;

		const view = await readDomainView(guild, row, domain);
		const selfId = guild.client.user?.id;
		const forcePost = options.forcePost ?? false;

		const steps = buildStepsCard(view);
		const stepsId = await keepMessage({
			channel,
			storedId: row.setupStepsMessageIds?.[field],
			title: view.title,
			selfId,
			forcePost,
			pin: true,
			replaceWhenRetitled: true,
			shape: { ...shapeOfEmbed(steps.embeds[0]?.data), buttons: shapeOfRows(steps.components) },
			send: () => channel.send(steps),
			edit: (message) => message.edit(steps),
		});

		const { kept, finished } = revealedSteps(view.steps, domain, row.setupStepsSkipped ?? [], row.tutorialCardMessageIds);
		// Before the switches and the chart, so a server that finishes its last step reads
		// its held messages below the cards.
		const writes = view.ownCardOnly ? await dropArcadeStepCards(channel, row) : await keepStepCards(channel, row, kept, domain, { selfId, forcePost });

		// A held message is neither posted nor dropped: it waits for the domain to finish
		// (2026-11 item 289). One already posted stays and keeps updating, which is what leaves
		// an existing server its chart and switches. Only the arcade's off view drops a chart.
		const switchesView = view.switches;
		const storedSwitchesId = row.settingsSwitchesMessageIds?.[field];
		const holdSwitches = !finished && !storedSwitchesId;
		const switchesId = switchesView && !holdSwitches
			? await keepMessage({
					channel,
					storedId: storedSwitchesId,
					title: switchesView.title,
					selfId,
					forcePost,
					pin: false,
					shape: (() => {
						const message = buildSwitchesMessage(switchesView);
						return { ...shapeOfEmbed(message.embeds[0]?.data), buttons: shapeOfRows(message.components) };
					})(),
					send: () => channel.send(buildSwitchesMessage(switchesView)),
					edit: (message) => message.edit(buildSwitchesMessage(switchesView)),
				})
			: null;

		const chart = view.chart;
		const storedChartId = row.settingsChartMessageIds?.[field];
		const holdChart = chart !== null && !finished && !storedChartId;
		let chartId: string | null = null;
		if (chart && !holdChart) {
			const chartEmbed = settingsChartEmbed(chart);
			const chartShape = { ...shapeOfEmbed(chartEmbed.data), buttons: shapeOfRows([]) };
			// Drawn only when the chart must be written: an unchanged chart costs no render.
			const chartPayload = async () => {
				const drawn = await withRenderFallback(() => renderSettingsChart(chart), () => null);
				if (!isRenderPayload(drawn)) return { embeds: [chartEmbed], files: [], attachments: [] };
				return { embeds: [new EmbedBuilder(chartEmbed.data).setImage(drawn.ref)], files: [drawn.attachment], attachments: [] };
			};
			chartId = await keepMessage({
				channel,
				storedId: storedChartId,
				title: chart.title,
				selfId,
				forcePost,
				pin: false,
				shape: chartShape,
				send: async () => {
					const { embeds, files } = await chartPayload();
					return channel.send({ embeds, files });
				},
				// `attachments: []` drops the old drawing, or every redraw would stack another file.
				edit: async (message) => message.edit(await chartPayload()),
			});
		} else if (!chart) {
			chartId = await dropMessage(channel, storedChartId);
		}

		if (stepsId && stepsId !== row.setupStepsMessageIds?.[field]) writes[`setupStepsMessageIds.${field}`] = stepsId;
		if (chartId !== (storedChartId ?? null) && (chartId || storedChartId)) writes[`settingsChartMessageIds.${field}`] = chartId;
		if (switchesId && switchesId !== row.settingsSwitchesMessageIds?.[field]) writes[`settingsSwitchesMessageIds.${field}`] = switchesId;
		if (Object.keys(writes).length > 0) await guildConfigStore.update(guild.id, writes);
	} catch (error) {
		console.warn(`[headquarters] the ${domain} steps card and chart could not be brought up to date in guild ${guild.id}`, error);
	}
}

/**
 * Every config channel, one after another so their id writes never race. `freshIntroFields`
 * names the channels whose intro was just posted, whose cards go fresh beneath it.
 */
export async function syncAllHeadquarters(guild: Guild, freshIntroFields: ReadonlySet<string> = new Set()): Promise<void> {
	for (const domain of HEADQUARTERS_DOMAINS) {
		await syncHeadquartersChannel(guild, domain, { forcePost: freshIntroFields.has(DOMAIN_CHANNEL_FIELDS[domain]) });
	}
}

/** After a change in a domain: redraw its card and chart, fire and forget. */
export function refreshHeadquartersCards(guild: Guild | null | undefined, domain: HeadquartersDomain): void {
	if (!guild) return;
	void syncHeadquartersChannel(guild, domain);
}
