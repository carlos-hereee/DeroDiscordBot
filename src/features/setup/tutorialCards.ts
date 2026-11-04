import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type ButtonInteraction } from "discord.js";
import { COLORS } from "@base/copy/brand.js";
import { getPluginCopy, type ICopyConfig } from "@base/copy/getCopy.js";
import type { IPluginCopy } from "@base/copy/types.js";
import type { HeadquartersDomain, SetupStep } from "./headquartersCards.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { gateOwnerOrAdmin } from "@utils/permissions.js";
import { errorEmbed, infoEmbed } from "@utils/embedBuilder.js";
import { beginChannelAnswer } from "@utils/answerInChannel.js";
import { showNotice } from "@utils/textModal.js";
import { ensureOnDemandChannel, type OnDemandField } from "./onDemandChannel.js";
import { setupCopy } from "./setupCopy.js";

// ── tutorialCards ───────────────────────────────────────────────────────────
// What:  the notice board tutorial in 🧭onboarding (2026-11 item 285 Phase 3): one card
//        per channel an admin builds by hand, each teaching what its channel is for and
//        carrying one button that builds it. A card reads done once its slot holds a
//        channel id, whoever built it, and pending while the slot is empty.
// Who:   headquartersCards.ts keeps the cards beneath 🧭onboarding's chart (buildCards);
//        headquartersSteps.ts routes each button here (handleAddChannel).
// Where: the build itself is onDemandChannel's, the one path that builds a notice board
//        channel after install, so a card's button and a feature's first use can never
//        build a channel two different ways. Nothing here touches Discord's channels.
// How:   seven cards: the four the plan named (introductions, announcements, schedule,
//        welcome) and, by the owner's rulings at Phase 3 kickoff, the rules, the command
//        center and the Meeting Hall, the notice board channels no feature can ask for
//        on a server without them (the Edit rules button lives on the rules post itself).

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
	const key = step.slice(TUTORIAL_STEP_TAIL.length);
	return Object.hasOwn(TUTORIAL_CHANNELS, key) ? (key as TutorialChannelKey) : null;
}

/** The step tail a Skip or Continue button's customId carries after `hqstep:<domain>:`. */
export const SKIP_STEP_TAIL = "skip-";

/** The customId of a Skip or Continue button: `hqstep:<domain>:skip-<key>`. */
export function skipCustomId(domain: HeadquartersDomain, key: string): string {
	return `hqstep:${domain}:${SKIP_STEP_TAIL}${key}`;
}

/** The slots buildCards reads off the row, and the steps an admin moved past. */
export type TutorialRow = Partial<Record<TutorialChannelField, string | null>> & {
	setupStepsSkipped?: readonly string[] | null;
};

/** One kept card: the slot it builds (which keys its stored message id), its title and its message. */
export interface TutorialCard {
	field: TutorialChannelField;
	title: string;
	done: boolean;
	message: { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] };
}

const copy = setupCopy.headquarters.onboarding.tutorial;
const cardCopy = setupCopy.headquarters.stepCards;

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

/**
 * Every tutorial card as the row stands. The title never carries the mark, because the
 * keeper finds a card whose id was lost by its title, and a title that changed with the
 * mark would post a second card the moment a channel was built.
 */
export function buildCards(stored: TutorialRow | null, pack: IPluginCopy): TutorialCard[] {
	return (Object.keys(TUTORIAL_CHANNELS) as TutorialChannelKey[]).map((key) => {
		const field = TUTORIAL_CHANNELS[key];
		const channelId = stored?.[field] ?? null;
		const teaching = pack.channelContent.tutorial[key];
		const embed = new EmbedBuilder()
			.setTitle(teaching.title)
			.setDescription(`${teaching.body}\n\n${channelId ? copy.doneLine(channelId) : copy.pendingLine}`)
			.setColor(COLORS.ADMIN);
		// A done card's button still works: it answers that the channel is already there.
		const button = new ButtonBuilder()
			.setCustomId(tutorialCustomId(key))
			.setLabel(channelId ? copy.doneButton : copy.addButton)
			.setStyle(channelId ? ButtonStyle.Success : ButtonStyle.Primary);
		return { field, title: teaching.title, done: Boolean(channelId), message: { embeds: [embed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)] } };
	});
}

// ── the button ───────────────────────────────────────────────────────────────

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
