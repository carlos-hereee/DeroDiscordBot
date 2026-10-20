import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Guild, GuildMember } from "discord.js";
import { EndBehaviorType } from "@discordjs/voice";
import type { IDeroVoiceConfig } from "@db/models/DeroVoiceConfig.js";
import { CooldownManager } from "@utils/cooldownManager.js";
import type { OpusPacketDecoder } from "./opusDecoder.js";
import { createLatencyLog } from "./turnLatency.js";
import { createTurnLoop, type TurnLoop, type TurnLoopDeps } from "./turnLoop.js";
import { startVoiceListener, type ListenMember, type ListenTarget, type ReceiveStreamLike, type VoiceListenerDeps } from "./voiceListener.js";

// ── voice listener ─────────────────────────────────────────────────────────
// Dero's ears against a fake receiver: who is ever subscribed to (the operator
// gate), what one utterance becomes, barge in, the capture bounds, and a clean
// stop. The operator case runs the REAL turn loop on fake providers, so "zero
// decode calls and zero provider calls for a member who is not on the task
// list" is observed end to end, not inferred.

const GUILD_ID = "g1";
const CALL_ID = "vc-1";
const ROLE = "taskers";
const ALLOWED = "allowed-member";
const STRANGER = "stranger";
const CONFIG = { guildId: GUILD_ID, enabled: true, voiceId: "voice-1", allowedRoleIds: [ROLE], allowedChannelIds: [] } as unknown as IDeroVoiceConfig;
// 48 kHz stereo s16le is 192 bytes per millisecond.
const BYTES_PER_MS = 192;
const SILENCE_FRAME = Buffer.from([0xf8, 0xff, 0xfe]);

class FakeStream extends EventEmitter implements ReceiveStreamLike {
	destroyed = false;

	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.emit("close");
	}

	packet(bytes: Buffer = Buffer.from([0xfc, 0x01, 0x02])): void {
		this.emit("data", bytes);
	}

	endUtterance(): void {
		this.emit("end");
	}
}

class FakeReceiver {
	speaking = new EventEmitter();
	subscribed: string[] = [];
	options: unknown[] = [];
	streams = new Map<string, FakeStream>();

	subscribe(userId: string, options: unknown): FakeStream {
		this.subscribed.push(userId);
		this.options.push(options);
		const stream = new FakeStream();
		this.streams.set(userId, stream);
		return stream;
	}

	start(userId: string): void {
		this.speaking.emit("start", userId);
	}
}

interface Rig {
	receiver: FakeReceiver;
	deps: VoiceListenerDeps;
	target: ListenTarget;
	members: Map<string, ListenMember>;
	loadConfig: ReturnType<typeof vi.fn>;
	decodes: { count: number; decoders: number; closed: number; bytesPerPacket: number };
	speakerState: { status: "idle" | "playing"; stop: ReturnType<typeof vi.fn> };
	clock: { now: number };
	submit: ReturnType<typeof vi.fn>;
}

function member(id: string, options: { roles?: string[]; bot?: boolean; channelId?: string | null } = {}): ListenMember {
	return {
		id,
		guild: { id: GUILD_ID },
		roles: { cache: new Set(options.roles ?? []) },
		user: { bot: options.bot ?? false },
		voice: { channelId: options.channelId === undefined ? CALL_ID : options.channelId },
	};
}

function fakeTurnLoop(submit: ReturnType<typeof vi.fn>): TurnLoop {
	return { submit, close: vi.fn(), waitingCount: 0 };
}

function makeRig(createTurnLoopFor?: VoiceListenerDeps["createTurnLoop"]): Rig {
	const receiver = new FakeReceiver();
	const members = new Map<string, ListenMember>([
		[ALLOWED, member(ALLOWED, { roles: [ROLE] })],
		[STRANGER, member(STRANGER)],
	]);
	const decodes = { count: 0, decoders: 0, closed: 0, bytesPerPacket: 20 * BYTES_PER_MS };
	const clock = { now: 50_000 };
	const loadConfig = vi.fn(async () => CONFIG);
	const submit = vi.fn(() => "started");
	const speakerState = { status: "idle" as "idle" | "playing", stop: vi.fn() };
	const deps: VoiceListenerDeps = {
		now: () => clock.now,
		createDecoder: (): OpusPacketDecoder => {
			decodes.decoders += 1;
			return {
				decode: () => {
					decodes.count += 1;
					return Buffer.alloc(decodes.bytesPerPacket);
				},
				failures: 0,
				close: () => {
					decodes.closed += 1;
				},
			};
		},
		cachedMember: (_guild, userId) => members.get(userId) ?? null,
		fetchMember: async () => null,
		loadConfig,
		createTurnLoop: createTurnLoopFor ?? (() => fakeTurnLoop(submit)),
	};
	const target: ListenTarget = {
		guild: { id: GUILD_ID, ownerId: "owner", channels: { cache: new Map() } } as unknown as Guild,
		channelId: CALL_ID,
		controlChannelId: "text-1",
		speaker: {
			speak: vi.fn(() => "playing"),
			stop: speakerState.stop,
			get status() {
				return speakerState.status;
			},
			lastOwnLineEndedAt: null,
		} as unknown as ListenTarget["speaker"],
		receiver: receiver as unknown as ListenTarget["receiver"],
	};
	return { receiver, deps, target, members, loadConfig, decodes, speakerState, clock, submit };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// One spoken utterance: the start event, the gate, then `packets` frames.
async function speak(rig: Rig, userId: string, packets = 25): Promise<FakeStream | undefined> {
	rig.receiver.start(userId);
	await settle();
	const stream = rig.receiver.streams.get(userId);
	for (let index = 0; index < packets; index++) stream?.packet();
	stream?.endUtterance();
	return stream;
}

let rig: Rig;

beforeEach(() => {
	vi.spyOn(console, "info").mockImplementation(() => undefined);
	rig = makeRig();
});

describe("the operator gate", () => {
	it("subscribes only to the member on the task list: zero decodes and zero provider calls for anyone else", async () => {
		const transcribe = vi.fn(async () => ({ text: "Dero, send hello world with an emoji in general" }));
		const turnDeps: TurnLoopDeps = {
			now: () => rig.clock.now,
			loadConfig: async () => CONFIG,
			findMember: async (_guild, userId) => rig.members.get(userId) as unknown as GuildMember,
			reserve: async () => ({ status: "ok", reservation: { guildId: GUILD_ID, month: "2026-10", cents: 1, ttsChars: 0 } }),
			refund: async () => undefined,
			stt: { modelId: "scribe_v2", transcribe },
			runTurn: async () => ({ status: "unanswered", jobId: null, offeredChannels: 0, reason: "offline", code: "offline", resultAt: rig.clock.now }),
			render: async () => ({ status: "capReached" }),
			postNotice: async () => undefined,
			audit: vi.fn(),
			latency: createLatencyLog(),
			troubleCooldown: new CooldownManager(30_000),
		};
		rig = makeRig((target) => createTurnLoop(target, turnDeps));
		// One packet that decodes to two seconds of audio: one decode, one utterance.
		rig.decodes.bytesPerPacket = 2000 * BYTES_PER_MS;
		startVoiceListener(rig.target, rig.deps);

		await speak(rig, STRANGER, 1);
		await speak(rig, ALLOWED, 1);
		await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));

		expect(rig.receiver.subscribed).toEqual([ALLOWED]);
		expect(rig.decodes.decoders).toBe(1);
		expect(rig.decodes.count).toBe(1);
		expect(transcribe).toHaveBeenCalledTimes(1);
	});

	it.each([
		["a bot", member("bot", { roles: [ROLE], bot: true })],
		["a member outside Dero's channel", member("elsewhere", { roles: [ROLE], channelId: "vc-other" })],
		["a member who is not on the task list", member("plain")],
	])("never subscribes to %s", async (_label, who) => {
		rig.members.set(who.id, who);
		startVoiceListener(rig.target, rig.deps);
		await speak(rig, who.id);
		expect(rig.receiver.subscribed).toEqual([]);
		expect(rig.decodes.count).toBe(0);
	});

	it("refuses a bot or a member outside the call without even reading the config", async () => {
		rig.members.set("bot", member("bot", { roles: [ROLE], bot: true }));
		startVoiceListener(rig.target, rig.deps);
		await speak(rig, "bot");
		expect(rig.loadConfig).not.toHaveBeenCalled();
	});

	it("subscribes to nobody while the kill switch is off", async () => {
		rig.loadConfig.mockResolvedValue({ ...CONFIG, enabled: false });
		startVoiceListener(rig.target, rig.deps);
		await speak(rig, ALLOWED);
		expect(rig.receiver.subscribed).toEqual([]);
	});

	it("lets the guild owner in without a role", async () => {
		rig.members.set("owner", member("owner"));
		startVoiceListener(rig.target, rig.deps);
		await speak(rig, "owner");
		expect(rig.receiver.subscribed).toEqual(["owner"]);
	});

	it("trusts a pass for 60 seconds, then checks the allowlist again", async () => {
		startVoiceListener(rig.target, rig.deps);
		await speak(rig, ALLOWED);
		await speak(rig, ALLOWED);
		expect(rig.loadConfig).toHaveBeenCalledTimes(1);
		expect(rig.receiver.subscribed).toEqual([ALLOWED, ALLOWED]);

		rig.clock.now += 60_000;
		await speak(rig, ALLOWED);
		expect(rig.loadConfig).toHaveBeenCalledTimes(2);
	});

	it("never caches a refusal, so a role added mid call counts on the next phrase", async () => {
		startVoiceListener(rig.target, rig.deps);
		await speak(rig, STRANGER);
		rig.members.set(STRANGER, member(STRANGER, { roles: [ROLE] }));
		await speak(rig, STRANGER);
		expect(rig.receiver.subscribed).toEqual([STRANGER]);
	});

	it("refuses a trusted member who walked out of the call, at once", async () => {
		startVoiceListener(rig.target, rig.deps);
		await speak(rig, ALLOWED);
		rig.members.set(ALLOWED, member(ALLOWED, { roles: [ROLE], channelId: "vc-other" }));
		await speak(rig, ALLOWED);
		expect(rig.receiver.subscribed).toEqual([ALLOWED]);
	});
});

describe("one utterance", () => {
	it("subscribes with an end after 800 ms of silence", async () => {
		startVoiceListener(rig.target, rig.deps);
		await speak(rig, ALLOWED);
		expect(rig.receiver.options[0]).toEqual({ end: { behavior: EndBehaviorType.AfterSilence, duration: 800 } });
	});

	it("hands the concatenated PCM to the turn loop with its length and when speech ended", async () => {
		startVoiceListener(rig.target, rig.deps);
		rig.receiver.start(ALLOWED);
		await settle();
		const stream = rig.receiver.streams.get(ALLOWED) as FakeStream;
		for (let index = 0; index < 25; index++) stream.packet();
		const lastVoiceAt = rig.clock.now;
		rig.clock.now += 100;
		stream.packet(SILENCE_FRAME);
		rig.clock.now += 800;
		stream.endUtterance();

		expect(rig.submit).toHaveBeenCalledTimes(1);
		const [utterance] = rig.submit.mock.calls[0] as unknown as [{ speakerId: string; pcm48kStereo: Buffer; durationMs: number; speechEndedAt: number }];
		expect(utterance.speakerId).toBe(ALLOWED);
		expect(utterance.pcm48kStereo.length).toBe(26 * 20 * BYTES_PER_MS);
		expect(utterance.durationMs).toBe(520);
		expect(utterance.speechEndedAt).toBe(lastVoiceAt);
		expect(rig.decodes.closed).toBe(1);
	});

	it("discards an utterance under 400 ms before any call", async () => {
		startVoiceListener(rig.target, rig.deps);
		await speak(rig, ALLOWED, 19);
		expect(rig.submit).not.toHaveBeenCalled();
		expect(rig.decodes.closed).toBe(1);
	});

	it("cuts and discards an utterance past 20 seconds of audio, whole", async () => {
		startVoiceListener(rig.target, rig.deps);
		rig.receiver.start(ALLOWED);
		await settle();
		const stream = rig.receiver.streams.get(ALLOWED) as FakeStream;
		for (let index = 0; index < 1001; index++) stream.packet();
		expect(stream.destroyed).toBe(true);
		stream.endUtterance();
		expect(rig.submit).not.toHaveBeenCalled();
	});

	it("captures at most 3 members at once", async () => {
		for (const id of ["a", "b", "c", "d"]) rig.members.set(id, member(id, { roles: [ROLE] }));
		startVoiceListener(rig.target, rig.deps);
		for (const id of ["a", "b", "c", "d"]) rig.receiver.start(id);
		await settle();
		expect(rig.receiver.subscribed).toEqual(["a", "b", "c"]);
	});
});

describe("barge in", () => {
	it("stops Dero at once when a member on the task list starts speaking over it", async () => {
		rig.speakerState.status = "playing";
		startVoiceListener(rig.target, rig.deps);
		rig.receiver.start(ALLOWED);
		await settle();
		expect(rig.speakerState.stop).toHaveBeenCalledTimes(1);
	});

	it("lets anyone else talk over Dero without stopping it", async () => {
		rig.speakerState.status = "playing";
		startVoiceListener(rig.target, rig.deps);
		rig.receiver.start(STRANGER);
		await settle();
		expect(rig.speakerState.stop).not.toHaveBeenCalled();
	});

	it("does nothing to a quiet Dero", async () => {
		startVoiceListener(rig.target, rig.deps);
		rig.receiver.start(ALLOWED);
		await settle();
		expect(rig.speakerState.stop).not.toHaveBeenCalled();
	});
});

describe("stop", () => {
	it("stops hearing, destroys live captures, frees decoders and closes the turn loop", async () => {
		const close = vi.fn();
		rig = makeRig(() => ({ submit: rig.submit, close, waitingCount: 0 }));
		const listener = startVoiceListener(rig.target, rig.deps);
		rig.receiver.start(ALLOWED);
		await settle();
		const stream = rig.receiver.streams.get(ALLOWED) as FakeStream;
		stream.packet();

		listener.stop();
		expect(stream.destroyed).toBe(true);
		expect(rig.decodes.closed).toBeGreaterThanOrEqual(1);
		expect(close).toHaveBeenCalledTimes(1);
		expect(rig.submit).not.toHaveBeenCalled();
		expect(rig.receiver.speaking.listenerCount("start")).toBe(0);
		expect(listener.capturingCount).toBe(0);
	});
});
