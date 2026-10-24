import {
	SlashCommandBuilder,
	MessageFlags,
	PermissionFlagsBits,
	type ChatInputCommandInteraction,
	type RepliableInteraction,
	type EmbedBuilder,
	type Guild,
	type GuildMember,
	type VoiceBasedChannel,
} from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { BOT_LOG_EVENTS } from "@base/constants/BOT_LOG_EVENTS.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { deroVoiceConfigStore } from "@db/stores/deroVoiceConfigStore.js";
import type { IDeroVoiceConfig } from "@db/models/DeroVoiceConfig.js";
import { resolveDeroVoiceId } from "@features/voice/deroVoiceId.js";
import { CooldownManager } from "@utils/cooldownManager.js";
import { errorEmbed, infoEmbed } from "@utils/embedBuilder.js";
import { brainQueue } from "@features/dero-brain/brainQueue.js";
import { describeBrainTurn, runBrainTurn, type UnansweredReason } from "@features/dero-brain/brainTurn.js";
import { isAuthorizedSpeaker } from "@features/dero-brain/authorizer.js";
import { readSpeakerAdminRoleId } from "@features/dero-brain/speakerAdminRole.js";
import type { ActionReport } from "@features/dero-brain/executor.js";
import { rulesCardFor } from "@features/dero-brain/holdemRulesCard.js";
import { deroBrainCopy } from "@features/dero-brain/deroBrainCopy.js";
import { voiceSessions } from "@features/voice/voiceSessions.js";
import { announceJoin, type GreetingOutcome } from "@features/voice/joinNotice.js";
import { voiceCopy } from "@features/voice/voiceCopy.js";
import { turnLatencyLog } from "@features/voice/turnLatency.js";
import { liveVoicePresenceState, renderVoicePresenceCard } from "@features/voice/voicePresenceRenderer.js";
import { isRenderPayload, withRenderFallback } from "@features/renderer/index.js";

// ── /dero ─────────────────────────────────────────────────────────────────
// What:  the text path to Dero's brain and Dero's way into a voice call. `tell`
//        hands an authorized member's task to the launcher's local Dero and
//        carries out the typed actions it answers with; `status` says whether
//        the brain is online and where Dero is in a call; `join` and `leave`
//        bring Dero into the caller's voice channel and send it out again.
// Who:   any member may run it. Only the guild owner and members holding an
//        allowlisted role get a job made, or move Dero in or out of a call (the
//        authorizer); everyone else is refused before anything happens.
// When:  on demand. A member may start one task every 10 seconds, counted only
//        from a task the brain answered "ok"; a guild may attempt one join
//        every 10 seconds.
// Where: reads DeroVoiceConfig (the kill switch, the role, channel and voice
//        channel allowlists), enqueues on brainQueue, executes through the
//        executor, and joins through voiceSessions (one call per guild).
// How (tell): ① guild only; ② config exists and is enabled; ③ speaker
//        authorized; ④ brain online; ⑤ cooldown; ⑥ the task's own bounds;
//        ⑦ defer, private; ⑧ runBrainTurn, the step the voice turn loop shares
//        (build and enqueue the job, wait, execute an "ok" answer); ⑨ answer
//        busy, timeout or not understood plainly, or list what happened;
//        ⑩ audit, fire and forget.
// How (join): the gates in joinRefusal, in order; then the per guild
//        cooldown; defer; join and wait for Ready; post the join notice and
//        speak the greeting; one private line saying how it went.
//
// ⚠️ PRIVACY: the task text goes to the brain and nowhere else. It is never
// logged, stored, or put in an error; the audit row carries its length. In a
// call Dero hears only members on the task list (voiceListener), and the join
// notice says so every time.

const tellCopy = deroBrainCopy.tell;
const callCopy = voiceCopy.call;
const MS_PER_SECOND = 1000;
const LATENCY_DECIMALS = 1;

const toSeconds = (ms: number): string => (ms / MS_PER_SECOND).toFixed(LATENCY_DECIMALS);

// What the bot needs in a voice channel to be any use there.
const BOT_VOICE_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak];

const tellCooldown = new CooldownManager(BOT_CONSTANTS.DERO_BRAIN_TELL_COOLDOWN_MS);
const joinCooldown = new CooldownManager(BOT_CONSTANTS.DERO_VOICE_JOIN_COOLDOWN_MS);

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
	.addSubcommand((sub) => sub.setName("status").setDescription(deroBrainCopy.command.status))
	.addSubcommand((sub) => sub.setName("join").setDescription(deroBrainCopy.command.join))
	.addSubcommand((sub) => sub.setName("leave").setDescription(deroBrainCopy.command.leave));

// ── replies ──

async function refuse(interaction: RepliableInteraction, line: string): Promise<void> {
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

// What the member is told when the brain did not answer "ok". The voice turn
// speaks its own lines for the same reasons (voiceCopy.turn).
const UNANSWERED_LINES: Record<UnansweredReason, string> = {
	offline: tellCopy.brainOffline,
	busy: tellCopy.busy,
	timeout: tellCopy.timeout,
	notUnderstood: tellCopy.notUnderstood,
};

function reportLines(reports: ActionReport[]): string[] {
	return reports.length > 0 ? reports.map((entry) => entry.line) : [tellCopy.nothingToDo];
}

// A table request turns the private reply into its rules card: the card's
// buttons are how the member answers it, so it replaces the deferred reply, and
// any other action's line rides below it.
async function answerPayload(guild: Guild, reports: ActionReport[]) {
	const tableReport = reports.find((entry) => entry.holdemRequestId);
	const card = tableReport?.holdemRequestId ? await rulesCardFor(guild, tableReport.holdemRequestId) : null;
	if (!card) return { embeds: [taskEmbed(reportLines(reports))] };
	const others = reports.filter((entry) => entry !== tableReport);
	return { embeds: others.length > 0 ? [...card.embeds, taskEmbed(reportLines(others))] : card.embeds, components: card.components };
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
	const adminRoleId = await readSpeakerAdminRoleId(guild.id);
	if (!isAuthorizedSpeaker({ member: speaker, guildOwnerId: guild.ownerId, adminRoleId, voiceConfig: config })) {
		await refuse(interaction, tellCopy.notAuthorized);
		return;
	}

	// ④ The one refusal after the authorizer that gets an audit row: an offline
	// brain is the failure the owner most needs to count (R9), and it is the same
	// "offline" outcome a voice turn records, so the two paths read alike.
	if (!brainQueue.isBrainOnline()) {
		await refuse(interaction, tellCopy.brainOffline);
		auditAction(guild.id, { jobId: null, channels: 0, outcome: "offline", speakerId: speaker.id, source: "text" });
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
		// ⑧ the shared brain turn: job, wait, and on "ok" the executor runs
		// against a fresh config read (the kill switch may have flipped meanwhile)
		const turn = await runBrainTurn({ guild, speaker, text: task, source: "text", voiceConfig: config });
		const audit = { ...describeBrainTurn(turn), speakerId: speaker.id, source: "text", taskChars: task.length };

		// ⑨
		if (turn.status === "unanswered") {
			await interaction.editReply({ embeds: [errorEmbed(UNANSWERED_LINES[turn.reason])] });
			auditAction(guild.id, { ...audit, durationMs: Date.now() - startedAt });
			return;
		}
		tellCooldown.record(cooldownKey);
		await interaction.editReply(await answerPayload(guild, turn.reports));

		// ⑩
		auditAction(guild.id, { ...audit, durationMs: Date.now() - startedAt });
	}
	catch (err) {
		console.error(`[dero-brain] tell failed guild=${guild.id} user=${speaker.id}`, err);
		await interaction.editReply({ embeds: [errorEmbed(tellCopy.failed)] }).catch(() => undefined);
	}
}

// ── /dero status ──

/**
 * /dero status, shared with the Status button on the two voice rooms' intros
 * (2026-10 item 245 Phase 4b). Any member may ask; the task list lines show only
 * to a member on it.
 */
export async function showDeroStatus(interaction: RepliableInteraction): Promise<void> {
	const lines = [brainQueue.isBrainOnline() ? deroBrainCopy.status.online : deroBrainCopy.status.offline];

	// Shown to every member: anyone in the server can already see Dero sitting
	// in a voice channel, so where it is reveals nothing new.
	const call = interaction.guildId ? voiceSessions.get(interaction.guildId) : null;
	const callChannelId = call?.channelId;
	lines.push(callChannelId ? callCopy.statusInCall(callChannelId) : callCopy.notInCall);

	// Whether YOU may give tasks is shown only to members who may: a refused
	// member learns that from /dero tell, and the list itself is never shown.
	if (interaction.inCachedGuild()) {
		const config = await deroVoiceConfigStore.findByGuildId(interaction.guild.id);
		const authorized =
			config !== null &&
			isAuthorizedSpeaker({
				member: interaction.member,
				guildOwnerId: interaction.guild.ownerId,
				adminRoleId: await readSpeakerAdminRoleId(interaction.guild.id),
				voiceConfig: config,
			});
		if (authorized) {
			lines.push(config.enabled ? deroBrainCopy.status.canTell : deroBrainCopy.status.switchedOffForYou);
			// How fast Dero answers by voice here lately, for the people who talk
			// to it. The owner reads these numbers at Gate B.
			const latency = turnLatencyLog.summary(interaction.guild.id);
			if (latency) lines.push(callCopy.statusLatency(toSeconds(latency.medianMs), toSeconds(latency.slowestMs), latency.count));
		}
	}

	const embed = infoEmbed(deroBrainCopy.status.title, lines.join("\n"));
	// A live call also gets its presence card, LISTENING or SPEAKING as the speaker
	// is right now; the embed alone when Dero is not in a call or the card does not
	// draw. The card reads only the speaker's playing flag, never what is said.
	const card = call
		? await withRenderFallback(
				() =>
					renderVoicePresenceCard({
						state: liveVoicePresenceState(call.speaker.status),
						channelName: interaction.guild?.channels.cache.get(call.channelId)?.name ?? "",
					}),
				() => null
			)
		: null;
	if (isRenderPayload(card)) {
		embed.setImage(card.ref);
		await interaction.reply({ embeds: [embed], files: [card.attachment], flags: MessageFlags.Ephemeral });
		return;
	}
	await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// ── /dero join ──

export type JoinGate = { ok: true; channel: VoiceBasedChannel; voiceId: string } | { ok: false; line: string };

export interface JoinGateInput {
	speaker: GuildMember;
	guildOwnerId: string;
	// GuildConfig.adminRoleId, which authorizes by itself (post-launch plan item 12).
	adminRoleId: string | null;
	botMember: GuildMember | null;
	config: IDeroVoiceConfig | null;
	/** The voice channel Dero is already in for this guild, if any. */
	sessionChannelId: string | null;
}

const refuseJoin = (line: string): JoinGate => ({ ok: false, line });

/**
 * The /dero join gates, in order, with nothing joined and nothing spent: the
 * kill switch, an authorized speaker, the speaker in
 * a voice channel, Dero not already in a call here, the channel on the voice
 * allowlist, and the bot able to see, connect and speak there. Every refusal
 * reuses the line that already says it, from the tell gates or the Listen copy.
 */
export function checkJoin({ speaker, guildOwnerId, adminRoleId, botMember, config, sessionChannelId }: JoinGateInput): JoinGate {
	if (!config) return refuseJoin(voiceCopy.listen.notSetUp);
	if (!config.enabled) return refuseJoin(tellCopy.switchedOff);
	if (!isAuthorizedSpeaker({ member: speaker, guildOwnerId, adminRoleId, voiceConfig: config })) return refuseJoin(tellCopy.notAuthorized);

	// The speaker's own channel is the target, so "the speaker is in it" holds
	// by construction and there is no channel option to spoof.
	const channel = speaker.voice.channel;
	if (!channel) return refuseJoin(callCopy.notInVoice);
	// One call per guild: name where Dero already is rather than move it.
	if (sessionChannelId) {
		return refuseJoin(sessionChannelId === channel.id ? callCopy.alreadyHere(sessionChannelId) : callCopy.alreadyElsewhere(sessionChannelId));
	}
	if (!config.allowedVoiceChannelIds.includes(channel.id)) return refuseJoin(callCopy.channelNotAllowed);
	if (!botMember || !channel.permissionsFor(botMember)?.has(BOT_VOICE_PERMISSIONS)) return refuseJoin(callCopy.botLacksPermission);
	return { ok: true, channel, voiceId: resolveDeroVoiceId(config) };
}

/**
 * /dero join, shared with the Join button on the two voice rooms' intros. Every
 * gate is checkJoin's, so the button admits exactly who the command admits: a
 * member on the task list, standing in an allowed voice channel.
 */
export async function bringDeroIntoCall(interaction: RepliableInteraction): Promise<void> {
	if (!interaction.inCachedGuild()) {
		await refuse(interaction, tellCopy.notInGuild);
		return;
	}
	const guild = interaction.guild;
	const config = await deroVoiceConfigStore.findByGuildId(guild.id);
	const gate = checkJoin({
		speaker: interaction.member,
		guildOwnerId: guild.ownerId,
		adminRoleId: await readSpeakerAdminRoleId(guild.id),
		botMember: guild.members.me,
		config,
		sessionChannelId: voiceSessions.get(guild.id)?.channelId ?? null,
	});
	if (!gate.ok) {
		await refuse(interaction, gate.line);
		return;
	}

	// Checked only after the gates, so a refused join never burns the window, and
	// recorded on the ATTEMPT, because a join that never reaches Ready still cost
	// gateway voice traffic.
	const cooldown = joinCooldown.check(guild.id);
	if (cooldown.onCooldown) {
		await refuse(interaction, callCopy.joinCooldown(Math.ceil(cooldown.remainingMs / MS_PER_SECOND)));
		return;
	}
	joinCooldown.record(guild.id);

	// Ready can take up to 20 seconds, far past Discord's 3 second window.
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });
	const voiceChannelId = gate.channel.id;
	// The channel the request came from carries the join notice. A slash command
	// and a button always have one; only an interaction with no channel at all falls
	// back to the call's own voice chat, which is where the voice room's Join sits.
	const controlChannelId = interaction.channelId ?? voiceChannelId;
	try {
		const outcome = await voiceSessions.join({ guild, channel: gate.channel, controlChannelId });
		if (outcome.status === "alreadyInGuild") {
			// Another join won the race between the gate and here.
			await interaction.editReply({ embeds: [errorEmbed(callCopy.alreadyElsewhere(outcome.channelId))] });
			return;
		}
		if (outcome.status === "failed") {
			await interaction.editReply({ embeds: [errorEmbed(callCopy.connectFailed(voiceChannelId))] });
			return;
		}

		const greeting: GreetingOutcome = await announceJoin({
			guild,
			controlChannelId,
			voiceChannelId,
			voiceId: gate.voiceId,
			speaker: outcome.session.speaker,
		});
		await interaction.editReply({ embeds: [infoEmbed(callCopy.replyTitle, callCopy.joined[greeting](voiceChannelId))] });
	}
	catch (err) {
		console.error(`[dero-voice] join command failed guild=${guild.id} channel=${voiceChannelId}`, err);
		await interaction.editReply({ embeds: [errorEmbed(tellCopy.failed)] }).catch(() => undefined);
	}
}

// ── /dero leave ──

/**
 * /dero leave, shared with the Leave button on the two voice rooms' intros: the
 * owner or a member on the task list sends Dero out of its call.
 */
export async function sendDeroAwayFromCall(interaction: RepliableInteraction): Promise<void> {
	if (!interaction.inCachedGuild()) {
		await refuse(interaction, tellCopy.notInGuild);
		return;
	}
	const guild = interaction.guild;
	const config = await deroVoiceConfigStore.findByGuildId(guild.id);
	if (!config) {
		await refuse(interaction, voiceCopy.listen.notSetUp);
		return;
	}
	// The kill switch is NOT a gate here: sending Dero away is always safe, and a
	// switched off guild is exactly where an authorized member may want it gone.
	if (!isAuthorizedSpeaker({ member: interaction.member, guildOwnerId: guild.ownerId, adminRoleId: await readSpeakerAdminRoleId(guild.id), voiceConfig: config })) {
		await refuse(interaction, tellCopy.notAuthorized);
		return;
	}
	const session = voiceSessions.get(guild.id);
	if (!session) {
		await refuse(interaction, callCopy.notInCall);
		return;
	}

	voiceSessions.leave(guild.id);
	await interaction.reply({ embeds: [infoEmbed(callCopy.replyTitle, callCopy.left(session.channelId))], flags: MessageFlags.Ephemeral });
}

async function runSubcommand(interaction: ChatInputCommandInteraction): Promise<void> {
	switch (interaction.options.getSubcommand(true)) {
		case "tell":
			return tell(interaction);
		case "join":
			return bringDeroIntoCall(interaction);
		case "leave":
			return sendDeroAwayFromCall(interaction);
		default:
			return showDeroStatus(interaction);
	}
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
	try {
		await runSubcommand(interaction);
	}
	catch (err) {
		// Only reached before a deferral (tell and join catch their own after
		// one), so a plain reply is still possible unless Discord already got one.
		console.error(`[dero] command failed guild=${interaction.guildId ?? "none"}`, err);
		if (!interaction.replied && !interaction.deferred) {
			await refuse(interaction, tellCopy.failed).catch(() => undefined);
		}
	}
}
