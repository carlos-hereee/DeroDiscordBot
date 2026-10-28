import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	CategoryChannel,
	EmbedBuilder,
	LabelBuilder,
	MessageFlags,
	ModalBuilder,
	StringSelectMenuBuilder,
	TextChannel,
	TextDisplayBuilder,
	type ButtonInteraction,
	type Guild,
	type ModalSubmitInteraction,
} from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { COLORS } from "@base/copy/brand.js";
import { registerButton, registerModal } from "@handlers/interactionRegistry.js";
import { gateOwnerOrAdmin } from "@utils/permissions.js";
import { beginChannelAnswer, type PendingChannelAnswer } from "@utils/answerInChannel.js";
import { showModalOrReply, showNotice } from "@utils/textModal.js";
import { mustStayReadable, readOnboardingSafeChannels } from "@features/community/onboardingChannels.js";
import { communityOverwritesFor, isMemberRoleGated, type IOverwriteRoles } from "./communityOverwrites.js";
import { matchesAdoptionPattern, moveIntoNoticeBoard, readAdoptedChannelIds, readAdoptionChoice, type AdoptionChoice } from "./adoption.js";
import { adminLog } from "./adminLog.js";
import { setupCopy } from "./setupCopy.js";
import { getPluginCopy } from "@base/copy/getCopy.js";

// ── adoptionChoice ───────────────────────────────────────────────────
// What:  the setup step that asks an admin, per channel, whether a welcome or rules
//        channel the server already had moves into 🪧 NOTICE BOARD or stays where it
//        is (2026-10 item 257 Phase 1a, owner decision 5), and the ONE move every
//        path shares once an admin said Move. It never builds or deletes a channel.
// Who:   GuildSetupManager posts the card (offerAdoptionChoice) after a build or a
//        boot sweep adopts a channel, and moves a channel whose stored answer is
//        "move" (moveChosenChannel) when a rebuild adopts it again; main.ts registers
//        the Choose button and the modal's Submit.
// When:  the card goes up once per adoption, in the admin channel. Until an admin
//        answers, the channel is adopted IN PLACE: Dero posts in it and leaves its
//        place and permissions alone, so nothing moves without an admin saying so.
// How:   ① the card lists the channels and carries a Choose button; ② Choose
//        re-checks owner or admin and opens a modal with one select per channel;
//        ③ Submit re-checks, moves each channel picked to move (its overwrite first,
//        its parent only after Discord accepts it), stores every answer on
//        GuildConfig.adoptedChannelChoices, logs one admin log line per channel and
//        rewrites the card with what happened. A channel Discord Onboarding uses
//        moves onto the open shape, so it stays readable by everyone either way.

// ── constants ────────────────────────────────────────────────────────

/** The interactionRegistry prefix of the card's button and of the modal. */
export const ADOPTION_CHOICE_PREFIX = "adoption";
// Exported for the 🧭onboarding steps card, whose step 2 carries this same button (2026-10 item 257 Phase 2b).
export const CHOOSE_BUTTON_ID = `${ADOPTION_CHOICE_PREFIX}:choose`;
const SUBMIT_MODAL_ID = `${ADOPTION_CHOICE_PREFIX}:submit`;
// Discord caps a select label at 45 characters.
const MAX_SELECT_LABEL_LENGTH = 45;

/** The slots an adopted channel can fill, in the order the card lists them. */
const ADOPTABLE_SLOTS = ["welcomeChannelId", "rulesChannelId"] as const;
type AdoptableSlot = (typeof ADOPTABLE_SLOTS)[number];

// ── types ────────────────────────────────────────────────────────────

/** The stored GuildConfig fields this step reads. */
export interface IAdoptionChoiceRow {
	categoryId?: string | null;
	adminChannelId?: string | null;
	adminRoleId?: string | null;
	memberRoleId?: string | null;
	welcomeChannelId?: string | null;
	rulesChannelId?: string | null;
	adoptedChannelIds?: unknown;
	adoptedChannelChoices?: unknown;
}

/** One adopted channel an admin may place, and the slot it fills. */
export interface IChoosableChannel {
	slot: AdoptableSlot;
	channel: TextChannel;
}

/** What one move did: moved, already in the notice board, or refused by Discord and left in place. */
export type MoveOutcome = "moved" | "already" | "refused";

// ── the move ─────────────────────────────────────────────────────────

/**
 * Move one adopted channel into the notice board onto the public shape. A channel
 * Discord Onboarding uses (or, when Onboarding cannot be read, any adopted channel)
 * takes the open shape, which keeps @everyone's ViewChannel, because Discord refuses
 * the gated one with 350003. A refusal is logged in one line and leaves the channel
 * exactly where it was, still adopted. Never throws.
 */
export async function moveChosenChannel(guild: Guild, channel: TextChannel, category: { id: string }, roles: IOverwriteRoles): Promise<MoveOutcome> {
	let shapeRoles = roles;
	// Only a gated shape can hide the channel, so only then is Onboarding worth a read.
	if (isMemberRoleGated(guild, roles.memberRoleId)) {
		const safe = await readOnboardingSafeChannels(guild);
		// No member role means the open shape: @everyone keeps ViewChannel.
		if (mustStayReadable(safe, channel.id, true)) shapeRoles = { memberRoleId: null, adminRoleId: roles.adminRoleId };
	}
	const overwrites = communityOverwritesFor("public", guild, { ownerId: guild.ownerId }, shapeRoles);
	try {
		return (await moveIntoNoticeBoard(channel, category, overwrites)) ? "moved" : "already";
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		console.warn(`[adoption] guild ${guild.id} could not move channel ${channel.id} into the notice board (${reason}); it stays adopted where it is`);
		return "refused";
	}
}

// ── which channels an admin may place ────────────────────────────────

/**
 * The adopted channels an admin may place. A system channel adopted in place under a
 * name that is not a welcome name (a #general, the server's main chat) is left out:
 * the notice board's read only shape would silence it, so it is never offered a move.
 */
export function choosableAdoptedChannels(guild: Pick<Guild, "channels" | "systemChannelId">, row: IAdoptionChoiceRow): IChoosableChannel[] {
	const adopted = new Set(readAdoptedChannelIds(row));
	const choosable: IChoosableChannel[] = [];
	for (const slot of ADOPTABLE_SLOTS) {
		const channelId = row[slot];
		if (!channelId || !adopted.has(channelId)) continue;
		const channel = guild.channels.cache?.get(channelId);
		if (!(channel instanceof TextChannel)) continue;
		const isMainChat = channel.id === guild.systemChannelId && !matchesAdoptionPattern(channel.name, BOT_CONSTANTS.WELCOME_ADOPTION_PATTERNS);
		if (!isMainChat) choosable.push({ slot, channel });
	}
	return choosable;
}

// ── the card ─────────────────────────────────────────────────────────

/** The card in the admin channel: which channels Dero found, and the Choose button. */
export function buildAdoptionChoiceCard(entries: readonly IChoosableChannel[]): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
	const copy = setupCopy.adoptionChoice;
	const lines = entries.map((entry) => copy.channelLine(entry.channel.id, copy.slots[entry.slot]));
	return {
		embeds: [new EmbedBuilder().setTitle(copy.cardTitle).setDescription(copy.cardBody(lines)).setColor(COLORS.ADMIN)],
		components: [chooseButtonRow()],
	};
}

/**
 * Post the card when the guild has an adopted channel nobody has placed yet. Fire and
 * forget after the adoption it follows (project rule 7): logs its own failures and
 * never throws into the build or the boot sweep.
 */
export async function offerAdoptionChoice(guild: Guild): Promise<void> {
	try {
		const row = (await guildConfigStore.findByGuildId(guild.id)) as unknown as IAdoptionChoiceRow | null;
		if (!row?.adminChannelId) return;
		const unanswered = choosableAdoptedChannels(guild, row).filter((entry) => readAdoptionChoice(row, entry.channel.id) === null);
		if (unanswered.length === 0) return;
		const adminChannel = await guild.channels.fetch(row.adminChannelId).catch(() => null);
		if (!(adminChannel instanceof TextChannel)) return;
		await adminChannel.send({ ...buildAdoptionChoiceCard(unanswered), allowedMentions: { parse: [] } });
	} catch (error) {
		console.warn(`[adoption] guild ${guild.id} could not post the channel choice card`, error);
	}
}

// ── the modal ────────────────────────────────────────────────────────

/** The modal: a prompt, then one select per channel, preset to its stored answer or to where it sits now. */
export function buildAdoptionChoiceModal(entries: readonly IChoosableChannel[], row: IAdoptionChoiceRow): ModalBuilder {
	const copy = setupCopy.adoptionChoice;
	const labels = entries.map((entry) => {
		const current: AdoptionChoice = readAdoptionChoice(row, entry.channel.id) ?? (entry.channel.parentId === row.categoryId ? "move" : "stay");
		const select = new StringSelectMenuBuilder()
			.setCustomId(entry.channel.id)
			.setRequired(true)
			.addOptions(
				{ label: copy.options.move.label, description: copy.options.move.description, value: "move", default: current === "move" },
				{ label: copy.options.stay.label, description: copy.options.stay.description, value: "stay", default: current === "stay" }
			);
		return new LabelBuilder().setLabel(copy.selectLabel(entry.channel.name).slice(0, MAX_SELECT_LABEL_LENGTH)).setStringSelectMenuComponent(select);
	});
	return new ModalBuilder()
		.setCustomId(SUBMIT_MODAL_ID)
		.setTitle(copy.modalTitle)
		.addTextDisplayComponents(new TextDisplayBuilder().setContent(copy.modalPrompt))
		.addLabelComponents(...labels);
}

/** The Choose button: re-check owner or admin, then open the modal. */
export async function handleChooseButton(interaction: ButtonInteraction): Promise<void> {
	const copy = setupCopy.adoptionChoice;
	const guild = interaction.guild;
	if (!guild) return;
	const row = (await guildConfigStore.findByGuildId(guild.id)) as unknown as IAdoptionChoiceRow | null;
	// A channel is not a gate: the card sits in the admin channel, but every press re-checks.
	if (!(await gateOwnerOrAdmin(interaction, row))) {
		await showNotice(interaction, { title: getPluginCopy(null).notice.setup, sections: [copy.notAllowed] });
		return;
	}
	const entries = row ? choosableAdoptedChannels(guild, row) : [];
	if (!row || entries.length === 0) {
		await showNotice(interaction, { title: getPluginCopy(null).notice.setup, sections: [copy.nothingToChoose] });
		return;
	}
	await showModalOrReply(interaction, buildAdoptionChoiceModal(entries, row), () => ({ content: copy.modalRefused, flags: MessageFlags.Ephemeral }));
}

/** The modal's Submit: re-check, move or leave each channel, store the answers, rewrite the card. */
export async function handleChoiceSubmit(interaction: ModalSubmitInteraction): Promise<void> {
	const copy = setupCopy.adoptionChoice;
	const guild = interaction.guild;
	if (!guild) return;
	const row = (await guildConfigStore.findByGuildId(guild.id)) as unknown as IAdoptionChoiceRow | null;
	// Re-checked at Submit: a role can be taken away while the modal is open.
	if (!row || !(await gateOwnerOrAdmin(interaction, row))) {
		await showNotice(interaction, { title: getPluginCopy(null).notice.setup, sections: [copy.notAllowed] });
		return;
	}
	// A move is a Discord round trip or two per channel, past the three second window.
	// The result replaces the choice card only when the modal came from that card: from
	// the 🧭onboarding steps card (2026-10 item 257 Phase 2b) an update would overwrite
	// the steps card, so the result posts as a new card in 🧭onboarding instead (Phase 5).
	const fromChoiceCard = interaction.isFromMessage() && interaction.message.embeds[0]?.title === copy.cardTitle;
	let answer: PendingChannelAnswer | null = null;
	if (fromChoiceCard) await interaction.deferUpdate();
	else answer = await beginChannelAnswer(interaction, "onboarding");

	const category = row.categoryId ? await guild.channels.fetch(row.categoryId).catch(() => null) : null;
	const roles = { memberRoleId: row.memberRoleId ?? null, adminRoleId: row.adminRoleId ?? null };
	const answers: Record<string, AdoptionChoice> = {};
	const lines: string[] = [];
	for (const entry of choosableAdoptedChannels(guild, row)) {
		const picked = pickedChoice(interaction, entry.channel.id);
		if (!picked) continue;
		const outcome = picked === "move" ? await moveOrRefuse(guild, entry.channel, category, roles) : null;
		// A refused move is stored as "stay", what actually happened, so a rebuild never
		// retries a move Discord already refused.
		answers[entry.channel.id] = outcome === "refused" || picked === "stay" ? "stay" : "move";
		lines.push(resultLine(entry.channel.id, outcome));
		adminLog.emitFor(interaction, guild.id, "config.change", {
			subject: entry.slot === "welcomeChannelId" ? setupCopy.adminLog.subjects.welcomeLog : setupCopy.adminLog.subjects.rulesChannel,
			detail: auditDetail(outcome),
		});
	}

	const writes = Object.fromEntries(Object.entries(answers).map(([channelId, choice]) => [`adoptedChannelChoices.${channelId}`, choice]));
	if (Object.keys(writes).length > 0) await guildConfigStore.update(guild.id, writes);

	const result = new EmbedBuilder().setTitle(copy.cardTitle).setDescription(lines.join("\n") || copy.nothingToChoose).setColor(COLORS.ADMIN);
	const card = { embeds: [result], components: [chooseButtonRow()] };
	if (answer) await answer.send(card);
	else await interaction.editReply(card).catch((error) => console.warn(`[adoption] guild ${guild.id} could not update the channel choice card`, error));
	// 🧭onboarding's step 2 mark follows the answers. Loaded on use, because
	// headquartersCards reads this module's channel list and a static import back would
	// close a cycle.
	void import("./headquartersCards.js").then((cards) => cards.refreshHeadquartersCards(guild, "onboarding"));
}

/** Register the Choose button and the modal's Submit. Called once at boot from main.ts. */
export function registerAdoptionChoiceHandlers(): void {
	registerButton(ADOPTION_CHOICE_PREFIX, handleChooseButton);
	registerModal(ADOPTION_CHOICE_PREFIX, handleChoiceSubmit);
}

// ── helpers ──────────────────────────────────────────────────────────

function chooseButtonRow(): ActionRowBuilder<ButtonBuilder> {
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder().setCustomId(CHOOSE_BUTTON_ID).setLabel(setupCopy.adoptionChoice.buttonLabel).setStyle(ButtonStyle.Primary)
	);
}

// A move with no notice board to move into reads as refused: the channel stays put.
async function moveOrRefuse(guild: Guild, channel: TextChannel, category: unknown, roles: IOverwriteRoles): Promise<MoveOutcome> {
	if (!(category instanceof CategoryChannel)) return "refused";
	return moveChosenChannel(guild, channel, category, roles);
}

// The select's answer, or null for a submit without it, which only a hand made submit
// can be, since Discord enforces a required select.
function pickedChoice(interaction: ModalSubmitInteraction, fieldId: string): AdoptionChoice | null {
	try {
		const [value] = interaction.fields.getStringSelectValues(fieldId);
		return value === "move" || value === "stay" ? value : null;
	} catch {
		return null;
	}
}

function resultLine(channelId: string, outcome: MoveOutcome | null): string {
	const results = setupCopy.adoptionChoice.results;
	if (outcome === "moved") return results.moved(channelId);
	if (outcome === "already") return results.already(channelId);
	if (outcome === "refused") return results.refused(channelId);
	return results.stayed(channelId);
}

function auditDetail(outcome: MoveOutcome | null): string {
	const copy = setupCopy.adoptionChoice;
	if (outcome === "refused") return copy.auditRefused;
	return outcome === null ? copy.auditStayed : copy.auditMoved;
}
