import type { Guild, GuildMember, MessageMentionOptions } from "discord.js";
import type { IDeroVoiceConfig } from "@db/models/DeroVoiceConfig.js";
import { renderCallSpeech, type CallSpeechInput, type CallSpeechResult } from "@features/voice/callSpeech.js";
import { voiceSessions, type VoiceSessionView } from "@features/voice/voiceSessions.js";
import { voiceCopy } from "@features/voice/voiceCopy.js";
import type { BrainAction, BrainActionType, PostMessageAction, SayAction } from "./brainTypes.js";
import { isAuthorizedSpeaker } from "./authorizer.js";
import { checkPostableChannel, type ChannelRefusal } from "./channelGate.js";
import { deroBrainCopy } from "./deroBrainCopy.js";

// ── executor ──────────────────────────────────────────────────────────────
// What:  carry out a parsed brain result in one guild, for one speaker, and
//        report one human readable line per action.
// Who:   /dero tell, after the brain answered "ok". Later phases call it for
//        voice turns too. It is the ONLY code that touches Discord or a voice
//        call on the brain's behalf.
// When:  once per answered job, with a voice config re-read just before.
// Where: the result is bound to the JOB's guild, passed in by the caller; no
//        action can name a guild, and no channel is ever looked up by name.
//        `say` and `leave_voice` act only on the call already open in that
//        guild; the brain can never make Dero join one.
// How:   ① the kill switch, re-checked here because a job can wait 20 seconds;
//        ② the honest stub: open_holdem answers "not available yet" and does
//        nothing; ③ the pure checks first (a post's allowlist, whether a call
//        is open), so a refused action costs zero Discord API calls; ④ the
//        speaker re-fetched and re-authorized, only when an action survived ③
//        (a role removed while the brain was thinking stops the action); ⑤ the
//        channel gate against the live cache; ⑥ the send, with every ping
//        disabled; ⑦ `say` renders through callSpeech (metered, cached) and
//        queues at brain priority; `leave_voice` ends the call.
//
// ⚠️ PRIVACY: a send failure logs ids and an error code, never the text, and a
// spoken line is never logged or stored.

export type ActionOutcome =
	| "posted"
	| ChannelRefusal
	| "not_authorized"
	| "switched_off"
	| "send_failed"
	| "not_available_yet"
	| "spoke"
	| "no_call"
	| "not_set_up"
	| "cap_reached"
	| "voice_failed"
	| "queue_full"
	| "left_call";

/** What happened to one action, with the line the member is shown. */
export interface ActionReport {
	type: BrainActionType;
	outcome: ActionOutcome;
	line: string;
}

/** The voice calls the executor makes, injected so tests use a fake call. */
export interface ExecutorVoiceDeps {
	sessionIn(guildId: string): VoiceSessionView | null;
	leave(guildId: string): boolean;
	render(input: CallSpeechInput): Promise<CallSpeechResult>;
}

export interface ExecutorDeps {
	/** A fresh read of the member, bypassing the cache, or null when they left. */
	fetchMember(guild: Guild, userId: string): Promise<GuildMember | null>;
	/** Optional so a caller that never speaks need not build it; defaults to the live calls. */
	voice?: ExecutorVoiceDeps;
}

export interface ExecuteInput {
	guild: Guild;
	speakerId: string;
	actions: BrainAction[];
	voiceConfig: IDeroVoiceConfig | null;
	deps?: ExecutorDeps;
}

// Every brain originated post goes out with no pings of any kind. The parser
// already refuses mention text; this is the second wall for anything it missed.
export const SAFE_MENTIONS: MessageMentionOptions = { parse: [], users: [], roles: [], repliedUser: false };

const MASS_MENTION_GLOBAL = /@(everyone|here)/gi;
const ZERO_WIDTH_SPACE = "​";

const REFUSAL_LINES: Record<ChannelRefusal, string> = {
	channel_not_allowed: deroBrainCopy.result.channelNotAllowed,
	channel_unavailable: deroBrainCopy.result.channelUnavailable,
	bot_lacks_permission: deroBrainCopy.result.botLacksPermission,
	channel_not_visible: deroBrainCopy.result.channelNotVisible,
};

export const defaultExecutorVoiceDeps: ExecutorVoiceDeps = {
	sessionIn: (guildId) => voiceSessions.get(guildId),
	leave: (guildId) => voiceSessions.leave(guildId, "left"),
	render: renderCallSpeech,
};

export const defaultExecutorDeps: ExecutorDeps = {
	// force: true because the cached member is exactly the stale copy this
	// re-check exists to get past. A member who left resolves to null.
	fetchMember: (guild, userId) => guild.members.fetch({ user: userId, force: true }).catch(() => null),
	voice: defaultExecutorVoiceDeps,
};

/**
 * Break "@everyone" and "@here" with a zero width space after the at sign, so
 * the text renders but can never be read by Discord as a mass mention.
 */
export function neutralizeMassMentions(text: string): string {
	return text.replace(MASS_MENTION_GLOBAL, `@${ZERO_WIDTH_SPACE}$1`);
}

function report(type: BrainActionType, outcome: ActionOutcome, line: string): ActionReport {
	return { type, outcome, line };
}

const isVoiceAction = (action: BrainAction): boolean => action.type === "say" || action.type === "leave_voice";

async function sendPost(
	guild: Guild,
	speaker: GuildMember,
	action: PostMessageAction,
	allowedChannelIds: readonly string[],
): Promise<ActionReport> {
	// ⑤
	const gate = checkPostableChannel({ guild, channelId: action.channelId, allowedChannelIds, speaker });
	if (!gate.ok) return report(action.type, gate.reason, REFUSAL_LINES[gate.reason]);

	// ⑥
	try {
		await gate.channel.send({ content: neutralizeMassMentions(action.text), allowedMentions: SAFE_MENTIONS });
		return report(action.type, "posted", deroBrainCopy.result.posted(action.channelId));
	}
	catch (err) {
		const code = (err as { code?: unknown }).code ?? "unknown";
		console.error(`[dero-brain] post failed guild=${guild.id} channel=${action.channelId} code=${String(code)}`);
		return report(action.type, "send_failed", deroBrainCopy.result.sendFailed);
	}
}

// ⑦ say: render, then queue only if the call it was rendered for is still open.
async function sayInCall(guild: Guild, action: SayAction, voiceId: string | null, voice: ExecutorVoiceDeps): Promise<ActionReport> {
	const session = voice.sessionIn(guild.id);
	if (!session) return report(action.type, "no_call", deroBrainCopy.result.sayNoCall);
	if (!voiceId) return report(action.type, "not_set_up", deroBrainCopy.result.sayNotSetUp);

	const speech = await voice.render({ guildId: guild.id, voiceId, text: action.text });
	if (speech.status === "capReached") return report(action.type, "cap_reached", deroBrainCopy.result.sayCapReached);
	if (speech.status === "failed") return report(action.type, "voice_failed", deroBrainCopy.result.sayFailed);
	// The call can end during the render; a line for a call that is gone is dropped.
	if (voice.sessionIn(guild.id) !== session) return report(action.type, "no_call", deroBrainCopy.result.sayNoCall);

	if (session.speaker.speak(speech.pcm48kStereo, "brain") === "dropped") {
		return report(action.type, "queue_full", deroBrainCopy.result.sayQueueFull);
	}
	return report(action.type, "spoke", deroBrainCopy.result.spoke);
}

function leaveCall(guild: Guild, voice: ExecutorVoiceDeps): ActionReport {
	const session = voice.sessionIn(guild.id);
	if (!session) return report("leave_voice", "no_call", deroBrainCopy.result.leaveNoCall);
	voice.leave(guild.id);
	return report("leave_voice", "left_call", voiceCopy.call.left(session.channelId));
}

/** Run a parsed result's actions and say what happened to each, in order. */
export async function executeActions({
	guild,
	speakerId,
	actions,
	voiceConfig,
	deps = defaultExecutorDeps,
}: ExecuteInput): Promise<ActionReport[]> {
	// ① a config for another guild counts as no config at all
	if (!voiceConfig || !voiceConfig.enabled || voiceConfig.guildId !== guild.id) {
		return actions.map((action) => report(action.type, "switched_off", deroBrainCopy.result.switchedOff));
	}
	const voice = deps.voice ?? defaultExecutorVoiceDeps;

	// ③ before any API call: the posts that could possibly go out, and whether a
	// voice action has a call to act on (the session map is local memory)
	const allowed = voiceConfig.allowedChannelIds;
	const postable = actions.filter(
		(action): action is PostMessageAction => action.type === "post_message" && allowed.includes(action.channelId),
	);
	const callActionable = actions.some(isVoiceAction) && voice.sessionIn(guild.id) !== null;

	// ④ only fetched when an action survived ③, so a refused result costs no
	// Discord call at all
	let speaker: GuildMember | null = null;
	let speakerAuthorized = false;
	if (postable.length > 0 || callActionable) {
		speaker = await deps.fetchMember(guild, speakerId);
		speakerAuthorized = isAuthorizedSpeaker({ member: speaker, guildOwnerId: guild.ownerId, voiceConfig });
	}

	const reports: ActionReport[] = [];
	for (const action of actions) {
		// ② the honest stub: say what is missing, never fake a success
		if (action.type === "open_holdem") {
			reports.push(report(action.type, "not_available_yet", deroBrainCopy.result.notAvailableYet(action.type)));
			continue;
		}
		if (action.type === "post_message" && !allowed.includes(action.channelId)) {
			reports.push(report(action.type, "channel_not_allowed", REFUSAL_LINES.channel_not_allowed));
			continue;
		}
		// No call means nothing to say or leave, and saying so needs no member.
		if (isVoiceAction(action) && !voice.sessionIn(guild.id)) {
			const line = action.type === "say" ? deroBrainCopy.result.sayNoCall : deroBrainCopy.result.leaveNoCall;
			reports.push(report(action.type, "no_call", line));
			continue;
		}
		if (!speaker || !speakerAuthorized) {
			reports.push(report(action.type, "not_authorized", deroBrainCopy.result.notAuthorized));
			continue;
		}
		if (action.type === "say") reports.push(await sayInCall(guild, action, voiceConfig.voiceId, voice));
		else if (action.type === "leave_voice") reports.push(leaveCall(guild, voice));
		else reports.push(await sendPost(guild, speaker, action, allowed));
	}
	return reports;
}
