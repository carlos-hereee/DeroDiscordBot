import { ActionRowBuilder, MessageFlags, type ButtonBuilder, type ButtonInteraction } from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { getPluginCopy } from "@base/copy/getCopy.js";
import { registerButton } from "@handlers/interactionRegistry.js";
import { gateOwnerOrAdmin } from "@utils/permissions.js";
import { errorEmbed } from "@utils/embedBuilder.js";
import { communityCopy } from "./communityCopy.js";
import {
	COMMUNITY_CUSTOM_IDS,
	COMMUNITY_INDEXED_ACTIONS,
	COMMUNITY_PREFIX,
	buildConfigureOnboardingButton,
	buildEnableCommunityButton,
	type CommunityAction,
} from "./communityControls.js";
import { handleConfirm, handleEnableClick, type IEnableCommunityConfig } from "./enableCommunity.js";
import { handleCancelOnboarding, handleConfigureOnboardingButton, handleConfirmOnboarding, type IConfigureOnboardingConfig } from "./configureOnboarding.js";
import { handleEditPromptButton } from "./promptEditModal.js";

// ── communityButtons ─────────────────────────────────────────────────
// What:  the admin guide's community row (Enable Community and Configure
//        Onboarding, 2026-10 item 247 Phase 3) and the one router every
//        `community:<action>` press goes through. The router gates and routes; the
//        flows themselves live in enableCommunity, configureOnboarding and
//        promptEditModal (Phase 4).
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

/** The stored GuildConfig fields the community flows read, together. */
type ICommunityConfig = IEnableCommunityConfig & IConfigureOnboardingConfig;

/** Every `community:<action>` press: refuse what is stale or not allowed, then hand the press to its flow. */
export async function handleCommunityButton(interaction: ButtonInteraction): Promise<void> {
	const parsed = parseCommunityCustomId(interaction.customId);
	// A button from an older layout, answered before any read since nothing runs.
	if (!parsed) {
		await interaction.reply({ content: communityCopy.errors.controlRetired, flags: MessageFlags.Ephemeral });
		return;
	}
	const guild = interaction.guild;
	if (!guild) {
		await replyRefusal(interaction, communityCopy.errors.notInServer, null);
		return;
	}
	const config = (await guildConfigStore.findByGuildId(guild.id)) as ICommunityConfig | null;
	if (!config) {
		await replyRefusal(interaction, communityCopy.errors.notSetUp, null);
		return;
	}
	if (!(await gateOwnerOrAdmin(interaction, config))) {
		await replyRefusal(interaction, getPluginCopy(config).responses.noWizardPowers, config);
		return;
	}

	switch (parsed.action) {
		case "enable":
			await handleEnableClick(interaction, guild, config);
			return;
		case "confirm":
			await handleConfirm(interaction, guild, config);
			return;
		case "configure":
			await handleConfigureOnboardingButton(interaction, guild, config);
			return;
		case "editPrompt":
			await handleEditPromptButton(interaction, guild, config, parsed.argument);
			return;
		case "confirmOnboarding":
			await handleConfirmOnboarding(interaction, guild, config);
			return;
		case "cancelOnboarding":
			await handleCancelOnboarding(interaction, guild);
			return;
	}
}

// The action a customId names and the segment after it, or null when it is not one
// this version answers. Every action matches its customId exactly, except an
// indexed one, which also matches `<customId>:<argument>` (the Edit buttons). The
// bare indexed id still parses, with no argument, so it is gated like every other
// press and its flow answers it as retired.
function parseCommunityCustomId(customId: string): { action: CommunityAction; argument: string | null } | null {
	for (const [action, id] of Object.entries(COMMUNITY_CUSTOM_IDS) as Array<[CommunityAction, string]>) {
		if (customId === id) return { action, argument: null };
		if (COMMUNITY_INDEXED_ACTIONS.has(action) && customId.startsWith(`${id}:`)) return { action, argument: customId.slice(id.length + 1) };
	}
	return null;
}

async function replyRefusal(interaction: ButtonInteraction, message: string, config: ICommunityConfig | null): Promise<void> {
	await interaction.reply({ embeds: [errorEmbed(message, config)], flags: MessageFlags.Ephemeral }).catch(() => undefined);
}

/** Register the community router. Called once at boot from main.ts, before the InteractionCreate listener installs. */
export function registerCommunityHandlers(): void {
	registerButton(COMMUNITY_PREFIX, handleCommunityButton);
}
