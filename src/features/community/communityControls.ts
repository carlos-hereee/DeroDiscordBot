import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { communityCopy } from "./communityCopy.js";

// ── communityControls ────────────────────────────────────────────────
// What:  every customId and button the community feature puts on screen (2026-10
//        item 247 Phases 3 and 4): the two admin guide buttons, the Enable Community
//        review's Confirm, the Configure Onboarding offer the flow chains into, and
//        the Onboarding review's Edit, Confirm and Cancel. Pure builders only.
// Who:   communityButtons (the admin guide row and the router that answers these
//        customIds), enableCommunity and configureOnboarding (their review and
//        result replies).
// Where: a leaf on purpose. The router imports the flow and the flow replies with
//        these buttons, so keeping them in either file would make the two import
//        each other; here both import one module that imports neither.
// How:   customIds follow the registry convention `community:<action>`, and the
//        registry routes on the part before the first colon, so one registration
//        of COMMUNITY_PREFIX answers every action below.

/** The interactionRegistry prefix every community control routes on. */
export const COMMUNITY_PREFIX = "community";

/** The customId of each community control, `community:<action>`. */
export const COMMUNITY_CUSTOM_IDS = {
	enable: `${COMMUNITY_PREFIX}:enable`,
	configure: `${COMMUNITY_PREFIX}:configure`,
	confirm: `${COMMUNITY_PREFIX}:confirm`,
	// Carries one more segment, the index of the question it edits:
	// `community:editprompt:<index>` (see COMMUNITY_INDEXED_ACTIONS).
	editPrompt: `${COMMUNITY_PREFIX}:editprompt`,
	confirmOnboarding: `${COMMUNITY_PREFIX}:confirmOnboarding`,
	cancelOnboarding: `${COMMUNITY_PREFIX}:cancelOnboarding`,
} as const;

/** The action a community customId names, the part after the prefix. */
export type CommunityAction = keyof typeof COMMUNITY_CUSTOM_IDS;

/** The actions whose customId carries one more segment after the action; every other action matches its customId exactly. */
export const COMMUNITY_INDEXED_ACTIONS: ReadonlySet<CommunityAction> = new Set<CommunityAction>(["editPrompt"]);

// Discord allows five buttons a row and five rows a message. The Onboarding review
// keeps its last row for Confirm and Cancel, which leaves four rows of Edit buttons.
const BUTTONS_PER_ROW = 5;
const MAX_EDIT_PROMPT_ROWS = 4;

/** Enable Community, the lead button on the admin guide's community row. */
export function buildEnableCommunityButton(): ButtonBuilder {
	return new ButtonBuilder().setCustomId(COMMUNITY_CUSTOM_IDS.enable).setLabel(communityCopy.buttons.enable).setEmoji("🏘️").setStyle(ButtonStyle.Primary);
}

/** Configure Onboarding, on the admin guide and as the offer after Community is on. */
export function buildConfigureOnboardingButton(): ButtonBuilder {
	return new ButtonBuilder()
		.setCustomId(COMMUNITY_CUSTOM_IDS.configure)
		.setLabel(communityCopy.buttons.configure)
		.setEmoji("🧭")
		.setStyle(ButtonStyle.Secondary);
}

/** The review's one row: Confirm, which is the only button that changes the server. */
export function buildConfirmEnableRow(): ActionRowBuilder<ButtonBuilder> {
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder().setCustomId(COMMUNITY_CUSTOM_IDS.confirm).setLabel(communityCopy.buttons.confirm).setEmoji("✅").setStyle(ButtonStyle.Success)
	);
}

/** The offer that follows Community being on: the Configure Onboarding button alone. */
export function buildConfigureOnboardingOfferRow(): ActionRowBuilder<ButtonBuilder> {
	return new ActionRowBuilder<ButtonBuilder>().addComponents(buildConfigureOnboardingButton());
}

/** The customId of the Edit button for the question at this index (zero based) of the draft. */
export function editPromptCustomId(index: number): string {
	return `${COMMUNITY_CUSTOM_IDS.editPrompt}:${index}`;
}

/**
 * The Onboarding review's buttons: one Edit per question, numbered from 1 as the
 * review numbers them, five to a row, then Confirm and Cancel. Twenty Edit buttons
 * fit in the four rows left; a question past the twentieth is still in the review
 * and the write, it just has no Edit button.
 */
export function buildOnboardingReviewRows(promptCount: number): ActionRowBuilder<ButtonBuilder>[] {
	const editButtons = Array.from({ length: Math.min(promptCount, BUTTONS_PER_ROW * MAX_EDIT_PROMPT_ROWS) }, (_, index) =>
		new ButtonBuilder()
			.setCustomId(editPromptCustomId(index))
			.setLabel(communityCopy.buttons.editPrompt(index + 1))
			.setEmoji("✏️")
			.setStyle(ButtonStyle.Secondary)
	);
	const rows: ActionRowBuilder<ButtonBuilder>[] = [];
	for (let start = 0; start < editButtons.length; start += BUTTONS_PER_ROW) {
		rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(editButtons.slice(start, start + BUTTONS_PER_ROW)));
	}
	rows.push(
		new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder()
				.setCustomId(COMMUNITY_CUSTOM_IDS.confirmOnboarding)
				.setLabel(communityCopy.buttons.confirmOnboarding)
				.setEmoji("✅")
				.setStyle(ButtonStyle.Success),
			new ButtonBuilder().setCustomId(COMMUNITY_CUSTOM_IDS.cancelOnboarding).setLabel(communityCopy.buttons.cancelOnboarding).setStyle(ButtonStyle.Secondary)
		)
	);
	return rows;
}
