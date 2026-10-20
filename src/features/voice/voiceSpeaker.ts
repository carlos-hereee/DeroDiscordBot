import { Readable } from "node:stream";
import {
	AudioPlayerStatus,
	NoSubscriberBehavior,
	StreamType,
	createAudioPlayer,
	createAudioResource,
	type AudioPlayer,
	type AudioResource,
	type CreateAudioPlayerOptions,
} from "@discordjs/voice";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";

// ── voice speaker ──────────────────────────────────────────────────────────
// What:  Dero's mouth in one voice call: one audio player, the clip playing now,
//        and a short queue of clips waiting behind it.
// Who:   voiceSessions makes one per session and subscribes the connection to
//        `player`. Callers speak through the session (the join greeting now;
//        the brain's `say`, in call Listen and the dealer next).
// When:  lives exactly as long as its session. The session calls close() on the
//        way out, which empties the queue, halts the player at once and turns
//        away anything spoken later.
// Where: takes 48 kHz stereo s16le only (resample.ts makes it). It never renders
//        speech, never meters spend and never logs what a clip says; it only
//        decides what plays next.
// How:   ① an idle speaker plays a new clip at once; ② otherwise the clip waits,
//        ordered by priority (brain, then listen, then dealer) and first come
//        first served inside one priority; ③ a full queue makes room only for a
//        HIGHER priority clip, by dropping the newest of its lowest entries, so
//        an equal clip is the one turned away; ④ every Idle (a clip ended or
//        failed) starts the next. A clip already playing is never cut off by a
//        newer one; only stop() cuts it, which is how a member barges in.
//        ⑤ every Idle after one of Dero's OWN lines (priority brain: the
//        greeting, a brain `say`, a turn's answer) stamps lastOwnLineEndedAt,
//        the start of the addressing rule's follow up window. A Listen reading
//        or table narration is Dero reading, not Dero talking to someone, so
//        neither opens the window.
//
// The player pauses itself when no connection is subscribed (a reconnect in
// progress) rather than playing into nothing or stopping, so a clip resumes
// where it was once the session is back.

export type SpeakPriority = "brain" | "listen" | "dealer";

/** What happened to one speak() call. */
export type SpeakResult = "playing" | "queued" | "dropped";

export type SpeakerStatus = "idle" | "playing";

// Lower plays first. Dero's own answers outrank a member's Listen, which
// outranks table narration that is stale a few seconds after it was written.
const PRIORITY_RANK: Record<SpeakPriority, number> = { brain: 0, listen: 1, dealer: 2 };

export const SPEAKER_PLAYER_OPTIONS: CreateAudioPlayerOptions = {
	behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
};

/** The two library calls the speaker makes, injected so tests use a fake player. */
export interface VoiceSpeakerDeps {
	createPlayer(): AudioPlayer;
	createResource(pcm48kStereo: Buffer): AudioResource;
	/** The clock for lastOwnLineEndedAt; the system clock when absent. */
	now?(): number;
}

export const defaultVoiceSpeakerDeps: VoiceSpeakerDeps = {
	createPlayer: () => createAudioPlayer(SPEAKER_PLAYER_OPTIONS),
	// objectMode false so the encoder reads plain bytes, and Raw so the library
	// encodes it with opusscript instead of looking for ffmpeg.
	createResource: (pcm) => createAudioResource(Readable.from([pcm], { objectMode: false }), { inputType: StreamType.Raw }),
};

interface QueuedClip {
	pcm: Buffer;
	priority: SpeakPriority;
	order: number;
}

function playsBefore(a: QueuedClip, b: QueuedClip): boolean {
	const rankA = PRIORITY_RANK[a.priority];
	const rankB = PRIORITY_RANK[b.priority];
	return rankA !== rankB ? rankA < rankB : a.order < b.order;
}

export class VoiceSpeaker {
	readonly player: AudioPlayer;
	private readonly queue: QueuedClip[] = [];
	private nextOrder = 0;
	private closed = false;
	private current: QueuedClip | null = null;
	private ownLineEndedAt: number | null = null;

	constructor(
		private readonly deps: VoiceSpeakerDeps = defaultVoiceSpeakerDeps,
		private readonly maxQueue: number = BOT_CONSTANTS.DERO_VOICE_SPEAKER_MAX_QUEUE,
	) {
		this.player = deps.createPlayer();
		// ④ A clip that ends and a clip that errors both land in Idle, so this one
		// listener is what keeps the queue moving.
		this.player.on(AudioPlayerStatus.Idle, () => {
			// ⑤
			if (this.current?.priority === "brain") this.ownLineEndedAt = this.deps.now?.() ?? Date.now();
			this.current = null;
			this.playNext();
		});
		// The message is the library's (a stream or encoder fault) and never holds
		// audio. The Idle that follows an error plays the next clip.
		this.player.on("error", (error) => console.warn(`[dero-voice] speaker error: ${error.message}`));
	}

	/** "playing" while a clip plays, buffers or waits paused for a reconnect. */
	get status(): SpeakerStatus {
		return this.player.state.status === AudioPlayerStatus.Idle ? "idle" : "playing";
	}

	/** How many clips wait behind the one playing. */
	get queuedCount(): number {
		return this.queue.length;
	}

	/** When Dero last finished (or was cut off in) one of its own lines, or null. */
	get lastOwnLineEndedAt(): number | null {
		return this.ownLineEndedAt;
	}

	/** Play a clip now, queue it, or drop it when the queue holds only clips that outrank or match it. */
	speak(pcm48kStereo: Buffer, priority: SpeakPriority): SpeakResult {
		if (this.closed) return "dropped";
		const clip: QueuedClip = { pcm: pcm48kStereo, priority, order: this.nextOrder++ };

		// ①
		if (this.status === "idle" && this.queue.length === 0) {
			return this.start(clip) ? "playing" : "dropped";
		}

		// ③
		if (this.queue.length >= this.maxQueue) {
			const lowestIndex = this.lowestQueuedIndex();
			if (!playsBefore(clip, this.queue[lowestIndex])) return "dropped";
			this.queue.splice(lowestIndex, 1);
		}

		// ②
		const insertAt = this.queue.findIndex((queued) => playsBefore(clip, queued));
		if (insertAt === -1) this.queue.push(clip);
		else this.queue.splice(insertAt, 0, clip);
		return "queued";
	}

	/** Empty the queue and halt the clip playing now, at once. */
	stop(): void {
		this.queue.length = 0;
		// force: skip the silence padding frames, because a stop is a member
		// leaving or a kill switch, not the natural end of a sentence.
		this.player.stop(true);
	}

	/**
	 * Stop, and refuse every later clip. The session calls this when it ends, so
	 * a line rendered while the session was leaving (the greeting is a second or
	 * two of provider time) can never start a player that no connection hears.
	 * That matters because the library keeps its global audio timer running for
	 * as long as any player is playing or paused waiting for a subscriber.
	 */
	close(): void {
		this.closed = true;
		this.stop();
	}

	// The clip that plays last is the one a full queue gives up first.
	private lowestQueuedIndex(): number {
		return this.queue.length - 1;
	}

	private playNext(): void {
		// Bounded by the queue: a clip that fails to start is dropped, never retried.
		while (this.queue.length > 0) {
			const next = this.queue.shift() as QueuedClip;
			if (this.start(next)) return;
		}
	}

	private start(clip: QueuedClip): boolean {
		try {
			this.player.play(this.deps.createResource(clip.pcm));
			this.current = clip;
			return true;
		}
		catch (error) {
			// A missing Opus encoder throws here, at resource creation. Logged by
			// message only; the clip is dropped so the queue cannot jam behind it.
			console.warn(`[dero-voice] speaker could not start a ${clip.priority} clip: ${(error as Error).message}`);
			return false;
		}
	}
}
