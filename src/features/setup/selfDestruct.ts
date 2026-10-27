import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	CategoryChannel,
	Guild,
	LabelBuilder,
	MessageFlags,
	ModalBuilder,
	StringSelectMenuBuilder,
	StringSelectMenuOptionBuilder,
	TextDisplayBuilder,
	TextInputBuilder,
	TextInputStyle,
	type ButtonInteraction,
	type ChatInputCommandInteraction,
	type ModalSubmitInteraction,
} from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { registerButton, registerModal } from "@handlers/interactionRegistry.js";
import { errorEmbed, infoEmbed } from "@utils/embedBuilder.js";
import { answerInChannel, beginChannelAnswer } from "@utils/answerInChannel.js";
import { showErrorNotice } from "@utils/textModal.js";
import { COLORS } from "@base/copy/brand.js";
import { DERO_VOICE_ROOM_FIELDS, revokeDeroVoiceRooms } from "@features/voice/deroVoiceRooms.js";
import { readAdoptedChannelIds } from "./adoption.js";
import { adminLog } from "./adminLog.js";
import { turnArcadeOff } from "./arcadeSwitch.js";
import { resetConfigsToDefault, wipeServerData } from "./serverReset.js";
import { setupCopy } from "./setupCopy.js";

// ── Self destruct ──────────────────────────────────────────────────────
// Server owner only, as three honest choices (2026-10 item 254, the owner's
// decision 4 in the Dero 2.0.0 debug checklist):
//   ① "Self destruct" opens a modal that says what goes (every Dero channel and its
//      message history) and what stays (stored data, and an adopted welcome or
//      rules channel), and asks through one REQUIRED select:
//        Just delete channels  demolishHomebase alone. Every setting is kept, so
//                              /setup rebuilds the server as it was.
//        Arcade only           the /arcade off path (arcadeSwitch.turnArcadeOff).
//        Delete my data        answers with one Type CONFIRM button, because a
//                              modal cannot open from a modal submit.
//   ② Type CONFIRM opens the CONFIRM modal. Only the exact word deletes:
//      demolishHomebase, then wipeServerData, then resetConfigsToDefault, so the
//      data AND the settings go (owner decision 4a).
// GuildConfig.homebaseDestroyed keeps the homebase gone across restarts until
// /setup runs again. The select IS the confirmation for the two choices that keep
// the data, which is why it is required and has no default.
//
// Two entry points open the SAME modal: the /self-destruct slash command, and the
// owner only "Self destruct" button on the admin command guide. Every step re-checks
// the owner, and each choice's outcome (a refusal included) is ONE line in
// 🗒️admin-log. Delete my data writes its line at the CONFIRM step, never at the
// choice, so confirming does not log it twice.
//
// customId scheme `self_destruct:<action>`, routed on the "self_destruct" prefix via
// interactionRegistry: prompt (the guide button), choose (the choice modal), delete
// (Type CONFIRM, opens the CONFIRM modal) and modal (the CONFIRM modal). Anything
// else, including `reset`, `cancel` and `confirm` from a prompt still open from an
// older build, answers as a stale control and does nothing its label once said.

const PREFIX = "self_destruct";
const PROMPT_ID = `${PREFIX}:prompt`;
const CHOICE_MODAL_ID = `${PREFIX}:choose`;
const DELETE_ID = `${PREFIX}:delete`;
const MODAL_ID = `${PREFIX}:modal`;
const CONFIRM_WORD_FIELD = "confirm_word";
const CHOICE_FIELD = "self_destruct_choice";

/** The three things self destruct can do, as the select's values. */
export const SELF_DESTRUCT_CHOICES = ["channels", "data", "arcade"] as const;
export type SelfDestructChoice = (typeof SELF_DESTRUCT_CHOICES)[number];

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
	// 🏆rated-challenges (2026-10 item 254, Arcade 5)
	"arcadeRatedChallengesChannelId",
	// The two voice rooms, one per category (2026-10 item 235)
	"meetingVoiceChannelId",
	"arcadeVoiceChannelId",
	// 🏰 DERO HEADQUARTERS' three config channels and 💬dero-commands (2026-10 item 257 Phase 2a)
	"deroConfigChannelId",
	"onboardingConfigChannelId",
	"arcadeControlChannelId",
	"commandOutputChannelId",
] as const;

// Every managed category, deleted after every channel and in this order, 🏰 DERO
// HEADQUARTERS last (2026-10 item 257 Phase 2a). Per-match ROOM
// channels are deliberately absent: they live on GameRoom rows rather than on
// GuildConfig, and the children sweep inside demolishCategory catches them
// anyway, which is the correct outcome for a self-destruct.
export const MANAGED_CATEGORY_FIELDS = ["categoryId", "gamesCategoryId", "headquartersCategoryId"] as const;

/**
 * Who asked for a demolition. It becomes the reason Discord's own audit log shows
 * beside every delete, so a server owner reading that log can tell the two apart.
 */
export type DemolitionSource = "self-destruct" | "arcade-off";

const DEMOLITION_REASONS: Record<DemolitionSource, string> = {
	"self-destruct": "Homebase self-destruct",
	"arcade-off": "Arcade switched off with /arcade off",
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
	await showErrorNotice(interaction, c.ownerOnly);
}

/** The choice modal: what self destruct deletes and keeps, over one required select of the three choices. Exported for the tests. */
export function buildChoiceModal(): ModalBuilder {
	const options = SELF_DESTRUCT_CHOICES.map((choice) =>
		new StringSelectMenuOptionBuilder().setValue(choice).setLabel(c.choices[choice].label).setDescription(c.choices[choice].description).setEmoji(c.choices[choice].emoji)
	);
	// Required with no default: an owner must pick a choice by hand, so a stray
	// Submit can never run one.
	const select = new StringSelectMenuBuilder().setCustomId(CHOICE_FIELD).setRequired(true).setMinValues(1).setMaxValues(1).addOptions(options);
	return new ModalBuilder()
		.setCustomId(CHOICE_MODAL_ID)
		.setTitle(c.choiceModalTitle)
		.addTextDisplayComponents(new TextDisplayBuilder().setContent(c.choiceModalBody))
		.addLabelComponents(new LabelBuilder().setLabel(c.choiceLabel).setStringSelectMenuComponent(select));
}

/**
 * Open the choice modal. Shared by the /self-destruct command and the admin guide
 * button. Owner only (both callers also gate; this is defense in depth).
 */
export async function showSelfDestructChoices(interaction: ButtonInteraction | ChatInputCommandInteraction): Promise<void> {
	if (!isServerOwner(interaction)) {
		await refuseNonOwner(interaction);
		return;
	}
	await interaction.showModal(buildChoiceModal());
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
		await showSelfDestructChoices(interaction);
		return;
	}

	if (action === "delete") {
		await interaction.showModal(buildConfirmModal());
		return;
	}

	// Unknown action, including the retired reset, cancel and confirm (see the header).
	await showErrorNotice(interaction, c.staleControl);
}

// Both modals share the prefix, so one registered handler routes them by customId.
async function handleSelfDestructModal(interaction: ModalSubmitInteraction): Promise<void> {
	if (!interaction.guild) {
		await showErrorNotice(interaction, c.notInGuild);
		return;
	}
	// The owner is checked again on every submit, because a modal submit is
	// reachable without the button that opened it.
	if (!isServerOwner(interaction)) {
		await refuseNonOwner(interaction);
		return;
	}
	if (interaction.customId === CHOICE_MODAL_ID) {
		await runChoice(interaction, interaction.guild);
		return;
	}
	await handleConfirmModal(interaction, interaction.guild);
}

function readChoice(interaction: ModalSubmitInteraction): SelfDestructChoice | null {
	const [value] = interaction.fields.getStringSelectValues(CHOICE_FIELD);
	return SELF_DESTRUCT_CHOICES.find((choice) => choice === value) ?? null;
}

async function runChoice(interaction: ModalSubmitInteraction, guild: Guild): Promise<void> {
	const choice = readChoice(interaction);
	if (choice === "channels") {
		await runJustDeleteChannels(interaction, guild);
		return;
	}
	if (choice === "arcade") {
		await runArcadeOnly(interaction, guild);
		return;
	}
	if (choice === "data") {
		// Nothing is logged here: Delete my data writes its one line at the CONFIRM
		// step, where it either deletes or is refused. The prompt posts in
		// 🎛️admin-controls (2026-10 item 257 Phase 5): a modal Submit opens no notice,
		// and its button refuses everyone but the server owner (refuseNonOwner).
		const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder().setCustomId(DELETE_ID).setLabel(c.typeConfirmLabel).setEmoji("🗑️").setStyle(ButtonStyle.Danger)
		);
		await answerInChannel(interaction, "admin", { embeds: [infoEmbed(c.deleteDataTitle, c.deleteDataBody, COLORS.ERROR)], components: [row] });
		return;
	}
	// A required select always carries a value; this answers a submit Discord built
	// from an older modal whose values no longer match.
	await showErrorNotice(interaction, c.staleControl);
}

// Just delete channels: the teardown alone. Every setting stays on the row, so
// /setup rebuilds the channels from it (autoSetup with force only rewrites ids).
// Its answers stay private: every channel they could post in is the one being deleted.
async function runJustDeleteChannels(interaction: ModalSubmitInteraction, guild: Guild): Promise<void> {
	// Logged BEFORE the teardown on purpose: the log channel is about to be deleted,
	// and the BotLog row is written either way.
	auditAttempt(interaction, c.auditChannelsConfirmed);
	await interaction.reply({ embeds: [infoEmbed(c.deletingTitle, c.deletingChannelsBody, COLORS.ERROR)], flags: MessageFlags.Ephemeral });
	try {
		await demolishHomebase(guild, interaction.user.id);
	} catch (error) {
		console.error(`[self-destruct] channel demolish failed in guild ${guild.id}`, error);
		await interaction.followUp({ content: c.deleteFailed, flags: MessageFlags.Ephemeral }).catch(() => undefined);
		return;
	}
	// Best effort: the channel this ran in may already be gone.
	await interaction.followUp({ content: c.channelsDone, flags: MessageFlags.Ephemeral }).catch(() => undefined);
}

// Arcade only: exactly what /arcade off runs, acknowledged first because deleting a
// category and its channels can outrun Discord's three second window. The outcome posts
// in 🎰arcade-control, which sits in Dero Headquarters and outlives the arcade.
async function runArcadeOnly(interaction: ModalSubmitInteraction, guild: Guild): Promise<void> {
	const arcadeCopy = setupCopy.arcade;
	const answer = await beginChannelAnswer(interaction, "arcade");
	try {
		const outcome = await turnArcadeOff(guild);
		auditAttempt(interaction, outcome === "off" ? c.auditArcadeOff : c.auditArcadeAlreadyOff);
		const body = outcome === "off" ? arcadeCopy.offBody : arcadeCopy.alreadyOff;
		await answer.send({ embeds: [infoEmbed(arcadeCopy.offTitle, body, COLORS.ERROR)] });
	} catch (error) {
		console.error(`[self-destruct] arcade only failed in guild ${guild.id}`, error);
		auditAttempt(interaction, c.auditArcadeFailed);
		await answer.send({ embeds: [errorEmbed(arcadeCopy.offFailed)] });
	}
}

// Delete my data, step ②: only the exact word deletes.
async function handleConfirmModal(interaction: ModalSubmitInteraction, guild: Guild): Promise<void> {
	if (interaction.fields.getTextInputValue(CONFIRM_WORD_FIELD).trim() !== c.confirmWord) {
		auditAttempt(interaction, c.auditDeleteRefused);
		await showErrorNotice(interaction, c.mismatch);
		return;
	}

	// Logged BEFORE the teardown on purpose: the log channel is about to be deleted,
	// and the BotLog row is written either way. The answers stay private for the same
	// reason: every channel they could post in is being deleted.
	auditAttempt(interaction, c.auditDeleteConfirmed);
	await interaction.reply({ embeds: [infoEmbed(c.deletingTitle, c.deletingBody, COLORS.ERROR)], flags: MessageFlags.Ephemeral });
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
	// The settings go last (owner decision 4a): a reset that fails still leaves the
	// records gone, and is named beside any record that failed so a rerun finishes it.
	try {
		await resetConfigsToDefault(guild.id);
	} catch (error) {
		console.error(`[self-destruct] settings reset failed in guild ${guild.id}`, error);
		failed.push(c.settingsLabel);
	}
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

	// The voice rooms about to go come off Dero's voice allow list, which setup put
	// them on (2026-10 item 257, owner item 8); an admin's own entries stay.
	void revokeDeroVoiceRooms(guild.id, DERO_VOICE_ROOM_FIELDS.map((field) => ids[field]));

	let deleted = await demolishChannels(guild, HOMEBASE_CHANNEL_FIELDS.map((field) => ids[field]), adoptedIds, "self-destruct");

	// Every managed category, through one helper so neither the arcade nor
	// Headquarters can be demolished less thoroughly than the homebase.
	for (const field of MANAGED_CATEGORY_FIELDS) {
		deleted += await demolishCategory(guild, ids[field], field, adoptedIds, "self-destruct");
	}

	// The ONE line for the whole teardown: ChannelDeleteWatcher stays silent on each of
	// these deletes because the homebase flag is set, so this summary is where an
	// operator reads what happened (2026-10 item 257, Log 5).
	console.warn(`[self-destruct] homebase demolished in guild ${guild.id}: ${deleted} channel(s) deleted, none rebuilt until /setup runs`);
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
): Promise<number> {
	let deleted = 0;
	for (const id of channelIds) {
		if (!id || keepIds.has(id)) continue;
		const channel = await guild.channels.fetch(id).catch(() => null);
		if (!channel) continue;
		const removed = await channel.delete(DEMOLITION_REASONS[source]).then(
			() => true,
			(err) => {
				console.warn(`[${source}] failed to delete channel ${id} in guild ${guild.id}`, err);
				return false;
			}
		);
		if (removed) deleted += 1;
	}
	return deleted;
}

/**
 * Delete one managed category and anything still parented to it. Best effort
 * throughout: a failed delete is logged and the rest proceed, because a partial
 * demolition that reports honestly beats one that aborts halfway. `source` says
 * which command asked (self destruct or /arcade off).
 */
export async function demolishCategory(
	guild: Guild,
	categoryId: string | null | undefined,
	label: string,
	keepIds: ReadonlySet<string>,
	source: DemolitionSource
): Promise<number> {
	if (!categoryId) return 0;
	const category = await guild.channels.fetch(categoryId).catch(() => null);
	if (!category) return 0;
	const reason = DEMOLITION_REASONS[source];
	let deleted = 0;

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
			const removed = await child.delete(reason).then(
				() => true,
				(err) => {
					console.warn(`[${source}] failed to delete orphan child ${child.id} in guild ${guild.id}`, err);
					return false;
				}
			);
			if (removed) deleted += 1;
		}
	}

	await category.delete(reason).catch((err) => console.warn(`[${source}] failed to delete ${label} in guild ${guild.id}`, err));
	return deleted;
}

/**
 * Owner-only "Self destruct" button, folded into the pinned admin command guide
 * row (alongside the admin controls). Exported as a bare ButtonBuilder so
 * resolveIntroComponents can compose it with the other admin-controls buttons.
 * The `self_destruct:prompt` customId routes through handleSelfDestruct, which
 * gates owner only and opens the choice modal. Visible to admins but only the
 * server owner can act on it.
 */
export function buildSelfDestructButton(): ButtonBuilder {
	return new ButtonBuilder().setCustomId(PROMPT_ID).setLabel(c.buttonLabel).setEmoji("💥").setStyle(ButtonStyle.Danger);
}

/**
 * Register the self-destruct button and modal handlers. Called once at boot
 * from main.ts before the InteractionCreate listener installs.
 */
export function registerSelfDestructHandlers(): void {
	registerButton(PREFIX, handleSelfDestruct);
	registerModal(PREFIX, handleSelfDestructModal);
}
