import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	CategoryChannel,
	Guild,
	MessageFlags,
	ModalBuilder,
	TextInputBuilder,
	TextInputStyle,
	type ButtonInteraction,
	type ChatInputCommandInteraction,
	type ModalSubmitInteraction,
} from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { registerButton, registerModal } from "@handlers/interactionRegistry.js";
import { errorEmbed, infoEmbed } from "@utils/embedBuilder.js";
import { COLORS } from "@base/copy/brand.js";
import { readAdoptedChannelIds } from "./adoption.js";
import { adminLog } from "./adminLog.js";
import { resetConfigsToDefault, wipeServerData } from "./serverReset.js";
import { setupCopy } from "./setupCopy.js";

// ── Self destruct ──────────────────────────────────────────────────────
// Server-owner-only, in TWO tiers (post-launch plan item 10, the owner's choice):
//   ① "Self destruct" opens a prompt that says it resets all configs to default.
//      Confirm runs resetConfigsToDefault and keeps every channel and record.
//   ② The reset's result carries "Delete server data", which opens a modal asking
//      the owner to type CONFIRM. Only the exact word deletes: demolishHomebase
//      takes both categories and every channel, then wipeServerData deletes this
//      guild's stored records. GuildConfig.homebaseDestroyed keeps the homebase
//      gone across restarts until /setup runs again.
//
// Two entry points pop the SAME prompt: the /self-destruct slash command, and the
// owner-only "Self destruct" button on the admin command guide. Every step re-checks
// the owner, and every outcome (a refusal included) is one line in 🗒️admin-log.
//
// customId scheme `self_destruct:<action>`, routed on the "self_destruct" prefix via
// interactionRegistry: prompt (the guide button), reset (tier ① Confirm), cancel,
// delete (opens the tier ② modal), and the modal itself. The tier ① Confirm is
// `reset` rather than the old `confirm` on purpose: a prompt still open from before
// this change carries `confirm`, which used to DEMOLISH, and it now answers as a
// stale control instead of doing something its label never said.

const PREFIX = "self_destruct";
const RESET_ID = `${PREFIX}:reset`;
const CANCEL_ID = `${PREFIX}:cancel`;
const DELETE_ID = `${PREFIX}:delete`;
const MODAL_ID = `${PREFIX}:modal`;
const CONFIRM_WORD_FIELD = "confirm_word";

const c = setupCopy.selfDestruct;

// GuildConfig channel-id fields demolished on self-destruct (the categories are
// fetched + deleted separately). Children are deleted first; the category last.
//
// ⚠️ SPANS BOTH MANAGED CATEGORIES as of the ARCADE GAMES work. The name still
// says "homebase" because self-destruct's job is "remove everything this bot
// built", and that surface is now two categories rather than one. Any new
// managed channel must be added here in the SAME change that creates it (risk
// R13): a channel this list forgets survives the demolition, and the
// homebaseDestroyed flag set moments earlier then stops ensureHomebase from ever
// touching it again, so the leftover is PERMANENT rather than merely untidy.
export const HOMEBASE_CHANNEL_FIELDS = [
	"introChannelId",
	"commandsChannelId",
	"leaderboardChannelId",
	"scheduleChannelId",
	"announcementsChannelId",
	"nextDecreeChannelId",
	"adminChannelId",
	"adminCommandsChannelId",
	// 🗒️admin-log (post-launch plan item 11)
	"adminLogChannelId",
	// 👋welcome and 📘rules (2026-10 item 247 Phase 2). Demolished only when Dero
	// built them: an adopted one is the server's own and is left standing.
	"welcomeChannelId",
	"rulesChannelId",
	// 🎮 ARCADE GAMES
	"arcadeRulesChannelId",
	"arcadeChallengesChannelId",
	// 🕹️games (2026-10 item 245 Phase 4a)
	"arcadeGamesChannelId",
	// 🎉party-games (post-launch plan item 3)
	"partyGamesChannelId",
	// The two voice rooms, one per category (2026-10 item 235)
	"meetingVoiceChannelId",
	"arcadeVoiceChannelId",
] as const;

// Both managed categories, deleted last and in this order. Per-match ROOM
// channels are deliberately absent: they live on GameRoom rows rather than on
// GuildConfig, and the children sweep inside demolishCategory catches them
// anyway, which is the correct outcome for a self-destruct.
export const MANAGED_CATEGORY_FIELDS = ["categoryId", "gamesCategoryId"] as const;

/**
 * Who asked for a demolition. It becomes the reason Discord's own audit log shows
 * beside every delete, so a server owner reading that log can tell the two apart.
 */
export type DemolitionSource = "self-destruct" | "arcade-off";

const DEMOLITION_REASONS: Record<DemolitionSource, string> = {
	"self-destruct": "Homebase self-destruct",
	"arcade-off": "Arcade switched off with /dero-config arcade off",
};

type SelfDestructEntry = ButtonInteraction | ChatInputCommandInteraction | ModalSubmitInteraction;

function isServerOwner(interaction: SelfDestructEntry): boolean {
	return Boolean(interaction.guild) && interaction.user.id === interaction.guild!.ownerId;
}

// One audit line per self destruct outcome. A refusal is logged too: an admin
// pressing the owner's button is exactly the attempt the log exists to show.
function auditAttempt(interaction: SelfDestructEntry, detail: string): void {
	if (!interaction.guild) return;
	adminLog.emit({ guild: interaction.guild, kind: "selfdestruct.attempt", actor: { userId: interaction.user.id }, payload: { detail } });
}

async function refuseNonOwner(interaction: SelfDestructEntry): Promise<void> {
	auditAttempt(interaction, c.auditRefusedNotOwner);
	await interaction.reply({ embeds: [errorEmbed(c.ownerOnly)], flags: MessageFlags.Ephemeral });
}

/**
 * Show tier ①, the reset prompt with Confirm and Cancel. Shared by the
 * /self-destruct command and the admin guide button. Owner-only (both callers also
 * gate; this is defense in depth).
 */
export async function showSelfDestructConfirm(interaction: ButtonInteraction | ChatInputCommandInteraction): Promise<void> {
	if (!isServerOwner(interaction)) {
		await refuseNonOwner(interaction);
		return;
	}

	const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder().setCustomId(RESET_ID).setLabel(c.confirmLabel).setEmoji("💥").setStyle(ButtonStyle.Danger),
		new ButtonBuilder().setCustomId(CANCEL_ID).setLabel(c.cancelLabel).setStyle(ButtonStyle.Secondary)
	);
	await interaction.reply({ embeds: [infoEmbed(c.resetPromptTitle, c.resetPromptBody, COLORS.ERROR)], components: [row], flags: MessageFlags.Ephemeral });
}

// Tier ①: reset every setting, then offer tier ②. The click is acknowledged first so
// a slow reset never outlives Discord's three second window.
async function runReset(interaction: ButtonInteraction): Promise<void> {
	await interaction.update({ embeds: [infoEmbed(c.resettingTitle, c.resettingBody, COLORS.ERROR)], components: [] });
	try {
		await resetConfigsToDefault(interaction.guild!.id);
	} catch (error) {
		console.error(`[self-destruct] config reset failed in guild ${interaction.guild?.id}`, error);
		auditAttempt(interaction, c.auditResetFailed);
		await interaction.editReply({ embeds: [errorEmbed(c.resetFailed)] }).catch(() => undefined);
		return;
	}
	auditAttempt(interaction, c.auditReset);
	const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder().setCustomId(DELETE_ID).setLabel(c.deleteDataLabel).setEmoji("🗑️").setStyle(ButtonStyle.Danger)
	);
	await interaction.editReply({ embeds: [infoEmbed(c.resetDoneTitle, c.resetDoneBody, COLORS.ERROR)], components: [row] }).catch(() => undefined);
}

function buildConfirmModal(): ModalBuilder {
	return new ModalBuilder()
		.setCustomId(MODAL_ID)
		.setTitle(c.modalTitle)
		.addComponents(
			new ActionRowBuilder<TextInputBuilder>().addComponents(
				new TextInputBuilder()
					.setCustomId(CONFIRM_WORD_FIELD)
					.setLabel(c.modalInputLabel)
					.setPlaceholder(c.modalPlaceholder)
					.setStyle(TextInputStyle.Short)
					.setRequired(true)
					.setMaxLength(c.confirmWord.length + 10)
			)
		);
}

async function handleSelfDestruct(interaction: ButtonInteraction): Promise<void> {
	const action = interaction.customId.split(":")[1];

	// Re-verify owner on every action, the prompt button lives on the pinned
	// admin command guide (visible to admins), and every later step is destructive.
	if (!isServerOwner(interaction)) {
		await refuseNonOwner(interaction);
		return;
	}

	if (action === "prompt") {
		await showSelfDestructConfirm(interaction);
		return;
	}

	if (action === "cancel") {
		await interaction.update({ embeds: [infoEmbed(c.cancelledTitle, c.cancelledBody, COLORS.SCHEDULE)], components: [] });
		return;
	}

	if (action === "reset") {
		await runReset(interaction);
		return;
	}

	if (action === "delete") {
		await interaction.showModal(buildConfirmModal());
		return;
	}

	// Unknown action, including the retired `confirm` (see the header).
	await interaction.reply({ content: c.staleControl, flags: MessageFlags.Ephemeral });
}

// Tier ②: only the exact word deletes, and the owner is checked again, because a
// modal submit is reachable without the button that opened it.
async function handleConfirmModal(interaction: ModalSubmitInteraction): Promise<void> {
	if (!interaction.guild) {
		await interaction.reply({ embeds: [errorEmbed(c.notInGuild)], flags: MessageFlags.Ephemeral });
		return;
	}
	if (!isServerOwner(interaction)) {
		await refuseNonOwner(interaction);
		return;
	}
	if (interaction.fields.getTextInputValue(CONFIRM_WORD_FIELD).trim() !== c.confirmWord) {
		auditAttempt(interaction, c.auditDeleteRefused);
		await interaction.reply({ embeds: [errorEmbed(c.mismatch)], flags: MessageFlags.Ephemeral });
		return;
	}

	// Logged BEFORE the teardown on purpose: the log channel is about to be deleted,
	// and the BotLog row is written either way.
	auditAttempt(interaction, c.auditDeleteConfirmed);
	await interaction.reply({ embeds: [infoEmbed(c.deletingTitle, c.deletingBody, COLORS.ERROR)], flags: MessageFlags.Ephemeral });
	const guild = interaction.guild;
	try {
		await demolishHomebase(guild, interaction.user.id);
	} catch (error) {
		// demolishHomebase sets the flag first and only deletes after, so a throw
		// here means the pre-delete write failed and nothing was torn down.
		console.error(`[self-destruct] demolish failed in guild ${guild.id}`, error);
		auditAttempt(interaction, c.auditDeleteFailed);
		await interaction.followUp({ content: c.deleteFailed, flags: MessageFlags.Ephemeral }).catch(() => undefined);
		return;
	}

	const { failed } = await wipeServerData(guild.id);
	// Best-effort follow-up; the channel this ran in is already gone, and an
	// ephemeral follow up may go with it.
	await interaction
		.followUp({ content: failed.length === 0 ? c.deleteDone : c.deletePartial(failed), flags: MessageFlags.Ephemeral })
		.catch(() => undefined);
}

/**
 * Delete the category + every homebase channel, and flag the guild so nothing
 * rebuilds it until /setup runs. Best-effort per channel: a single failed delete
 * is logged and the rest proceed.
 */
async function demolishHomebase(guild: Guild, actorId: string): Promise<void> {
	const config = await guildConfigStore.findByGuildId(guild.id);
	if (!config) return;

	// Channels the server had before Dero adopted them (2026-10 item 247 Phase 2)
	// are the owner's, so they survive the demolition: skipped below, and their
	// stored ids are released in the same write as the flag, so nothing Dero keeps
	// still points at a channel it no longer manages. Their overwrites are untouched.
	const ids = config as unknown as Record<string, string | null | undefined>;
	const adoptedIds = new Set(readAdoptedChannelIds(config));
	const releasedSlots = Object.fromEntries(
		HOMEBASE_CHANNEL_FIELDS.filter((field) => adoptedIds.has(ids[field] ?? "")).map((field) => [field, null])
	);

	// Flag FIRST, before any delete. The realtime ChannelDeleteWatcher reads this
	// on each channelDelete; setting it first means the watcher (and the boot
	// sweep) skip rebuilding instead of racing the teardown and resurrecting
	// channels. setupComplete is cleared so /setup treats this as a fresh setup.
	await guildConfigStore.update(guild.id, { homebaseDestroyed: true, setupComplete: false, ...releasedSlots, adoptedChannelIds: [] });

	console.warn(`[self-destruct] demolishing homebase in guild ${guild.id}, requested by ${actorId}; keeping ${adoptedIds.size} adopted channel(s)`);

	await demolishChannels(guild, HOMEBASE_CHANNEL_FIELDS.map((field) => ids[field]), adoptedIds, "self-destruct");

	// Both managed categories, through one helper so the arcade cannot be
	// demolished less thoroughly than the homebase.
	for (const field of MANAGED_CATEGORY_FIELDS) {
		await demolishCategory(guild, ids[field], field, adoptedIds, "self-destruct");
	}

	console.warn(`[self-destruct] homebase demolished in guild ${guild.id}`);
}

/**
 * Delete each tracked channel by id, skipping the server's own (keepIds). Best
 * effort: a failed delete is logged and the rest proceed. Shared by self destruct
 * and arcade off, so the two tear down a channel the same way.
 */
export async function demolishChannels(
	guild: Guild,
	channelIds: ReadonlyArray<string | null | undefined>,
	keepIds: ReadonlySet<string>,
	source: DemolitionSource
): Promise<void> {
	for (const id of channelIds) {
		if (!id || keepIds.has(id)) continue;
		const channel = await guild.channels.fetch(id).catch(() => null);
		if (!channel) continue;
		await channel.delete(DEMOLITION_REASONS[source]).catch((err) => console.warn(`[${source}] failed to delete channel ${id} in guild ${guild.id}`, err));
	}
}

/**
 * Delete one managed category and anything still parented to it. Best effort
 * throughout: a failed delete is logged and the rest proceed, because a partial
 * demolition that reports honestly beats one that aborts halfway. `source` says
 * which command asked (self destruct or /dero-config arcade off).
 */
export async function demolishCategory(
	guild: Guild,
	categoryId: string | null | undefined,
	label: string,
	keepIds: ReadonlySet<string>,
	source: DemolitionSource
): Promise<void> {
	if (!categoryId) return;
	const category = await guild.channels.fetch(categoryId).catch(() => null);
	if (!category) return;
	const reason = DEMOLITION_REASONS[source];

	// Defensive: delete any channel still parented to the category before removing
	// it (a tracked child whose delete above failed, one an admin filed under it,
	// or, under the arcade, a live per-match room channel that is not tracked on
	// GuildConfig at all). Discord ORPHANS children when a category is deleted
	// rather than cascading, so without this they survive as stray top level
	// channels that nothing will ever clean up. That same orphaning is what an
	// ADOPTED channel relies on: skipped here, it outlives the category, parent-less.
	if (category instanceof CategoryChannel) {
		for (const child of category.children.cache.values()) {
			if (keepIds.has(child.id)) continue;
			await child.delete(reason).catch((err) => console.warn(`[${source}] failed to delete orphan child ${child.id} in guild ${guild.id}`, err));
		}
	}

	await category.delete(reason).catch((err) => console.warn(`[${source}] failed to delete ${label} in guild ${guild.id}`, err));
}

/**
 * Owner-only "Self destruct" button, folded into the pinned admin command guide
 * row (alongside the admin controls). Exported as a bare ButtonBuilder so
 * resolveIntroComponents can compose it with the other admin-controls buttons.
 * The `self_destruct:prompt` customId routes through handleSelfDestruct, which
 * gates owner-only and pops the reset prompt. Visible to admins but only the
 * server owner can act on it.
 */
export function buildSelfDestructButton(): ButtonBuilder {
	return new ButtonBuilder().setCustomId(`${PREFIX}:prompt`).setLabel(c.buttonLabel).setEmoji("💥").setStyle(ButtonStyle.Danger);
}

/**
 * Register the self-destruct button and modal handlers. Called once at boot
 * from main.ts before the InteractionCreate listener installs.
 */
export function registerSelfDestructHandlers(): void {
	registerButton(PREFIX, handleSelfDestruct);
	registerModal(PREFIX, handleConfirmModal);
}
