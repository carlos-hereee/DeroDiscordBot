import {
	SlashCommandBuilder,
	ChatInputCommandInteraction,
	PermissionFlagsBits,
	MessageFlags,
} from "discord.js";
import { eventStore } from "@db/stores/eventStore.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { errorEmbed, infoEmbed } from "@utils/embedBuilder.js";
import { refreshSchedule } from "@features/schedule/ScheduleBoard.js";
import { LOG_MESSAGES } from "@base/constants/log-messages.js";

// /pause-all-schedules, bulk equivalent of /pause-schedule. Pauses every
// non-paused event in the guild in one shot. Already-paused events are
// skipped on purpose so any pausedUntil the streamer set individually
// earlier (e.g. /pause-schedule X days:14) stays intact and is not
// overwritten by a guild-wide days argument.

const c = rokCommanderCopy.pauseAllSchedules;

export const data = new SlashCommandBuilder()
	.setName("pause-all-schedules")
	.setDescription("Pause every recurring schedule on this server at once")
	.setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
	.addIntegerOption((option) =>
		option
			.setName("days")
			.setDescription("Auto-resume after N days. Omit to pause indefinitely (then run /continue-all-schedules to resume).")
			.setRequired(false)
			.setMinValue(1)
			.setMaxValue(90)
	);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
	const guildId = interaction.guildId;
	if (!guildId) {
		await interaction.reply({ embeds: [errorEmbed("Run this in a server, not a DM.")], flags: MessageFlags.Ephemeral });
		return;
	}

	const days = interaction.options.getInteger("days", false);

	const events = await eventStore.findByGuildId(guildId);
	if (events.length === 0) {
		await interaction.reply({ embeds: [errorEmbed(c.noEvents)], flags: MessageFlags.Ephemeral });
		return;
	}

	// Partition before the writes so the success message can report skipped
	// counts honestly. Already-paused events get skipped to preserve any
	// per-event pausedUntil the streamer set earlier with /pause-schedule.
	const toPause = events.filter((e) => !e.paused);
	const alreadyPaused = events.length - toPause.length;

	if (toPause.length === 0) {
		await interaction.reply({ embeds: [errorEmbed(c.allAlreadyPaused(events.length))], flags: MessageFlags.Ephemeral });
		return;
	}

	// Compute pausedUntil once and reuse across all writes. Anchoring every
	// event to the same "now" keeps the resume cohort tidy: when the auto-
	// resume tick comes around they all flip back together.
	let pausedUntil: Date | null = null;
	if (days !== null) {
		pausedUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
	}

	// Per-event try/catch so a single failed write does not abort the batch.
	// Partial-failure path surfaces the count split rather than pretending
	// success.
	let succeeded = 0;
	let failed = 0;
	for (const event of toPause) {
		try {
			await eventStore.updateInGuild(event.eventId, guildId, { paused: true, pausedUntil });
			succeeded++;
		} catch (err) {
			failed++;
			console.error("[pause-all-schedules] update failed", { eventId: event.eventId }, err);
		}
	}

	// Fire-and-forget board refresh so paused tags render right away.
	refreshSchedule(interaction.client, guildId).catch((err) =>
		console.error(LOG_MESSAGES.schedule.refreshAfterRouteFailed("/pause-all-schedules"), err)
	);

	if (failed > 0 && succeeded === 0) {
		await interaction.reply({ embeds: [errorEmbed(c.failed)], flags: MessageFlags.Ephemeral });
		return;
	}

	if (failed > 0) {
		await interaction.reply({
			embeds: [infoEmbed("⏸️ Partially paused", c.partialFailure(succeeded, failed), rokCommanderCopy.COLORS.SCHEDULE)],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const successText = pausedUntil
		? c.pausedUntil(succeeded, alreadyPaused, Math.floor(pausedUntil.getTime() / 1000))
		: c.paused(succeeded, alreadyPaused);

	await interaction.reply({
		embeds: [infoEmbed("⏸️ All schedules paused", successText, rokCommanderCopy.COLORS.SCHEDULE)],
		flags: MessageFlags.Ephemeral,
	});
}
