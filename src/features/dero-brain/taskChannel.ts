import { guildConfigStore } from "@db/stores/guildConfigStore.js";

// ── taskChannel ───────────────────────────────────────────────────────────
// What:  the one channel a Dero task may post in: the guild's 💬dero-commands
//        (GuildConfig.commandOutputChannelId), for every speaker (2026-10 item 263
//        Phase 4b, owner decision 15). The text channel list an admin kept on
//        /dero-config is retired; DeroVoiceConfig.allowedChannelIds stays in the
//        schema, unread.
// Who:   brainTurn, for the channels a job offers the brain, and the executor,
//        which reads it again before a post goes out. Both hand the list to
//        channelGate unchanged, so the gate still refuses a channel the speaker
//        cannot view or the bot cannot send in.
// When:  per job and per execution, uncached, for the reason speakerAdminRole gives:
//        a rerun /setup can move the channel while a job waits.
// How:   a guild with no channel stored (setup not rerun) or a failed read answers
//        an empty list, so a task's post is refused the way the gate refuses any
//        unlisted channel, never sent somewhere else.

/** The channel ids a Dero task may post in: 💬dero-commands, or none when it is not stored. */
export function taskChannelIds(commandOutputChannelId: string | null | undefined): string[] {
	return commandOutputChannelId ? [commandOutputChannelId] : [];
}

/** This guild's task channel ids, read fresh; an empty list when there is none or the read failed. */
export async function readTaskChannelIds(guildId: string): Promise<string[]> {
	try {
		const config = await guildConfigStore.findByGuildId(guildId);
		return taskChannelIds((config as unknown as { commandOutputChannelId?: string | null } | null)?.commandOutputChannelId);
	} catch (error) {
		console.warn(`[dero-brain] reading the task channel for guild ${guildId} failed; a task posts nowhere`, error);
		return [];
	}
}
