import {
	LabelBuilder,
	MessageFlags,
	ModalBuilder,
	StringSelectMenuBuilder,
	TextDisplayBuilder,
	type ButtonInteraction,
	type ModalSubmitInteraction,
} from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { deroVoiceConfigStore } from "@db/stores/deroVoiceConfigStore.js";
import { registerButton, registerModal } from "@handlers/interactionRegistry.js";
import { infoEmbed } from "@utils/embedBuilder.js";
import { gateOwnerOrAdmin } from "@utils/permissions.js";
import { answerInChannel, beginChannelAnswer } from "@utils/answerInChannel.js";
import { showModalOrReply, showNotice } from "@utils/textModal.js";
import { COLORS } from "@base/copy/brand.js";
import { normalizePriorityOrder, VOICE_PRIORITY_CATEGORIES, type VoicePriorityCategory } from "@features/voice/voicePriority.js";
import { voiceCopy } from "@features/voice/voiceCopy.js";
import { adminLog } from "./adminLog.js";
import {
	HEADQUARTERS_STEP_PREFIX,
	SERVER_CONFIG_STEPS,
	SWITCH_STEP_TAIL,
	refreshHeadquartersCards,
	type HeadquartersDomain,
	type ServerConfigStep,
	type ServerSwitch,
} from "./headquartersCards.js";
import { setupCopy } from "./setupCopy.js";
import { REMOVE_STEP_TAIL, SKIP_STEP_TAIL, channelKeyOf, handleAddChannel, handleSkip, parseStepId, stepIdOf, tutorialKeyOf, type TutorialChannelKey } from "./tutorialCards.js";
import { arcadeControlActionOf, handleDismantle, RETIRED_ENABLE_STUB_TAIL, type ArcadeControlAction } from "./arcadeControlCards.js";
import { handleOpen as handleRenameInfo } from "./renameInfoStep.js";
import { getPluginCopy } from "@base/copy/getCopy.js";
import { deroBrainCopy } from "@features/dero-brain/deroBrainCopy.js";
import { TIMEZONE_OPTIONS, resolveServerTimezone } from "@utils/tzParser.js";
import { TEMPLATE_PLUGIN_IDS, isTemplatePluginId, switchTemplate, type ISwitchTemplateResult, type TemplatePluginId, type TemplateRow } from "./switchTemplate.js";

// ── headquartersSteps ───────────────────────────────────────────────────────
// What:  where a 🏰 DERO HEADQUARTERS step button goes (2026-10 item 257 Phase 2b,
//        owner item 7). Every step but one opens a flow that already exists: the
//        /dero-config, /arcade, /server channels and /leveling settings panels, the
//        /events pick, or an /arcade, /events or /server subcommand's form,
//        through the admin command launcher. Two flows are new: ⚙️dero-config's step
//        2, the voice priority order (owner decision 4), a modal of four selects,
//        🛠️server-config's step 1, the server's timezone (2026-10 item 263 Phase 4c), a
//        modal of one select, and its step 2, Dero's template (2026-10 item 262 Phase 4),
//        a modal of one select that hands the pick to switchTemplate.
// Who:   the buttons headquartersCards.ts puts on the steps cards, as
//        `hqstep:<domain>:<step>`. The 🧭onboarding steps carry the Community and
//        adoption customIds themselves and never come here; its notice board tutorial
//        cards do, as `hqstep:onboarding:tutorial-<key>` (2026-11 item 285 Phase 3), and go
//        on to tutorialCards.handleAddChannel. A step card's Skip and Continue arrive as
//        `hqstep:<domain>:skip-<key>` and a ready channel's Remove as
//        `hqstep:onboarding:remove-<key>` (2026-11 item 289), and go on to tutorialCards too.
// How:   the launcher re-runs its owner or admin gate at every step, and the priority,
//        timezone and template modals run gateOwnerOrAdmin on the press and again on the
//        Submit, because a modal is reachable without the button that opened it.

/** What one routed step opens. */
type StepTarget =
	| { kind: "launch"; launchId: string }
	| { kind: "leaf"; command: string; path: string }
	| { kind: "priority" }
	| { kind: "timezone" }
	| { kind: "template" }
	| { kind: "tutorial"; key: TutorialChannelKey }
	| { kind: "skip"; stepId: string }
	| { kind: "remove"; key: TutorialChannelKey }
	| { kind: "arcadeControl"; action: ArcadeControlAction }
	| { kind: "renameInfo" };

const panel = (launchId: string): StepTarget => ({ kind: "launch", launchId });
const leaf = (command: string, path: string): StepTarget => ({ kind: "leaf", command, path });

// The step to flow map, read at each flow's call site. ⚙️dero-config has two steps
// (2026-10 item 263 Phase 4b, owner decision 15): the /dero-config panel (the voice and
// Listen switches, the task roles and the voice channels) and the priority order, so no
// two steps open the same modal. 🎰arcade-control's one panel step holds the chip switch
// (the daily claim rides it), the monthly post and the bots, the two steps that both
// opened it merged into one.
//
// 🛠️server-config (2026-10 item 263 Phase 4a) routes by step key, so a step inserted in
// SERVER_CONFIG_STEPS takes its route with it: the server's timezone opens its own
// modal (Phase 4c), Dero's template its own (2026-10 item 262 Phase 4), the KvK season and the weekly stream
// schedule open their /events forms, events opens the /events pick (list, pause,
// resume, delete), the channels the /server channels panel and leveling its panel.
const SERVER_CONFIG_ROUTES: Record<ServerConfigStep, StepTarget> = {
	timezone: { kind: "timezone" },
	template: { kind: "template" },
	kvkSeason: leaf("events", "kvk-season"),
	streams: leaf("events", "stream weekly"),
	events: panel("events"),
	channels: panel("server-channels"),
	leveling: panel("leveling"),
	rename: { kind: "renameInfo" },
};

// The server switches message: each switch opens its own /server form.
const SWITCH_ROUTES: Record<ServerSwitch, StepTarget> = {
	autoHeal: leaf("server", "auto-heal"),
	tracking: leaf("server", "leaderboard tracking"),
	weekStart: leaf("server", "leaderboard week-start"),
};

const ROUTED_STEPS: Partial<Record<HeadquartersDomain, readonly StepTarget[]>> = {
	deroConfig: [panel("dero-config"), { kind: "priority" }],
	arcadeControl: [leaf("arcade", "on"), panel("arcade"), leaf("arcade", "reach"), leaf("arcade", "server block")],
	serverConfig: SERVER_CONFIG_STEPS.map((key) => SERVER_CONFIG_ROUTES[key]),
};

/** The flow a routed step opens, or null for a customId from no current card. */
export function stepTarget(customId: string): StepTarget | null {
	const [prefix, domain, step] = customId.split(":");
	if (prefix !== HEADQUARTERS_STEP_PREFIX || !domain || !step) return null;
	// Before the onboarding branch below, which answers null to any tail but a tutorial's,
	// and before the number lookup. An unknown tail is null, so the press reads as stale.
	if (step.startsWith(SKIP_STEP_TAIL)) {
		const parsed = parseStepId(`${domain}:${step.slice(SKIP_STEP_TAIL.length)}`);
		return parsed ? { kind: "skip", stepId: stepIdOf(parsed.domain, parsed.key) } : null;
	}
	if (step.startsWith(REMOVE_STEP_TAIL)) {
		const key = channelKeyOf(step.slice(REMOVE_STEP_TAIL.length));
		return domain === "onboarding" && key ? { kind: "remove", key } : null;
	}
	if (step.startsWith(SWITCH_STEP_TAIL)) {
		const name = step.slice(SWITCH_STEP_TAIL.length);
		return domain === "serverConfig" && Object.hasOwn(SWITCH_ROUTES, name) ? SWITCH_ROUTES[name as ServerSwitch] : null;
	}
	if (domain === "onboarding") {
		const key = tutorialKeyOf(step);
		return key ? { kind: "tutorial", key } : null;
	}
	// 🎰arcade-control's Dismantle button carries a word, not a step number (2026-11 item
	// 285 Phase 4); its numbered steps fall through to the list below. The retired Enable
	// Arcade stub's press runs the enable step, step 1 (2026-11 item 285 debug pass).
	if (domain === "arcadeControl") {
		if (step === RETIRED_ENABLE_STUB_TAIL) return ROUTED_STEPS.arcadeControl?.[0] ?? null;
		const action = arcadeControlActionOf(step);
		if (action) return { kind: "arcadeControl", action };
	}
	return ROUTED_STEPS[domain as HeadquartersDomain]?.[Number(step) - 1] ?? null;
}

// ── the step press ───────────────────────────────────────────────────────────

// The launcher is loaded on use, for the reason dero.ts gives: it builds its command
// table from the admin commands as it loads, and those reach back into setup, so a
// static import from here risks a cycle with the table half built.
async function handleStepButton(interaction: ButtonInteraction): Promise<void> {
	const target = stepTarget(interaction.customId);
	if (!target || target.kind === "remove") {
		await showNotice(interaction, { title: getPluginCopy(null).notice.setup, sections: [setupCopy.headquarters.staleStep] });
		return;
	}
	if (target.kind === "priority") {
		await openPriorityModal(interaction);
		return;
	}
	if (target.kind === "timezone") {
		await openTimezoneModal(interaction);
		return;
	}
	if (target.kind === "template") {
		await openTemplateModal(interaction);
		return;
	}
	if (target.kind === "tutorial") {
		await handleAddChannel(interaction, target.key);
		return;
	}
	if (target.kind === "skip") {
		await handleSkip(interaction, target.stepId);
		return;
	}
	if (target.kind === "arcadeControl") {
		await handleDismantle(interaction);
		return;
	}
	if (target.kind === "renameInfo") {
		await handleRenameInfo(interaction);
		return;
	}
	const launcher = await import("@features/command-buttons/adminCommandLauncher.js");
	if (target.kind === "launch") await launcher.openAdminLaunch(interaction, target.launchId);
	else await launcher.openAdminLeaf(interaction, target.command, target.path);
}

// ── step 2, the voice priority order ─────────────────────────────────────────

const PRIORITY_MODAL_ID = `${HEADQUARTERS_STEP_PREFIX}priority`;
// The four places an admin picks; the category left out goes last.
const PLACES = voiceCopy.priority.placeLabels.length;
const placeFieldId = (index: number): string => `place-${index}`;

/** The modal: one select per place, each preset to the order stored now. */
export function buildPriorityModal(order: readonly VoicePriorityCategory[]): ModalBuilder {
	const labels = voiceCopy.priority.placeLabels.map((placeLabel, index) =>
		new LabelBuilder().setLabel(placeLabel).setStringSelectMenuComponent(
			new StringSelectMenuBuilder()
				.setCustomId(placeFieldId(index))
				.setMinValues(1)
				.setMaxValues(1)
				.addOptions(VOICE_PRIORITY_CATEGORIES.map((category) => ({ label: voiceCopy.priority.label(category), value: category, default: order[index] === category })))
		)
	);
	return new ModalBuilder()
		.setCustomId(PRIORITY_MODAL_ID)
		.setTitle(voiceCopy.priority.modalTitle)
		.addTextDisplayComponents(new TextDisplayBuilder().setContent(voiceCopy.priority.intro))
		.addLabelComponents(...labels);
}

/**
 * The full order from the four picks, or null when two places share a category. The
 * one category no place named goes last, so every request still has a rank.
 */
export function orderFromPicks(picks: readonly string[]): VoicePriorityCategory[] | null {
	if (new Set(picks).size !== picks.length) return null;
	return normalizePriorityOrder(picks);
}

async function openPriorityModal(interaction: ButtonInteraction): Promise<void> {
	const guild = interaction.guild;
	if (!guild) return;
	const config = await guildConfigStore.findByGuildId(guild.id);
	if (!(await gateOwnerOrAdmin(interaction, config))) {
		await showNotice(interaction, { title: deroBrainCopy.noticeTitle, sections: [voiceCopy.priority.notAdmin] });
		return;
	}
	const order = normalizePriorityOrder((await deroVoiceConfigStore.findByGuildId(guild.id))?.priorityOrder);
	await showModalOrReply(interaction, buildPriorityModal(order), () => ({ content: setupCopy.headquarters.stepUnavailable, flags: MessageFlags.Ephemeral }));
}

async function handlePrioritySubmit(interaction: ModalSubmitInteraction): Promise<void> {
	const guild = interaction.guild;
	if (!guild) return;
	const config = await guildConfigStore.findByGuildId(guild.id);
	if (!(await gateOwnerOrAdmin(interaction, config))) {
		await showNotice(interaction, { title: deroBrainCopy.noticeTitle, sections: [voiceCopy.priority.notAdmin] });
		return;
	}
	const picks = Array.from({ length: PLACES }, (_unused, index) => interaction.fields.getStringSelectValues(placeFieldId(index))[0] ?? "");
	const order = orderFromPicks(picks);
	if (!order) {
		await showNotice(interaction, { title: deroBrainCopy.noticeTitle, sections: [voiceCopy.priority.duplicate] });
		return;
	}
	await deroVoiceConfigStore.upsert(guild.id, { priorityOrder: order });
	const labels = order.map((category) => voiceCopy.priority.label(category));
	// A modal Submit opens no notice, so the saved order posts in ⚙️dero-config (2026-10 item
	// 257 Phase 5), the channel whose steps card the priority step sits on.
	await answerInChannel(interaction, "deroConfig", { embeds: [infoEmbed(voiceCopy.priority.modalTitle, voiceCopy.priority.saved(labels), COLORS.ADMIN)] }, { config });
	adminLog.emitFor(interaction, guild.id, "config.change", { subject: voiceCopy.priority.auditSubject, detail: labels.join(", ") });
	refreshHeadquartersCards(guild, "deroConfig");
}

// ── 🛠️server-config step 1, the server's timezone (2026-10 item 263 Phase 4c) ──

const TIMEZONE_MODAL_ID = `${HEADQUARTERS_STEP_PREFIX}timezone`;
const TIMEZONE_FIELD_ID = "timezone";
const timezoneCopy = setupCopy.headquarters.serverConfig.timezone;

/** The modal: one select of the shared 25 zones, the server's zone picked already. */
export function buildTimezoneModal(currentZone: string): ModalBuilder {
	const select = new StringSelectMenuBuilder()
		.setCustomId(TIMEZONE_FIELD_ID)
		.setMinValues(1)
		.setMaxValues(1)
		.addOptions(TIMEZONE_OPTIONS.map((option) => ({ label: option.label, value: option.value, description: option.description, default: option.value === currentZone })));
	return new ModalBuilder()
		.setCustomId(TIMEZONE_MODAL_ID)
		.setTitle(timezoneCopy.modalTitle)
		.addTextDisplayComponents(new TextDisplayBuilder().setContent(timezoneCopy.intro))
		.addLabelComponents(new LabelBuilder().setLabel(timezoneCopy.selectLabel).setStringSelectMenuComponent(select));
}

/**
 * The zone a Submit picked, or null for one that is not on the list. The select only
 * offers the list, but a crafted Submit can carry any string, and this value goes
 * straight into every scheduler's time math.
 */
export function pickedTimezone(picked: string | undefined): string | null {
	return TIMEZONE_OPTIONS.some((option) => option.value === picked) ? (picked as string) : null;
}

async function openTimezoneModal(interaction: ButtonInteraction): Promise<void> {
	const guild = interaction.guild;
	if (!guild) return;
	const config = await guildConfigStore.findByGuildId(guild.id);
	if (!(await gateOwnerOrAdmin(interaction, config))) {
		await showNotice(interaction, { title: getPluginCopy(config).notice.server, sections: [timezoneCopy.notAdmin] });
		return;
	}
	// Read by name: the store returns a hydrated document, whose fields are getters.
	const currentZone = resolveServerTimezone(config?.timezone);
	await showModalOrReply(interaction, buildTimezoneModal(currentZone), () => ({ content: setupCopy.headquarters.stepUnavailable, flags: MessageFlags.Ephemeral }));
}

async function handleTimezoneSubmit(interaction: ModalSubmitInteraction): Promise<void> {
	const guild = interaction.guild;
	if (!guild) return;
	const config = await guildConfigStore.findByGuildId(guild.id);
	if (!(await gateOwnerOrAdmin(interaction, config))) {
		await showNotice(interaction, { title: getPluginCopy(config).notice.server, sections: [timezoneCopy.notAdmin] });
		return;
	}
	const zone = pickedTimezone(interaction.fields.getStringSelectValues(TIMEZONE_FIELD_ID)[0]);
	if (!zone) {
		await showNotice(interaction, { title: getPluginCopy(config).notice.server, sections: [setupCopy.headquarters.staleStep] });
		return;
	}
	// timezoneSetAt marks the step done even when the admin keeps UTC on purpose.
	await guildConfigStore.update(guild.id, { timezone: zone, timezoneSetAt: new Date() });
	// The modal opened from the steps card, so its Submit is acknowledged quietly and the
	// saved zone posts in 🛠️server-config, the channel whose card the step sits on.
	await answerInChannel(interaction, "serverConfig", { embeds: [infoEmbed(timezoneCopy.modalTitle, timezoneCopy.saved(zone), COLORS.ADMIN)] }, { config });
	adminLog.emitFor(interaction, guild.id, "config.change", { subject: timezoneCopy.auditSubject, detail: zone });
	refreshHeadquartersCards(guild, "serverConfig");
}

// ── 🛠️server-config step 2, Dero's template (2026-10 item 262 Phase 4) ──

const TEMPLATE_MODAL_ID = `${HEADQUARTERS_STEP_PREFIX}template`;
const TEMPLATE_FIELD_ID = "template";
const templateCopy = setupCopy.headquarters.serverConfig.template;

// The template a row uses now: any id but the streamer one is the kingdom template, the
// way getPluginCopy falls back for an id it has no pack for.
function currentTemplate(config: { pluginId?: string | null } | null): TemplatePluginId {
	return config?.pluginId === "general-events" ? "general-events" : "rok-commander";
}

/** The modal: one select of the two templates, the server's own picked already. */
export function buildTemplateModal(current: TemplatePluginId): ModalBuilder {
	const select = new StringSelectMenuBuilder()
		.setCustomId(TEMPLATE_FIELD_ID)
		.setMinValues(1)
		.setMaxValues(1)
		.addOptions(TEMPLATE_PLUGIN_IDS.map((id) => ({ label: templateCopy.names[id], value: id, description: templateCopy.descriptions[id], default: id === current })));
	return new ModalBuilder()
		.setCustomId(TEMPLATE_MODAL_ID)
		.setTitle(templateCopy.modalTitle)
		.addTextDisplayComponents(new TextDisplayBuilder().setContent(templateCopy.intro))
		.addLabelComponents(new LabelBuilder().setLabel(templateCopy.selectLabel).setStringSelectMenuComponent(select));
}

async function openTemplateModal(interaction: ButtonInteraction): Promise<void> {
	const guild = interaction.guild;
	if (!guild) return;
	const config = await guildConfigStore.findByGuildId(guild.id);
	if (!(await gateOwnerOrAdmin(interaction, config))) {
		await showNotice(interaction, { title: getPluginCopy(config).notice.server, sections: [templateCopy.notAdmin] });
		return;
	}
	await showModalOrReply(interaction, buildTemplateModal(currentTemplate(config)), () => ({ content: setupCopy.headquarters.stepUnavailable, flags: MessageFlags.Ephemeral }));
}

async function handleTemplateSubmit(interaction: ModalSubmitInteraction): Promise<void> {
	const guild = interaction.guild;
	if (!guild) return;
	const config = await guildConfigStore.findByGuildId(guild.id);
	if (!(await gateOwnerOrAdmin(interaction, config))) {
		await showNotice(interaction, { title: getPluginCopy(config).notice.server, sections: [templateCopy.notAdmin] });
		return;
	}
	const picked = interaction.fields.getStringSelectValues(TEMPLATE_FIELD_ID)[0];
	// A server with no row has nothing to switch, so the card it came from is stale.
	if (!config || !isTemplatePluginId(picked)) {
		await showNotice(interaction, { title: getPluginCopy(config).notice.server, sections: [setupCopy.headquarters.staleStep] });
		return;
	}
	// Picking the template the server already uses is a state, so it is a notice and
	// nothing is renamed or rewritten.
	if (picked === currentTemplate(config)) {
		await showNotice(interaction, { title: getPluginCopy(config).notice.server, sections: [templateCopy.unchanged(templateCopy.names[picked])] });
		return;
	}
	// Acknowledged before the switch runs: Discord holds a rename past its limit rather
	// than refuse it, which would outlast a modal Submit's three second window.
	const answer = await beginChannelAnswer(interaction, "serverConfig", { config });
	const result = await switchTemplate(interaction.client, guild, config as unknown as TemplateRow, picked);
	const name = templateCopy.names[picked];
	await answer.send({ embeds: [infoEmbed(templateCopy.modalTitle, templateAnswerLines(result, name).join("\n\n"), COLORS.ADMIN)] });
	if (result.changed) adminLog.emitFor(interaction, guild.id, "config.change", { subject: templateCopy.auditSubject, detail: `${templateCopy.names[result.previousPluginId]} to ${name}` });
}

/** The answer to a switch: the new template, then one line per rename count that is not zero. */
export function templateAnswerLines(result: ISwitchTemplateResult, name: string): string[] {
	// Another admin switched first, between this Submit's read and its write.
	if (!result.changed) return [templateCopy.unchanged(name)];
	const lines = [templateCopy.saved(name)];
	if (result.renamed.length > 0) lines.push(templateCopy.renamed(result.renamed.length));
	if (result.kept.length > 0) lines.push(templateCopy.kept(result.kept.length));
	if (result.failed.length > 0) lines.push(templateCopy.failed(result.failed.length));
	return lines;
}

/** Register the step buttons and the priority, timezone and template modals. Called once at boot from main.ts. */
export function registerHeadquartersStepHandlers(): void {
	registerButton(HEADQUARTERS_STEP_PREFIX, handleStepButton);
	registerModal(PRIORITY_MODAL_ID, handlePrioritySubmit);
	registerModal(TIMEZONE_MODAL_ID, handleTimezoneSubmit);
	registerModal(TEMPLATE_MODAL_ID, handleTemplateSubmit);
}
