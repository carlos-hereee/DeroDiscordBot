import { SlashCommandBuilder, MessageFlags, type ChatInputCommandInteraction, type EmbedBuilder } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { BOT_LOG_EVENTS } from "@base/constants/BOT_LOG_EVENTS.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { deroVoiceConfigStore } from "@db/stores/deroVoiceConfigStore.js";
import { CooldownManager } from "@utils/cooldownManager.js";
import { errorEmbed, infoEmbed } from "@utils/embedBuilder.js";
import { brainQueue } from "@features/dero-brain/brainQueue.js";
import { buildJobInput } from "@features/dero-brain/brainJob.js";
import { isAuthorizedSpeaker } from "@features/dero-brain/authorizer.js";
import { executeActions, type ActionReport } from "@features/dero-brain/executor.js";
import { deroBrainCopy } from "@features/dero-brain/deroBrainCopy.js";
import type { BrainOutcome } from "@features/dero-brain/brainTypes.js";

// ── /dero ─────────────────────────────────────────────────────────────────
// What:  the text path to Dero's brain. `tell` hands an authorized member's task
//        to the launcher's local Dero and carries out the typed actions it
//        answers with; `status` says whether the brain is online.
// Who:   any member may run it. Only the guild owner and members holding an
//        allowlisted role get a job made (the authorizer); everyone else is
//        refused before the brain hears anything.
// When:  on demand. A member may start one task every 10 seconds, counted only
//        from a task the brain answered "ok".
// Where: reads DeroVoiceConfig (the kill switch, the role and channel
//        allowlists), enqueues on brainQueue, and executes through the
//        executor, which re-checks everything against the live guild.
// How (tell): ① guild only; ② config exists and is enabled; ③ speaker
//        authorized; ④ brain online; ⑤ cooldown; ⑥ the task's own bounds;
//        ⑦ defer, private; ⑧ build and enqueue the job, wait for its outcome;
//        ⑨ answer busy, timeout or not understood plainly, or execute and list
//        what happened; ⑩ audit, fire and forget.
//
// ⚠️ PRIVACY: the task text goes to the brain and nowhere else. It is never
// logged, stored, or put in an error; the audit row carries its length.

const tellCopy = deroBrainCopy.tell;
const MS_PER_SECOND = 1000;

const tellCooldown = new CooldownManager(BOT_CONSTANTS.DERO_BRAIN_TELL_COOLDOWN_MS);

export const data = new SlashCommandBuilder()
	.setName("dero")
	.setDescription(deroBrainCopy.command.description)
	.addSubcommand((sub) =>
		sub
			.setName("tell")
			.setDescription(deroBrainCopy.command.tell)
			.addStringOption((option) =>
				option
					.setName("task")
					.setDescription(deroBrainCopy.command.taskOption)
					.setRequired(true)
					.setMinLength(1)
					.setMaxLength(BOT_CONSTANTS.DERO_BRAIN_MAX_TASK_CHARS),
			),
	)
	.addSubcommand((sub) => sub.setName("status").setDescription(deroBrainCopy.command.status));

// ── replies ──

async function refuse(interaction: ChatInputCommandInteraction, line: string): Promise<void> {
	await interaction.reply({ embeds: [errorEmbed(line)], flags: MessageFlags.Ephemeral });
}

function taskEmbed(lines: string[]): EmbedBuilder {
	return infoEmbed(tellCopy.replyTitle, lines.join("\n"));
}

// Fire and forget (house rule 7): the member already has their answer.
function auditAction(guildId: string, metadata: Record<string, unknown>): void {
	botLogStore.log(guildId, BOT_LOG_EVENTS.DERO_BRAIN_ACTION, metadata).catch((err) => {
		console.error(`[dero-brain] audit write failed guild=${guildId}`, err);
	});
}

// What the member is told when the brain did not answer "ok", and the outcome
// code the audit row records for it. Called only for outcomes that are not an
// "ok" result, so the last line is the brain's own "error".
function unansweredReply(outcome: BrainOutcome): { line: string; code: string } {
	if (outcome.kind === "timeout") return { line: tellCopy.timeout, code: "timeout" };
	if (outcome.kind === "rejected") return { line: tellCopy.notUnderstood, code: `rejected:${outcome.reason}` };
	if (outcome.result.status === "busy") return { line: tellCopy.busy, code: "busy" };
	return { line: tellCopy.notUnderstood, code: "error" };
}

function reportLines(reports: ActionReport[]): string[] {
	return reports.length > 0 ? reports.map((entry) => entry.line) : [tellCopy.nothingToDo];
}

// ── /dero tell ──

async function tell(interaction: ChatInputCommandInteraction): Promise<void> {
	// ① A cached guild gives a real GuildMember, which the authorizer and the
	// channel gate both need; a DM or an uncached guild has neither.
	if (!interaction.inCachedGuild()) {
		await refuse(interaction, tellCopy.notInGuild);
		return;
	}
	const guild = interaction.guild;
	const speaker = interaction.member;

	// ②
	const config = await deroVoiceConfigStore.findByGuildId(guild.id);
	if (!config) {
		await refuse(interaction, tellCopy.notSetUp);
		return;
	}
	if (!config.enabled) {
		await refuse(interaction, tellCopy.switchedOff);
		return;
	}

	// ③ before anything reaches the brain, so a refused member costs no job
	if (!isAuthorizedSpeaker({ member: speaker, guildOwnerId: guild.ownerId, voiceConfig: config })) {
		await refuse(interaction, tellCopy.notAuthorized);
		return;
	}

	// ④
	if (!brainQueue.isBrainOnline()) {
		await refuse(interaction, tellCopy.brainOffline);
		return;
	}

	// ⑤ checked here, recorded only after an "ok" answer
	const cooldownKey = `${guild.id}:${speaker.id}`;
	const gate = tellCooldown.check(cooldownKey);
	if (gate.onCooldown) {
		await refuse(interaction, tellCopy.cooldown(Math.ceil(gate.remainingMs / MS_PER_SECOND)));
		return;
	}

	// ⑥ Discord enforces the option bounds in its client; this is the gate
	const task = interaction.options.getString("task", true).trim();
	if (task.length === 0) {
		await refuse(interaction, tellCopy.emptyTask);
		return;
	}
	if (task.length > BOT_CONSTANTS.DERO_BRAIN_MAX_TASK_CHARS) {
		await refuse(interaction, tellCopy.taskTooLong(BOT_CONSTANTS.DERO_BRAIN_MAX_TASK_CHARS));
		return;
	}

	// ⑦ the brain can take up to 20 seconds, far past Discord's 3 second window
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });
	const startedAt = Date.now();

	try {
		// ⑧
		const job = buildJobInput({ guild, speaker, text: task, voiceConfig: config, source: "text" });
		const { jobId, outcome: pendingOutcome } = brainQueue.enqueue(job);
		const outcome = await pendingOutcome;
		const audit = { jobId, speakerId: speaker.id, source: "text", taskChars: task.length, channels: job.channels.length };

		// ⑨
		if (outcome.kind !== "result" || outcome.result.status !== "ok") {
			const unanswered = unansweredReply(outcome);
			await interaction.editReply({ embeds: [errorEmbed(unanswered.line)] });
			auditAction(guild.id, { ...audit, outcome: unanswered.code, durationMs: Date.now() - startedAt });
			return;
		}

		// The kill switch and the allowlists may have changed while the brain
		// thought, so the executor gets a fresh read, not the one from step ②.
		const freshConfig = await deroVoiceConfigStore.findByGuildId(guild.id);
		const reports = await executeActions({ guild, speakerId: speaker.id, actions: outcome.result.actions, voiceConfig: freshConfig });
		tellCooldown.record(cooldownKey);
		await interaction.editReply({ embeds: [taskEmbed(reportLines(reports))] });

		// ⑩
		auditAction(guild.id, {
			...audit,
			outcome: "ok",
			actions: reports.map((entry) => `${entry.type}:${entry.outcome}`),
			durationMs: Date.now() - startedAt,
		});
	}
	catch (err) {
		console.error(`[dero-brain] tell failed guild=${guild.id} user=${speaker.id}`, err);
		await interaction.editReply({ embeds: [errorEmbed(tellCopy.failed)] }).catch(() => undefined);
	}
}

// ── /dero status ──

async function status(interaction: ChatInputCommandInteraction): Promise<void> {
	const lines = [brainQueue.isBrainOnline() ? deroBrainCopy.status.online : deroBrainCopy.status.offline];

	// Whether YOU may give tasks is shown only to members who may: a refused
	// member learns that from /dero tell, and the list itself is never shown.
	if (interaction.inCachedGuild()) {
		const config = await deroVoiceConfigStore.findByGuildId(interaction.guild.id);
		const authorized =
			config !== null &&
			isAuthorizedSpeaker({ member: interaction.member, guildOwnerId: interaction.guild.ownerId, voiceConfig: config });
		if (authorized) lines.push(config.enabled ? deroBrainCopy.status.canTell : deroBrainCopy.status.switchedOffForYou);
	}

	await interaction.reply({ embeds: [infoEmbed(deroBrainCopy.status.title, lines.join("\n"))], flags: MessageFlags.Ephemeral });
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
	try {
		if (interaction.options.getSubcommand(true) === "tell") await tell(interaction);
		else await status(interaction);
	}
	catch (err) {
		// Only reached before a deferral (tell catches its own after one), so a
		// plain reply is still possible unless Discord already got one.
		console.error(`[dero] command failed guild=${interaction.guildId ?? "none"}`, err);
		if (!interaction.replied && !interaction.deferred) {
			await refuse(interaction, tellCopy.failed).catch(() => undefined);
		}
	}
}
