import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Guild } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { SpendReservation } from "@features/voice/spendMeter.js";
import { SttError } from "@features/voice/sttProvider.js";
import { PREPAID_CENTS, getMeetingRecorder, startMeetingRecorder, sttMillicents, type MeetingRecorderDeps, type RecordedSegment } from "./meetingRecorder.js";

// The recorder against a fake receiver and a fake speech to text: who is subscribed, how chunks
// are cut, what a revoke, a destroyed stream and a refused reserve do, and what an hour costs.

const PCM_BYTES_PER_MS = 192; // 48 kHz, stereo, 16 bit
const pcm = (ms: number): Buffer => Buffer.alloc(ms * PCM_BYTES_PER_MS);
const MEETING = "mtg123456789";
const GUILD = "g1";
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

class FakeStream extends EventEmitter {
	destroyed = false;
	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.emit("close");
	}
}

class FakeReceiver {
	speaking = new EventEmitter();
	streams = new Map<string, FakeStream>();
	subscribed: string[] = [];
	subscribe(userId: string): FakeStream {
		this.subscribed.push(userId);
		const stream = new FakeStream();
		this.streams.set(userId, stream);
		return stream;
	}
	/** A member speaks: Discord's speaking start, then their audio. */
	async speak(userId: string, ms: number): Promise<void> {
		this.speaking.emit("start", userId);
		await tick();
		this.streams.get(userId)?.emit("data", pcm(ms));
	}
}

interface Rig {
	receiver: FakeReceiver;
	deps: MeetingRecorderDeps;
	segments: RecordedSegment[];
	reserved: number[];
	refunds: SpendReservation[];
	transcribe: ReturnType<typeof vi.fn>;
	spendRefused: ReturnType<typeof vi.fn>;
	agreed: Set<string>;
	removedSpeakers: string[];
	removedMeetings: string[];
	steps: string[];
}

function makeRig(options: { agreed?: string[]; bots?: string[]; reserveOk?: (cents: number) => boolean } = {}): Rig {
	const agreed = new Set(options.agreed ?? ["alice", "bob"]);
	const bots = new Set(options.bots ?? []);
	const segments: RecordedSegment[] = [];
	const reserved: number[] = [];
	const refunds: SpendReservation[] = [];
	const transcribe = vi.fn(async () => ({ text: "words" }));
	const spendRefused = vi.fn();
	const removedSpeakers: string[] = [];
	const removedMeetings: string[] = [];
	const steps: string[] = [];
	const deps: MeetingRecorderDeps = {
		now: () => Date.now(),
		createDecoder: () => ({ decode: (packet: Buffer) => packet, close: () => undefined }),
		isBot: (_guild, userId) => bots.has(userId),
		hasConsent: async (_guildId, userId) => agreed.has(userId),
		stt: { modelId: "fake", transcribe },
		reserve: async (guildId, cents) => {
			if (options.reserveOk && !options.reserveOk(cents)) return null;
			reserved.push(cents);
			return { guildId, month: "2026-11", cents, ttsChars: 0 };
		},
		refund: async (reservation) => {
			refunds.push(reservation);
		},
		readStanding: async (_guildId, _meetingId, userId) => ({ consents: agreed.has(userId), meeting: "open" }),
		writeSegment: async (segment) => {
			steps.push("write");
			segments.push(segment);
		},
		addSpeaker: async () => void steps.push("speaker"),
		removeSpeakerWords: async (_guildId, _meetingId, userId) => void removedSpeakers.push(userId),
		removeMeetingWords: async (_guildId, meetingId) => void removedMeetings.push(meetingId),
		addUsage: async () => undefined,
		onSpendRefused: spendRefused,
	};
	return { receiver: new FakeReceiver(), deps, segments, reserved, refunds, transcribe, spendRefused, agreed, removedSpeakers, removedMeetings, steps };
}

const guild = { id: GUILD } as unknown as Guild;
const start = (rig: Rig) => startMeetingRecorder({ guild, receiver: rig.receiver, meetingId: MEETING }, rig.deps);

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(async () => {
	await getMeetingRecorder(MEETING)?.flush();
	vi.useRealTimers();
});

describe("who is heard", () => {
	it("a simulated meeting with two who agreed and one who did not writes segments only for the two", async () => {
		const rig = makeRig({ agreed: ["alice", "bob"] });
		const recorder = start(rig);
		await rig.receiver.speak("alice", 2000);
		await rig.receiver.speak("bob", 3000);
		await rig.receiver.speak("carol", 4000);
		await recorder.flush();
		expect(rig.receiver.subscribed).toEqual(["alice", "bob"]);
		expect(rig.segments.map((segment) => segment.speakerId).sort()).toEqual(["alice", "bob"]);
	});

	it("never subscribes a member who did not agree, however often they speak", async () => {
		const rig = makeRig({ agreed: [] });
		start(rig);
		for (let turn = 0; turn < 5; turn += 1) await rig.receiver.speak("carol", 1000);
		expect(rig.receiver.subscribed).toEqual([]);
	});

	it("never subscribes a bot, even one with a consent row", async () => {
		const rig = makeRig({ agreed: ["dero-bot"], bots: ["dero-bot"] });
		start(rig);
		await rig.receiver.speak("dero-bot", 1000);
		expect(rig.receiver.subscribed).toEqual([]);
	});

	it("caps the speakers heard at once at MAX_SPEAKERS", async () => {
		const ids = Array.from({ length: BOT_CONSTANTS.MEETINGS.MAX_SPEAKERS + 2 }, (_, index) => `m${index}`);
		const rig = makeRig({ agreed: ids });
		start(rig);
		for (const id of ids) await rig.receiver.speak(id, 500);
		expect(rig.receiver.subscribed).toHaveLength(BOT_CONSTANTS.MEETINGS.MAX_SPEAKERS);
	});
});

// A member who left the hall (2026-11 item 420, L12). Not a withdrawal: what they said is kept.
describe("a speaker who leaves the hall (L12)", () => {
	it("L12: frees a slot, loses no words and is heard again on return", async () => {
		const ids = Array.from({ length: BOT_CONSTANTS.MEETINGS.MAX_SPEAKERS + 1 }, (_, index) => `m${index}`);
		const rig = makeRig({ agreed: ids });
		const recorder = start(rig);
		for (const id of ids.slice(0, -1)) await rig.receiver.speak(id, 2000);
		recorder.releaseSpeaker("m0");
		await tick();
		expect(rig.segments.map((segment) => segment.speakerId)).toEqual(["m0"]);
		expect(recorder.capturingCount).toBe(BOT_CONSTANTS.MEETINGS.MAX_SPEAKERS - 1);
		await rig.receiver.speak(ids.at(-1)!, 2000);
		expect(rig.receiver.subscribed).toContain(ids.at(-1));
		recorder.releaseSpeaker("m1");
		await rig.receiver.speak("m0", 2000);
		await recorder.flush();
		expect(rig.receiver.subscribed.filter((id) => id === "m0")).toHaveLength(2);
		expect(rig.segments.filter((segment) => segment.speakerId === "m0")).toHaveLength(2);
		expect(rig.segments.filter((segment) => segment.speakerId === "m1")).toHaveLength(1);
	});

	it("L12: a member who left while their consent was read is not subscribed after they went", async () => {
		const rig = makeRig();
		let answer: (agreed: boolean) => void = () => undefined;
		rig.deps.hasConsent = () => new Promise<boolean>((resolve) => (answer = resolve));
		const recorder = start(rig);
		rig.receiver.speaking.emit("start", "alice");
		recorder.releaseSpeaker("alice");
		answer(true);
		await tick();
		expect(recorder.capturingCount).toBe(0);
	});

	it("L12: leaving never lifts a withdrawal", async () => {
		const rig = makeRig();
		const recorder = start(rig);
		await recorder.dropSpeaker("alice");
		recorder.releaseSpeaker("alice");
		await rig.receiver.speak("alice", 2000);
		await recorder.flush();
		expect(rig.receiver.subscribed).toEqual([]);
	});
});

describe("chunks", () => {
	it("flushes a chunk once its speech reaches CHUNK_MAX_SPEECH_MS", async () => {
		const rig = makeRig();
		start(rig);
		await rig.receiver.speak("alice", BOT_CONSTANTS.MEETINGS.CHUNK_MAX_SPEECH_MS);
		await tick();
		expect(rig.transcribe).toHaveBeenCalledTimes(1);
		expect(rig.segments[0]).toMatchObject({ speakerId: "alice", durationMs: BOT_CONSTANTS.MEETINGS.CHUNK_MAX_SPEECH_MS, meetingId: MEETING, guildId: GUILD });
	});

	it("flushes after the speaker is silent CHUNK_SPEAKER_SILENCE_MS, and not before", async () => {
		const rig = makeRig();
		start(rig);
		await rig.receiver.speak("alice", 2000);
		vi.advanceTimersByTime(BOT_CONSTANTS.MEETINGS.CHUNK_SPEAKER_SILENCE_MS - 1);
		await tick();
		expect(rig.transcribe).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		await tick();
		expect(rig.segments).toHaveLength(1);
	});

	it("drops a burst under MIN_UTTERANCE_MS", async () => {
		const rig = makeRig();
		const recorder = start(rig);
		await rig.receiver.speak("alice", BOT_CONSTANTS.MEETINGS.MIN_UTTERANCE_MS - 1);
		await recorder.flush();
		expect(rig.transcribe).not.toHaveBeenCalled();
	});

	it("a destroyed stream ends that chunk, and the member is subscribed again on their next speaking start", async () => {
		const rig = makeRig();
		const recorder = start(rig);
		await rig.receiver.speak("alice", 2000);
		rig.receiver.streams.get("alice")?.destroy();
		await tick();
		expect(rig.segments).toHaveLength(1);
		await rig.receiver.speak("alice", 2000);
		await recorder.flush();
		expect(rig.receiver.subscribed).toEqual(["alice", "alice"]);
		expect(rig.segments).toHaveLength(2);
	});

	it("an STT error writes nothing and refunds what that chunk reserved", async () => {
		const rig = makeRig();
		let calls = 0;
		rig.transcribe.mockImplementation(async () => {
			calls += 1;
			if (calls === 4) throw new SttError("timeout");
			return { text: "words" };
		});
		const recorder = start(rig);
		// Each full chunk costs about a quarter cent, so the fourth is the one that passes the
		// prepaid cent and reserves one of its own, and its failure gives that cent back.
		for (let chunk = 0; chunk < 4; chunk += 1) await rig.receiver.speak("alice", BOT_CONSTANTS.MEETINGS.CHUNK_MAX_SPEECH_MS);
		await recorder.flush();
		expect(rig.segments).toHaveLength(3);
		expect(rig.reserved).toEqual([1]);
		expect(rig.refunds.map((reservation) => reservation.cents)).toEqual([1]);
	});
});

describe("Stop recording me", () => {
	it("drops the member's unflushed buffer unsent and never subscribes them again this meeting", async () => {
		const rig = makeRig();
		const recorder = start(rig);
		await rig.receiver.speak("alice", 5000);
		await recorder.dropSpeaker("alice");
		await rig.receiver.speak("alice", 5000);
		await recorder.flush();
		expect(rig.transcribe).not.toHaveBeenCalled();
		expect(rig.segments).toEqual([]);
		expect(rig.receiver.subscribed).toEqual(["alice"]);
	});

	it("throws away a chunk already at the provider when its text returns", async () => {
		const rig = makeRig();
		let release: (value: { text: string }) => void = () => undefined;
		rig.transcribe.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
		const recorder = start(rig);
		await rig.receiver.speak("alice", BOT_CONSTANTS.MEETINGS.CHUNK_MAX_SPEECH_MS);
		await tick();
		const dropped = recorder.dropSpeaker("alice");
		release({ text: "words" });
		await dropped;
		expect(rig.segments).toEqual([]);
	});

	it("L6: a chunk sent before a withdrawal is never written, even when the member agreed again before its text returned", async () => {
		const rig = makeRig();
		let release: (value: { text: string }) => void = () => undefined;
		rig.transcribe.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
		const recorder = start(rig);
		await rig.receiver.speak("alice", BOT_CONSTANTS.MEETINGS.CHUNK_MAX_SPEECH_MS);
		await tick();
		const dropped = recorder.dropSpeaker("alice");
		recorder.allowAgain("alice");
		release({ text: "words" });
		await dropped;
		expect(rig.segments).toEqual([]);
	});

	it("hears a member again after they agree again", async () => {
		const rig = makeRig();
		const recorder = start(rig);
		await recorder.dropSpeaker("alice");
		recorder.allowAgain("alice");
		await rig.receiver.speak("alice", 2000);
		await recorder.flush();
		expect(rig.segments).toHaveLength(1);
	});
});

// Consent is read again when words are spent on and when they are written (2026-11 item 420, L5):
// an unreadable answer is a no, and a no inside a chunk never waits for that chunk.
describe("consent at the spend and at the write (L5)", () => {
	const fullChunk = (rig: Rig, userId = "alice") => rig.receiver.speak(userId, BOT_CONSTANTS.MEETINGS.CHUNK_MAX_SPEECH_MS);

	it("L5: a member who no longer consents is neither paid for nor sent, and their live buffer is dropped", async () => {
		const rig = makeRig();
		const recorder = start(rig);
		await rig.receiver.speak("alice", 5000);
		rig.agreed.delete("alice");
		await fullChunk(rig);
		await tick();
		expect(rig.transcribe).not.toHaveBeenCalled();
		expect(recorder.capturingCount).toBe(0);
		await recorder.flush();
		expect(rig.segments).toEqual([]);
	});

	it("L5: a consent read that fails before the spend drops only that chunk", async () => {
		const rig = makeRig();
		const recorder = start(rig);
		await rig.receiver.speak("alice", 1000);
		vi.spyOn(rig.deps, "hasConsent").mockRejectedValueOnce(new Error("mongo down"));
		await fullChunk(rig);
		await tick();
		expect(rig.transcribe).not.toHaveBeenCalled();
		expect(recorder.capturingCount).toBe(1);
		await fullChunk(rig);
		await recorder.flush();
		expect(rig.segments).toHaveLength(1);
	});

	it.each([
		["consent ended", { consents: false, meeting: "open" as const }, 0],
		["the meeting is closed", { consents: true, meeting: "closed" as const }, 1],
		["the meeting is gone", { consents: true, meeting: "gone" as const }, 1],
	])("L5: a chunk whose text comes back after %s is never written", async (_label, standing, stillCaptured) => {
		const rig = makeRig();
		rig.deps.readStanding = async () => standing;
		const recorder = start(rig);
		await fullChunk(rig);
		await tick();
		expect(rig.transcribe).toHaveBeenCalledTimes(1);
		expect(rig.segments).toEqual([]);
		expect(recorder.capturingCount).toBe(stillCaptured);
	});

	it("L5: an unreadable standing at the write drops the chunk", async () => {
		const rig = makeRig();
		rig.deps.readStanding = async () => Promise.reject(new Error("mongo down"));
		const recorder = start(rig);
		await fullChunk(rig);
		await recorder.flush();
		expect(rig.segments).toEqual([]);
	});

	it("L5: consent gone between the check and the insert takes that member's words out again", async () => {
		const rig = makeRig();
		const answers = [true, false];
		rig.deps.readStanding = async () => ({ consents: answers.shift() ?? false, meeting: "open" });
		const recorder = start(rig);
		await fullChunk(rig);
		await recorder.flush();
		expect(rig.removedSpeakers).toEqual(["alice"]);
		expect(rig.removedMeetings).toEqual([]);
	});

	it("L11: a meeting deleted between the check and the insert takes its words with it", async () => {
		const rig = makeRig();
		const answers = ["open", "gone"] as const;
		let read = 0;
		rig.deps.readStanding = async () => ({ consents: true, meeting: answers[read++] ?? "gone" });
		const recorder = start(rig);
		await fullChunk(rig);
		await recorder.flush();
		expect(rig.removedMeetings).toEqual([MEETING]);
	});

	it("L6: a withdrawal and a new yes while the insert runs still take the earlier words out", async () => {
		const rig = makeRig();
		const recorder = start(rig);
		rig.deps.writeSegment = async () => {
			void recorder.dropSpeaker("alice");
			recorder.allowAgain("alice");
		};
		await fullChunk(rig);
		await tick();
		expect(rig.removedSpeakers).toEqual(["alice"]);
	});

	it("L5: lists the speaker before the words land, so a crash in between still marks whose they are", async () => {
		const rig = makeRig();
		const recorder = start(rig);
		await fullChunk(rig);
		await recorder.flush();
		expect(rig.steps).toEqual(["speaker", "write"]);
	});

	it("L11: discard sends nothing unsent, throws away what is at the provider, and releases a waiting flush", async () => {
		const rig = makeRig();
		let release: (value: { text: string }) => void = () => undefined;
		rig.transcribe.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
		const recorder = start(rig);
		await fullChunk(rig);
		await tick();
		await rig.receiver.speak("bob", 2000);
		recorder.stop();
		const flushed = recorder.flush();
		await recorder.discard();
		await flushed;
		release({ text: "words" });
		await tick();
		expect(rig.segments).toEqual([]);
		expect(getMeetingRecorder(MEETING)).toBeNull();
	});
});

describe("spend (owner decision D3)", () => {
	it("a refused reserve stops capture and tells the lifecycle once", async () => {
		const rig = makeRig({ reserveOk: () => false });
		const recorder = start(rig);
		await rig.receiver.speak("alice", BOT_CONSTANTS.MEETINGS.CHUNK_MAX_SPEECH_MS);
		await tick();
		for (let chunk = 0; chunk < 3; chunk += 1) await rig.receiver.speak("alice", BOT_CONSTANTS.MEETINGS.CHUNK_MAX_SPEECH_MS);
		await rig.receiver.speak("bob", 2000);
		await recorder.flush();
		expect(rig.spendRefused).toHaveBeenCalledTimes(1);
		expect(rig.spendRefused).toHaveBeenCalledWith(GUILD, MEETING);
		expect(rig.receiver.subscribed).toEqual(["alice"]);
	});

	it("meters a 60 minute, four speaker meeting at the real rate, under 50 cents", async () => {
		const rig = makeRig({ agreed: ["a", "b", "c", "d"] });
		const recorder = start(rig);
		const turnMs = 30_000;
		const turns = (60 * 60_000) / turnMs;
		for (let turn = 0; turn < turns; turn += 1) {
			await rig.receiver.speak(["a", "b", "c", "d"][turn % 4], turnMs);
			vi.advanceTimersByTime(BOT_CONSTANTS.MEETINGS.CHUNK_SPEAKER_SILENCE_MS);
			await tick();
		}
		await recorder.flush();
		const total = PREPAID_CENTS + rig.reserved.reduce((sum, cents) => sum + cents, 0);
		expect(rig.segments).toHaveLength(turns);
		expect(total).toBe(Math.ceil(sttMillicents(60 * 60_000) / 1000));
		expect(total).toBeLessThan(50);
	});
});
