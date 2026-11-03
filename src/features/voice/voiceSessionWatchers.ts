import { Events, type Client, type DMChannel, type Guild, type NonThreadGuildBasedChannel, type VoiceState } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { deroVoiceConfigStore } from "@db/stores/deroVoiceConfigStore.js";
import type { IDeroVoiceConfig } from "@db/models/DeroVoiceConfig.js";
import { isAuthorizedSpeaker } from "@features/dero-brain/authorizer.js";
import { readSpeakerAdminRoleId } from "@features/dero-brain/speakerAdminRole.js";
import { voiceSessions, type VoiceSessions, type VoiceSessionView } from "./voiceSessions.js";

// ── voice session watchers ─────────────────────────────────────────────────
// What:  end a call that no longer has a reason to exist: nobody allowed to give
//        Dero tasks has been in it for two minutes, Dero itself was moved,
//        disconnected or kicked, or its channel was deleted.
// Who:   registered once from main.ts on ClientReady. Ends calls through
//        voiceSessions.leave, whose end() posts the matching text line.
// When:  on every VoiceStateUpdate and ChannelDelete, but it does real work only
//        for a guild with a live call, and only for updates that touch that
//        call's channel or Dero's own voice state.
// Where: reads the guild's cached voice states and the stored role allowlist.
//        Nothing here receives audio or knows what anyone said.
// How:   ① Dero's own state: still in its channel (a join, a mute toggle) is
//        fine; anywhere else or nowhere ends the call at once. ② anyone else
//        entering or leaving the call's channel: count the authorized humans
//        still in it. None arms one idle timer (a second departure never
//        restarts it, so the clock runs from the LAST authorized member out);
//        any cancels it. ③ the timer fires only for the session it was armed
//        for, so a call that ended and a new one that started in between is
//        never cut short.
//
// ⚠️ This is the THIRD VoiceStateUpdate listener, on purpose.
// activity-tracking/ActivityTracker.ts scores KvK participation and skips bots;
// leveling/voiceXp.ts is a sweep, not a listener, and also skips bots. Neither
// knows about calls, and this one ignores everything they measure.

export interface VoiceWatcherDeps {
	sessions: Pick<VoiceSessions, "get" | "leave">;
	findConfig(guildId: string): Promise<IDeroVoiceConfig | null>;
	/**
	 * GuildConfig.adminRoleId, which authorizes by itself (post-launch plan item 12).
	 * Optional so a test rig that never builds it keeps the allowlist only rule; the
	 * default deps always wire it to readSpeakerAdminRoleId.
	 */
	loadAdminRoleId?(guildId: string): Promise<string | null>;
	idleLeaveMs: number;
}

export const defaultVoiceWatcherDeps: VoiceWatcherDeps = {
	sessions: voiceSessions,
	findConfig: (guildId) => deroVoiceConfigStore.findByGuildId(guildId),
	loadAdminRoleId: readSpeakerAdminRoleId,
	idleLeaveMs: BOT_CONSTANTS.DERO_VOICE_IDLE_LEAVE_MS,
};

interface IdleTimer {
	timer: ReturnType<typeof setTimeout>;
	session: VoiceSessionView;
}

/** The watcher's logic without the client wiring, so tests drive it with fake states. */
export function createVoiceSessionWatcher(deps: VoiceWatcherDeps = defaultVoiceWatcherDeps) {
	const idleTimers = new Map<string, IdleTimer>();

	function cancelIdle(guildId: string): void {
		const pending = idleTimers.get(guildId);
		if (!pending) return;
		clearTimeout(pending.timer);
		idleTimers.delete(guildId);
	}

	function armIdle(guildId: string, session: VoiceSessionView): void {
		if (idleTimers.get(guildId)?.session === session) return;
		cancelIdle(guildId);
		const timer = setTimeout(() => {
			idleTimers.delete(guildId);
			// ③
			if (deps.sessions.get(guildId) !== session) return;
			deps.sessions.leave(guildId, "idle");
		}, deps.idleLeaveMs);
		// A pending idle leave must never keep a shutting down process alive.
		timer.unref?.();
		idleTimers.set(guildId, { timer, session });
	}

	function hasAuthorizedHuman(guild: Guild, channelId: string, config: IDeroVoiceConfig | null, adminRoleId: string | null): boolean {
		if (!config) return false;
		const channel = guild.channels.cache.get(channelId);
		if (!channel || !channel.isVoiceBased()) return false;
		return channel.members.some(
			(member) => !member.user.bot && isAuthorizedSpeaker({ member, guildOwnerId: guild.ownerId, adminRoleId, voiceConfig: config }),
		);
	}

	// ① A call Dero is no longer in ends now, not after the idle wait.
	function onOwnStateChange(session: VoiceSessionView, channelId: string | null): void {
		if (channelId === session.channelId) return;
		cancelIdle(session.guildId);
		deps.sessions.leave(session.guildId, channelId === null ? "removed" : "moved");
	}

	// ②
	async function reconcilePresence(guild: Guild, session: VoiceSessionView): Promise<void> {
		const config = await deps.findConfig(guild.id);
		const adminRoleId = deps.loadAdminRoleId ? await deps.loadAdminRoleId(guild.id) : null;
		// The call can end while the config is read.
		if (deps.sessions.get(guild.id) !== session) return;
		if (hasAuthorizedHuman(guild, session.channelId, config, adminRoleId)) cancelIdle(guild.id);
		else armIdle(guild.id, session);
	}

	async function onVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): Promise<void> {
		const guild = newState.guild;
		const session = deps.sessions.get(guild.id);
		if (!session) {
			cancelIdle(guild.id);
			return;
		}
		if (newState.id === newState.client.user?.id) {
			onOwnStateChange(session, newState.channelId);
			return;
		}
		if (oldState.channelId !== session.channelId && newState.channelId !== session.channelId) return;
		await reconcilePresence(guild, session);
	}

	function onChannelDelete(channel: DMChannel | NonThreadGuildBasedChannel): void {
		if (channel.isDMBased()) return;
		const session = deps.sessions.get(channel.guildId);
		if (!session || session.channelId !== channel.id) return;
		cancelIdle(channel.guildId);
		deps.sessions.leave(channel.guildId, "channel_deleted");
	}

	return { onVoiceStateUpdate, onChannelDelete, pendingIdleCount: (): number => idleTimers.size };
}

/**
 * Wire the watchers onto the client. Call once, from main.ts, on ClientReady.
 * Both listeners log and swallow their own failures: a watcher bug must never
 * take the gateway's event loop down with it.
 */
export function registerVoiceSessionWatchers(client: Client, watcher = createVoiceSessionWatcher()): void {
	client.on(Events.VoiceStateUpdate, (oldState, newState) => {
		watcher.onVoiceStateUpdate(oldState, newState).catch((error) => {
			console.error(`[dero-voice] voice state watcher failed guild=${newState.guild.id}`, error);
		});
	});
	client.on(Events.ChannelDelete, (channel) => {
		try {
			watcher.onChannelDelete(channel);
		}
		catch (error) {
			console.error("[dero-voice] channel delete watcher failed", error);
		}
	});
}
