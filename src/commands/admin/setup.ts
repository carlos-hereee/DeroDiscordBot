import { SlashCommandBuilder, PermissionFlagsBits, type ChatInputCommandInteraction, type RepliableInteraction } from "discord.js";
import { GuildSetupManager, isHeadquartersOnly } from "@features/setup/GuildSetupManager.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { getPluginCopy } from "@base/copy/getCopy.js";
import { LOG_MESSAGES } from "@base/constants/log-messages.js";
import { errorEmbed, infoEmbed } from "@utils/embedBuilder.js";
import { creatorId } from "@utils/config.js";
import { beginChannelAnswer } from "@utils/answerInChannel.js";
import { showNotice } from "@utils/textModal.js";
import type { CommandOptionReader } from "@handlers/commandOptions.js";

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

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
	await run(interaction, interaction.options);
}

/**
 * The one setup handler. The /setup slash command and 🔒inner-sanctum's Set up Dero
 * button both reach it: the button through the admin command launcher, whose form is
 * built from this command's own two role options (2026-11 item 285 debug pass), so the
 * button can never ask for a role the command lacks or run a second setup path.
 */
export async function run(interaction: RepliableInteraction, options: CommandOptionReader): Promise<void> {
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
		const adminRole = options.getRole("admin-role", true);
		const memberRole = options.getRole("member-role", true);
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
			// A self destructed server rebuilds 🏰 DERO HEADQUARTERS alone (2026-11 item 285
			// debug pass), storing no notice board, so the category proved is the notice
			// board's when there is one and Headquarters' otherwise. Checking only categoryId
			// failed every such rebuild and left the roles unset.
			const rebuilt = await guildConfigStore.findByGuildId(interaction.guildId!);
			const rebuiltCategoryId = rebuilt?.categoryId ?? (rebuilt as { headquartersCategoryId?: string | null } | null)?.headquartersCategoryId ?? null;
			const category = rebuiltCategoryId ? await interaction.guild!.channels.fetch(rebuiltCategoryId).catch(() => null) : null;
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

	// channels haven't been built yet. A fresh install builds only 🏰 DERO HEADQUARTERS
	// (2026-11 item 285 Phase 2), so a Headquarters only row is built and goes on to the
	// role grant; reading categoryId alone would refuse it forever.
	if (!config || (!config.categoryId && !isHeadquartersOnly(config))) {
		await showNotice(interaction, { title: getPluginCopy(null).notice.setup, sections: [responses.setupChannelsPending] });
		return;
	}

	// already fully set up
	if (config.setupComplete) {
		await showNotice(interaction, { title: getPluginCopy(null).notice.setup, sections: [responses.alreadySetup] });
		return;
	}

	const adminRole = options.getRole("admin-role", true);
	const memberRole = options.getRole("member-role", true);

	// The result posts in 🛠️server-config (2026-10 item 257 Phase 5), pinging the admin
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
