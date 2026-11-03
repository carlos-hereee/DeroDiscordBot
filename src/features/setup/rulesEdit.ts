import {
	ActionRowBuilder,
	ModalBuilder,
	TextChannel,
	TextInputBuilder,
	TextInputStyle,
	type ButtonInteraction,
	type Message,
	type ModalSubmitInteraction,
} from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { BOT_LOG_EVENTS } from "@base/constants/BOT_LOG_EVENTS.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { getPluginCopy } from "@base/copy/getCopy.js";
import { registerButton } from "@handlers/interactionRegistry.js";
import { gateOwnerOrAdmin } from "@utils/permissions.js";
import { RULES_EDIT_CUSTOM_ID, RULES_PREFIX, resolveRulesMarkdown, rulesContent, type IRulesConfig } from "./rulesContent.js";
import { answerInChannel } from "@utils/answerInChannel.js";
import { showErrorNotice, showNotice } from "@utils/textModal.js";

// ── rulesEdit ────────────────────────────────────────────────────────
// What:  the Edit rules button on the 📘rules post (2026-10 item 247 Phase 2): it
//        opens a modal preloaded with the rules as they stand, saves the owner's
//        text to GuildConfig.customRulesMarkdown, and re-renders the rules post in
//        place. It never posts a new rules message and never touches a message
//        Dero did not write.
// Who:   main.ts registers it once at boot; the button itself is built by
//        rulesContent and rides the rules post, which members can see too.
// When:  on every press. The modal waits RULES_EDIT_MODAL_TIMEOUT_MS; a submit
//        after that is not heard and saves nothing.
// How:   ① re-check the clicker is the owner or an admin; ② show the modal and
//        await its submit (the configure-rok-reminders pattern); ③ re-check the
//        SUBMITTER, because a role can be taken away while the modal is open;
//        ④ save; ⑤ edit the rules post in place, the tracked anchor first and the
//        message the button sat on second; ⑥ audit, fire and forget.
//        A save whose text equals the pack default stores null, so the guild keeps
//        following the pack's wording rather than a frozen copy of it.

// ── constants ────────────────────────────────────────────────────────

const MODAL_ID_PREFIX = `${RULES_PREFIX}:modal`;
const MARKDOWN_FIELD = "rules_markdown";
// Zero width characters: a submit made only of these looks filled in and renders
// as an empty rules post, so they are removed before the emptiness check.
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;

// ── types ────────────────────────────────────────────────────────────

/** The stored GuildConfig fields this flow reads. */
interface IRulesEditConfig extends IRulesConfig {
	adminRoleId?: string | null;
	rulesChannelId?: string | null;
	introMessageIds?: { rulesChannelId?: string | null } | null;
}

/** What one submit did to the rules post. */
type RerenderOutcome = "edited" | "not-found" | "failed";

// ── the button ───────────────────────────────────────────────────────

/** The Edit rules button: gate, modal, save, re-render. */
export async function handleRulesEditButton(interaction: ButtonInteraction): Promise<void> {
	const config = interaction.guild ? ((await guildConfigStore.findByGuildId(interaction.guild.id)) as IRulesEditConfig | null) : null;
	const copy = getPluginCopy(config);
	if (interaction.customId !== RULES_EDIT_CUSTOM_ID || !interaction.guild || !config) {
		await replyPrivately(interaction, copy.responses.rulesEdit.expired, config);
		return;
	}
	if (!(await gateOwnerOrAdmin(interaction, config))) {
		await replyPrivately(interaction, copy.responses.noWizardPowers, config);
		return;
	}

	// The interaction id keys the modal, so a second admin's modal opened at the
	// same moment is never mistaken for this one.
	const modalId = `${MODAL_ID_PREFIX}:${interaction.id}`;
	await interaction.showModal(buildRulesModal(modalId, config));
	const submission = await interaction
		.awaitModalSubmit({
			time: BOT_CONSTANTS.RULES_EDIT_MODAL_TIMEOUT_MS,
			filter: (submit) => submit.user.id === interaction.user.id && submit.customId === modalId,
		})
		.catch(() => null);
	// Timed out or dismissed: Discord gives nothing to reply to, and nothing changed.
	if (!submission) return;

	await handleRulesEditSubmit(submission, interaction.message);
}

// ── the submit ───────────────────────────────────────────────────────

/** One Edit rules submit. `buttonMessage` is the post the button sat on, the fallback when the tracked anchor is gone. */
export async function handleRulesEditSubmit(submission: ModalSubmitInteraction, buttonMessage: Message | null): Promise<void> {
	const guildId = submission.guild?.id;
	const config = guildId ? ((await guildConfigStore.findByGuildId(guildId)) as IRulesEditConfig | null) : null;
	const copy = getPluginCopy(config);
	if (!guildId || !config) {
		await replyPrivately(submission, copy.responses.rulesEdit.expired, config);
		return;
	}
	if (!(await gateOwnerOrAdmin(submission, config))) {
		await replyPrivately(submission, copy.responses.noWizardPowers, config);
		return;
	}

	const text = submission.fields.getTextInputValue(MARKDOWN_FIELD).replace(ZERO_WIDTH, "").trim();
	if (text.length === 0) {
		await replyPrivately(submission, copy.responses.rulesEdit.empty, config);
		return;
	}

	const isDefault = text === copy.channelContent.rules.defaultMarkdown.trim();
	const customRulesMarkdown = isDefault ? null : text;
	// The row the update hands back renders the post, rather than a spread of the
	// row read above: spreading a hydrated Mongoose document copies its internals,
	// not its fields, so the pack and the channel ids would read as missing.
	const saved = (await guildConfigStore.update(guildId, { customRulesMarkdown }).catch((error: unknown) => {
		console.error(`[rules-edit] guild ${guildId} could not save the rules`, error);
		return null;
	})) as IRulesEditConfig | null;
	if (!saved) {
		// The one failure among this file's refusals keeps the error title (owner rule 1).
		await showErrorNotice(submission, copy.responses.rulesEdit.failed, config);
		return;
	}

	const outcome = await rerenderRulesPost(submission, saved, buttonMessage);
	const reply = outcome === "edited" ? (isDefault ? copy.responses.rulesEdit.reset : copy.responses.rulesEdit.saved) : copy.responses.rulesEdit.savedNotRefreshed;
	// A modal Submit opens no notice, so the outcome posts in 🧭onboarding, the rules being
	// part of the server's Community setup (2026-10 item 257 Phase 5).
	await answerInChannel(submission, "onboarding", { content: reply }, { config: saved });

	// Ids and a length only, never the rules text (the RULES_EDITED privacy note).
	void botLogStore
		.log(guildId, BOT_LOG_EVENTS.RULES_EDITED, {
			actorId: submission.user.id,
			channelId: config.rulesChannelId ?? null,
			length: customRulesMarkdown?.length ?? 0,
			reset: isDefault,
			rerender: outcome,
		})
		.catch((error) => console.warn(`[rules-edit] guild ${guildId} audit write failed`, error));
}

// ── helpers ──────────────────────────────────────────────────────────

/** The Edit rules modal, preloaded with the rules the post shows right now. */
function buildRulesModal(modalId: string, config: IRulesEditConfig): ModalBuilder {
	const copy = getPluginCopy(config).responses.rulesEdit;
	// The preload is capped too: a default longer than the input allows would make
	// Discord reject the whole modal rather than trim it.
	const current = resolveRulesMarkdown(config).slice(0, BOT_CONSTANTS.RULES_MARKDOWN_MAX_LENGTH);
	return new ModalBuilder()
		.setCustomId(modalId)
		.setTitle(copy.modalTitle)
		.addComponents(
			new ActionRowBuilder<TextInputBuilder>().addComponents(
				new TextInputBuilder()
					.setCustomId(MARKDOWN_FIELD)
					.setLabel(copy.inputLabel)
					.setStyle(TextInputStyle.Paragraph)
					.setPlaceholder(copy.placeholder)
					.setRequired(true)
					.setMaxLength(BOT_CONSTANTS.RULES_MARKDOWN_MAX_LENGTH)
					.setValue(current)
			)
		);
}

/**
 * Edit the rules post in place with the saved rules. The tracked anchor
 * (introMessageIds.rulesChannelId) is the post the boot sweep keeps; the message
 * the button sat on is the fallback when the anchor cannot be read.
 */
async function rerenderRulesPost(submission: ModalSubmitInteraction, saved: IRulesEditConfig, buttonMessage: Message | null): Promise<RerenderOutcome> {
	const post = (await fetchTrackedRulesPost(submission, saved)) ?? buttonMessage;
	if (!post) return "not-found";
	try {
		const { embed, components } = rulesContent.build(saved);
		await post.edit({ embeds: [embed], components });
		return "edited";
	} catch (error) {
		console.warn(`[rules-edit] guild ${submission.guild?.id} saved the rules but could not edit the rules post`, error);
		return "failed";
	}
}

async function fetchTrackedRulesPost(submission: ModalSubmitInteraction, config: IRulesEditConfig): Promise<Message | null> {
	const channelId = config.rulesChannelId;
	const messageId = config.introMessageIds?.rulesChannelId;
	if (!channelId || !messageId) return null;
	const channel = await submission.client.channels.fetch(channelId).catch(() => null);
	if (!(channel instanceof TextChannel)) return null;
	return channel.messages.fetch(messageId).catch(() => null);
}

// The refusals (expired, not allowed, an empty post) are states, so a notice titled Rules;
// the failed save calls showErrorNotice itself (owner rule 1, 2026-10 item 263 R3-12).
async function replyPrivately(interaction: ButtonInteraction | ModalSubmitInteraction, message: string, config: IRulesConfig | null): Promise<void> {
	await showNotice(interaction, { title: getPluginCopy(config).notice.rules, sections: [message] });
}

/** Register the Edit rules button. Called once at boot from main.ts, before the InteractionCreate listener installs. */
export function registerRulesEditHandlers(): void {
	registerButton(RULES_PREFIX, handleRulesEditButton);
}
