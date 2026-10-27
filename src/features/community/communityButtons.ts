import {
	ActionRowBuilder,
	Events,
	TextChannel,
	type APIActionRowComponent,
	type APIComponentInMessageActionRow,
	type ButtonBuilder,
	type ButtonInteraction,
	type Client,
	type Guild,
	type StringSelectMenuInteraction,
} from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { getPluginCopy } from "@base/copy/getCopy.js";
import { registerButton, registerSelectMenu } from "@handlers/interactionRegistry.js";
import { gateOwnerOrAdmin } from "@utils/permissions.js";
import { showErrorNotice } from "@utils/textModal.js";
import { refreshHeadquartersCards } from "@features/setup/headquartersCards.js";
import { communityCopy } from "./communityCopy.js";
import {
	COMMUNITY_CUSTOM_IDS,
	COMMUNITY_INDEXED_ACTIONS,
	COMMUNITY_PREFIX,
	COMMUNITY_SELECT_ACTIONS,
	buildConfigureOnboardingButton,
	buildEnableCommunityButton,
	type CommunityAction,
} from "./communityControls.js";
import { handleConfirm, handleEnableClick, isCommunityEnabled, type IEnableCommunityConfig } from "./enableCommunity.js";
import { handleCancelOnboarding, handleConfigureOnboardingButton, handleConfirmOnboarding, type IConfigureOnboardingConfig } from "./configureOnboarding.js";
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
// What:  the admin guide's community row (Enable Community and Configure
//        Onboarding, 2026-10 item 247 Phase 3) and the one router every
//        `community:<action>` press goes through, the Onboarding review's two
//        selects included (2026-10 item 254). The router gates and routes; the
//        flows themselves live in enableCommunity, configureOnboarding and
//        promptEditModal (Phase 4).
// Who:   GuildSetupManager.resolveIntroComponents puts the row on the pinned admin
//        guide; main.ts registers the router once at boot.
// When:  on every press. The row reaches existing guilds on their next boot, when
//        refreshIntroEmbeds sees the guide's rows differ (componentsAreEquivalent)
//        and edits the pinned guide in place, so no guild re-runs /setup.
// How:   the buttons sit in the admin channel, but a channel is not a gate: every
//        press re-checks owner or admin here, before any action runs, the same rule
//        PowerUps applies to its admin controls. The row shows ONE of the two
//        buttons (post-launch plan item 8): Enable Community while Community is
//        off, Configure Onboarding once it is on, because Discord refuses Onboarding
//        on a server without Community and nothing is left to enable after. The
//        GuildUpdate listener below swaps it the moment Discord's state changes,
//        whether Dero or Server Settings changed it.

// ── the admin guide row ──────────────────────────────────────────────

/** The community row on the admin guide: Enable Community while Community is off, Configure Onboarding once it is on. */
export function buildCommunityControlButtons(communityOn: boolean): ActionRowBuilder<ButtonBuilder> {
	return new ActionRowBuilder<ButtonBuilder>().addComponents(communityOn ? buildConfigureOnboardingButton() : buildEnableCommunityButton());
}

// ── the router ───────────────────────────────────────────────────────

/** The stored GuildConfig fields the community flows read, together. */
type ICommunityConfig = IEnableCommunityConfig & IConfigureOnboardingConfig;

/** A press on a community control: a button, or one of the Onboarding review's selects. */
type CommunityPress = ButtonInteraction | StringSelectMenuInteraction;

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
	if (!parsed || COMMUNITY_SELECT_ACTIONS.has(parsed.action) !== isSelectPress(interaction)) {
		await showErrorNotice(interaction, communityCopy.errors.controlRetired, null);
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
	await routeButton(interaction, parsed.action, guild, config, parsed.argument);
	// The two presses that change what 🧭onboarding shows: Community turned on, and an
	// Onboarding config written. Its steps card and chart follow, fire and forget
	// (2026-10 item 257 Phase 2b).
	if (ONBOARDING_CHANGING_ACTIONS.has(parsed.action)) refreshHeadquartersCards(guild, "onboarding");
}

const ONBOARDING_CHANGING_ACTIONS: ReadonlySet<CommunityAction> = new Set<CommunityAction>(["confirm", "confirmOnboarding"]);

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

async function replyRefusal(interaction: CommunityPress, message: string, config: ICommunityConfig | null): Promise<void> {
	await showErrorNotice(interaction, message, config);
}

// ── keeping the guide's row on the live state ────────────────────────

/** The stored GuildConfig fields the guide sync reads. */
interface ICommunityGuideConfig {
	homebaseDestroyed?: boolean | null;
	adminCommandsChannelId?: string | null;
	introMessageIds?: { adminCommandsChannelId?: string | null } | null;
}

/**
 * Swap the community row on the pinned admin guide to the button the guild's live
 * Community state calls for. Edits the guide IN PLACE and only that row, the same
 * button only edit refreshIntroEmbeds makes when rows drift; a guide already right,
 * a missing guide or a refused edit changes nothing (the next boot's refresh catches
 * up). Resolves true when it edited. Never throws.
 */
export async function syncCommunityGuideRow(guild: Pick<Guild, "id" | "features" | "client">): Promise<boolean> {
	try {
		const stored = (await guildConfigStore.findByGuildId(guild.id)) as ICommunityGuideConfig | null;
		const guideId = stored?.introMessageIds?.adminCommandsChannelId;
		if (!stored || stored.homebaseDestroyed || !stored.adminCommandsChannelId || !guideId) return false;
		const channel = await guild.client.channels.fetch(stored.adminCommandsChannelId).catch(() => null);
		if (!(channel instanceof TextChannel)) return false;
		const guide = await channel.messages.fetch(guideId).catch(() => null);
		if (!guide) return false;

		// toJSON reads a live message row in the API shape, the way
		// GuildSetupManager.componentsAreEquivalent reads it. The admin guide holds
		// action rows only, which is the shape the cast names.
		const rows = guide.components.map((row) => row.toJSON()) as APIActionRowComponent<APIComponentInMessageActionRow>[];
		const rowIndex = rows.findIndex((row) => customIdsOf(row).some((id) => id.startsWith(`${COMMUNITY_PREFIX}:`)));
		if (rowIndex === -1) return false;
		const wanted = buildCommunityControlButtons(isCommunityEnabled(guild)).toJSON();
		if (customIdsOf(rows[rowIndex]!).join() === customIdsOf(wanted).join()) return false;

		await guide.edit({ components: rows.map((row, index) => (index === rowIndex ? wanted : row)) });
		console.log(`[community-guide] guild ${guild.id} guide row now shows ${isCommunityEnabled(guild) ? "Configure Onboarding" : "Enable Community"}`);
		return true;
	} catch (error) {
		console.warn(`[community-guide] guild ${guild.id} could not swap the community row; the next boot retries`, error);
		return false;
	}
}

function customIdsOf(row: APIActionRowComponent<APIComponentInMessageActionRow>): string[] {
	return row.components.map((component) => ("custom_id" in component ? component.custom_id : ""));
}

/**
 * Attach the GuildUpdate listener that swaps the guide's row when Community is
 * switched on or off. Called once at boot from main.ts. A change Dero misses while
 * offline is caught by the boot refresh, which builds the row from the same state.
 */
export function registerCommunityGuideSync(client: Client): void {
	client.on(Events.GuildUpdate, (before, after) => {
		if (isCommunityEnabled(before) === isCommunityEnabled(after)) return;
		void syncCommunityGuideRow(after);
	});
}

/** Register the community router, for buttons and the review's selects. Called once at boot from main.ts, before the InteractionCreate listener installs. */
export function registerCommunityHandlers(): void {
	registerButton(COMMUNITY_PREFIX, handleCommunityButton);
	registerSelectMenu(COMMUNITY_PREFIX, handleCommunityButton);
}
