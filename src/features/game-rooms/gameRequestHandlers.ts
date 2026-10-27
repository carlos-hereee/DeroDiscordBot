import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	EmbedBuilder,
	MessageFlags,
	ModalBuilder,
	StringSelectMenuBuilder,
	TextInputBuilder,
	TextInputStyle,
	escapeMarkdown,
	type ButtonInteraction,
	type ColorResolvable,
	type MessageActionRowComponentBuilder,
	type ModalSubmitInteraction,
	type StringSelectMenuInteraction,
} from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { registerButton, registerModal, registerSelectMenu } from "@handlers/interactionRegistry.js";
import { getPluginCopy, type ICopyConfig } from "@base/copy/getCopy.js";
import type { IPluginCopy } from "@base/copy/types.js";
import { COLORS } from "@base/copy/brand.js";
import { infoEmbed } from "@utils/embedBuilder.js";
import { NO_PINGS } from "@utils/mentions.js";
import { gateOwnerOrAdmin } from "@utils/permissions.js";
import type { IGameRequest } from "@db/models/GameRequest.js";
import {
	GAME_REQUEST_NAME_MAX,
	GAME_REQUEST_NAME_MIN,
	GAME_REQUEST_POOL_CAP,
	addGameRequest,
	listGameRequests,
	removeGameRequest,
	toggleGameRequestVote,
} from "./gameRequests.js";
import { showNotice } from "@utils/textModal.js";

// ── gameRequestHandlers ────────────────────────────────────────────────────
// What:  the Discord half of the game request ballot (2026-10 item 245 Phase 4a):
//        the "Don't see your favorite game?" button on 📋arcade-rules, the private
//        ballot it opens, the vote select, the Add a game modal and the owner or
//        admin's Remove select.
// Who:   GuildSetupManager puts the button on the rules card (buildGameRequestRow);
//        main.ts registers the handlers once at boot. The rules live in
//        gameRequests.ts; this file translates between them and Discord.
// When:  on a press, a pick or a modal submit, any time.
// How:   ONE ephemeral ballot per member, redrawn in place after every action
//        (interaction.update), so the counts a member reads are the counts after
//        their own vote. Every handler re-reads the guild's row and re-checks the
//        clicker, because a component's customId and values are replayable input.
//        The existing PollDispatcher is deliberately not used: its options are
//        fixed at post time, and this pool grows from what members type.

const PREFIX = "game_request";
// The four actions after the prefix. The button, select and modal registries are
// separate maps, so "add" on a button and "add" on a modal cannot collide.
const ACTION = { open: "open", add: "add", vote: "vote", remove: "remove" } as const;
const NAME_FIELD = "name";

// Discord's ceiling for a select option's label and description.
const SELECT_TEXT_MAX = 100;

type BallotCopy = IPluginCopy["gameRequests"];

/** The ballot as one ephemeral message's worth of content. */
export interface BallotView {
	content?: string;
	embeds: EmbedBuilder[];
	components: ActionRowBuilder<MessageActionRowComponentBuilder>[];
}

/**
 * The one button the 📋arcade-rules card carries. The label comes from the guild's
 * copy pack, read by GuildSetupManager.resolveIntroComponents.
 */
export function buildGameRequestRow(label: string): ActionRowBuilder<ButtonBuilder> {
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder().setCustomId(`${PREFIX}:${ACTION.open}`).setLabel(label).setEmoji("🗳️").setStyle(ButtonStyle.Secondary)
	);
}

/**
 * Draw the ballot for one member: the ranked pool with vote counts, the vote select,
 * the Remove select when the viewer passed the owner or admin gate, and Add a game.
 * Pure, so the ranking, the counts and who sees Remove are testable without Discord.
 * `requests` must already be ranked (listGameRequests ranks).
 */
export function buildBallotView(requests: readonly IGameRequest[], viewerId: string, canRemove: boolean, copy: BallotCopy, notice?: string): BallotView {
	const isMine = (request: IGameRequest): boolean => request.voterIds.includes(viewerId);
	const isFull = requests.length >= GAME_REQUEST_POOL_CAP;

	const lines = requests.map((request, index) => copy.row(index + 1, escapeMarkdown(request.name), request.voterIds.length, isMine(request)));
	const body = [copy.intro, "", ...(lines.length > 0 ? lines : [copy.empty])];
	if (isFull) body.push("", copy.full(GAME_REQUEST_POOL_CAP));
	const embed = infoEmbed(copy.title, body.join("\n"), COLORS.ARCADE as ColorResolvable);

	const components: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
	if (requests.length > 0) {
		components.push(requestSelectRow(ACTION.vote, copy.votePlaceholder, requests, (request) => copy.voteOption(request.voterIds.length, isMine(request))));
		// Shown only to the owner or an admin. Hiding it is a courtesy, not the gate:
		// the remove handler re-runs gateOwnerOrAdmin on every pick.
		if (canRemove) components.push(requestSelectRow(ACTION.remove, copy.removePlaceholder, requests));
	}
	components.push(
		new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder()
				.setCustomId(`${PREFIX}:${ACTION.add}`)
				.setLabel(copy.addButtonLabel)
				.setEmoji("➕")
				.setStyle(ButtonStyle.Primary)
				// Disabled at the cap with the reason in the embed above, rather than a
				// press that opens a modal only to refuse what was typed into it.
				.setDisabled(isFull)
		)
	);

	return { ...(notice ? { content: notice } : {}), embeds: [embed], components };
}

// A select over the pool, one option per request, valued by nameKey. The pool cap is
// the select ceiling, so every request fits.
function requestSelectRow(
	action: string,
	placeholder: string,
	requests: readonly IGameRequest[],
	describe?: (request: IGameRequest) => string
): ActionRowBuilder<StringSelectMenuBuilder> {
	return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
		new StringSelectMenuBuilder()
			.setCustomId(`${PREFIX}:${action}`)
			.setPlaceholder(placeholder)
			.setMinValues(1)
			.setMaxValues(1)
			.addOptions(
				requests.map((request) => ({
					label: request.name.slice(0, SELECT_TEXT_MAX),
					value: request.nameKey,
					...(describe ? { description: describe(request).slice(0, SELECT_TEXT_MAX) } : {}),
				}))
			)
	);
}

// ── shared context ─────────────────────────────────────────────────────────
type BallotInteraction = ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction;

interface BallotContext {
	guildId: string;
	copy: BallotCopy;
	canRemove: boolean;
}

// The guild's pack and whether this clicker may remove, read fresh on every action
// so a role change takes effect on the next press. Null outside a server.
async function loadContext(interaction: BallotInteraction): Promise<BallotContext | null> {
	const guildId = interaction.guildId;
	if (!guildId || !interaction.guild) return null;
	const config = await guildConfigStore.findByGuildId(guildId);
	return {
		guildId,
		copy: getPluginCopy(config as unknown as ICopyConfig | null).gameRequests,
		canRemove: await gateOwnerOrAdmin(interaction, config),
	};
}

async function currentView(context: BallotContext, viewerId: string, notice?: string): Promise<BallotView> {
	return buildBallotView(await listGameRequests(context.guildId), viewerId, context.canRemove, context.copy, notice);
}

async function replyOutsideGuild(interaction: BallotInteraction): Promise<void> {
	await showNotice(interaction, { title: getPluginCopy(null).notice.gameRequests, sections: [getPluginCopy(null).gameRequests.outsideGuild] });
}

// ── the button: open the ballot, or open the Add a game modal ───────────────
async function handleGameRequestButton(interaction: ButtonInteraction): Promise<void> {
	const [, action] = interaction.customId.split(":");
	const context = await loadContext(interaction);
	if (!context) return replyOutsideGuild(interaction);

	if (action === ACTION.open) {
		await interaction.reply({ ...(await currentView(context, interaction.user.id)), flags: MessageFlags.Ephemeral, allowedMentions: NO_PINGS });
		return;
	}
	if (action === ACTION.add) {
		await interaction.showModal(buildAddModal(context.copy));
	}
}

function buildAddModal(copy: BallotCopy): ModalBuilder {
	return new ModalBuilder()
		.setCustomId(`${PREFIX}:${ACTION.add}`)
		.setTitle(copy.modalTitle)
		.addComponents(
			new ActionRowBuilder<TextInputBuilder>().addComponents(
				new TextInputBuilder()
					.setCustomId(NAME_FIELD)
					.setLabel(copy.modalLabel)
					.setPlaceholder(copy.modalPlaceholder)
					.setStyle(TextInputStyle.Short)
					.setRequired(true)
					.setMinLength(GAME_REQUEST_NAME_MIN)
					.setMaxLength(GAME_REQUEST_NAME_MAX)
			)
		);
}

// ── the modal: add a game ───────────────────────────────────────────────────
async function handleGameRequestModal(interaction: ModalSubmitInteraction): Promise<void> {
	const [, action] = interaction.customId.split(":");
	if (action !== ACTION.add) return;
	const context = await loadContext(interaction);
	if (!context) return replyOutsideGuild(interaction);

	// The modal's own length limits are a convenience; addGameRequest checks again,
	// because a modal submit is reachable without the modal Discord drew.
	const result = await addGameRequest(context.guildId, interaction.user.id, interaction.fields.getTextInputValue(NAME_FIELD));
	const view = await currentView(context, interaction.user.id, addNotice(result, context.copy));

	// Opened from the ballot's own button, so the ballot itself is redrawn; a submit
	// with no message behind it gets a fresh ephemeral ballot instead.
	if (interaction.isFromMessage()) {
		await interaction.update({ ...view, allowedMentions: NO_PINGS });
		return;
	}
	await interaction.reply({ ...view, flags: MessageFlags.Ephemeral, allowedMentions: NO_PINGS });
}

function addNotice(result: Awaited<ReturnType<typeof addGameRequest>>, copy: BallotCopy): string {
	if (result.ok) return copy.added(escapeMarkdown(result.request.name));
	if (result.reason === "duplicate") return copy.duplicate(escapeMarkdown(result.existingName));
	if (result.reason === "full") return copy.full(GAME_REQUEST_POOL_CAP);
	return copy.nameLength(GAME_REQUEST_NAME_MIN, GAME_REQUEST_NAME_MAX);
}

// ── the selects: vote, and the owner or admin's Remove ──────────────────────
async function handleGameRequestSelect(interaction: StringSelectMenuInteraction): Promise<void> {
	const [, action] = interaction.customId.split(":");
	if (action !== ACTION.vote && action !== ACTION.remove) return;
	const context = await loadContext(interaction);
	if (!context) return replyOutsideGuild(interaction);
	const nameKey = interaction.values[0] ?? "";

	if (action === ACTION.remove) {
		await removeAsAdmin(interaction, context, nameKey);
		return;
	}

	const vote = await toggleGameRequestVote(context.guildId, nameKey, interaction.user.id);
	await interaction.update({ ...(await currentView(context, interaction.user.id, voteNotice(vote, context.copy))), allowedMentions: NO_PINGS });
}

function voteNotice(vote: Awaited<ReturnType<typeof toggleGameRequestVote>>, copy: BallotCopy): string {
	if (!vote.ok) return copy.notFound;
	const name = escapeMarkdown(vote.request.name);
	return vote.voted ? copy.voted(name) : copy.unvoted(name);
}

// ⚠️ THE GATE, re-run on every pick. The Remove select is only drawn for the owner or
// an admin, but a select's customId and values can be replayed by anyone, so a
// member who is neither is refused here and nothing is deleted.
async function removeAsAdmin(interaction: StringSelectMenuInteraction, context: BallotContext, nameKey: string): Promise<void> {
	if (!context.canRemove) {
		await showNotice(interaction, { title: getPluginCopy(null).notice.gameRequests, sections: [context.copy.adminOnly] });
		return;
	}
	const removed = await removeGameRequest(context.guildId, nameKey);
	const notice = removed ? context.copy.removed(escapeMarkdown(removed.name)) : context.copy.notFound;
	await interaction.update({ ...(await currentView(context, interaction.user.id, notice)), allowedMentions: NO_PINGS });
}

/**
 * Register the ballot's button, select and modal handlers. Called once at boot from
 * main.ts, before the InteractionCreate listener installs, like every persistent UI.
 */
export function registerGameRequestHandlers(): void {
	registerButton(PREFIX, handleGameRequestButton);
	registerSelectMenu(PREFIX, handleGameRequestSelect);
	registerModal(PREFIX, handleGameRequestModal);
}
