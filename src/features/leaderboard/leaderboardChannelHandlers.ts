import { ButtonInteraction, PermissionFlagsBits, MessageFlags, TextChannel } from "discord.js";
import { registerButton } from "@handlers/interactionRegistry.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { errorEmbed, infoEmbed } from "@utils/embedBuilder.js";
import { COLORS } from "@base/copy/brand.js";

// ── leaderboard channel handlers ──────────────────────────────────────
// What:  persistent button handlers that follow up the
//        /server leaderboard tracking flow with optional channel-
//        lifecycle actions. When the admin turns tracking OFF, the
//        command's reply includes a "Remove leaderboard channel" button.
//        Clicking that button routes here.
// Who:   one handler per button prefix. Today: `lb-ch-del` for
//        "delete the leaderboard channel." Future variants (e.g.,
//        rebuild-now) can register additional prefixes from this module.
// When:  click time. The button persists indefinitely on the original
//        reply, so this handler must not assume the toggle is still off
//       , the admin could have re-enabled tracking in between. Re-read
//        GuildConfig at handler entry to make a fresh decision.
// Where: customId format is `lb-ch-del:<guildId>`. The guildId is
//        included as positional arg so a stale message from a different
//        guild cannot cross-fire if a bot ever shares messages between
//        guilds (it currently does not, but the explicit guildId is a
//        cheap sanity check).
// How:   ① guard guildId presence + match against the button arg;
//        ② Administrator permission check (same gate as the slash
//           command that produced the button);
//        ③ load GuildConfig, locate the leaderboard channel by stored
//           id, delete it via Discord API;
//        ④ clear GuildConfig.leaderboardChannelId so a future toggle-on
//           with autoHealEnabled can rebuild it cleanly;
//        ⑤ reply with confirmation + a hint about how to restore.

const BUTTON_PREFIX = "lb-ch-del";

// Exported so /server leaderboard tracking (configureLeaderboardTracking.ts)
// can build the matching customId. Centralizing the prefix here means that
// handler does not need to know the format string, it just calls this helper.
export function buildLeaderboardChannelDeleteCustomId(guildId: string): string {
	return `${BUTTON_PREFIX}:${guildId}`;
}

async function handleLeaderboardChannelDelete(interaction: ButtonInteraction): Promise<void> {
	const guildId = interaction.guildId;
	if (!guildId) {
		await interaction.reply({
			embeds: [errorEmbed("Run this in a server, not a DM.")],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	// Cross-guild sanity check. customId carries the guildId of origin so
	// a button click in a different guild cannot delete the wrong channel.
	const customIdParts = interaction.customId.split(":");
	const buttonGuildId = customIdParts[1];
	if (buttonGuildId && buttonGuildId !== guildId) {
		await interaction.reply({
			embeds: [errorEmbed("This button was issued for a different server.")],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	// Permission gate. The slash command that produced this button is
	// Administrator-only, but the button persists and could theoretically
	// be clicked by any user who can see the original ephemeral reply.
	// (Ephemerals are scoped to the original sender, so this is belt and
	// suspenders, but the cost is zero.)
	const member = interaction.member;
	if (!member || typeof member.permissions === "string" || !member.permissions.has(PermissionFlagsBits.Administrator)) {
		await interaction.reply({
			embeds: [errorEmbed("You need Administrator permission to remove the leaderboard channel.")],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const config = await guildConfigStore.findByGuildId(guildId);
	if (!config) {
		await interaction.reply({
			embeds: [errorEmbed("This server has not been set up yet. Run /setup first.")],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const channelId = config.leaderboardChannelId;
	if (!channelId) {
		// Already deleted (or never set). Idempotent reply, surface what
		// the admin probably wanted to hear rather than a confusing error.
		await interaction.reply({
			embeds: [
				infoEmbed(
					"Already removed",
					"The leaderboard channel is already gone from this server. To restore it later, run /server leaderboard tracking enabled:True with auto-heal enabled.",
					COLORS.SCHEDULE
				),
			],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	try {
		// CRITICAL ORDER: flag userRemovedChannels FIRST, then delete the
		// channel. Discord's channelDelete event fires synchronously when we
		// call channel.delete(), and ChannelDeleteWatcher reads GuildConfig
		// at that moment to decide whether to rebuild. If we delete first
		// and flag second, the watcher races us, it reads the pre-flag
		// state, sees autoHealEnabled is still true, and rebuilds the
		// channel before our flag write lands. Reordering closes the race.
		// Defense in depth: ChannelDeleteWatcher also checks the flag
		// independently so a future code path that forgets this ordering
		// still gets the right behavior.
		const removed = new Set<string>((config as unknown as { userRemovedChannels?: string[] }).userRemovedChannels ?? []);
		removed.add("leaderboardChannelId");
		await guildConfigStore.update(guildId, {
			userRemovedChannels: Array.from(removed),
		});

		// Now safe to delete the channel, when the channelDelete event
		// fires, the flag is already on disk and the watcher will honor it.
		// May be null if the admin already deleted it in Discord directly
		// between the slash command and the button click. Treat that as
		// "nothing to do" rather than an error.
		const channel = await interaction.guild?.channels.fetch(channelId).catch(() => null);
		if (channel) {
			await channel.delete("Removed via /server leaderboard tracking follow-up button");
		}

		// Clear the stored id after the delete settles. Splitting the write
		// from the flag update is harmless, repairMissingChannels checks
		// the flag before the storedId, so a state where flag-is-set and
		// storedId-is-stale still skips rebuild correctly.
		await guildConfigStore.update(guildId, {
			leaderboardChannelId: null,
		});

		// Audit notice in the admin channel. Other admins see "X removed
		// the leaderboard channel via /server leaderboard tracking" so
		// the action is traceable without broadcasting to every member.
		// Swallow send failures, the deletion itself succeeded and the
		// notice is observability, not the load-bearing path.
		try {
			const adminChannel = await interaction.guild?.channels.fetch(config.adminChannelId).catch(() => null);
			if (adminChannel && adminChannel instanceof TextChannel) {
				const actor = interaction.user.username || interaction.user.id;
				await adminChannel.send({
					embeds: [
						infoEmbed(
							"🗑️ Leaderboard channel removed",
							`**${actor}** removed the leaderboard channel via /server leaderboard tracking.\n\nTo restore it later, an admin can run /server leaderboard tracking enabled:True. Auto-heal will rebuild the channel on the next boot sweep as long as autoHealEnabled is on.`,
							COLORS.SCHEDULE
						),
					],
				});
			}
		} catch (noticeErr) {
			console.warn(`[leaderboard-channel-delete] admin audit notice failed for guild ${guildId}`, noticeErr);
		}

		await interaction.reply({
			embeds: [
				infoEmbed(
					"🗑️ Leaderboard channel removed",
					"The leaderboard channel has been deleted from this server and flagged so auto-heal will not rebuild it. To restore it later, run /server leaderboard tracking enabled:True, that re-enables tracking AND clears the removal flag, so the channel rebuilds on the next boot sweep (assuming autoHealEnabled is on).",
					COLORS.SCHEDULE
				),
			],
			flags: MessageFlags.Ephemeral,
		});
	} catch (err) {
		console.error("[leaderboard-channel-delete] failed", err);
		await interaction.reply({
			embeds: [errorEmbed("Could not remove the leaderboard channel. Check the bot's permissions or delete it manually in Discord.")],
			flags: MessageFlags.Ephemeral,
		});
	}
}

/**
 * Register the leaderboard channel button handlers. Call once at bot boot
 * from main.ts, alongside registerDecreeEditHandlers(). Idempotent at module
 * level, the registry throws on duplicate prefix registration, which
 * surfaces a bootstrap bug at startup rather than at first click.
 */
export function registerLeaderboardChannelHandlers(): void {
	registerButton(BUTTON_PREFIX, handleLeaderboardChannelDelete);
}
