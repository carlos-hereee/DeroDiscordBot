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
import { CHOOSE_BUTTON_ID, choosableAdoptedChannels, type IAdoptionChoiceRow } from "./adoptionChoice.js";
import { readAdoptionChoice } from "./adoption.js";
import { isMemberRoleGated } from "./communityOverwrites.js";
import { setupCopy } from "./setupCopy.js";

// ── headquartersCards ───────────────────────────────────────────────────────
// What:  the two messages each 🏰 DERO HEADQUARTERS config channel holds under its
//        intro (2026-10 item 257 Phase 2b, owner item 7): the pinned steps card, a
//        numbered checklist whose marks are read from the server as it stands and
//        whose buttons open each step's existing flow, and the drawn settings chart of
//        every switch in that channel's domain.
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
//        beneath a freshly posted intro so the order stays intro, steps, chart. Every
//        failure logs one line and never throws (rulebook convention 7).

/** The three Headquarters config channels, by the domain each one sets up. */
export const HEADQUARTERS_DOMAINS = ["deroConfig", "onboarding", "arcadeControl"] as const;
export type HeadquartersDomain = (typeof HEADQUARTERS_DOMAINS)[number];

/** The GuildConfig field holding each domain's channel, which also keys its message ids. */
export const DOMAIN_CHANNEL_FIELDS: Record<HeadquartersDomain, "deroConfigChannelId" | "onboardingConfigChannelId" | "arcadeControlChannelId"> = {
	deroConfig: "deroConfigChannelId",
	onboarding: "onboardingConfigChannelId",
	arcadeControl: "arcadeControlChannelId",
};

/** The customId prefix of a step that headquartersSteps.ts routes. */
export const HEADQUARTERS_STEP_PREFIX = "hqstep";

export function stepCustomId(domain: HeadquartersDomain, step: number): string {
	return `${HEADQUARTERS_STEP_PREFIX}:${domain}:${step}`;
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
export interface HeadquartersRow extends IAdoptionChoiceRow {
	deroConfigChannelId?: string | null;
	onboardingConfigChannelId?: string | null;
	arcadeControlChannelId?: string | null;
	gamesCategoryId?: string | null;
	chipEconomyEnabled?: boolean | null;
	arcadeMonthlyPost?: boolean | null;
	botOpponentsEnabled?: boolean | null;
	challengeReach?: string | null;
	blockedNetworkGuildIds?: string[] | null;
	setupStepsMessageIds?: Partial<Record<string, string | null>> | null;
	settingsChartMessageIds?: Partial<Record<string, string | null>> | null;
}

/** One numbered step of a steps card. A step with no customId shows its mark only. */
export interface SetupStep {
	label: string;
	done: boolean;
	optional?: boolean;
	note?: string;
	customId: string | null;
}

/** What one domain shows: its steps and its chart. */
export interface DomainView {
	title: string;
	steps: SetupStep[];
	chart: SettingsChartView;
}

const onOff = { onLabel: copy.on, offLabel: copy.off };
const toggle = (label: string, on: boolean): SettingsChartRow => ({ label, kind: "switch", on });
const value = (label: string, text: string): SettingsChartRow => ({ label, kind: "value", value: text });

/** ⚙️dero-config: Dero's voice row, or its defaults when no admin saved one yet. */
export function deroConfigView(voice: IDeroVoiceConfig | null): DomainView {
	const domain = copy.deroConfig;
	const order = normalizePriorityOrder(voice?.priorityOrder);
	const done = [
		voice?.enabled === true,
		(voice?.allowedVoiceChannelIds.length ?? 0) > 0,
		(voice?.allowedRoleIds.length ?? 0) > 0,
		// The budget and the order have working defaults, so a saved row has both set.
		voice !== null,
		voice !== null,
	];
	return {
		title: domain.title,
		steps: domain.steps.map((label, index) => ({ label, done: done[index] ?? false, customId: stepCustomId("deroConfig", index + 1) })),
		chart: {
			title: domain.chartTitle,
			subtitle: domain.chartSubtitle,
			...onOff,
			rows: [
				toggle(domain.rows.voice, voice?.enabled ?? false),
				toggle(domain.rows.listen, voice?.listenEnabled ?? true),
				value(domain.rows.roles, copy.count(voice?.allowedRoleIds.length ?? 0)),
				value(domain.rows.textChannels, copy.count(voice?.allowedChannelIds.length ?? 0)),
				value(domain.rows.voiceChannels, copy.count(voice?.allowedVoiceChannelIds.length ?? 0)),
				value(domain.rows.cap, voice ? copy.dollars(voice.monthlyCapUsd) : copy.notSet),
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
}

/** 🧭onboarding. Step 4 carries no button: /setup names the member role (option A). */
export function onboardingView(facts: OnboardingFacts): DomainView {
	const domain = copy.onboarding;
	const [community, adopted, onboarding, gating] = domain.steps;
	return {
		title: domain.title,
		steps: [
			{ label: community, done: facts.communityOn, customId: COMMUNITY_CUSTOM_IDS.enable },
			{ label: adopted, done: facts.adoptedPlaced, customId: CHOOSE_BUTTON_ID },
			{ label: onboarding, done: facts.onboardingOn === true, customId: COMMUNITY_CUSTOM_IDS.configure },
			{ label: gating, done: facts.gated, note: domain.gatingNote, customId: null },
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
	const done = [arcadeOn, chipsOn, monthlyPost && bots, reach === "network", blocked > 0];
	return {
		title: domain.title,
		steps: domain.steps.map((label, index) => ({
			label,
			done: done[index] ?? false,
			// Blocking a server is never required, so its step says so rather than nagging.
			optional: index === domain.steps.length - 1,
			customId: stepCustomId("arcadeControl", index + 1),
		})),
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
	};
}

/** One domain's view as the server stands now. */
export async function readDomainView(guild: Guild, row: HeadquartersRow, domain: HeadquartersDomain): Promise<DomainView> {
	if (domain === "deroConfig") return deroConfigView(await deroVoiceConfigStore.findByGuildId(guild.id));
	if (domain === "onboarding") return onboardingView(await readOnboardingFacts(guild, row));
	return arcadeControlView(row);
}

// ── the steps card ───────────────────────────────────────────────────────────

function stepLine(step: SetupStep, number: number): string {
	const line = copy.stepLine(step.done ? copy.done : copy.todo, number, step.label);
	const optional = step.optional ? ` ${copy.optional}` : "";
	const note = step.note ? `\n${step.note}` : "";
	return `${line}${optional}${note}`;
}

/** The steps card: every step with its mark, and a button per step that opens a flow. */
export function buildStepsCard(view: DomainView): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
	const embed = new EmbedBuilder()
		.setTitle(view.title)
		.setDescription(view.steps.map((step, index) => stepLine(step, index + 1)).join("\n"))
		.setColor(COLORS.ADMIN)
		.setFooter({ text: copy.footer });
	const buttons = view.steps.flatMap((step, index) =>
		step.customId
			? [new ButtonBuilder().setCustomId(step.customId).setLabel(copy.buttonLabel(index + 1)).setStyle(step.done ? ButtonStyle.Secondary : ButtonStyle.Primary)]
			: []
	);
	const components: ActionRowBuilder<ButtonBuilder>[] = [];
	for (let start = 0; start < buttons.length && components.length < MAX_STEP_ROWS; start += BUTTONS_PER_ROW) {
		components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(start, start + BUTTONS_PER_ROW)));
	}
	return { embeds: [embed], components };
}

// ── keeping the two messages ─────────────────────────────────────────────────

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
	const existing = input.forcePost ? null : await findKeptMessage(input);
	try {
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

/** Options for one sync. `forcePost` posts both messages fresh beneath an intro that was just posted. */
export interface SyncOptions {
	forcePost?: boolean;
	row?: HeadquartersRow | null;
}

/**
 * Bring one config channel's steps card and chart up to date with the server, and
 * store their ids. Never throws.
 */
export async function syncHeadquartersChannel(guild: Guild, domain: HeadquartersDomain, options: SyncOptions = {}): Promise<void> {
	try {
		const row = options.row ?? ((await guildConfigStore.findByGuildId(guild.id)) as unknown as HeadquartersRow | null);
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
			shape: { ...shapeOfEmbed(steps.embeds[0]?.data), buttons: shapeOfRows(steps.components) },
			send: () => channel.send(steps),
			edit: (message) => message.edit(steps),
		});

		const chartEmbed = settingsChartEmbed(view.chart);
		const chartShape = { ...shapeOfEmbed(chartEmbed.data), buttons: shapeOfRows([]) };
		// Drawn only when the chart must be written: an unchanged chart costs no render.
		const chartPayload = async () => {
			const drawn = await withRenderFallback(() => renderSettingsChart(view.chart), () => null);
			if (!isRenderPayload(drawn)) return { embeds: [chartEmbed], files: [], attachments: [] };
			return { embeds: [new EmbedBuilder(chartEmbed.data).setImage(drawn.ref)], files: [drawn.attachment], attachments: [] };
		};
		const chartId = await keepMessage({
			channel,
			storedId: row.settingsChartMessageIds?.[field],
			title: view.chart.title,
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

		const writes: Record<string, string> = {};
		if (stepsId && stepsId !== row.setupStepsMessageIds?.[field]) writes[`setupStepsMessageIds.${field}`] = stepsId;
		if (chartId && chartId !== row.settingsChartMessageIds?.[field]) writes[`settingsChartMessageIds.${field}`] = chartId;
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
