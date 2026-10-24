import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type EmbedBuilder } from "discord.js";
import { getPluginCopy, type ICopyConfig } from "@base/copy/getCopy.js";
import { infoEmbed } from "@utils/embedBuilder.js";

// ── rulesContent ─────────────────────────────────────────────────────
// What:  builds the 📘rules post (2026-10 item 247 Phase 2): the pack's title
//        over the owner's saved rules (GuildConfig.customRulesMarkdown), or over
//        the pack's default rules when the owner never edited, plus the Edit rules
//        button. Pure: it reads a config and returns builders, and posts nothing.
// Who:   ChannelContent.rulesIntro and GuildSetupManager.resolveIntroComponents
//        (every post, repost and refresh of the rules channel), and rulesEdit
//        (the modal's preloaded text and the in place re-render after a save).
// When:  on every build, so a save shows on the next render with no cache.
// Where: the Edit rules customId is exported from here so the button that is
//        built and the handler that answers it cannot name different prefixes.
// How:   the button rides the public post because Discord cannot show a message
//        button to admins only; rulesEdit re-checks the clicker on every press and
//        every submit, so a member who presses it is refused privately.

// ── customIds ────────────────────────────────────────────────────────

/** The interactionRegistry prefix the Edit rules button routes on (the part before the first ":"). */
export const RULES_PREFIX = "rules";
/** The Edit rules button's customId. Also the marker that tells Dero's own rules post apart from owner content. */
export const RULES_EDIT_CUSTOM_ID = `${RULES_PREFIX}:edit`;

// ── types ────────────────────────────────────────────────────────────

/** The stored GuildConfig fields the rules post reads. */
export interface IRulesConfig extends ICopyConfig {
	customRulesMarkdown?: string | null;
}

/** The rules post, ready to send or edit. */
export interface IRulesPost {
	embed: EmbedBuilder;
	components: ActionRowBuilder<ButtonBuilder>[];
}

// ── builders ─────────────────────────────────────────────────────────

/** The rules the post shows: the owner's saved text, or the pack default when there is none (null, or only whitespace). */
export function resolveRulesMarkdown(config?: IRulesConfig | null): string {
	const custom = config?.customRulesMarkdown?.trim();
	return custom ? custom : getPluginCopy(config).channelContent.rules.defaultMarkdown;
}

/** The rules embed alone. */
export function buildRulesEmbed(config?: IRulesConfig | null): EmbedBuilder {
	const copy = getPluginCopy(config);
	return infoEmbed(copy.channelContent.rules.title, resolveRulesMarkdown(config), copy.COLORS.DERO);
}

/** The one row under the rules post: the Edit rules button. */
export function buildRulesEditRow(config?: ICopyConfig | null): ActionRowBuilder<ButtonBuilder> {
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder()
			.setCustomId(RULES_EDIT_CUSTOM_ID)
			.setLabel(getPluginCopy(config).channelContent.rules.editButtonLabel)
			.setEmoji("✏️")
			.setStyle(ButtonStyle.Secondary)
	);
}

export const rulesContent = {
	/**
	 * The rules post. `editable` (default true) attaches the Edit rules row, which is
	 * what the channel post carries; false builds the embed alone for a surface that
	 * is not the owner's admin control.
	 */
	build(config?: IRulesConfig | null, options: { editable?: boolean } = {}): IRulesPost {
		const editable = options.editable ?? true;
		return { embed: buildRulesEmbed(config), components: editable ? [buildRulesEditRow(config)] : [] };
	},
};

// ── the marker ───────────────────────────────────────────────────────

/** True when a message carries the Edit rules button, which only Dero's own rules post does. */
export function carriesRulesEditButton(message: { components: ReadonlyArray<{ toJSON(): unknown }> }): boolean {
	return message.components.some((row) => {
		// toJSON gives a live message row and a builder the same API shape, the way
		// GuildSetupManager.componentsAreEquivalent reads them.
		const json = row.toJSON() as { components?: Array<{ custom_id?: string }> };
		return (json.components ?? []).some((component) => component.custom_id === RULES_EDIT_CUSTOM_ID);
	});
}
