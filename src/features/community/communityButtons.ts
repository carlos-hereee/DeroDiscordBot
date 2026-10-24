import { ActionRowBuilder, MessageFlags, type ButtonBuilder, type ButtonInteraction } from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { getPluginCopy } from "@base/copy/getCopy.js";
import { registerButton } from "@handlers/interactionRegistry.js";
import { gateOwnerOrAdmin } from "@utils/permissions.js";
import { errorEmbed } from "@utils/embedBuilder.js";
import { communityCopy } from "./communityCopy.js";
import { COMMUNITY_CUSTOM_IDS, COMMUNITY_PREFIX, buildConfigureOnboardingButton, buildEnableCommunityButton, type CommunityAction } from "./communityControls.js";
import { handleConfirm, handleEnableClick, type IEnableCommunityConfig } from "./enableCommunity.js";
import { draftOnboarding } from "./onboardingDraftStub.js";

// ── communityButtons ─────────────────────────────────────────────────
// What:  the admin guide's community row (Enable Community and Configure
//        Onboarding, 2026-10 item 247 Phase 3) and the one router every
//        `community:<action>` press goes through. The router gates and routes; the
//        flows themselves live in enableCommunity (and, from Phase 4, Configure
//        Onboarding's own module).
// Who:   GuildSetupManager.resolveIntroComponents puts the row on the pinned admin
//        guide; main.ts registers the router once at boot.
// When:  on every press. The row reaches existing guilds on their next boot, when
//        refreshIntroEmbeds sees the guide's rows differ (componentsAreEquivalent)
//        and edits the pinned guide in place, so no guild re-runs /setup.
// How:   the buttons sit in the admin channel, but a channel is not a gate: every
//        press re-checks owner or admin here, before any action runs, the same rule
//        PowerUps applies to its admin controls.

// ── the admin guide row ──────────────────────────────────────────────

/** The community row on the admin guide: Enable Community (Primary), then Configure Onboarding (Secondary). */
export function buildCommunityControlButtons(): ActionRowBuilder<ButtonBuilder> {
	return new ActionRowBuilder<ButtonBuilder>().addComponents(buildEnableCommunityButton(), buildConfigureOnboardingButton());
}

// ── the router ───────────────────────────────────────────────────────

/** Every `community:<action>` press: refuse what is stale or not allowed, then hand the press to its flow. */
export async function handleCommunityButton(interaction: ButtonInteraction): Promise<void> {
	const action = communityActionOf(interaction.customId);
	// A button from an older layout, answered before any read since nothing runs.
	if (!action) {
		await interaction.reply({ content: communityCopy.errors.controlRetired, flags: MessageFlags.Ephemeral });
		return;
	}
	const guild = interaction.guild;
	if (!guild) {
		await replyRefusal(interaction, communityCopy.errors.notInServer, null);
		return;
	}
	const config = (await guildConfigStore.findByGuildId(guild.id)) as IEnableCommunityConfig | null;
	if (!config) {
		await replyRefusal(interaction, communityCopy.errors.notSetUp, null);
		return;
	}
	if (!(await gateOwnerOrAdmin(interaction, config))) {
		await replyRefusal(interaction, getPluginCopy(config).responses.noWizardPowers, config);
		return;
	}

	switch (action) {
		case "enable":
			await handleEnableClick(interaction, guild, config);
			return;
		case "confirm":
			await handleConfirm(interaction, guild, config);
			return;
		case "configure":
			await handleConfigureOnboardingClick(interaction);
			return;
	}
}

// Until Phase 4 builds Configure Onboarding, its button answers with the honest
// "next release" line rather than an error. The stub drafter stands where the real
// one will, so Phase 4 replaces this function and deletes the stub together.
async function handleConfigureOnboardingClick(interaction: ButtonInteraction): Promise<void> {
	draftOnboarding();
	await interaction.reply({ content: communityCopy.configureComingSoon, flags: MessageFlags.Ephemeral });
}

// The action a customId names, or null when it is not one this version answers.
function communityActionOf(customId: string): CommunityAction | null {
	const entry = Object.entries(COMMUNITY_CUSTOM_IDS).find(([, id]) => id === customId);
	return entry ? (entry[0] as CommunityAction) : null;
}

async function replyRefusal(interaction: ButtonInteraction, message: string, config: IEnableCommunityConfig | null): Promise<void> {
	await interaction.reply({ embeds: [errorEmbed(message, config)], flags: MessageFlags.Ephemeral }).catch(() => undefined);
}

/** Register the community router. Called once at boot from main.ts, before the InteractionCreate listener installs. */
export function registerCommunityHandlers(): void {
	registerButton(COMMUNITY_PREFIX, handleCommunityButton);
}
