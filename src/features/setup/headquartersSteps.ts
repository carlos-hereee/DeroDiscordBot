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
import { showErrorNotice, showModalOrReply } from "@utils/textModal.js";
import { COLORS } from "@base/copy/brand.js";
import { normalizePriorityOrder, VOICE_PRIORITY_CATEGORIES, type VoicePriorityCategory } from "@features/voice/voicePriority.js";
import { voiceCopy } from "@features/voice/voiceCopy.js";
import { adminLog } from "./adminLog.js";
import { HEADQUARTERS_STEP_PREFIX, refreshHeadquartersCards, type HeadquartersDomain } from "./headquartersCards.js";
import { setupCopy } from "./setupCopy.js";

// ── headquartersSteps ───────────────────────────────────────────────────────
// What:  where a 🏰 DERO HEADQUARTERS step button goes (2026-10 item 257 Phase 2b,
//        owner item 7). Every step but one opens a flow that already exists: the
//        /dero-config and /arcade settings panels, or an /arcade subcommand's form,
//        through the admin command launcher. The one new flow is ⚙️dero-config's step
//        5, the voice priority order (owner decision 4): a modal of four selects.
// Who:   the buttons headquartersCards.ts puts on the steps cards, as
//        `hqstep:<domain>:<step>`. The 🧭onboarding steps carry the Community and
//        adoption customIds themselves and never come here.
// How:   the launcher re-runs its owner or admin gate at every step, and the priority
//        modal runs gateOwnerOrAdmin on the press and again on the Submit, because a
//        modal is reachable without the button that opened it.

/** What one routed step opens. */
type StepTarget =
	| { kind: "launch"; launchId: string }
	| { kind: "leaf"; command: string; path: string }
	| { kind: "priority" };

const panel = (launchId: string): StepTarget => ({ kind: "launch", launchId });
const leaf = (command: string, path: string): StepTarget => ({ kind: "leaf", command, path });

// The step to flow map, read at each flow's call site. The /dero-config panel holds the
// voice switch, the voice channel list, Listen and the task list, and the budget, so
// steps 1 to 4 all open it; the arcade panel holds the chip switch (the daily claim
// rides it), the monthly post and the bots.
const ROUTED_STEPS: Partial<Record<HeadquartersDomain, readonly StepTarget[]>> = {
	deroConfig: [panel("dero-config"), panel("dero-config"), panel("dero-config"), panel("dero-config"), { kind: "priority" }],
	arcadeControl: [leaf("arcade", "on"), panel("arcade"), panel("arcade"), leaf("arcade", "reach"), leaf("arcade", "server block")],
};

/** The flow a routed step opens, or null for a customId from no current card. */
export function stepTarget(customId: string): StepTarget | null {
	const [prefix, domain, step] = customId.split(":");
	if (prefix !== HEADQUARTERS_STEP_PREFIX || !domain || !step) return null;
	return ROUTED_STEPS[domain as HeadquartersDomain]?.[Number(step) - 1] ?? null;
}

// ── the step press ───────────────────────────────────────────────────────────

// The launcher is loaded on use, for the reason dero.ts gives: it builds its command
// table from the admin commands as it loads, and those reach back into setup, so a
// static import from here risks a cycle with the table half built.
async function handleStepButton(interaction: ButtonInteraction): Promise<void> {
	const target = stepTarget(interaction.customId);
	if (!target) {
		await showErrorNotice(interaction, setupCopy.headquarters.staleStep);
		return;
	}
	if (target.kind === "priority") {
		await openPriorityModal(interaction);
		return;
	}
	const launcher = await import("@features/command-buttons/adminCommandLauncher.js");
	if (target.kind === "launch") await launcher.openAdminLaunch(interaction, target.launchId);
	else await launcher.openAdminLeaf(interaction, target.command, target.path);
}

// ── step 5, the voice priority order ─────────────────────────────────────────

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
		await showErrorNotice(interaction, voiceCopy.priority.notAdmin);
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
		await showErrorNotice(interaction, voiceCopy.priority.notAdmin);
		return;
	}
	const picks = Array.from({ length: PLACES }, (_unused, index) => interaction.fields.getStringSelectValues(placeFieldId(index))[0] ?? "");
	const order = orderFromPicks(picks);
	if (!order) {
		await showErrorNotice(interaction, voiceCopy.priority.duplicate);
		return;
	}
	await deroVoiceConfigStore.upsert(guild.id, { priorityOrder: order });
	const labels = order.map((category) => voiceCopy.priority.label(category));
	await interaction.reply({ embeds: [infoEmbed(voiceCopy.priority.modalTitle, voiceCopy.priority.saved(labels), COLORS.ADMIN)], flags: MessageFlags.Ephemeral });
	adminLog.emitFor(interaction, guild.id, "config.change", { subject: voiceCopy.priority.auditSubject, detail: labels.join(", ") });
	refreshHeadquartersCards(guild, "deroConfig");
}

/** Register the step buttons and the priority modal. Called once at boot from main.ts. */
export function registerHeadquartersStepHandlers(): void {
	registerButton(HEADQUARTERS_STEP_PREFIX, handleStepButton);
	registerModal(PRIORITY_MODAL_ID, handlePrioritySubmit);
}
