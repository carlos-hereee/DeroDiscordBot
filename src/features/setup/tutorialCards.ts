import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type ButtonInteraction, type Guild } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { COLORS } from "@base/copy/brand.js";
import { getPluginCopy, type ICopyConfig } from "@base/copy/getCopy.js";
import type { IPluginCopy } from "@base/copy/types.js";
import type { HeadquartersDomain, SetupStep } from "./headquartersCards.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { gateOwnerOrAdmin } from "@utils/permissions.js";
import { errorEmbed, infoEmbed } from "@utils/embedBuilder.js";
import { askInChannel, beginChannelAnswer } from "@utils/answerInChannel.js";
import { showNotice } from "@utils/textModal.js";
import { readAdoptedChannelIds } from "./adoption.js";
import { adminLog } from "./adminLog.js";
import { ensureOnDemandChannel, type OnDemandField } from "./onDemandChannel.js";
import { removeNoticeBoardChannel, type RemoveOutcome } from "./removeChannel.js";
import { setupCopy } from "./setupCopy.js";

// ── tutorialCards ───────────────────────────────────────────────────────────
// What:  the step cards of the four config channels (2026-11 item 285 Phase 3, widened
//        by 2026-11 item 289): the step model every config channel walks, and one card per
//        step, each teaching what its step is for. A channel card builds one notice board
//        channel and reads done once its slot holds an id, whoever built it. A flow card
//        opens a step's existing flow. Every step can be skipped or continued past, and a
//        ready channel can be removed.
// Who:   headquartersCards.ts keeps the cards in their channel (buildCards) and reveals them
//        one at a time (revealedSteps); headquartersSteps.ts routes each button here.
// Where: the build is onDemandChannel's, the one path that builds a notice board channel
//        after install, and a card's Remove is removeChannel.ts, so a card cannot build or
//        take away a channel any other way. Nothing here touches Discord's channels.
// How:   ten channel cards, one per notice board channel, and the 17 flow steps of the four
//        channels. A card's title never carries its mark, so a lost id still finds its card.

/** The channels a tutorial card builds, in card order, keyed by the word its customId carries. */
export const TUTORIAL_CHANNELS = {
	intro: "introChannelId",
	announcements: "announcementsChannelId",
	schedule: "scheduleChannelId",
	welcome: "welcomeChannelId",
	rules: "rulesChannelId",
	commands: "commandsChannelId",
	meetingVoice: "meetingVoiceChannelId",
	commandOutput: "commandOutputChannelId",
	leaderboard: "leaderboardChannelId",
	nextDecree: "nextDecreeChannelId",
} as const satisfies Record<string, OnDemandField>;

export type TutorialChannelKey = keyof typeof TUTORIAL_CHANNELS;
export type TutorialChannelField = (typeof TUTORIAL_CHANNELS)[TutorialChannelKey];

/** The step tail a tutorial button's customId carries after `hqstep:onboarding:`. */
export const TUTORIAL_STEP_TAIL = "tutorial-";

/** The customId of one card's button: `hqstep:onboarding:tutorial-<key>`. */
export function tutorialCustomId(key: TutorialChannelKey): string {
	return `hqstep:onboarding:${TUTORIAL_STEP_TAIL}${key}`;
}

/** The card key a step tail names, or null for one no card carries. */
export function tutorialKeyOf(step: string): TutorialChannelKey | null {
	if (!step.startsWith(TUTORIAL_STEP_TAIL)) return null;
	return channelKeyOf(step.slice(TUTORIAL_STEP_TAIL.length));
}

/** The step tail a Skip or Continue button's customId carries after `hqstep:<domain>:`. */
export const SKIP_STEP_TAIL = "skip-";

/** The customId of a Skip or Continue button: `hqstep:<domain>:skip-<key>`. */
export function skipCustomId(domain: HeadquartersDomain, key: string): string {
	return `hqstep:${domain}:${SKIP_STEP_TAIL}${key}`;
}

/** The step tail a Remove button's customId carries after `hqstep:onboarding:`. */
export const REMOVE_STEP_TAIL = "remove-";

/** The customId of a ready channel card's Remove: `hqstep:onboarding:remove-<key>`. */
export function removeCustomId(key: TutorialChannelKey): string {
	return `hqstep:onboarding:${REMOVE_STEP_TAIL}${key}`;
}

/** The channel key a word names, or null for one no channel card carries. */
export function channelKeyOf(word: string): TutorialChannelKey | null {
	return Object.hasOwn(TUTORIAL_CHANNELS, word) ? (word as TutorialChannelKey) : null;
}

// The arcade's enable step has no stored card and no teaching: the steps card is its card.
const ARCADE_ENABLE_KEY = "enable";

/**
 * The domain and key of a step id, or null for an id no step carries. The teaching table is
 * the list of flow steps, so a step added to it is known here at once.
 */
export function parseStepId(stepId: string): { domain: HeadquartersDomain; key: string } | null {
	const [domain, key, extra] = stepId.split(":");
	if (!domain || !key || extra !== undefined || !Object.hasOwn(setupCopy.headquarters.stepTeaching, domain)) return null;
	const known = domain as HeadquartersDomain;
	const isChannel = known === "onboarding" && channelKeyOf(key) !== null;
	const isArcadeEnable = known === "arcadeControl" && key === ARCADE_ENABLE_KEY;
	return isChannel || isArcadeEnable || Object.hasOwn(setupCopy.headquarters.stepTeaching[known], key) ? { domain: known, key } : null;
}

/** The slots buildCards reads off the row, and the steps an admin moved past. */
export type TutorialRow = Partial<Record<TutorialChannelField, string | null>> & {
	setupStepsSkipped?: readonly string[] | null;
};

/** One kept card: the key its stored message id sits under, its title and its message. */
export interface StepCard {
	key: string;
	title: string;
	message: { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] };
}

const copy = setupCopy.headquarters.onboarding.tutorial;
const removeCopy = copy.remove;
const cardCopy = setupCopy.headquarters.stepCards;

const REMOVE_CONFIRM_ID = "confirm_remove_channel";
const REMOVE_CANCEL_ID = "cancel_remove_channel";

// ── the step model (2026-11 item 289) ────────────────────────────────────────
// A step id is domain:key, the one word setupStepsSkipped stores. Two pure reads answer
// everything a card or a sync needs from that list: progressOf is what a step shows, and
// revealedSteps is which steps keep a card. One rule serves every server, because both read
// only the row: a new server and an old one differ in what they already hold, never in a flag.

/** What a step shows: its ✅, its ⬜ or its ⏭️. */
export type StepProgress = "done" | "skipped" | "open";

/** The steps that keep a card, and whether the domain has no step left to resolve. */
export interface RevealedSteps {
	kept: SetupStep[];
	finished: boolean;
}

/** The id setupStepsSkipped stores for one step. */
export function stepIdOf(domain: HeadquartersDomain, key: string): string {
	return `${domain}:${key}`;
}

/**
 * What a step shows. A pressed Continue reads done, never skipped, because a step that needs
 * Continue has nothing to skip: it only waits for an admin to see it.
 */
export function progressOf(step: SetupStep, domain: HeadquartersDomain, skipped: readonly string[]): StepProgress {
	const listed = skipped.includes(stepIdOf(domain, step.key));
	if (step.done || (step.needsContinue && listed)) return "done";
	return listed ? "skipped" : "open";
}

/**
 * True once the walk may move past a step. A needsContinue step wants its press even when it
 * already reads done, because that mark can read true with nobody having looked at it.
 */
export function isResolved(step: SetupStep, domain: HeadquartersDomain, skipped: readonly string[]): boolean {
	return skipped.includes(stepIdOf(domain, step.key)) || (step.done && !step.needsContinue);
}

/** The key one step's card is stored under: the channel slot, or <domain>-<key> for a flow step. */
export function cardKeyOf(step: Pick<SetupStep, "key" | "kind">, domain: HeadquartersDomain): string {
	if (step.kind === "channel") return TUTORIAL_CHANNELS[step.key as TutorialChannelKey];
	return `${domain}-${step.key}`;
}

/**
 * Which steps keep a card, walking in step order. A stored card always stays, even past the
 * frontier, because a posted card is never deleted. The frontier, the first unresolved step,
 * is the one new card a walk reveals. A resolved channel step before the frontier keeps a
 * card so its Remove has a home, while a resolved flow step with no card stays cardless, or
 * a fully set up server would be handed every step at once.
 */
export function revealedSteps(
	steps: readonly SetupStep[],
	domain: HeadquartersDomain,
	skipped: readonly string[],
	storedIds: Partial<Record<string, string | null>> | null | undefined
): RevealedSteps {
	const kept: SetupStep[] = [];
	let frontierPassed = false;
	for (const step of steps) {
		const resolved = isResolved(step, domain, skipped);
		const hasStoredCard = Boolean(storedIds?.[cardKeyOf(step, domain)]);
		const isFrontier = !resolved && !frontierPassed;
		const isChannelBeforeFrontier = resolved && step.kind === "channel" && !frontierPassed;
		if (hasStoredCard || isFrontier || isChannelBeforeFrontier) kept.push(step);
		if (isFrontier) frontierPassed = true;
	}
	return { kept, finished: !frontierPassed };
}

// ── the cards ────────────────────────────────────────────────────────────────

/** The ten channel steps as the row stands, each teaching from the guild's pack. */
export function channelSteps(row: TutorialRow | null, pack: IPluginCopy): SetupStep[] {
	return (Object.keys(TUTORIAL_CHANNELS) as TutorialChannelKey[]).map((key) => {
		const teaching = pack.channelContent.tutorial[key];
		return { key, kind: "channel", label: teaching.title, done: Boolean(row?.[TUTORIAL_CHANNELS[key]]), needsContinue: false, teaching: teaching.body, customId: tutorialCustomId(key) };
	});
}

/** A step's Skip button. Grey, because a step's own action is the one to press. */
export function buildSkipButton(domain: HeadquartersDomain, key: string): ButtonBuilder {
	return new ButtonBuilder().setCustomId(skipCustomId(domain, key)).setLabel(cardCopy.skipButton).setStyle(ButtonStyle.Secondary);
}

function buildStepCard(key: string, title: string, description: string, buttons: ButtonBuilder[]): StepCard {
	const embed = new EmbedBuilder().setTitle(title).setDescription(description).setColor(COLORS.ADMIN);
	const components = buttons.length > 0 ? [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)] : [];
	return { key, title, message: { embeds: [embed], components } };
}

function channelButtons(key: TutorialChannelKey, domain: HeadquartersDomain, progress: StepProgress): ButtonBuilder[] {
	// A done card's button still works: it answers that the channel is already there.
	if (progress === "done") {
		return [
			new ButtonBuilder().setCustomId(tutorialCustomId(key)).setLabel(copy.doneButton).setStyle(ButtonStyle.Success),
			new ButtonBuilder().setCustomId(removeCustomId(key)).setLabel(cardCopy.removeButton).setStyle(ButtonStyle.Danger),
		];
	}
	const add = new ButtonBuilder().setCustomId(tutorialCustomId(key)).setLabel(copy.addButton).setStyle(ButtonStyle.Primary);
	return progress === "open" ? [add, buildSkipButton(domain, key)] : [add];
}

function channelLine(channelId: string | null, progress: StepProgress): string {
	if (channelId) return copy.doneLine(channelId);
	return progress === "skipped" ? cardCopy.skippedLine : copy.pendingLine;
}

function channelCard(step: SetupStep, domain: HeadquartersDomain, row: TutorialRow | null, skipped: readonly string[]): StepCard {
	const key = step.key as TutorialChannelKey;
	const channelId = row?.[TUTORIAL_CHANNELS[key]] ?? null;
	const progress = progressOf(step, domain, skipped);
	return buildStepCard(cardKeyOf(step, domain), step.label, `${step.teaching}\n\n${channelLine(channelId, progress)}`, channelButtons(key, domain, progress));
}

// A needsContinue step has nothing to skip: it only waits to be seen, so its one extra
// button is Continue, which is the action here and takes the blue. Gating has no flow to
// open, so a pressed Continue leaves it no button at all.
function continueButtons(step: SetupStep, domain: HeadquartersDomain, pressed: boolean): ButtonBuilder[] {
	const open = step.customId ? [new ButtonBuilder().setCustomId(step.customId).setLabel(cardCopy.openButton).setStyle(ButtonStyle.Secondary)] : [];
	if (pressed) return open;
	return [...open, new ButtonBuilder().setCustomId(skipCustomId(domain, step.key)).setLabel(cardCopy.continueButton).setStyle(ButtonStyle.Primary)];
}

function flowButtons(step: SetupStep, domain: HeadquartersDomain, progress: StepProgress): ButtonBuilder[] {
	if (!step.customId) return [];
	const open = new ButtonBuilder().setCustomId(step.customId).setLabel(cardCopy.openButton);
	if (progress === "open") return [open.setStyle(ButtonStyle.Primary), buildSkipButton(domain, step.key)];
	return [open.setStyle(ButtonStyle.Secondary)];
}

function flowCard(step: SetupStep, domain: HeadquartersDomain, skipped: readonly string[]): StepCard {
	const listed = skipped.includes(stepIdOf(domain, step.key));
	const key = cardKeyOf(step, domain);
	if (step.needsContinue) {
		const description = listed ? `${step.teaching}\n\n${cardCopy.continuedLine}` : step.teaching;
		return buildStepCard(key, step.label, description, continueButtons(step, domain, listed));
	}
	const progress = progressOf(step, domain, skipped);
	const description = progress === "skipped" ? `${step.teaching}\n\n${cardCopy.skippedLine}` : step.teaching;
	return buildStepCard(key, step.label, description, flowButtons(step, domain, progress));
}

/**
 * The one builder of a step card, channel or flow, as the row stands. A title never carries
 * the mark, because the keeper finds a card whose id was lost by its title, and a title that
 * changed with the mark would post a second card the moment a step moved.
 */
export function buildCards(steps: readonly SetupStep[], domain: HeadquartersDomain, row: TutorialRow | null): StepCard[] {
	const skipped = row?.setupStepsSkipped ?? [];
	return steps.map((step) => (step.kind === "channel" ? channelCard(step, domain, row, skipped) : flowCard(step, domain, skipped)));
}

// ── the buttons ──────────────────────────────────────────────────────────────

// Loaded on use: headquartersCards imports this file for the cards.
async function redrawDomain(guild: Guild, domain: HeadquartersDomain): Promise<void> {
	const { syncHeadquartersChannel } = await import("./headquartersCards.js");
	await syncHeadquartersChannel(guild, domain);
}

/**
 * Skip or Continue: re-check the presser, list the step and redraw its channel, which reveals
 * the next card. A double press is harmless, because the list is a set and syncs are queued.
 * The press writes no admin log line: it changes no setting. Never throws.
 */
export async function handleSkip(interaction: ButtonInteraction, stepId: string): Promise<void> {
	const guild = interaction.guild;
	if (!guild) return;
	const config = await guildConfigStore.findByGuildId(guild.id);
	const title = getPluginCopy(config as unknown as ICopyConfig | null).notice.setup;
	// A button outlives the role that was allowed to press it.
	if (!(await gateOwnerOrAdmin(interaction, config))) {
		await showNotice(interaction, { title, sections: [cardCopy.notAdmin] });
		return;
	}
	const step = parseStepId(stepId);
	if (!step) {
		await showNotice(interaction, { title, sections: [setupCopy.headquarters.staleStep] });
		return;
	}
	try {
		// Acknowledged first: the redraw can draw a chart, past the press's three second window.
		await interaction.deferUpdate();
		await guildConfigStore.addToList(guild.id, "setupStepsSkipped", stepId);
		await redrawDomain(guild, step.domain);
	} catch (error) {
		console.error(`[tutorial] guild ${guild.id}: moving past step ${stepId} failed`, error);
	}
}

/**
 * Add this channel: re-check the presser, then build the card's channel through
 * onDemandChannel and say where it is in 🧭onboarding. The card itself is redrawn by
 * onDemandChannel once the channel exists. Never throws.
 */
export async function handleAddChannel(interaction: ButtonInteraction, channelKey: TutorialChannelKey): Promise<void> {
	const guild = interaction.guild;
	if (!guild) return;
	const config = await guildConfigStore.findByGuildId(guild.id);
	const copyConfig = config as unknown as ICopyConfig | null;
	if (!(await gateOwnerOrAdmin(interaction, config))) {
		await showNotice(interaction, { title: getPluginCopy(copyConfig).notice.setup, sections: [copy.notAdmin] });
		return;
	}

	const field = TUTORIAL_CHANNELS[channelKey];
	const storedBefore = (config as unknown as TutorialRow | null)?.[field] ?? null;
	// A first build makes a category, a channel and an intro post, past the press's three
	// second window, so the press is acknowledged before the work runs.
	const answer = await beginChannelAnswer(interaction, "onboarding", { config });
	try {
		const channel = await ensureOnDemandChannel(guild, field, { explicitRequest: true, actorUserId: interaction.user.id });
		if (!channel) {
			await answer.send({ embeds: [errorEmbed(copy.notBuilt, copyConfig)] });
			return;
		}
		const line = channel.id === storedBefore ? copy.alreadyBuilt(channel.id) : copy.built(channel.id);
		await answer.send({ embeds: [infoEmbed(copy.answerTitle, line, COLORS.ADMIN, copyConfig)] });
	} catch (error) {
		console.error(`[tutorial] guild ${guild.id}: building ${field} from its tutorial card failed`, error);
		await answer.send({ embeds: [errorEmbed(copy.notBuilt, copyConfig)] });
	}
}

function buildRemoveConfirmRow(): ActionRowBuilder<ButtonBuilder> {
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder().setCustomId(REMOVE_CANCEL_ID).setLabel(removeCopy.cancelButton).setStyle(ButtonStyle.Secondary),
		new ButtonBuilder().setCustomId(REMOVE_CONFIRM_ID).setLabel(removeCopy.confirmButton).setStyle(ButtonStyle.Danger)
	);
}

function removeOutcomeEmbed(outcome: RemoveOutcome, label: string, copyConfig: ICopyConfig | null): EmbedBuilder {
	if (outcome === "refused") return errorEmbed(removeCopy.refused(label), copyConfig);
	return infoEmbed(copy.answerTitle, removeCopy[outcome](label), COLORS.ADMIN, copyConfig);
}

// The confirmed half of a Remove. Only a change to the server earns a log line: a refusal and
// an already empty slot changed nothing.
async function runRemove(press: ButtonInteraction, guild: Guild, channelKey: TutorialChannelKey, label: string): Promise<RemoveOutcome> {
	const outcome = await removeNoticeBoardChannel(guild, TUTORIAL_CHANNELS[channelKey], stepIdOf("onboarding", channelKey));
	if (outcome === "deleted" || outcome === "released") {
		const detail = outcome === "deleted" ? setupCopy.adminLog.removedFromCard : setupCopy.adminLog.releasedFromCard;
		adminLog.emitFor(press, guild.id, "config.change", { subject: setupCopy.adminLog.noticeBoardChannel(label), detail });
	}
	await redrawDomain(guild, "onboarding");
	return outcome;
}

/**
 * Remove on a ready channel's card: re-check the presser, ask Remove or Cancel in 🧭onboarding,
 * saying whether the channel goes or stays, and only on Remove hand the slot to
 * removeChannel.ts, then rewrite the prompt with the outcome. A cancel and a timeout change
 * nothing. Never throws.
 */
export async function handleRemove(interaction: ButtonInteraction, channelKey: TutorialChannelKey): Promise<void> {
	const guild = interaction.guild;
	if (!guild) return;
	const config = await guildConfigStore.findByGuildId(guild.id);
	const copyConfig = config as unknown as ICopyConfig | null;
	const pack = getPluginCopy(copyConfig);
	if (!(await gateOwnerOrAdmin(interaction, config))) {
		await showNotice(interaction, { title: pack.notice.setup, sections: [removeCopy.notAdmin] });
		return;
	}

	const channelId = (config as unknown as TutorialRow | null)?.[TUTORIAL_CHANNELS[channelKey]] ?? null;
	if (!channelId) {
		await showNotice(interaction, { title: pack.notice.setup, sections: [removeCopy.alreadyGone] });
		await redrawDomain(guild, "onboarding");
		return;
	}

	const body = readAdoptedChannelIds(config).includes(channelId) ? removeCopy.confirmAdopted(channelId) : removeCopy.confirmBuilt(channelId);
	// Only the asker's press resolves the wait; anyone else is turned away with a notice.
	const prompt = await askInChannel(interaction, "onboarding", { embeds: [infoEmbed(removeCopy.title, body, COLORS.ERROR, copyConfig)], components: [buildRemoveConfirmRow()] }, { config });

	const press = await prompt.awaitPress(BOT_CONSTANTS.CONFIRM_PROMPT_MS);
	if (!press) {
		await prompt.edit({ embeds: [infoEmbed(removeCopy.title, removeCopy.timedOut, COLORS.ADMIN, copyConfig)], components: [] });
		return;
	}
	if (press.customId !== REMOVE_CONFIRM_ID) {
		await press.update({ embeds: [infoEmbed(removeCopy.title, removeCopy.cancelled, COLORS.ADMIN, copyConfig)], components: [] });
		return;
	}

	// Deleting a channel and its category can outrun the press's three second window, so it is
	// acknowledged first and the prompt rewritten after.
	await press.deferUpdate();
	try {
		const label = pack.channelContent.tutorial[channelKey].title;
		const outcome = await runRemove(press, guild, channelKey, label);
		await prompt.edit({ embeds: [removeOutcomeEmbed(outcome, label, copyConfig)], components: [] });
	} catch (error) {
		console.error(`[tutorial] guild ${guild.id}: removing ${channelKey} from its card failed`, error);
		await prompt.edit({ embeds: [errorEmbed(removeCopy.failed, copyConfig)], components: [] });
	}
}
