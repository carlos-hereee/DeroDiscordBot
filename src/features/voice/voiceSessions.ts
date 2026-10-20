import type { Guild } from "discord.js";
import {
	VoiceConnectionDisconnectReason,
	VoiceConnectionStatus,
	entersState,
	generateDependencyReport,
	joinVoiceChannel,
	type DiscordGatewayAdapterCreator,
	type VoiceConnection,
	type VoiceConnectionState,
	type VoiceReceiver,
} from "@discordjs/voice";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { BOT_LOG_EVENTS } from "@base/constants/BOT_LOG_EVENTS.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { postVoiceNotice } from "./joinNotice.js";
import { voiceCopy } from "./voiceCopy.js";
import { VoiceSpeaker } from "./voiceSpeaker.js";

// ── voice sessions ─────────────────────────────────────────────────────────
// What:  Dero's presence in voice: at most one call per guild, each with its
//        connection, its speaker and the text channel it reports to.
// Who:   /dero join and /dero leave; main.ts calls leaveAll() on shutdown and
//        hands over the listener factory with useListener(). get() is how
//        Listen, the executor's `say` and `leave_voice`, and /dero status find
//        a live call. voiceSessionWatchers ends a call that went idle or that
//        Dero was moved or kicked out of, and /dero-config ends one for the
//        kill switch.
// When:  a session starts on join and lives until a leave, a shutdown, a failed
//        Ready wait, a kick or move, a deleted channel, an idle call, the kill
//        switch, or a reconnect budget that ran out. end() posts the text line
//        for every ending that has one (END_NOTICES).
// Where: in memory by design. A Railway deploy ends every call, and Discord
//        drops the bot from the channel on its own when the process dies, so
//        there is nothing worth persisting.
// How:   ① join: register the session BEFORE waiting, so a second /dero join in
//        the same guild sees it at once; wait up to 20 s for Ready, else tear
//        down. ② a disconnect after Ready follows the @discordjs/voice documented
//        pattern: give the connection 5 s to re-enter signalling or connecting
//        on its own (a move or a voice server change), and wait for Ready if it
//        does. ③ a 4014 close that did not come back is a kick or a deleted
//        channel, so the bot never rejoins it uninvited. ④ otherwise rejoin up
//        to 3 times with a doubling backoff, each with its own Ready wait.
//        ⑤ out of budget: destroy and say so in text. Every wait listens to the
//        session's AbortController, so ending a session clears its timers at
//        once instead of leaving a 20 s wait to run out. ⑥ once Ready, the
//        session starts its listener on the connection's receiver; ending the
//        session stops it before anything else, so no capture outlives a call.
//
// ⚠️ PRIVACY: Dero joins undeafened so it can hear members on the task list,
// and only through voiceListener, whose operator gate decides who is ever
// subscribed to. The join notice says so on every join. With no listener
// factory registered (tests, or a boot that skipped it) nothing is received
// at all. Log lines and audit rows carry ids, status names, close codes,
// counts and durations, never audio or text.
//
// ⚠️ DAVE end to end encryption stays ON. joinChannel never passes
// `daveEncryption`, so the library default (true) applies. Do not add it.

// Discord voice close code 4014: "Disconnected. Channel was deleted, you were
// kicked, voice server changed, or the main gateway session was dropped. Should
// not reconnect." The voice server case comes back by itself inside the
// recover window, which is why the window is checked first.
const CLOSE_CODE_DISCONNECTED = 4014;

export type VoiceSessionStatus = "connecting" | "ready" | "recovering";

export type SessionEndReason =
	| "left"
	| "shutdown"
	| "ready_timeout"
	| "reconnect_failed"
	| "removed"
	| "moved"
	| "channel_deleted"
	| "idle"
	| "switched_off"
	| "destroyed";

const MS_PER_MINUTE = 60_000;

// The endings the control channel hears about in text, all from end() so no
// path can forget its line. A leave a member asked for, a shutdown and a join
// that never connected already answer whoever caused them, and a connection
// destroyed by the library has no one to tell, so those post nothing.
const END_NOTICES: Partial<Record<SessionEndReason, (channelId: string) => string>> = {
	reconnect_failed: (channelId) => voiceCopy.call.reconnectFailed(channelId, BOT_CONSTANTS.DERO_VOICE_MAX_RECONNECT_ATTEMPTS),
	removed: (channelId) => voiceCopy.call.removed(channelId),
	moved: (channelId) => voiceCopy.call.moved(channelId),
	channel_deleted: () => voiceCopy.call.channelDeleted,
	idle: (channelId) => voiceCopy.call.idleLeft(channelId, BOT_CONSTANTS.DERO_VOICE_IDLE_LEAVE_MS / MS_PER_MINUTE),
	switched_off: (channelId) => voiceCopy.call.switchedOff(channelId),
};

/** What a listener gets to hear one call with. */
export interface ListenStart {
	guild: Guild;
	channelId: string;
	controlChannelId: string;
	speaker: VoiceSpeaker;
	receiver: VoiceReceiver;
}

/** Starts Dero's ears in a Ready call; voiceListener.startVoiceListener in production. */
export type StartListening = (start: ListenStart) => { stop(): void };

/** What callers may read about a live session. The speaker is the live object. */
export interface VoiceSessionView {
	readonly guildId: string;
	readonly channelId: string;
	readonly controlChannelId: string;
	readonly status: VoiceSessionStatus;
	readonly speaker: VoiceSpeaker;
}

export interface JoinInput {
	guild: Guild;
	channel: { id: string };
	controlChannelId: string;
}

export type JoinOutcome =
	| { status: "joined"; session: VoiceSessionView; readyMs: number }
	| { status: "alreadyInGuild"; channelId: string }
	| { status: "failed"; reason: SessionEndReason | "join_threw" };

export interface JoinChannelOptions {
	guildId: string;
	channelId: string;
	adapterCreator: DiscordGatewayAdapterCreator;
	selfDeaf: boolean;
	selfMute: boolean;
}

/** Every library and side effect call a session makes, injected so tests use fakes. */
export interface VoiceSessionDeps {
	joinChannel(options: JoinChannelOptions): VoiceConnection;
	/** True when the connection reached `status` in time; false on timeout or abort. */
	waitForStatus(connection: VoiceConnection, status: VoiceConnectionStatus, timeoutMs: number, signal: AbortSignal): Promise<boolean>;
	createSpeaker(): VoiceSpeaker;
	postNotice(guild: Guild, channelId: string, line: string): Promise<void>;
	audit(guildId: string, event: string, metadata: Record<string, unknown>): void;
	dependencyReport(): string;
	now(): number;
}

export const defaultVoiceSessionDeps: VoiceSessionDeps = {
	joinChannel: (options) => joinVoiceChannel(options),
	waitForStatus: (connection, status, timeoutMs, signal) =>
		entersState(connection, status, AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])).then(
			() => true,
			() => false,
		),
	createSpeaker: () => new VoiceSpeaker(),
	postNotice: postVoiceNotice,
	// Fire and forget: an audit row never changes what happens to a call.
	audit: (guildId, event, metadata) => {
		botLogStore.log(guildId, event, metadata).catch((error) => {
			console.error(`[dero-voice] audit write failed guild=${guildId} event=${event}`, error);
		});
	},
	dependencyReport: generateDependencyReport,
	now: () => Date.now(),
};

interface LiveSession {
	guild: Guild;
	guildId: string;
	channelId: string;
	controlChannelId: string;
	status: VoiceSessionStatus;
	speaker: VoiceSpeaker;
	connection: VoiceConnection;
	startedAt: number;
	readySince: number | null;
	// The budget in use (reset after a stable Ready) and the lifetime total.
	reconnectAttempts: number;
	rejoins: number;
	recovering: boolean;
	ended: boolean;
	endReason: SessionEndReason | null;
	abort: AbortController;
	listener: { stop(): void } | null;
}

function closeCodeOf(state: VoiceConnectionState): number | null {
	if (state.status !== VoiceConnectionStatus.Disconnected) return null;
	return state.reason === VoiceConnectionDisconnectReason.WebSocketClose ? state.closeCode : null;
}

function backoffMs(attempt: number): number {
	return BOT_CONSTANTS.DERO_VOICE_RECONNECT_BACKOFF_MS * 2 ** (attempt - 1);
}

// True as soon as any wait reports true, false once all of them reported false.
// Promise.race would settle on the first wait to finish even when it is a false,
// and Promise.all would hold a quick success until the slowest wait timed out.
// waitForStatus never rejects, so there is no rejection to route.
function firstTrue(waits: Promise<boolean>[]): Promise<boolean> {
	return new Promise((resolve) => {
		let pending = waits.length;
		for (const wait of waits) {
			void wait.then((reached) => {
				pending -= 1;
				if (reached) resolve(true);
				else if (pending === 0) resolve(false);
			});
		}
	});
}

// A timer that resolves early, and clears itself, the moment the session ends.
function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const done = (): void => {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal.addEventListener("abort", done, { once: true });
	});
}

/** One guild's calls, at most one each. `voiceSessions` below is the process wide instance. */
export function createVoiceSessions(deps: VoiceSessionDeps = defaultVoiceSessionDeps) {
	const sessions = new Map<string, LiveSession>();
	let dependencyReportLogged = false;
	// Registered by main.ts rather than imported here: the listener reaches the
	// executor through the turn loop, and the executor imports this module, so a
	// static import would close a cycle that only works by accident of load order.
	let startListening: StartListening | null = null;

	// ── ending ──

	function end(session: LiveSession, reason: SessionEndReason): void {
		if (session.ended) return;
		session.ended = true;
		session.endReason = reason;
		session.abort.abort();
		if (sessions.get(session.guildId) === session) sessions.delete(session.guildId);

		// ⑥ the ears first, so no capture is still running when the mouth closes
		try {
			session.listener?.stop();
		}
		catch (error) {
			console.warn(`[dero-voice] listener stop failed guild=${session.guildId}`, error);
		}
		session.listener = null;
		try {
			session.speaker.close();
		}
		catch (error) {
			console.warn(`[dero-voice] speaker close failed guild=${session.guildId}`, error);
		}
		// destroy() emits Destroyed, which lands back here as a no-op because
		// `ended` is already set.
		if (session.connection.state.status !== VoiceConnectionStatus.Destroyed) {
			try {
				session.connection.destroy();
			}
			catch (error) {
				console.warn(`[dero-voice] connection destroy failed guild=${session.guildId}`, error);
			}
		}

		console.info(`[dero-voice] left guild=${session.guildId} channel=${session.channelId} reason=${reason} rejoins=${session.rejoins}`);
		deps.audit(session.guildId, BOT_LOG_EVENTS.DERO_VOICE_LEFT, {
			channelId: session.channelId,
			reason,
			durationMs: deps.now() - session.startedAt,
			rejoins: session.rejoins,
		});

		const notice = END_NOTICES[reason];
		if (notice) notify(session, notice(session.channelId));
	}

	function notify(session: LiveSession, line: string): void {
		deps.postNotice(session.guild, session.controlChannelId, line).catch(() => undefined);
	}

	// ── recovery ──

	function waitForReady(session: LiveSession): Promise<boolean> {
		return deps.waitForStatus(session.connection, VoiceConnectionStatus.Ready, BOT_CONSTANTS.DERO_VOICE_READY_TIMEOUT_MS, session.abort.signal);
	}

	// ② Whether the connection starts reconnecting by itself inside the window.
	function reentersSignalling(session: LiveSession): Promise<boolean> {
		const windowMs = BOT_CONSTANTS.DERO_VOICE_RECOVER_WINDOW_MS;
		const signal = session.abort.signal;
		return firstTrue([
			deps.waitForStatus(session.connection, VoiceConnectionStatus.Signalling, windowMs, signal),
			deps.waitForStatus(session.connection, VoiceConnectionStatus.Connecting, windowMs, signal),
		]);
	}

	async function recover(session: LiveSession, closeCode: number | null): Promise<void> {
		// A disconnect before the first Ready belongs to the join's own Ready wait,
		// and one during a recovery is already being handled by that recovery.
		if (session.ended || session.recovering || session.status === "connecting") return;
		session.recovering = true;
		session.status = "recovering";
		try {
			const stable = session.readySince !== null && deps.now() - session.readySince >= BOT_CONSTANTS.DERO_VOICE_RECONNECT_STABLE_MS;
			if (stable) session.reconnectAttempts = 0;
			session.readySince = null;

			// ②
			const selfRecovering = await reentersSignalling(session);
			if (session.ended) return;
			if (selfRecovering && (await waitForReady(session))) return;
			if (session.ended) return;

			// ③
			if (!selfRecovering && closeCode === CLOSE_CODE_DISCONNECTED) {
				end(session, "removed");
				return;
			}

			// ④ bounded: the budget only ever counts up inside this loop
			while (session.reconnectAttempts < BOT_CONSTANTS.DERO_VOICE_MAX_RECONNECT_ATTEMPTS) {
				session.reconnectAttempts += 1;
				await sleep(backoffMs(session.reconnectAttempts), session.abort.signal);
				if (session.ended) return;
				session.rejoins += 1;
				console.info(`[dero-voice] rejoin guild=${session.guildId} attempt=${session.reconnectAttempts}`);
				session.connection.rejoin();
				if (await waitForReady(session)) return;
				if (session.ended) return;
			}

			// ⑤
			end(session, "reconnect_failed");
		}
		finally {
			session.recovering = false;
		}
	}

	// ── wiring ──

	function watch(session: LiveSession): void {
		const { connection } = session;
		// The spike reads these lines on Railway: status names, a reason and a close
		// code, and the library's own error messages (UDP, socket, DAVE faults).
		connection.on("stateChange", (oldState, newState) => {
			const code = closeCodeOf(newState);
			console.info(
				`[dero-voice] state guild=${session.guildId} from=${oldState.status} to=${newState.status}${code === null ? "" : ` closeCode=${code}`}`,
			);
		});
		connection.on("error", (error) => console.warn(`[dero-voice] connection error guild=${session.guildId}: ${error.message}`));
		// A DAVE group transition finished: proof on the host that end to end
		// encryption negotiated. The id is a protocol counter, not a secret.
		connection.on("transitioned", (transitionId) => {
			console.info(`[dero-voice] DAVE transitioned guild=${session.guildId} transitionId=${transitionId}`);
		});
		connection.on(VoiceConnectionStatus.Ready, () => {
			session.status = "ready";
			session.readySince = deps.now();
		});
		connection.on(VoiceConnectionStatus.Disconnected, (_oldState, newState) => {
			void recover(session, closeCodeOf(newState));
		});
		// Destroyed by anything other than end() (the library giving up on its
		// adapter, say): forget the session so the guild can join again.
		connection.on(VoiceConnectionStatus.Destroyed, () => end(session, "destroyed"));
	}

	// Which codecs and encryption libraries actually loaded, once per process. On
	// a new host this is the first thing to read when a call is silent.
	function logDependencyReportOnce(): void {
		if (dependencyReportLogged) return;
		dependencyReportLogged = true;
		try {
			console.info(`[dero-voice] dependency report\n${deps.dependencyReport()}`);
		}
		catch (error) {
			console.warn("[dero-voice] dependency report failed", error);
		}
	}

	// ⑥ A listener that fails to start leaves the call speaking only, which is
	// the safe direction: Dero hears nothing rather than the wrong people.
	function listen(session: LiveSession): void {
		if (!startListening) return;
		try {
			session.listener = startListening({
				guild: session.guild,
				channelId: session.channelId,
				controlChannelId: session.controlChannelId,
				speaker: session.speaker,
				receiver: session.connection.receiver,
			});
		}
		catch (error) {
			console.error(`[dero-voice] listener failed to start guild=${session.guildId}`, error);
		}
	}

	// ── public surface ──

	function get(guildId: string): VoiceSessionView | null {
		return sessions.get(guildId) ?? null;
	}

	async function join({ guild, channel, controlChannelId }: JoinInput): Promise<JoinOutcome> {
		const existing = sessions.get(guild.id);
		if (existing) return { status: "alreadyInGuild", channelId: existing.channelId };

		logDependencyReportOnce();
		const startedAt = deps.now();

		// ① selfDeaf false: Discord sends a deafened bot no audio at all, and Dero
		// must hear members on the task list (the listener decides who). selfMute
		// false: the library defaults it to true, and a self muted bot shows the
		// muted icon while it talks.
		let connection: VoiceConnection;
		try {
			connection = deps.joinChannel({
				guildId: guild.id,
				channelId: channel.id,
				adapterCreator: guild.voiceAdapterCreator,
				selfDeaf: false,
				selfMute: false,
			});
		}
		catch (error) {
			console.error(`[dero-voice] join threw guild=${guild.id} channel=${channel.id}`, error);
			return { status: "failed", reason: "join_threw" };
		}

		let speaker: VoiceSpeaker;
		try {
			speaker = deps.createSpeaker();
		}
		catch (error) {
			// Without a player there is nothing to say; leave the channel at once.
			console.error(`[dero-voice] speaker create failed guild=${guild.id}`, error);
			connection.destroy();
			return { status: "failed", reason: "join_threw" };
		}

		const session: LiveSession = {
			guild,
			guildId: guild.id,
			channelId: channel.id,
			controlChannelId,
			status: "connecting",
			speaker,
			connection,
			startedAt,
			readySince: null,
			reconnectAttempts: 0,
			rejoins: 0,
			recovering: false,
			ended: false,
			endReason: null,
			abort: new AbortController(),
			listener: null,
		};
		sessions.set(guild.id, session);
		watch(session);
		connection.subscribe(speaker.player);

		const ready = await waitForReady(session);
		if (session.ended) return { status: "failed", reason: session.endReason ?? "destroyed" };
		if (!ready) {
			end(session, "ready_timeout");
			return { status: "failed", reason: "ready_timeout" };
		}

		const readyMs = deps.now() - startedAt;
		console.info(`[dero-voice] ready guild=${guild.id} channel=${channel.id} readyMs=${readyMs}`);
		deps.audit(guild.id, BOT_LOG_EVENTS.DERO_VOICE_JOINED, { channelId: channel.id, readyMs });
		listen(session);
		return { status: "joined", session, readyMs };
	}

	/** End this guild's call. False when there was none. */
	function leave(guildId: string, reason: SessionEndReason = "left"): boolean {
		const session = sessions.get(guildId);
		if (!session) return false;
		end(session, reason);
		return true;
	}

	/** End every call, for shutdown. Returns how many were open. */
	function leaveAll(): number {
		const open = [...sessions.values()];
		for (const session of open) end(session, "shutdown");
		return open.length;
	}

	/** Register how a Ready call starts listening. main.ts calls this once at boot. */
	function useListener(factory: StartListening): void {
		startListening = factory;
	}

	return { get, join, leave, leaveAll, useListener };
}

export type VoiceSessions = ReturnType<typeof createVoiceSessions>;

export const voiceSessions: VoiceSessions = createVoiceSessions();
