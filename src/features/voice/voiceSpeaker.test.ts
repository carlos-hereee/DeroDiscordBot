import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AudioPlayerStatus, NoSubscriberBehavior, type AudioPlayer, type AudioResource } from "@discordjs/voice";
import { SPEAKER_PLAYER_OPTIONS, VoiceSpeaker, type VoiceSpeakerDeps } from "./voiceSpeaker.js";

// ── voice speaker ──────────────────────────────────────────────────────────
// The speaker's promises, against a fake player that records what it was told
// to play: an idle speaker plays at once; waiting clips go out by priority and
// then by arrival; a full queue turns away the clip that would play last; stop
// clears everything and halts the player; a clip that fails to start never
// jams the queue.

class FakePlayer extends EventEmitter {
	state: { status: AudioPlayerStatus } = { status: AudioPlayerStatus.Idle };
	played: string[] = [];
	stopCalls: boolean[] = [];

	play(resource: { label: string }): void {
		this.played.push(resource.label);
		this.state = { status: AudioPlayerStatus.Playing };
	}

	stop(force?: boolean): boolean {
		this.stopCalls.push(force === true);
		this.finish();
		return true;
	}

	// The clip on air ends: the library moves to Idle and emits it.
	finish(): void {
		this.state = { status: AudioPlayerStatus.Idle };
		this.emit(AudioPlayerStatus.Idle);
	}
}

// Each clip's bytes are its label, so the fake can report what played.
const clip = (label: string): Buffer => Buffer.from(label);

let player: FakePlayer;
let failLabels: Set<string>;

function makeSpeaker(maxQueue = 5): VoiceSpeaker {
	const deps: VoiceSpeakerDeps = {
		createPlayer: () => player as unknown as AudioPlayer,
		createResource: (pcm) => {
			const label = pcm.toString();
			if (failLabels.has(label)) throw new Error("Could not find an Opus module");
			return { label } as unknown as AudioResource;
		},
	};
	return new VoiceSpeaker(deps, maxQueue);
}

// Play the queue out to the end and return the order it played in.
function drain(): string[] {
	for (let guard = 0; guard < 20 && player.state.status !== AudioPlayerStatus.Idle; guard++) player.finish();
	return player.played;
}

beforeEach(() => {
	player = new FakePlayer();
	failLabels = new Set();
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("VoiceSpeaker", () => {
	it("asks the library to pause, not stop, when no connection is subscribed", () => {
		expect(SPEAKER_PLAYER_OPTIONS.behaviors?.noSubscriber).toBe(NoSubscriberBehavior.Pause);
	});

	it("plays a clip at once when idle and reports playing until it ends", () => {
		const speaker = makeSpeaker();
		expect(speaker.status).toBe("idle");
		expect(speaker.speak(clip("hello"), "brain")).toBe("playing");
		expect(speaker.status).toBe("playing");
		player.finish();
		expect(speaker.status).toBe("idle");
		expect(player.played).toEqual(["hello"]);
	});

	it("queues behind the clip on air and plays by priority, then by arrival", () => {
		const speaker = makeSpeaker();
		speaker.speak(clip("on-air"), "dealer");
		expect(speaker.speak(clip("dealer-1"), "dealer")).toBe("queued");
		expect(speaker.speak(clip("listen-1"), "listen")).toBe("queued");
		expect(speaker.speak(clip("brain-1"), "brain")).toBe("queued");
		expect(speaker.speak(clip("listen-2"), "listen")).toBe("queued");
		expect(speaker.queuedCount).toBe(4);
		expect(drain()).toEqual(["on-air", "brain-1", "listen-1", "listen-2", "dealer-1"]);
	});

	it("never cuts off the clip on air for a higher priority one", () => {
		const speaker = makeSpeaker();
		speaker.speak(clip("listen"), "listen");
		speaker.speak(clip("brain"), "brain");
		expect(player.played).toEqual(["listen"]);
	});

	it("drops the newest lowest clip when a higher priority one arrives at a full queue", () => {
		const speaker = makeSpeaker(2);
		speaker.speak(clip("on-air"), "brain");
		speaker.speak(clip("dealer-old"), "dealer");
		speaker.speak(clip("dealer-new"), "dealer");
		expect(speaker.speak(clip("listen"), "listen")).toBe("queued");
		expect(speaker.queuedCount).toBe(2);
		expect(drain()).toEqual(["on-air", "listen", "dealer-old"]);
	});

	it("turns away a clip that does not outrank anything in a full queue", () => {
		const speaker = makeSpeaker(2);
		speaker.speak(clip("on-air"), "brain");
		speaker.speak(clip("listen-1"), "listen");
		speaker.speak(clip("listen-2"), "listen");
		expect(speaker.speak(clip("listen-3"), "listen")).toBe("dropped");
		expect(speaker.speak(clip("dealer"), "dealer")).toBe("dropped");
		expect(drain()).toEqual(["on-air", "listen-1", "listen-2"]);
	});

	it("holds at most five waiting clips by default", () => {
		const speaker = new VoiceSpeaker({
			createPlayer: () => player as unknown as AudioPlayer,
			createResource: (pcm) => ({ label: pcm.toString() }) as unknown as AudioResource,
		});
		speaker.speak(clip("on-air"), "listen");
		const results = ["a", "b", "c", "d", "e", "f"].map((label) => speaker.speak(clip(label), "listen"));
		expect(results).toEqual(["queued", "queued", "queued", "queued", "queued", "dropped"]);
	});

	it("stop clears the queue and halts the player at once", () => {
		const speaker = makeSpeaker();
		speaker.speak(clip("on-air"), "brain");
		speaker.speak(clip("waiting"), "listen");
		speaker.stop();
		expect(player.stopCalls).toEqual([true]);
		expect(speaker.queuedCount).toBe(0);
		expect(speaker.status).toBe("idle");
		expect(player.played).toEqual(["on-air"]);
	});

	it("close stops the player and refuses every later clip", () => {
		const speaker = makeSpeaker();
		speaker.speak(clip("on-air"), "brain");
		speaker.close();
		expect(player.stopCalls).toEqual([true]);
		expect(speaker.speak(clip("late"), "brain")).toBe("dropped");
		expect(player.played).toEqual(["on-air"]);
	});

	it("drops a clip that fails to start and moves on to the next", () => {
		const speaker = makeSpeaker();
		failLabels.add("broken");
		expect(speaker.speak(clip("broken"), "brain")).toBe("dropped");
		expect(speaker.status).toBe("idle");

		speaker.speak(clip("first"), "brain");
		speaker.speak(clip("broken"), "listen");
		speaker.speak(clip("last"), "dealer");
		expect(drain()).toEqual(["first", "last"]);
	});
});
