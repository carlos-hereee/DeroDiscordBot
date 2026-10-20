import type { Guild, GuildMember, MessageMentionOptions } from "discord.js";
import type { IDeroVoiceConfig } from "@db/models/DeroVoiceConfig.js";
import type { BrainAction, BrainActionType, PostMessageAction } from "./brainTypes.js";
import { isAuthorizedSpeaker } from "./authorizer.js";
import { checkPostableChannel, type ChannelRefusal } from "./channelGate.js";
import { deroBrainCopy } from "./deroBrainCopy.js";

// ── executor ──────────────────────────────────────────────────────────────
// What:  carry out a parsed brain result in one guild, for one speaker, and
//        report one human readable line per action.
// Who:   /dero tell, after the brain answered "ok". Later phases call it for
//        voice turns too. It is the ONLY code that touches Discord on the
//        brain's behalf.
// When:  once per answered job, with a voice config re-read just before.
// Where: the result is bound to the JOB's guild, passed in by the caller; no
//        action can name a guild, and no channel is ever looked up by name.
// How:   ① the kill switch, re-checked here because a job can wait 20 seconds;
//        ② the honest stubs: say, open_holdem and leave_voice answer "not
//        available yet" and do nothing; ③ the pure allowlist check, so a post
//        to an unlisted channel is refused with zero Discord API calls; ④ the
//        speaker re-fetched and re-authorized (a role removed while the brain
//        was thinking stops the post); ⑤ the channel gate against the live
//        cache; ⑥ the send, with every ping disabled.
//
// ⚠️ PRIVACY: a send failure logs ids and an error code, never the text.

export type ActionOutcome = "posted" | ChannelRefusal | "not_authorized" | "switched_off" | "send_failed" | "not_available_yet";

/** What happened to one action, with the line the member is shown. */
export interface ActionReport {
	type: BrainActionType;
	outcome: ActionOutcome;
	line: string;
}

export interface ExecutorDeps {
	/** A fresh read of the member, bypassing the cache, or null when they left. */
	fetchMember(guild: Guild, userId: string): Promise<GuildMember | null>;
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

export const defaultExecutorDeps: ExecutorDeps = {
	// force: true because the cached member is exactly the stale copy this
	// re-check exists to get past. A member who left resolves to null.
	fetchMember: (guild, userId) => guild.members.fetch({ user: userId, force: true }).catch(() => null),
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

	// ③ before any API call: the posts that could possibly go out
	const allowed = voiceConfig.allowedChannelIds;
	const postable = actions.filter(
		(action): action is PostMessageAction => action.type === "post_message" && allowed.includes(action.channelId),
	);

	// ④ only fetched when a post survived the allowlist, so a refused result
	// costs no Discord call at all
	let speaker: GuildMember | null = null;
	let speakerAuthorized = false;
	if (postable.length > 0) {
		speaker = await deps.fetchMember(guild, speakerId);
		speakerAuthorized = isAuthorizedSpeaker({ member: speaker, guildOwnerId: guild.ownerId, voiceConfig });
	}

	const reports: ActionReport[] = [];
	for (const action of actions) {
		// ② honest stubs: say what is missing, never fake a success
		if (action.type !== "post_message") {
			reports.push(report(action.type, "not_available_yet", deroBrainCopy.result.notAvailableYet(action.type)));
			continue;
		}
		if (!allowed.includes(action.channelId)) {
			reports.push(report(action.type, "channel_not_allowed", REFUSAL_LINES.channel_not_allowed));
			continue;
		}
		if (!speaker || !speakerAuthorized) {
			reports.push(report(action.type, "not_authorized", deroBrainCopy.result.notAuthorized));
			continue;
		}
		reports.push(await sendPost(guild, speaker, action, allowed));
	}
	return reports;
}
