import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits } from "discord.js";
import { GuildSetupManager } from "@features/setup/GuildSetupManager.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { getPluginCopy } from "@base/copy/getCopy.js";
import { LOG_MESSAGES } from "@base/constants/log-messages.js";
import { errorEmbed, infoEmbed } from "@utils/embedBuilder.js";
import { creatorId } from "@utils/config.js";
import { beginChannelAnswer } from "@utils/answerInChannel.js";
import { showNotice } from "@utils/textModal.js";

export const data = new SlashCommandBuilder()
	.setName("setup")
	.setDescription("Assign roles to configure the bot")
	.setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
	.addRoleOption((option) =>
		option.setName("admin-role").setDescription("The role that will have access to bot configuration").setRequired(true)
	)
	.addRoleOption((option) =>
		option
			.setName("member-role")
			.setDescription("The role assigned to verified Mortals, this role is pinged on every event reminder")
			.setRequired(true)
	);

export async function execute(interaction: ChatInputCommandInteraction) {
	// Load config first so every response below speaks in the guild's copy
	// pack. A null config (a guild that never finished setup) resolves to the
	// rok-commander default inside getPluginCopy, the documented fallback.
	const config = await guildConfigStore.findByGuildId(interaction.guildId!);
	const copy = getPluginCopy(config);
	const { responses } = copy;

	// ── owner / creator only ──────────────────────────────────
	const isOwner = interaction.user.id === interaction.guild?.ownerId;
	const isCreator = interaction.user.id === creatorId;

	if (!isOwner && !isCreator) {
		await showNotice(interaction, { title: getPluginCopy(null).notice.setup, sections: [responses.ownerOnly] });
		return;
	}

	// ── rebuild after self-destruct ──────────────────────────────────
	// The homebase was demolished via /self-destruct and flagged to stay gone.
	// /setup is the bring-back: rebuild the category + channels (autoSetup force),
	// clear the flag, then assign roles in the same run. Handled before the
	// normal categoryId/setupComplete checks because those assume a live homebase.
	if (config?.homebaseDestroyed) {
		const adminRole = interaction.options.getRole("admin-role", true);
		const memberRole = interaction.options.getRole("member-role", true);
		// A demolished homebase has no Headquarters channel left to name, so this answer
		// takes answerInChannel's private fallback (its stored ids point at deleted channels).
		const answer = await beginChannelAnswer(interaction, "admin", { config });
		try {
			await GuildSetupManager.autoSetup(
				interaction.guild!,
				{ guildId: interaction.guildId!, ownerId: interaction.guild!.ownerId },
				{ force: true }
			);

			// autoSetup swallows a missing-permissions failure (it catches 50013
			// and returns without building), so confirm the homebase actually came
			// back before clearing the flag. Otherwise the owner is stranded with
			// the flag cleared, a stale categoryId, and no channels, unable to
			// rebuild via /setup. Re-read the fresh config and verify the category.
			const rebuilt = await guildConfigStore.findByGuildId(interaction.guildId!);
			const category = rebuilt?.categoryId
				? await interaction.guild!.channels.fetch(rebuilt.categoryId).catch(() => null)
				: null;
			if (!category) {
				// Leave homebaseDestroyed=true so a retry re-enters this branch.
				await answer.send({ embeds: [errorEmbed(responses.setupFailed)] });
				return;
			}

			await GuildSetupManager.applyAdminRole(interaction.guild!, {
				guildId: interaction.guildId!,
				ownerId: interaction.guild!.ownerId,
				adminRoleId: adminRole.id,
				memberRoleId: memberRole.id,
			});

			// Clear the flag LAST, only after a verified rebuild AND roles applied,
			// so any failure above leaves the guild destroyed and the next /setup
			// retries the full rebuild rather than dead-ending.
			await guildConfigStore.update(interaction.guildId!, { homebaseDestroyed: false });

			await answer.send({
				embeds: [
					infoEmbed(
						responses.setupSuccess(adminRole.id).title,
						responses.setupSuccess(adminRole.id).description,
						copy.COLORS.ARRIVAL
					),
				],
			});
		} catch (error) {
			console.error(LOG_MESSAGES.setup.commandFailed, error);
			await answer.send({ embeds: [errorEmbed(responses.setupFailed)] });
		}
		return;
	}

	// channels haven't been built yet
	if (!config?.categoryId) {
		await showNotice(interaction, { title: getPluginCopy(null).notice.setup, sections: [responses.setupChannelsPending] });
		return;
	}

	// already fully set up
	if (config.setupComplete) {
		await showNotice(interaction, { title: getPluginCopy(null).notice.setup, sections: [responses.alreadySetup] });
		return;
	}

	const adminRole = interaction.options.getRole("admin-role", true);
	const memberRole = interaction.options.getRole("member-role", true);

	// The result posts in 🎛️admin-controls (2026-10 item 257 Phase 5), pinging the admin
	// who ran setup; the command itself is acknowledged quietly (2026-10 item 263 R3-10).
	const answer = await beginChannelAnswer(interaction, "admin", { config });

	try {
		await GuildSetupManager.applyAdminRole(interaction.guild!, {
			guildId: interaction.guildId!,
			ownerId: interaction.guild!.ownerId,
			adminRoleId: adminRole.id,
			memberRoleId: memberRole.id,
		});

		await answer.send({
			embeds: [
				infoEmbed(
					responses.setupSuccess(adminRole.id).title,
					responses.setupSuccess(adminRole.id).description,
					copy.COLORS.ARRIVAL
				),
			],
		});
	} catch (error) {
		console.error(LOG_MESSAGES.setup.commandFailed, error);
		await answer.send({ embeds: [errorEmbed(responses.setupFailed)] });
	}
}
