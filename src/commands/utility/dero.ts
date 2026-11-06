import {
	SlashCommandBuilder,
	PermissionFlagsBits,
	MessageFlags,
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
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { hasConfirmedAge } from "@features/age-gate/ageGateRules.js";
import { memberIdsOnly } from "@features/game-rooms/botSeat.js";
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
import { voiceQueue, type GameVoiceSkipReason, type QueuedJoinOutcome, type VoiceQueueRequest } from "@features/voice/voiceQueue.js";
import { categoryForChannel, normalizePriorityOrder } from "@features/voice/voicePriority.js";
import { announceJoin, postVoiceNotice, type GreetingOutcome } from "@features/voice/joinNotice.js";
import { voiceCopy } from "@features/voice/voiceCopy.js";
import { turnLatencyLog } from "@features/voice/turnLatency.js";
import { liveVoicePresenceState, renderVoicePresenceCard } from "@features/voice/voicePresenceRenderer.js";
import { isRenderPayload, withRenderFallback } from "@features/renderer/index.js";
import { answerInChannel, beginChannelAnswer } from "@utils/answerInChannel.js";
import { showCooldownNotice, showErrorNotice, showNotice, showPendingNotice } from "@utils/textModal.js";
import { getPluginCopy } from "@base/copy/getCopy.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { pendingPairingStore, PAIRING_CODE_TTL_MS } from "@db/stores/pendingPairingStore.js";
import { isServerCovered } from "@features/entitlements/serverPlanAccess.js";
import { serverPlanCommandCopy, serverPlanLine } from "@features/entitlements/serverPlanCopy.js";

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
// How (join): the gates in checkJoin, in order; then the per guild
//        cooldown; defer; join and wait for Ready; post the join notice and
//        speak the greeting; one private line saying how it went. While Dero
//        is in another call here the request waits in voiceQueue instead, and
//        runQueuedJoin runs it when that call ends (2026-10 item 257, item 22).
// How (plan): the guild owner only; a fresh one time code, privately, for the
//        Dero server plan checkout or the dashboard's pairing panel (2026-10
//        item 262). See sendServerPlanCode.
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
	.addSubcommand((sub) => sub.setName("leave").setDescription(deroBrainCopy.command.leave))
	.addSubcommand((sub) => sub.setName("plan").setDescription(deroBrainCopy.command.plan));

// ── replies ──

// Every refusal here states something (not in a server, not set up, not allowed, Dero offline,
// a task too long), so it wears Dero's area title; the one real failure, a command that threw,
// calls showErrorNotice itself (owner rule 1, 2026-10 item 263 R3-12).
async function refuse(interaction: RepliableInteraction, line: string): Promise<void> {
	await showNotice(interaction, { title: deroBrainCopy.noticeTitle, sections: [line] });
}

// The settings panel holding the voice switch (settingsPanels.ts, SETTINGS_PANELS).
const DERO_CONFIG_PANEL_ID = "dero-config";

// Voice switched off, answered with its fix (2026-10 item 257, owner item 15): the owner or
// an admin gets the /dero-config panel at once, whose switch turns the voice on; anyone
// else gets the command to send an admin. Loaded on use, for the reason chipClaim gives:
// the launcher builds its command table from the admin commands as it loads, and those
// reach deep into setup and the arcade, so a static import back into it from a member
// command risks a cycle with the table half built.
async function refuseVoiceOff(interaction: RepliableInteraction, guildId: string): Promise<void> {
	const config = await guildConfigStore.findByGuildId(guildId);
	const { offerSwitchFix } = await import("@features/command-buttons/adminCommandLauncher.js");
	await offerSwitchFix(interaction, { launchId: DERO_CONFIG_PANEL_ID, title: getPluginCopy(config).error.title, memberSections: [...voiceCopy.call.voiceOffForMember] }, config);
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
		await refuseVoiceOff(interaction, guild.id);
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
		// A cooldown is a state, not a failure, so it wears Dero's area title rather than the
		// error title refuse gives (2026-10 item 263 R3-12).
		await showCooldownNotice(interaction, { title: deroBrainCopy.noticeTitle, message: tellCopy.cooldown(Math.ceil(gate.remainingMs / MS_PER_SECOND)) });
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

	// ⑦ the brain can take up to 20 seconds, far past Discord's 3 second window, so a quiet
	// acknowledgement goes first and the answer posts in 💬dero-commands, pinging the member
	// (2026-10 item 257 Phase 5, item 263 R3-10)
	const answer = await beginChannelAnswer(interaction, "member");
	const startedAt = Date.now();

	try {
		// ⑧ the shared brain turn: job, wait, and on "ok" the executor runs
		// against a fresh config read (the kill switch may have flipped meanwhile)
		const turn = await runBrainTurn({ guild, speaker, text: task, source: "text", voiceConfig: config });
		const audit = { ...describeBrainTurn(turn), speakerId: speaker.id, source: "text", taskChars: task.length };

		// ⑨
		// An unanswered turn (the brain offline, busy, slow or puzzled) is a state, not a
		// failure, so it is a notice titled for Dero and never a ping in 💬dero-commands
		// (owner rule 1 of the Round 3 list, 2026-10 item 263).
		if (turn.status === "unanswered") {
			await showPendingNotice(interaction, answer, { title: deroBrainCopy.noticeTitle, sections: [UNANSWERED_LINES[turn.reason]] });
			auditAction(guild.id, { ...audit, durationMs: Date.now() - startedAt });
			return;
		}
		tellCooldown.record(cooldownKey);
		await answer.send(await answerPayload(guild, turn.reports));

		// ⑩
		auditAction(guild.id, { ...audit, durationMs: Date.now() - startedAt });
	}
	catch (err) {
		console.error(`[dero-brain] tell failed guild=${guild.id} user=${speaker.id}`, err);
		await answer.send({ embeds: [errorEmbed(tellCopy.failed)] });
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
	// The queue matters only while Dero is busy: with no call, nothing waits.
	if (callChannelId && interaction.guildId) lines.push(...(await queueStatusLines(interaction.guildId)));

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
	// A modal shows no image, so the card posts in 💬dero-commands (2026-10 item 257 Phase 5).
	if (isRenderPayload(card)) {
		embed.setImage(card.ref);
		await answerInChannel(interaction, "member", { embeds: [embed], files: [card.attachment] });
		return;
	}
	// A status is a reading, so it is an answer in 💬dero-commands, never a notice (owner rule 1).
	await answerInChannel(interaction, "member", { embeds: [embed] });
}

// ── /dero join ──

/** Which gate refused a join, so a game's request can say why on its own channel (voiceCopy.gameVoice). */
export type JoinRefusalReason = "notSetUp" | "switchedOff" | "notAuthorized" | "notInVoice" | "alreadyHere" | "channelNotAllowed" | "botLacksPermission";

export type JoinGate =
	| { ok: true; channel: VoiceBasedChannel; voiceId: string }
	| { ok: false; line: string; reason: JoinRefusalReason }
	// Dero is in another call here: the request may wait in the voice queue (owner item 22).
	| { ok: false; queue: true; channel: VoiceBasedChannel; sessionChannelId: string };

export interface JoinGateInput {
	speaker: GuildMember;
	guildOwnerId: string;
	// GuildConfig.adminRoleId, which authorizes by itself (post-launch plan item 12).
	adminRoleId: string | null;
	botMember: GuildMember | null;
	config: IDeroVoiceConfig | null;
	/** The voice channel Dero is already in for this guild, if any. */
	sessionChannelId: string | null;
	/**
	 * A game's join (2026-10 item 267 decision 11): the channel the card or the room asked
	 * for. Narrating a game is not a task, so the task speaker list is not asked and the
	 * target is this channel rather than the speaker's own; the switch, the allow list and
	 * the bot's permissions still are. Absent for /dero join and the voice rooms' Join.
	 */
	gameVoiceChannel?: VoiceBasedChannel;
}

const refuseJoin = (line: string, reason: JoinRefusalReason): JoinGate => ({ ok: false, line, reason });

/**
 * The /dero join gates, in order, with nothing joined and nothing spent: the
 * kill switch, an authorized speaker, the speaker in a voice channel, Dero not
 * already in that same channel, the channel on the voice allowlist, and the bot
 * able to see, connect and speak there. Every refusal reuses the line that already
 * says it, from the tell gates or the Listen copy. A request that passes all of
 * them while Dero is in ANOTHER call here comes back as `queue` (2026-10 item 257,
 * owner item 22), checked last so only a request that could run is ever queued.
 * A game's join skips the speaker gate and targets its own channel (gameVoiceChannel).
 */
export function checkJoin({ speaker, guildOwnerId, adminRoleId, botMember, config, sessionChannelId, gameVoiceChannel }: JoinGateInput): JoinGate {
	if (!config) return refuseJoin(voiceCopy.listen.notSetUp, "notSetUp");
	if (!config.enabled) return refuseJoin(tellCopy.switchedOff, "switchedOff");
	if (!gameVoiceChannel && !isAuthorizedSpeaker({ member: speaker, guildOwnerId, adminRoleId, voiceConfig: config })) return refuseJoin(tellCopy.notAuthorized, "notAuthorized");

	// The speaker's own channel is the target, so "the speaker is in it" holds
	// by construction and there is no channel option to spoof. A game's channel was
	// chosen by the bot itself (the host's call or the Arcade Lounge), never typed.
	const channel = gameVoiceChannel ?? speaker.voice.channel;
	if (!channel) return refuseJoin(callCopy.notInVoice, "notInVoice");
	if (sessionChannelId === channel.id) return refuseJoin(callCopy.alreadyHere(sessionChannelId), "alreadyHere");
	if (!config.allowedVoiceChannelIds.includes(channel.id)) return refuseJoin(callCopy.channelNotAllowed, "channelNotAllowed");
	if (!botMember || !channel.permissionsFor(botMember)?.has(BOT_VOICE_PERMISSIONS)) return refuseJoin(callCopy.botLacksPermission, "botLacksPermission");
	// One call per guild, and waiting never moves Dero: the request queues instead.
	if (sessionChannelId) return { ok: false, queue: true, channel, sessionChannelId };
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
	// The one join refusal with a fix a press can run: answered before checkJoin, which
	// would refuse the same switched off guild with the bare line.
	if (config && !config.enabled) {
		await refuseVoiceOff(interaction, guild.id);
		return;
	}
	const gate = checkJoin({
		speaker: interaction.member,
		guildOwnerId: guild.ownerId,
		adminRoleId: await readSpeakerAdminRoleId(guild.id),
		botMember: guild.members.me,
		config,
		sessionChannelId: voiceSessions.get(guild.id)?.channelId ?? null,
	});
	if ("queue" in gate) {
		await queueJoin(interaction, gate.channel.id, gate.sessionChannelId, config?.priorityOrder);
		return;
	}
	if (!gate.ok) {
		await refuse(interaction, gate.line);
		return;
	}

	// Checked only after the gates, so a refused join never burns the window, and
	// recorded on the ATTEMPT, because a join that never reaches Ready still cost
	// gateway voice traffic.
	const cooldown = joinCooldown.check(guild.id);
	if (cooldown.onCooldown) {
		await showCooldownNotice(interaction, { title: deroBrainCopy.noticeTitle, message: callCopy.joinCooldown(Math.ceil(cooldown.remainingMs / MS_PER_SECOND)) });
		return;
	}
	joinCooldown.record(guild.id);

	// Ready can take up to 20 seconds, far past Discord's 3 second window, so a quiet
	// acknowledgement goes first and the answer posts in 💬dero-commands, pinging the member
	// (2026-10 item 257 Phase 5, item 263 R3-10).
	const answer = await beginChannelAnswer(interaction, "member");
	const voiceChannelId = gate.channel.id;
	// The channel the request came from carries the join notice. A slash command
	// and a button always have one; only an interaction with no channel at all falls
	// back to the call's own voice chat, which is where the voice room's Join sits.
	const controlChannelId = interaction.channelId ?? voiceChannelId;
	try {
		const outcome = await voiceSessions.join({ guild, channel: gate.channel, controlChannelId });
		if (outcome.status === "alreadyInGuild") {
			// Another join won the race between the gate and here: a state, so a notice.
			await showPendingNotice(interaction, answer, { title: deroBrainCopy.noticeTitle, sections: [callCopy.alreadyElsewhere(outcome.channelId)] });
			return;
		}
		if (outcome.status === "failed") {
			await answer.send({ embeds: [errorEmbed(callCopy.connectFailed(voiceChannelId))] });
			return;
		}

		const greeting: GreetingOutcome = await announceJoin({
			guild,
			controlChannelId,
			voiceChannelId,
			voiceId: gate.voiceId,
			speaker: outcome.session.speaker,
		});
		const line = greeting === "capReached"
			? callCopy.joined.capReached(voiceChannelId, await isServerCovered(guild.id))
			: callCopy.joined[greeting](voiceChannelId);
		await answer.send({ embeds: [infoEmbed(callCopy.replyTitle, line)] });
	}
	catch (err) {
		console.error(`[dero-voice] join command failed guild=${guild.id} channel=${voiceChannelId}`, err);
		await answer.send({ embeds: [errorEmbed(tellCopy.failed)] });
	}
}

// ── the voice queue (2026-10 item 257, owner item 22) ──

// A join that passed every gate while Dero is in another call here waits its turn,
// and the member hears their place. Its category comes from the channel: the Meeting
// Hall and the Arcade Lounge by their GuildConfig ids, any other allowed channel last.
async function queueJoin(
	interaction: RepliableInteraction<"cached">,
	voiceChannelId: string,
	busyChannelId: string,
	storedOrder: string[] | undefined
): Promise<void> {
	const guild = interaction.guild;
	const rooms = await guildConfigStore.findByGuildId(guild.id);
	const place = voiceQueue.enqueue(
		{
			guild,
			requesterId: interaction.member.id,
			channelId: voiceChannelId,
			controlChannelId: interaction.channelId ?? voiceChannelId,
			category: categoryForChannel(voiceChannelId, rooms),
		},
		normalizePriorityOrder(storedOrder)
	);
	await answerInChannel(interaction, "member", { embeds: [infoEmbed(callCopy.replyTitle, callCopy.queued(place.place, place.total, busyChannelId))] });
}

/**
 * The voice queue's runner, handed over by main.ts: the request at the head runs
 * when the call before it ended. Every gate runs again on the member as they stand
 * now, so a member who left their voice channel, lost their place on the task list
 * or whose channel left the allow list is skipped. The join notice posts in the
 * channel the request came from, which is how the member learns Dero is there.
 */
export async function runQueuedJoin(request: VoiceQueueRequest): Promise<QueuedJoinOutcome> {
	const { guild } = request;
	const member = guild.members.cache.get(request.requesterId) ?? (await guild.members.fetch(request.requesterId).catch(() => null));
	const game = request.gameVoice ?? null;
	// A member's request runs only while they still stand in the channel they asked from; a
	// game's request asks that only when its target is the host's own call, never the Lounge.
	const leftTheCall = !member || member.voice.channelId !== request.channelId;
	if (!game && leftTheCall) return "skipped";
	if (game?.followsHost && leftTheCall) return skipGameJoin(request, "hostLeft");

	const gameChannel = game ? voiceChannelOf(guild, request.channelId) : undefined;
	if (game && !gameChannel) return skipGameJoin(request, "channelGone");
	// A game's request needs no member at all (the Lounge), and the gate reads a speaker only
	// for the task list it skips there, so the bot's own member stands in when the host is gone.
	const speaker = member ?? guild.members.me;
	if (!speaker) return "skipped";
	const gate = checkJoin({
		speaker,
		guildOwnerId: guild.ownerId,
		adminRoleId: await readSpeakerAdminRoleId(guild.id),
		botMember: guild.members.me,
		config: await deroVoiceConfigStore.findByGuildId(guild.id),
		sessionChannelId: voiceSessions.get(guild.id)?.channelId ?? null,
		gameVoiceChannel: gameChannel,
	});
	if ("queue" in gate) return "busy";
	if (!gate.ok) return game ? skipGameJoin(request, gameSkipReasonOf(gate.reason)) : "skipped";

	// Defense in depth for the age gate (2026-11 item 302): the primary gate is joinGate,
	// which should already keep an unconfirmed member from ever being seated, so this never
	// posts a notice and never blocks the game, it only logs once and leaves Dero out of the
	// room's voice for that join.
	if (game) {
		const room = await gameRoomStore.findByRoomId(guild.id, game.roomId);
		if (room) {
			const confirmed = await Promise.all(memberIdsOnly(room.playerIds).map((userId) => hasConfirmedAge(userId)));
			if (!confirmed.every(Boolean)) {
				console.warn(`[dero-voice] skipping voice for room ${game.roomId}: a seated player has not confirmed their age`);
				return "skipped";
			}
		}
	}

	// The same per guild window a typed join records, since this attempt costs the same traffic.
	joinCooldown.record(guild.id);
	const outcome = await voiceSessions.join({ guild, channel: gate.channel, controlChannelId: request.controlChannelId, startedByRoomId: game?.roomId ?? null });
	if (outcome.status === "alreadyInGuild") return "busy";
	if (outcome.status === "failed") return game ? skipGameJoin(request, "connectFailed") : "skipped";
	await announceJoin({
		guild,
		controlChannelId: request.controlChannelId,
		voiceChannelId: gate.channel.id,
		voiceId: gate.voiceId,
		speaker: outcome.session.speaker,
	});
	return "joined";
}

// The voice channel a game's request named, read from the cache the gateway keeps full.
function voiceChannelOf(guild: Guild, channelId: string): VoiceBasedChannel | undefined {
	const channel = guild.channels.cache.get(channelId);
	return channel?.isVoiceBased() ? channel : undefined;
}

// The refusals a game's join can meet. The speaker list is never asked for a game and the
// target is never the speaker's own channel, so those two read as the nearest true reason.
function gameSkipReasonOf(reason: JoinRefusalReason): GameVoiceSkipReason {
	if (reason === "notAuthorized" || reason === "notInVoice" || reason === "alreadyHere") return "channelGone";
	return reason;
}

// A game's join that could not happen says so on the card's or the room's channel (2026-10
// item 267 decision 2), where the host is looking, and is dropped like any skipped request.
async function skipGameJoin(request: VoiceQueueRequest, reason: GameVoiceSkipReason): Promise<QueuedJoinOutcome> {
	await postVoiceNotice(request.guild, request.controlChannelId, voiceCopy.gameVoice.couldNotJoin(request.channelId, reason));
	return "skipped";
}

// The queue lines /dero status shows: every waiting request in its place. Shown to
// every member, for the reason the call line is: who waits where is visible anyway.
async function queueStatusLines(guildId: string): Promise<string[]> {
	const order = normalizePriorityOrder((await deroVoiceConfigStore.findByGuildId(guildId))?.priorityOrder);
	const waiting = voiceQueue.list(guildId, order);
	if (waiting.length === 0) return [callCopy.queueEmpty];
	return [callCopy.queueTitle, ...waiting.map((request, index) => callCopy.queueLine(index + 1, request.requesterId, request.channelId, request.category))];
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
	await answerInChannel(interaction, "member", { embeds: [infoEmbed(callCopy.replyTitle, callCopy.left(session.channelId))] });
}

// ── /dero plan (2026-10 item 262) ──

const MS_PER_MINUTE = 60_000;
const PAIRING_CODE_TTL_MINUTES = PAIRING_CODE_TTL_MS / MS_PER_MINUTE;

/**
 * /dero plan: hands the guild owner a fresh one time code, privately. The code buys the Dero
 * server plan on the pricing page and also pairs the server in the dashboard's "Connect your
 * Discord server" panel, so it is issued for EVERY owner, covered servers included (the
 * owner's decision of 2026-10-29); only the plan pitch depends on coverage. Issuing replaces
 * any live code for the guild, the store keeps one per guild.
 */
async function sendServerPlanCode(interaction: ChatInputCommandInteraction): Promise<void> {
	if (!interaction.inCachedGuild()) {
		await refuse(interaction, serverPlanCommandCopy.notInGuild);
		return;
	}
	const guild = interaction.guild;
	// The guild owner only, not admins: the code claims the server for whoever redeems it,
	// and the pairing DM on join goes to the owner for the same reason.
	if (interaction.user.id !== guild.ownerId) {
		await refuse(interaction, serverPlanCommandCopy.ownerOnly);
		return;
	}

	// Private from the first byte: the code is a claim token and must never post in a channel.
	// Deferred because the issue and the coverage read can outlast Discord's 3 second window.
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });
	try {
		const [code, covered] = await Promise.all([pendingPairingStore.issue(guild.id, guild.ownerId), isServerCovered(guild.id)]);
		const pitch = covered ? serverPlanCommandCopy.covered : serverPlanLine();
		await interaction.editReply({
			embeds: [infoEmbed(serverPlanCommandCopy.title, [serverPlanCommandCopy.code(code, PAIRING_CODE_TTL_MINUTES), pitch].join("\n\n"))],
		});
		// Fire and forget (house rule 7): the owner already has the code.
		botLogStore.log(guild.id, BOT_LOG_EVENTS.PAIRING_CODE_SENT, { ownerId: guild.ownerId, source: "dero_plan" }).catch((err) => {
			console.error(`[dero] plan code audit write failed guild=${guild.id}`, err);
		});
	}
	catch (err) {
		console.error(`[dero] plan code failed guild=${guild.id}`, err);
		await interaction.editReply({ embeds: [errorEmbed(serverPlanCommandCopy.failed)] });
	}
}

async function runSubcommand(interaction: ChatInputCommandInteraction): Promise<void> {
	switch (interaction.options.getSubcommand(true)) {
		case "tell":
			return tell(interaction);
		case "join":
			return bringDeroIntoCall(interaction);
		case "leave":
			return sendDeroAwayFromCall(interaction);
		case "plan":
			return sendServerPlanCode(interaction);
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
			await showErrorNotice(interaction, tellCopy.failed).catch(() => undefined);
		}
	}
}
