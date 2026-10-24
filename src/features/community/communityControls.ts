import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { communityCopy } from "./communityCopy.js";

// ── communityControls ────────────────────────────────────────────────
// What:  every customId and button the community feature puts on screen (2026-10
//        item 247 Phase 3): the two admin guide buttons, the review's Confirm, and
//        the Configure Onboarding offer the flow chains into. Pure builders only.
// Who:   communityButtons (the admin guide row and the router that answers these
//        customIds) and enableCommunity (the review and result replies).
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
} as const;

/** The action a community customId names, the part after the prefix. */
export type CommunityAction = keyof typeof COMMUNITY_CUSTOM_IDS;

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
