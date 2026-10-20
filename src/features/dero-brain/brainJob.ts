import type { Guild, GuildMember } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { IDeroVoiceConfig } from "@db/models/DeroVoiceConfig.js";
import { BRAIN_ACTION_TYPES, type BrainJobChannel, type BrainJobInput, type BrainJobSource } from "./brainTypes.js";
import { checkPostableChannel } from "./channelGate.js";

// ── brainJob ──────────────────────────────────────────────────────────────
// What:  build the job the brain receives from an authorized member's task.
// Who:   /dero tell today; the voice turn loop later (source "voice").
// When:  after the speaker passed the authorizer, before the job is enqueued.
// Where: this is the brain's ENTIRE view of the guild, so it holds only what the
//        speaker could already see: the guild's name, the speaker's own display
//        name and words, and the allowlisted channels the channel gate admits
//        for this speaker. No secrets, no other member's messages, no ids the
//        speaker cannot read.
// How:   walk the allowlist in its stored order, keep the channels that pass the
//        gate (one that was deleted or that the bot can no longer post in simply
//        drops out), and stop at the channel cap.
//
// The caller has already trimmed the task and enforced DERO_BRAIN_MAX_TASK_CHARS.

export interface BuildJobInput {
	guild: Guild;
	speaker: GuildMember;
	text: string;
	voiceConfig: Pick<IDeroVoiceConfig, "allowedChannelIds">;
	source: BrainJobSource;
}

/** The channels a job offers the brain: allowlisted, live, postable, visible to the speaker. */
export function offeredChannels(guild: Guild, speaker: GuildMember, allowedChannelIds: readonly string[]): BrainJobChannel[] {
	const channels: BrainJobChannel[] = [];
	for (const channelId of allowedChannelIds) {
		if (channels.length >= BOT_CONSTANTS.DERO_BRAIN_MAX_JOB_CHANNELS) break;
		const gate = checkPostableChannel({ guild, channelId, allowedChannelIds, speaker });
		if (gate.ok) channels.push({ id: gate.channel.id, name: gate.channel.name });
	}
	return channels;
}

/** A job ready for brainQueue.enqueue, which adds the job id. */
export function buildJobInput({ guild, speaker, text, voiceConfig, source }: BuildJobInput): BrainJobInput {
	return {
		source,
		guild: { id: guild.id, name: guild.name },
		speaker: { id: speaker.id, displayName: speaker.displayName },
		text,
		channels: offeredChannels(guild, speaker, voiceConfig.allowedChannelIds),
		capabilities: [...BRAIN_ACTION_TYPES],
	};
}
