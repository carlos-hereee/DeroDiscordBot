import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	CategoryChannel,
	Client,
	Guild,
	MessageFlags,
	type ButtonInteraction,
	type ChatInputCommandInteraction,
} from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { registerButton } from "@handlers/interactionRegistry.js";
import { errorEmbed, infoEmbed } from "@utils/embedBuilder.js";
import { COLORS } from "@base/copy/brand.js";

// ── Self destruct ──────────────────────────────────────────────────────
// Server-owner-only homebase teardown. Demolishes the bot's category and every
// homebase channel in the guild it is invoked in, then sets
// GuildConfig.homebaseDestroyed so the boot sweep (ensureHomebase) and the
// realtime ChannelDeleteWatcher both STOP rebuilding it. The homebase stays gone
// across restarts until /setup runs again (which rebuilds it and re-assigns
// roles). Built for dev testing of the setup/auto-heal path; safe in production
// because it is owner-only and confirmation-gated.
//
// Two entry points both pop the SAME ephemeral Confirm/Cancel prompt: the
// /self-destruct slash command, and an owner-only "Self destruct" button on the
// admin command guide (pinned in the admin command channel). The teardown only
// runs on an explicit Confirm, with an owner re-check at confirm time.
//
// customId scheme `self_destruct:<action>` (prompt | confirm | cancel), routed on
// the "self_destruct" prefix via interactionRegistry. The "Self destruct" button
// folded into the admin command guide row uses `self_destruct:prompt`, which
// handleSelfDestruct turns into the Confirm/Cancel prompt; confirm/cancel use the
// same prefix. (It is NOT a powerup-prefixed control, PowerUps does not delegate here.)

const PREFIX = "self_destruct";
const CONFIRM_ID = `${PREFIX}:confirm`;
const CANCEL_ID = `${PREFIX}:cancel`;

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
	// 🎮 ARCADE GAMES
	"arcadeRulesChannelId",
	"gamesChallengesChannelId",
] as const;

// Both managed categories, deleted last and in this order. Per-match ROOM
// channels are deliberately absent: they live on GameRoom rows rather than on
// GuildConfig, and the children sweep inside demolishCategory catches them
// anyway, which is the correct outcome for a self-destruct.
export const MANAGED_CATEGORY_FIELDS = ["categoryId", "gamesCategoryId"] as const;

type SelfDestructEntry = ButtonInteraction | ChatInputCommandInteraction;

function isServerOwner(interaction: SelfDestructEntry): boolean {
	return Boolean(interaction.guild) && interaction.user.id === interaction.guild!.ownerId;
}

/**
 * Show the ephemeral Confirm/Cancel prompt. Shared by the /self-destruct command
 * and the danger-zone panel button. Owner-only (both callers also gate; this is
 * defense in depth).
 */
export async function showSelfDestructConfirm(interaction: SelfDestructEntry): Promise<void> {
	if (!isServerOwner(interaction)) {
		await interaction.reply({
			embeds: [errorEmbed("Only the server owner can self destruct the homebase.")],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const warning = infoEmbed(
		"💥 Self destruct the homebase?",
		[
			"This DELETES **both** of the bot's categories and every channel in them, along with everything posted there.",
			"",
			"🪧 NOTICE BOARD: introductions, command center, leaderboard, event schedule, announcements, upcoming events, the admin channel, and the admin command center.",
			"",
			"🎮 ARCADE GAMES: the game rules card, the challenge board, and **any match currently in progress**.",
			"",
			"It stays gone across restarts until you run `/setup` again. **This cannot be undone.**",
		].join("\n"),
		COLORS.ERROR
	);

	const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder().setCustomId(CONFIRM_ID).setLabel("Yes, demolish it").setEmoji("💥").setStyle(ButtonStyle.Danger),
		new ButtonBuilder().setCustomId(CANCEL_ID).setLabel("Cancel").setStyle(ButtonStyle.Secondary)
	);

	await interaction.reply({ embeds: [warning], components: [row], flags: MessageFlags.Ephemeral });
}

async function handleSelfDestruct(interaction: ButtonInteraction): Promise<void> {
	const action = interaction.customId.split(":")[1];

	// Re-verify owner on every action, the prompt button lives on the pinned
	// admin command guide (visible to admins), and the confirm button is the
	// irreversible one.
	if (!isServerOwner(interaction)) {
		await interaction.reply({ embeds: [errorEmbed("Only the server owner can do this.")], flags: MessageFlags.Ephemeral });
		return;
	}

	if (action === "prompt") {
		// The button on the admin command guide → pop the Confirm/Cancel prompt.
		await showSelfDestructConfirm(interaction);
		return;
	}

	if (action === "cancel") {
		await interaction.update({
			embeds: [infoEmbed("Cancelled", "The homebase is intact. Nothing was deleted.", COLORS.SCHEDULE)],
			components: [],
		});
		return;
	}

	if (action === "confirm") {
		// Acknowledge first (and drop the buttons) so the click does not error if
		// the channel it lives in is about to be deleted.
		await interaction.update({
			embeds: [infoEmbed("💥 Demolishing", "Tearing down the homebase now.", COLORS.ERROR)],
			components: [],
		});
		try {
			await demolishHomebase(interaction.client, interaction.guild!, interaction.user.id);
			// Best-effort follow-up; the channel this ran in may already be gone.
			await interaction
				.followUp({ content: "✅ Homebase demolished. It stays gone until you run /setup.", flags: MessageFlags.Ephemeral })
				.catch(() => undefined);
		} catch (err) {
			// demolishHomebase sets the flag first and only deletes after, so a throw
			// here means the pre-delete write failed and nothing was torn down. Tell
			// the owner rather than leaving them on a stuck "Demolishing" message.
			console.error(`[self-destruct] demolish failed in guild ${interaction.guild?.id}`, err);
			await interaction
				.followUp({ content: "Self destruct failed and nothing was deleted. Try again in a moment.", flags: MessageFlags.Ephemeral })
				.catch(() => undefined);
		}
		return;
	}

	// Unknown action (stale button from an older deploy).
	await interaction.reply({ content: "This control is no longer available.", flags: MessageFlags.Ephemeral });
}

/**
 * Delete the category + every homebase channel, and flag the guild so nothing
 * rebuilds it until /setup runs. Best-effort per channel: a single failed delete
 * is logged and the rest proceed.
 */
async function demolishHomebase(client: Client, guild: Guild, actorId: string): Promise<void> {
	const config = await guildConfigStore.findByGuildId(guild.id);
	if (!config) return;

	// Flag FIRST, before any delete. The realtime ChannelDeleteWatcher reads this
	// on each channelDelete; setting it first means the watcher (and the boot
	// sweep) skip rebuilding instead of racing the teardown and resurrecting
	// channels. setupComplete is cleared so /setup treats this as a fresh setup.
	await guildConfigStore.update(guild.id, { homebaseDestroyed: true, setupComplete: false });

	console.warn(`[self-destruct] demolishing homebase in guild ${guild.id}, requested by ${actorId}`);

	const ids = config as unknown as Record<string, string | null | undefined>;
	for (const field of HOMEBASE_CHANNEL_FIELDS) {
		const id = ids[field];
		if (!id) continue;
		const channel = await guild.channels.fetch(id).catch(() => null);
		if (channel) {
			await channel
				.delete("Homebase self-destruct")
				.catch((err) => console.warn(`[self-destruct] failed to delete ${field} in guild ${guild.id}`, err));
		}
	}

	// Both managed categories, through one helper so the arcade cannot be
	// demolished less thoroughly than the homebase.
	for (const field of MANAGED_CATEGORY_FIELDS) {
		await demolishCategory(guild, ids[field], field);
	}

	console.warn(`[self-destruct] homebase demolished in guild ${guild.id}`);
}

/**
 * Delete one managed category and anything still parented to it. Best effort
 * throughout: a failed delete is logged and the rest proceed, because a partial
 * demolition that reports honestly beats one that aborts halfway.
 */
async function demolishCategory(guild: Guild, categoryId: string | null | undefined, label: string): Promise<void> {
	if (!categoryId) return;
	const category = await guild.channels.fetch(categoryId).catch(() => null);
	if (!category) return;

	// Defensive: delete any channel still parented to the category before removing
	// it (a tracked child whose delete above failed, one an admin filed under it,
	// or, under the arcade, a live per-match room channel that is not tracked on
	// GuildConfig at all). Discord ORPHANS children when a category is deleted
	// rather than cascading, so without this they survive as stray top level
	// channels that nothing will ever clean up.
	if (category instanceof CategoryChannel) {
		for (const child of category.children.cache.values()) {
			await child
				.delete("Homebase self-destruct")
				.catch((err) => console.warn(`[self-destruct] failed to delete orphan child ${child.id} in guild ${guild.id}`, err));
		}
	}

	await category.delete("Homebase self-destruct").catch((err) => console.warn(`[self-destruct] failed to delete ${label} in guild ${guild.id}`, err));
}

/**
 * Owner-only "Self destruct" button, folded into the pinned admin command guide
 * row (alongside the admin controls). Exported as a bare ButtonBuilder so
 * resolveIntroComponents can compose it with the other admin-controls buttons.
 * The `self_destruct:prompt` customId routes through handleSelfDestruct, which
 * gates owner-only and pops the Confirm/Cancel prompt. Visible to admins but
 * only the server owner can act on it.
 */
export function buildSelfDestructButton(): ButtonBuilder {
	return new ButtonBuilder().setCustomId(`${PREFIX}:prompt`).setLabel("Self destruct homebase").setEmoji("💥").setStyle(ButtonStyle.Danger);
}

/**
 * Register the self-destruct prompt/confirm/cancel handler. Called once at boot
 * from main.ts before the InteractionCreate listener installs.
 */
export function registerSelfDestructHandlers(): void {
	registerButton(PREFIX, handleSelfDestruct);
}
