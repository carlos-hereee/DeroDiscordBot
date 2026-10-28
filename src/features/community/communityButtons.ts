import { Events, type ButtonInteraction, type Client, type Guild, type ModalSubmitInteraction, type StringSelectMenuInteraction } from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { getPluginCopy } from "@base/copy/getCopy.js";
import { registerButton, registerModal, registerSelectMenu } from "@handlers/interactionRegistry.js";
import { gateOwnerOrAdmin } from "@utils/permissions.js";
import { showNotice } from "@utils/textModal.js";
import { refreshHeadquartersCards } from "@features/setup/headquartersCards.js";
import { communityCopy } from "./communityCopy.js";
import {
	COMMUNITY_CONFIRM_PREFIX,
	COMMUNITY_CUSTOM_IDS,
	COMMUNITY_INDEXED_ACTIONS,
	COMMUNITY_PREFIX,
	COMMUNITY_SELECT_ACTIONS,
	type CommunityAction,
} from "./communityControls.js";
import { handleConfirm, handleEnableClick, isCommunityEnabled, type IEnableCommunityConfig } from "./enableCommunity.js";
import { handleCancelOnboarding, handleConfigureOnboardingButton, handleConfirmOnboarding, handleWriteOnboarding, type IConfigureOnboardingConfig } from "./configureOnboarding.js";
import {
	handleAddOption,
	handleAddPrompt,
	handleDeleteOption,
	handleDeletePrompt,
	handleEditOption,
	handleEditPromptButton,
	handlePickOption,
	handlePickPrompt,
} from "./promptEditModal.js";

// ── communityButtons ─────────────────────────────────────────────────
// What:  the one router every `community:<action>` press goes through, the Onboarding
//        review's two selects included (2026-10 item 254) and the Submit of the
//        confirm its Confirm opens (2026-10 item 263 R3-20), and the listener that
//        redraws 🧭onboarding when Discord's Community state changes. The router
//        gates and routes; the flows themselves live in enableCommunity,
//        configureOnboarding and promptEditModal (Phase 4).
// Who:   the buttons on 🧭onboarding's steps card (steps 1 and 3 carry the Community
//        customIds themselves); main.ts registers the router and the listener at boot.
//        The admin guide's community row that used to duplicate them retired with
//        🎛️admin-controls (2026-10 item 263 Phase 4a, R3-14).
// When:  on every press, and on every GuildUpdate that flips Community.
// How:   a channel is not a gate: every press re-checks owner or admin here, before
//        any action runs, the same rule PowerUps applies to its admin controls.

// ── the router ───────────────────────────────────────────────────────

/** The stored GuildConfig fields the community flows read, together. */
type ICommunityConfig = IEnableCommunityConfig & IConfigureOnboardingConfig;

/** A press on a community control: a button, one of the Onboarding review's selects, or the Onboarding confirm's Submit. */
type CommunityPress = ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction;

// The one action a modal Submit may carry: the Onboarding confirm, whose fallback
// button carries the same id. A Submit naming any other action is from no layout.
const MODAL_ACTIONS: ReadonlySet<CommunityAction> = new Set<CommunityAction>(["writeOnboarding"]);

// A modal Submit carries its fields; a button or a select carries none. Read by shape
// for the same reason as isSelectPress.
function isModalSubmit(interaction: CommunityPress): interaction is ModalSubmitInteraction {
	return "fields" in interaction;
}

// A select carries its picked values; a button carries none. Read by shape rather
// than isStringSelectMenu, so the router reads the same for a test's plain object.
function isSelectPress(interaction: CommunityPress): interaction is StringSelectMenuInteraction {
	return "values" in interaction;
}

/** Every `community:<action>` press: refuse what is stale or not allowed, then hand the press to its flow. */
export async function handleCommunityButton(interaction: CommunityPress): Promise<void> {
	const parsed = parseCommunityCustomId(interaction.customId);
	// A control from an older layout, answered before any read since nothing runs.
	// A select's action reached as a button, or the reverse, is from no layout either.
	if (!parsed || COMMUNITY_SELECT_ACTIONS.has(parsed.action) !== isSelectPress(interaction) || (isModalSubmit(interaction) && !MODAL_ACTIONS.has(parsed.action))) {
		await showNotice(interaction, { title: getPluginCopy(null).notice.community, sections: [communityCopy.errors.controlRetired] });
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

	if (isSelectPress(interaction)) {
		await routeSelect(interaction, parsed.action, guild, config, parsed.argument);
		return;
	}
	if (isModalSubmit(interaction)) await handleWriteOnboarding(interaction, guild, config);
	else await routeButton(interaction, parsed.action, guild, config, parsed.argument);
	// The two presses that change what 🧭onboarding shows: Community turned on, and an
	// Onboarding config written (the confirm's Submit, since Confirm itself only opens
	// the confirm). Its steps card and chart follow, fire and forget (2026-10 item 257 Phase 2b).
	if (ONBOARDING_CHANGING_ACTIONS.has(parsed.action)) refreshHeadquartersCards(guild, "onboarding");
}

const ONBOARDING_CHANGING_ACTIONS: ReadonlySet<CommunityAction> = new Set<CommunityAction>(["confirm", "writeOnboarding"]);

async function routeSelect(interaction: StringSelectMenuInteraction, action: CommunityAction, guild: Guild, config: ICommunityConfig, argument: string | null): Promise<void> {
	if (action === "pickPrompt") await handlePickPrompt(interaction, guild, config, argument);
	else if (action === "pickOption") await handlePickOption(interaction, guild, config, argument);
}

async function routeButton(interaction: ButtonInteraction, action: CommunityAction, guild: Guild, config: ICommunityConfig, argument: string | null): Promise<void> {
	switch (action) {
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
			await handleEditPromptButton(interaction, guild, config, argument);
			return;
		case "deletePrompt":
			await handleDeletePrompt(interaction, guild, config, argument);
			return;
		case "addPrompt":
			await handleAddPrompt(interaction, guild, config, argument);
			return;
		case "addOption":
			await handleAddOption(interaction, guild, config, argument);
			return;
		case "editOption":
			await handleEditOption(interaction, guild, config, argument);
			return;
		case "deleteOption":
			await handleDeleteOption(interaction, guild, config, argument);
			return;
		case "confirmOnboarding":
			await handleConfirmOnboarding(interaction, guild, config);
			return;
		// The confirm's fallback button, when no modal could open; its Submit routes above.
		case "writeOnboarding":
			await handleWriteOnboarding(interaction, guild, config);
			return;
		case "cancelOnboarding":
			await handleCancelOnboarding(interaction, guild);
			return;
		// The two selects reach routeSelect; the router refuses them as buttons first.
		case "pickPrompt":
		case "pickOption":
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

// Every refusal here is a state (not in a server, not set up, not allowed), so it is a
// notice titled Community, never the error title (owner rule 1, 2026-10 item 263 R3-12).
async function replyRefusal(interaction: CommunityPress, message: string, config: ICommunityConfig | null): Promise<void> {
	await showNotice(interaction, { title: getPluginCopy(config).notice.community, sections: [message] });
}

// ── 🧭onboarding follows Discord's Community state ────────────────────

/**
 * Attach the GuildUpdate listener that redraws 🧭onboarding's steps card and chart when
 * Community is switched on or off, so step 1's mark follows at once whether Dero or
 * Server Settings changed it. Called once at boot from main.ts. A change Dero misses
 * while offline is caught by the boot's Headquarters sync, which reads the same state.
 */
export function registerCommunityStateSync(client: Client): void {
	client.on(Events.GuildUpdate, (before, after) => {
		if (isCommunityEnabled(before) === isCommunityEnabled(after)) return;
		refreshHeadquartersCards(after, "onboarding");
	});
}

/** Register the community router, for buttons, the review's selects and the Onboarding confirm's Submit. Called once at boot from main.ts, before the InteractionCreate listener installs. */
export function registerCommunityHandlers(): void {
	registerButton(COMMUNITY_PREFIX, handleCommunityButton);
	registerSelectMenu(COMMUNITY_PREFIX, handleCommunityButton);
	registerButton(COMMUNITY_CONFIRM_PREFIX, handleCommunityButton);
	registerModal(COMMUNITY_CONFIRM_PREFIX, handleCommunityButton);
}
