import { EventEmitter } from "node:events";
import { createHash, createHmac } from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { ChannelType, type ButtonInteraction, type ChatInputCommandInteraction, type Client, type EmbedBuilder, type Guild, type GuildMember, type VoiceState } from "discord.js";
import { VoiceConnectionDisconnectReason, VoiceConnectionStatus, type VoiceConnection } from "@discordjs/voice";

// ── Dero voice failure matrix (Phase 5) ────────────────────────────────────
// One row per way a voice or brain turn can fail. Each row asserts three things:
// the line a member sees or hears, the audit row that records it, and that
// nothing threw. The pieces are the REAL ones wherever a seam allows: the turn
// loop, the brain queue (on a manual clock), runBrainTurn, the executor, the
// spend meter, callSpeech, both ElevenLabs clients (over a fake fetch), the
// voice session state machine (over a fake connection), the watchers, /dero
// and /dero-config. Faked: Mongo (the stores), Discord (channels and members)
// and the network. "Spoken" means a line went to text to speech and then to
// the call's speaker; every world uses its own voice id, so the clip cache
// never turns one row's render into another row's free replay.

const hoisted = vi.hoisted(() => ({
	KEY: "brain-key-for-the-failure-matrix-0123456789",
	log: vi.fn(async () => undefined),
	state: {
		config: null as Record<string, unknown> | null,
		spend: new Map<string, { estimatedCents: number; ttsChars: number; sttSeconds: number }>(),
		ttsFetch: (async () => new Response(null, { status: 500 })) as (url: string, init: RequestInit) => Promise<Response>,
		sessions: null as unknown,
	},
}));

// The admin role read is a GuildConfig lookup; null keeps these suites on the allowlist only rule.
vi.mock("@features/dero-brain/speakerAdminRole.js", () => ({ readSpeakerAdminRoleId: vi.fn(async () => null) }));
vi.mock("@utils/config.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	deroBrainKey: hoisted.KEY,
	elevenLabsApiKey: "",
}));
vi.mock("@db/stores/botLogStore.js", () => ({ botLogStore: { log: hoisted.log } }));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: async (guildId: string) => ({ guildId }) } }));
// Voice switched off routes /dero join to the switch (2026-10 item 257): the launcher's
// own tests cover the admin's panel; here the member's answer stands in for it.
vi.mock("@features/command-buttons/adminCommandLauncher.js", () => ({
	offerSwitchFix: vi.fn(async (interaction: { reply: (options: { content: string }) => Promise<unknown> }, fix: { memberSections: string[] }) => {
		await interaction.reply({ content: fix.memberSections.join(" ") });
	}),
}));
vi.mock("@db/stores/deroVoiceConfigStore.js", () => ({
	deroVoiceConfigStore: {
		findByGuildId: async (guildId: string) => {
			const config = hoisted.state.config;
			return config && config.guildId === guildId ? { ...config } : null;
		},
		upsert: async (_guildId: string, patch: Record<string, unknown>) => {
			Object.assign(hoisted.state.config ?? {}, patch);
			return { ...hoisted.state.config };
		},
	},
}));
// The meter's one atomic write, in memory: the same filter (the month's estimate
// plus this amount must fit under the cap) the real findOneAndUpdate carries.
vi.mock("@db/stores/deroVoiceSpendStore.js", () => {
	const rows = hoisted.state.spend;
	const key = (guildId: string, month: string) => `${guildId}:${month}`;
	return {
		deroVoiceSpendStore: {
			findMonth: async (guildId: string, month: string) => {
				const row = rows.get(key(guildId, month));
				return row ? { guildId, month, ...row } : null;
			},
			ensureMonth: async (guildId: string, month: string) => {
				if (!rows.has(key(guildId, month))) rows.set(key(guildId, month), { estimatedCents: 0, ttsChars: 0, sttSeconds: 0 });
			},
			reserve: async (guildId: string, month: string, capCents: number, usage: { cents: number; ttsChars: number; sttSeconds?: number }) => {
				const row = rows.get(key(guildId, month));
				if (!row || row.estimatedCents > capCents - usage.cents) return null;
				row.estimatedCents += usage.cents;
				row.ttsChars += usage.ttsChars;
				row.sttSeconds += usage.sttSeconds ?? 0;
				return { guildId, month, ...row };
			},
			refund: async (guildId: string, month: string, usage: { cents: number; ttsChars: number; sttSeconds?: number }) => {
				const row = rows.get(key(guildId, month));
				if (!row) return;
				row.estimatedCents -= usage.cents;
				row.ttsChars -= usage.ttsChars;
				row.sttSeconds -= usage.sttSeconds ?? 0;
			},
		},
	};
});
// The real ElevenLabs client, pointed at a fake fetch the row controls.
vi.mock("@features/voice/elevenLabsTts.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./elevenLabsTts.js")>();
	return {
		...actual,
		elevenLabsTts: actual.createElevenLabsTts({ apiKey: "test-key", fetchImpl: (url, init) => hoisted.state.ttsFetch(url, init) }),
		isTtsKeyConfigured: () => true,
	};
});
// Every consumer of the process wide session map (the executor, Listen,
// /dero-config, the dealer) reaches the row's own real instance through this.
vi.mock("@features/voice/voiceSessions.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./voiceSessions.js")>();
	const current = () => hoisted.state.sessions as ReturnType<typeof actual.createVoiceSessions>;
	return {
		...actual,
		voiceSessions: {
			get: (guildId: string) => current().get(guildId),
			join: (input: Parameters<ReturnType<typeof actual.createVoiceSessions>["join"]>[0]) => current().join(input),
			leave: (guildId: string, reason?: Parameters<ReturnType<typeof actual.createVoiceSessions>["leave"]>[1]) => current().leave(guildId, reason),
			leaveAll: () => current().leaveAll(),
			useListener: (factory: Parameters<ReturnType<typeof actual.createVoiceSessions>["useListener"]>[0]) => current().useListener(factory),
			stats: () => current().stats(),
		},
	};
});

import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { BOT_LOG_EVENTS } from "@base/constants/BOT_LOG_EVENTS.js";
import { CooldownManager } from "@utils/cooldownManager.js";
import { NO_PINGS } from "@utils/mentions.js";
import { deroVoiceConfigStore } from "@db/stores/deroVoiceConfigStore.js";
import { brainBodyErrorHandler, createBrainRouter } from "@api/routes/brain.routes.js";
import { createBrainQueue, type BrainQueue, type BrainQueueClock } from "@features/dero-brain/brainQueue.js";
import { runBrainTurn } from "@features/dero-brain/brainTurn.js";
import type { BrainResult } from "@features/dero-brain/brainTypes.js";
import { defaultExecutorVoiceDeps, executeActions } from "@features/dero-brain/executor.js";
import { deroBrainCopy } from "@features/dero-brain/deroBrainCopy.js";
import { createHoldemRequest, _clearHoldemRequests } from "@features/dero-brain/holdemRequests.js";
import { handleRulesCardButton, HOLDEM_CARD_PREFIX } from "@features/dero-brain/holdemRulesCard.js";
import {
	announceDealer,
	dealerTableOf,
	defaultDealerDeps,
	registerDealerTable,
	toPublicView,
	_clearDealerTables,
	type DealerDeps,
} from "@features/dero-brain/dealerNarration.js";
import { act, actionsFor, createTable, dealHand, handInProgress, joinTable, whoActs, type HoldemTable } from "@features/games/holdemTable.js";
import { execute as deroCommand } from "@commands/utility/dero.js";
import { execute as deroConfigCommand } from "@commands/admin/dero-config.js";
import { createElevenLabsStt } from "./elevenLabsStt.js";
import { postVoiceNotice } from "./joinNotice.js";
import { handleListen } from "./listenHandler.js";
import { monthKey } from "./spendMeter.js";
import { createLatencyLog } from "./turnLatency.js";
import { createTurnLoop, defaultTurnLoopDeps, type TurnLoop, type Utterance } from "./turnLoop.js";
import { createVoiceSessions, defaultVoiceSessionDeps, type VoiceSessionDeps, type VoiceSessions } from "./voiceSessions.js";
import { createVoiceSessionWatcher } from "./voiceSessionWatchers.js";
import { voiceCopy } from "./voiceCopy.js";

// ── ids ──

const GUILD_ID = "100000000000000001";
const OWNER_ID = "300000000000000001";
const SPEAKER_ID = "300000000000000002";
const SECOND_SPEAKER_ID = "300000000000000003";
const BOT_ID = "300000000000000009";
const ROLE = "400000000000000001";
const GENERAL = "200000000000000001";
const NOT_LISTED = "200000000000000002";
const CONTROL = "200000000000000003";
const VC = "200000000000000004";
const OTHER_VC = "200000000000000005";
const TASK = "Dero, send hello world with an emoji in general";
const CAP_CENTS = 2500;
const UTTERANCE_MS = 2000;
const PCM_48K_STEREO_BYTES_PER_MS = 192;

// ── a fake voice connection (the same contract voiceSessions.test.ts uses) ──

class FakeConnection extends EventEmitter {
	state: { status: VoiceConnectionStatus; reason?: VoiceConnectionDisconnectReason; closeCode?: number } = {
		status: VoiceConnectionStatus.Signalling,
	};
	rejoinCalls = 0;
	destroyCalls = 0;
	receiver = { fake: "receiver" };

	subscribe(): object {
		return {};
	}

	rejoin(): boolean {
		this.rejoinCalls += 1;
		this.setStatus(VoiceConnectionStatus.Signalling);
		return true;
	}

	destroy(): void {
		this.destroyCalls += 1;
		this.setStatus(VoiceConnectionStatus.Destroyed);
	}

	setStatus(status: VoiceConnectionStatus, extra: Partial<FakeConnection["state"]> = {}): void {
		const oldState = this.state;
		this.state = { status, ...extra };
		this.emit("stateChange", oldState, this.state);
		this.emit(status, oldState, this.state);
	}

	drop(closeCode = 4006): void {
		this.setStatus(VoiceConnectionStatus.Disconnected, { reason: VoiceConnectionDisconnectReason.WebSocketClose, closeCode });
	}
}

function fakeWaitForStatus(connection: VoiceConnection, status: VoiceConnectionStatus, timeoutMs: number, signal: AbortSignal): Promise<boolean> {
	const fake = connection as unknown as FakeConnection;
	if (fake.state.status === status) return Promise.resolve(true);
	return new Promise((resolve) => {
		const finish = (reached: boolean): void => {
			clearTimeout(timer);
			fake.off(status, onStatus);
			signal.removeEventListener("abort", onAbort);
			resolve(reached);
		};
		const onStatus = (): void => finish(true);
		const onAbort = (): void => finish(false);
		const timer = setTimeout(() => finish(false), timeoutMs);
		fake.on(status, onStatus);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

// ── a manual clock for the brain queue: timeouts fire only when a row says so ──

function manualClock() {
	let now = Date.now();
	let seq = 0;
	const timers = new Map<number, { at: number; callback: () => void }>();
	const clock: BrainQueueClock = {
		now: () => now,
		setTimeout: (callback, ms) => {
			seq += 1;
			timers.set(seq, { at: now + ms, callback });
			return seq;
		},
		clearTimeout: (handle) => {
			timers.delete(handle as number);
		},
	};
	return {
		clock,
		advance(ms: number): void {
			now += ms;
			for (const [id, timer] of [...timers]) {
				if (timer.at > now) continue;
				timers.delete(id);
				timer.callback();
			}
		},
	};
}

// ── the world one row runs in ──

let voiceSeq = 0;

function textChannel(id: string, name: string) {
	return {
		id,
		name,
		guildId: GUILD_ID,
		type: ChannelType.GuildText,
		isSendable: () => true,
		send: vi.fn(async () => ({ id: "message-1" })),
		permissionsFor: () => ({ has: () => true }),
	};
}

function fakeMember(id: string, roles: string[]) {
	return { id, displayName: `Member ${id.slice(-1)}`, user: { bot: false }, guild: { id: GUILD_ID }, roles: { cache: new Set(roles) } };
}

interface FakeSpeaker {
	player: object;
	closed: boolean;
	speak: ReturnType<typeof vi.fn>;
	stop: ReturnType<typeof vi.fn>;
	close: ReturnType<typeof vi.fn>;
	status: "idle";
	lastOwnLineEndedAt: number | null;
}

function makeWorld() {
	const general = textChannel(GENERAL, "general");
	const notListed = textChannel(NOT_LISTED, "secret-plans");
	const control = textChannel(CONTROL, "lobby");
	const guild = {
		id: GUILD_ID,
		name: "Guild",
		ownerId: OWNER_ID,
		channels: { cache: new Map([general, notListed, control].map((channel) => [channel.id, channel])) },
		members: { me: { id: BOT_ID } },
		voiceAdapterCreator: () => ({}),
	} as unknown as Guild;

	const members = new Map<string, ReturnType<typeof fakeMember> | null>([
		[SPEAKER_ID, fakeMember(SPEAKER_ID, [ROLE])],
		[SECOND_SPEAKER_ID, fakeMember(SECOND_SPEAKER_ID, [ROLE])],
	]);
	const fetchMember = vi.fn(async (_guild: Guild, userId: string) => (members.get(userId) ?? null) as unknown as GuildMember | null);

	const voiceId = `voice${String(++voiceSeq).padStart(12, "0")}`;
	hoisted.state.config = {
		guildId: GUILD_ID,
		enabled: true,
		voiceId,
		listenEnabled: true,
		allowedRoleIds: [ROLE],
		allowedChannelIds: [GENERAL],
		allowedVoiceChannelIds: [VC],
		monthlyCapUsd: CAP_CENTS / 100,
	};
	hoisted.state.spend.clear();

	// Speech out: every successful render records the text it was asked for.
	const tts = { status: 200, calls: 0, rendered: [] as string[] };
	hoisted.state.ttsFetch = async (_url, init) => {
		tts.calls += 1;
		if (tts.status !== 200) return new Response("provider says no", { status: tts.status });
		tts.rendered.push(String((JSON.parse(String(init.body)) as { text: string }).text));
		return new Response(new Uint8Array(480), { status: 200 });
	};
	// Speech in: one transcript, or a failing status.
	const stt = { status: 200, calls: 0, transcripts: [TASK] as string[] };
	const sttFetch = async (): Promise<Response> => {
		stt.calls += 1;
		if (stt.status !== 200) return new Response("provider says no", { status: stt.status });
		const text = stt.transcripts.length > 1 ? stt.transcripts.shift() : stt.transcripts[0];
		return new Response(JSON.stringify({ text }), { status: 200, headers: { "content-type": "application/json" } });
	};

	const queueClock = manualClock();
	const queue = createBrainQueue({ clock: queueClock.clock });

	const connections: FakeConnection[] = [];
	const speakers: FakeSpeaker[] = [];
	const sessionDeps: VoiceSessionDeps = {
		...defaultVoiceSessionDeps,
		joinChannel: () => {
			const connection = new FakeConnection();
			connections.push(connection);
			return connection as unknown as VoiceConnection;
		},
		waitForStatus: fakeWaitForStatus,
		createSpeaker: () => {
			const speaker: FakeSpeaker = {
				player: {},
				closed: false,
				speak: vi.fn(() => (speaker.closed ? "dropped" : "playing")),
				stop: vi.fn(),
				close: vi.fn(() => {
					speaker.closed = true;
				}),
				status: "idle",
				lastOwnLineEndedAt: null,
			};
			speakers.push(speaker);
			return speaker as unknown as ReturnType<VoiceSessionDeps["createSpeaker"]>;
		},
		postNotice: postVoiceNotice,
		dependencyReport: () => "dependency report",
		now: () => Date.now(),
	};
	const sessions: VoiceSessions = createVoiceSessions(sessionDeps);
	hoisted.state.sessions = sessions;

	// The listener factory, as main.ts registers it: a Ready call makes its turn
	// loop, and ending the call closes it. The row submits utterances to it.
	const world = {
		guild,
		general,
		notListed,
		control,
		members,
		fetchMember,
		voiceId,
		tts,
		stt,
		queue,
		queueClock,
		sessions,
		sessionDeps,
		connections,
		speakers,
		loop: null as TurnLoop | null,
	};
	sessions.useListener((start) => {
		const loop = createTurnLoop(
			{ guild: start.guild, channelId: start.channelId, controlChannelId: start.controlChannelId, speaker: start.speaker },
			{
				...defaultTurnLoopDeps,
				findMember: async (_guild, userId) => (members.get(userId) ?? null) as unknown as GuildMember | null,
				stt: createElevenLabsStt({ apiKey: "test-key", fetchImpl: sttFetch }),
				runTurn: (input) =>
					runBrainTurn(input, {
						queue,
						loadConfig: (id) => deroVoiceConfigStore.findByGuildId(id),
						// #general stands in for 💬dero-commands, the one task channel (2026-10 item 263 Phase 4b).
						loadTaskChannelIds: async () => [GENERAL],
						execute: (exec) => executeActions({ ...exec, deps: { fetchMember, loadTaskChannelIds: async () => [GENERAL], voice: defaultExecutorVoiceDeps } }),
						now: () => Date.now(),
					}),
				latency: createLatencyLog(),
				troubleCooldown: new CooldownManager(BOT_CONSTANTS.DERO_VOICE_TROUBLE_LINE_COOLDOWN_MS),
			},
		);
		world.loop = loop;
		return { stop: () => loop.close() };
	});
	return world;
}

type World = ReturnType<typeof makeWorld>;

async function joinCall(world: World) {
	const pending = world.sessions.join({ guild: world.guild, channel: { id: VC }, controlChannelId: CONTROL });
	(world.connections.at(-1) as FakeConnection).setStatus(VoiceConnectionStatus.Ready);
	const outcome = await pending;
	if (outcome.status !== "joined") throw new Error(`join failed: ${outcome.status}`);
	return { session: outcome.session, connection: world.connections.at(-1) as FakeConnection, speaker: world.speakers.at(-1) as FakeSpeaker };
}

function utterance(speakerId = SPEAKER_ID): Utterance {
	return {
		speakerId,
		pcm48kStereo: Buffer.alloc(UTTERANCE_MS * PCM_48K_STEREO_BYTES_PER_MS),
		durationMs: UTTERANCE_MS,
		speechEndedAt: Date.now(),
	};
}

// ── reading what happened ──

const rowsOf = (event: string): Record<string, unknown>[] =>
	hoisted.log.mock.calls.filter((call) => call[1] === event).map((call) => call[2] as Record<string, unknown>);

async function turnsAudited(count: number): Promise<Record<string, unknown>[]> {
	await vi.waitFor(() => expect(rowsOf(BOT_LOG_EVENTS.DERO_VOICE_TURN)).toHaveLength(count));
	return rowsOf(BOT_LOG_EVENTS.DERO_VOICE_TURN);
}

const postsIn = (channel: { send: ReturnType<typeof vi.fn> }): string[] =>
	channel.send.mock.calls.map((call) => String((call[0] as { content: string }).content));

const spendRow = () => hoisted.state.spend.get(`${GUILD_ID}:${monthKey(new Date())}`);

function seedSpend(estimatedCents: number): void {
	hoisted.state.spend.set(`${GUILD_ID}:${monthKey(new Date())}`, { estimatedCents, ttsChars: 0, sttSeconds: 0 });
}

const ok = (jobId: string, actions: BrainResult["actions"]): BrainResult => ({ jobId, status: "ok", actions });

/** The launcher's side of one turn: poll, then answer whatever job arrives. */
async function brainAnswers(queue: BrainQueue, answer: (jobId: string) => BrainResult): Promise<string> {
	const job = await queue.next(BOT_CONSTANTS.DERO_BRAIN_MAX_POLL_WAIT_MS);
	if (!job) throw new Error("no job reached the brain");
	queue.submitResult(job.jobId, answer(job.jobId));
	return job.jobId;
}

/** Run one voice turn with the brain answering, and return its audit row. */
async function voiceTurn(world: World, answer: (jobId: string) => BrainResult): Promise<Record<string, unknown>> {
	const brain = brainAnswers(world.queue, answer);
	expect(world.loop?.submit(utterance())).toBe("started");
	await brain;
	const [row] = await turnsAudited(1);
	return row;
}

beforeEach(() => {
	hoisted.log.mockClear();
	_clearHoldemRequests();
	_clearDealerTables();
	vi.spyOn(console, "info").mockImplementation(() => undefined);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	// Nothing in a row may reach the real network.
	vi.stubGlobal("fetch", vi.fn(async () => {
		throw new Error("the failure matrix made a real network call");
	}));
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

// ── the brain ──────────────────────────────────────────────────────────────

describe("the brain", () => {
	it("offline, by voice: Dero says so aloud, no job is made, the turn is audited offline", async () => {
		const world = makeWorld();
		await joinCall(world);
		world.loop?.submit(utterance());
		const [row] = await turnsAudited(1);

		expect(world.tts.rendered).toEqual([voiceCopy.turn.spoken.brainOffline]);
		expect(row).toMatchObject({ outcome: "offline", jobId: null, delivery: "playing" });
		expect(world.queue.openJobCount()).toBe(0);
	});

	it("offline, by /dero tell: a plain private line and a DERO_BRAIN_ACTION row with no job", async () => {
		makeWorld();
		const reply = vi.fn(async () => undefined);
		const interaction = {
			guildId: GUILD_ID,
			inCachedGuild: () => true,
			guild: { id: GUILD_ID, ownerId: OWNER_ID, name: "Guild" },
			member: fakeMember(SPEAKER_ID, [ROLE]),
			options: { getSubcommand: () => "tell", getString: () => TASK },
			replied: false,
			deferred: false,
			reply,
			deferReply: vi.fn(),
			editReply: vi.fn(),
		} as unknown as ChatInputCommandInteraction;
		await deroCommand(interaction);

		// Dero offline and an expired card are states: the notice's private fallback is plain text (owner rule 1, Phase 1c).
		expect((reply.mock.calls[0] as unknown as [{ content: string }])[0].content).toContain(deroBrainCopy.tell.brainOffline);
		expect(rowsOf(BOT_LOG_EVENTS.DERO_BRAIN_ACTION)).toEqual([
			{ jobId: null, channels: 0, outcome: "offline", speakerId: SPEAKER_ID, source: "text" },
		]);
	});

	it("busy: Dero says it is busy, the turn is audited busy", async () => {
		const world = makeWorld();
		await joinCall(world);
		const row = await voiceTurn(world, (jobId) => ({ jobId, status: "busy", actions: [] }));
		expect(world.tts.rendered).toEqual([voiceCopy.turn.spoken.busy]);
		expect(row).toMatchObject({ outcome: "busy" });
	});

	it("timeout: after 20 seconds with no answer Dero says it took too long, and the job is gone", async () => {
		const world = makeWorld();
		await joinCall(world);
		const delivered = world.queue.next(BOT_CONSTANTS.DERO_BRAIN_MAX_POLL_WAIT_MS);
		world.loop?.submit(utterance());
		const job = await delivered;
		world.queueClock.advance(BOT_CONSTANTS.DERO_BRAIN_TURN_TIMEOUT_MS);
		const [row] = await turnsAudited(1);

		expect(world.tts.rendered).toEqual([voiceCopy.turn.spoken.timeout]);
		expect(row).toMatchObject({ outcome: "timeout", jobId: job?.jobId });
		expect(world.queue.submitResult(job?.jobId ?? "", ok(job?.jobId ?? "", []))).toBe("not_found");
	});

	it("an invalid result: the route answers 400, audits DERO_BRAIN_REJECTED, and Dero says it did not understand", async () => {
		const world = makeWorld();
		await joinCall(world);
		const app = express();
		app.use(express.json({ verify: (req, _res, buf) => ((req as express.Request).rawBody = buf.toString("utf8")) }));
		app.use("/brain", createBrainRouter({ queue: world.queue }));
		app.use("/brain", brainBodyErrorHandler);

		const delivered = world.queue.next(BOT_CONSTANTS.DERO_BRAIN_MAX_POLL_WAIT_MS);
		world.loop?.submit(utterance());
		const job = await delivered;
		const body = JSON.stringify({ jobId: job?.jobId, status: "ok", actions: [{ type: "ban_member", userId: OWNER_ID }] });
		const timestamp = String(Date.now());
		const bodyHash = createHash("sha256").update(body, "utf8").digest("hex");
		const signature = createHmac("sha256", hoisted.KEY).update(`POST\n/brain/result\n${timestamp}\n${bodyHash}`, "utf8").digest("hex");
		const response = await request(app)
			.post("/brain/result")
			.set({ "Content-Type": "application/json", "x-timestamp": timestamp, "x-signature": signature })
			.send(body);
		const [row] = await turnsAudited(1);

		expect(response.status).toBe(400);
		expect(rowsOf(BOT_LOG_EVENTS.DERO_BRAIN_REJECTED)).toEqual([expect.objectContaining({ jobId: job?.jobId, reason: expect.any(String) })]);
		expect(row.outcome).toMatch(/^rejected:/);
		expect(world.tts.rendered).toEqual([voiceCopy.turn.spoken.notUnderstood]);
	});

	it("a rejected action: a post to a channel off the allowlist is refused with zero Discord calls, and Dero says why", async () => {
		const world = makeWorld();
		await joinCall(world);
		const row = await voiceTurn(world, (jobId) => ok(jobId, [{ type: "post_message", channelId: NOT_LISTED, text: "hello world 👋" }]));

		expect(row).toMatchObject({ outcome: "ok", actions: ["post_message:channel_not_allowed"], delivery: "summary" });
		expect(world.tts.rendered).toEqual(["Dero is not allowed to post in that channel."]);
		expect(world.notListed.send).not.toHaveBeenCalled();
		expect(world.general.send).not.toHaveBeenCalled();
		expect(world.fetchMember).not.toHaveBeenCalled();
	});
});

// ── the spend cap ──────────────────────────────────────────────────────────

describe("the spend cap", () => {
	it("reached on text to speech: nothing is rendered, the answer is posted in text instead", async () => {
		const world = makeWorld();
		await joinCall(world);
		// One cent of room: the utterance's speech to text takes it, then every render is refused.
		seedSpend(CAP_CENTS - 1);
		const row = await voiceTurn(world, (jobId) => ok(jobId, [{ type: "say", text: "Hello everyone, I am Dero." }]));

		expect(world.tts.calls).toBe(0);
		expect(row).toMatchObject({ outcome: "ok", actions: ["say:cap_reached"], delivery: "posted" });
		expect(postsIn(world.control)).toEqual([`${voiceCopy.turn.text.voiceTrouble}\n${deroBrainCopy.result.sayCapReached}`]);
		expect(spendRow()?.estimatedCents).toBe(CAP_CENTS);
	});

	it("reached on speech to text: the audio is never sent, the budget line is posted, no job is made", async () => {
		const world = makeWorld();
		await joinCall(world);
		seedSpend(CAP_CENTS);
		world.loop?.submit(utterance());
		const [row] = await turnsAudited(1);

		expect(world.stt.calls).toBe(0);
		expect(world.tts.calls).toBe(0);
		expect(row).toMatchObject({ outcome: "cap_reached", delivery: "posted" });
		expect(postsIn(world.control)).toEqual([voiceCopy.turn.text.capReached]);
		expect(world.queue.openJobCount()).toBe(0);
	});
});

// ── the speech provider, both directions ───────────────────────────────────

describe("ElevenLabs failures", () => {
	it.each([
		[401, "auth"],
		[429, "rateLimit"],
		[500, "providerDown"],
	])("speech to text answers %i: one call, no retry, refunded, and Dero asks to hear it again", async (status, kind) => {
		const world = makeWorld();
		await joinCall(world);
		world.stt.status = status;
		world.loop?.submit(utterance());
		const [row] = await turnsAudited(1);

		expect(world.stt.calls).toBe(1);
		expect(row).toMatchObject({ outcome: `stt_failed:${kind}`, delivery: "spoken" });
		expect(world.tts.rendered).toEqual([voiceCopy.turn.spoken.hearingTrouble]);
		// The refund left only the spoken line's own render on the meter.
		expect(spendRow()?.sttSeconds).toBe(0);
		expect(world.queue.openJobCount()).toBe(0);
	});

	it.each([
		[401, "auth", 2],
		[429, "rateLimit", 2],
		// A 5xx gets the client's one retry, for the say and again for the summary.
		[500, "providerDown", 4],
	])("text to speech answers %i: nothing is spoken, the answer is posted in text, every reservation refunded", async (status, kind, calls) => {
		const world = makeWorld();
		await joinCall(world);
		world.tts.status = status;
		const row = await voiceTurn(world, (jobId) => ok(jobId, [{ type: "say", text: "Hello everyone, I am Dero." }]));

		expect(world.tts.calls).toBe(calls);
		expect(row).toMatchObject({ outcome: "ok", actions: ["say:voice_failed"], delivery: "posted" });
		expect(postsIn(world.control)).toEqual([`${voiceCopy.turn.text.voiceTrouble}\n${deroBrainCopy.result.sayFailed}`]);
		expect(console.info).toHaveBeenCalledWith(expect.stringContaining(`outcome=failed:${kind}`));
		// Only the utterance's one cent of speech to text is left on the meter.
		expect(spendRow()).toMatchObject({ estimatedCents: 1, ttsChars: 0 });
	});
});

// ── what was heard ─────────────────────────────────────────────────────────

describe("transcripts too short to be a task", () => {
	it.each([
		["empty", ""],
		["one character", "a"],
	])("%s: silence on purpose, audited empty, nothing reaches the brain", async (_label, transcript) => {
		const world = makeWorld();
		await joinCall(world);
		world.stt.transcripts = [transcript];
		world.loop?.submit(utterance());
		const [row] = await turnsAudited(1);

		expect(row).toMatchObject({ outcome: "empty", transcriptChars: transcript.length });
		expect(world.tts.calls).toBe(0);
		expect(world.control.send).not.toHaveBeenCalled();
		expect(world.queue.openJobCount()).toBe(0);
	});
});

// ── the voice connection ───────────────────────────────────────────────────

describe("the voice connection", () => {
	it("drops and recovers by itself: the call carries on, no notice, no leave row, no rejoin", async () => {
		vi.useFakeTimers();
		const world = makeWorld();
		const { connection } = await joinCall(world);
		connection.drop();
		await vi.advanceTimersByTimeAsync(1_000);
		connection.setStatus(VoiceConnectionStatus.Connecting);
		connection.setStatus(VoiceConnectionStatus.Ready);
		await vi.advanceTimersByTimeAsync(BOT_CONSTANTS.DERO_VOICE_RECOVER_WINDOW_MS);

		expect(world.sessions.get(GUILD_ID)?.status).toBe("ready");
		expect(connection.rejoinCalls).toBe(0);
		expect(world.control.send).not.toHaveBeenCalled();
		expect(rowsOf(BOT_LOG_EVENTS.DERO_VOICE_LEFT)).toEqual([]);
	});

	it("drops and never recovers: 3 bounded rejoins, then a text notice and a clean destroy with no timer left", async () => {
		vi.useFakeTimers();
		const world = makeWorld();
		const { connection, speaker } = await joinCall(world);
		connection.drop();
		// The 5 s recover window, then three rejoins at 2, 4 and 8 s, each with a 20 s Ready wait.
		await vi.advanceTimersByTimeAsync(5_000 + (2_000 + 20_000) + (4_000 + 20_000) + (8_000 + 20_000));

		expect(connection.rejoinCalls).toBe(BOT_CONSTANTS.DERO_VOICE_MAX_RECONNECT_ATTEMPTS);
		expect(connection.destroyCalls).toBe(1);
		expect(speaker.close).toHaveBeenCalled();
		expect(world.sessions.get(GUILD_ID)).toBeNull();
		expect(postsIn(world.control)).toEqual([voiceCopy.call.reconnectFailed(VC, BOT_CONSTANTS.DERO_VOICE_MAX_RECONNECT_ATTEMPTS)]);
		expect(rowsOf(BOT_LOG_EVENTS.DERO_VOICE_LEFT)).toEqual([expect.objectContaining({ reason: "reconnect_failed", rejoins: 3 })]);
		expect(world.sessions.stats().rejoinsTotal).toBe(3);
		expect(vi.getTimerCount()).toBe(0);
		// Nothing more ever happens: the budget does not refill on a dead session.
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(connection.rejoinCalls).toBe(3);
	});

	it.each([
		["kicked (Dero's own voice state left every channel)", null, "removed"],
		["moved (Dero's own voice state is in another channel)", OTHER_VC, "moved"],
	])("%s: the call ends at once with its line and a leave row", async (_label, channelId, reason) => {
		const world = makeWorld();
		await joinCall(world);
		const watcher = createVoiceSessionWatcher({
			sessions: world.sessions,
			findConfig: (id) => deroVoiceConfigStore.findByGuildId(id),
			idleLeaveMs: BOT_CONSTANTS.DERO_VOICE_IDLE_LEAVE_MS,
		});
		const own = { guild: world.guild, id: BOT_ID, client: { user: { id: BOT_ID } } };
		await watcher.onVoiceStateUpdate({ ...own, channelId: VC } as unknown as VoiceState, { ...own, channelId } as unknown as VoiceState);

		const line = reason === "removed" ? voiceCopy.call.removed(VC) : voiceCopy.call.moved(VC);
		expect(world.sessions.get(GUILD_ID)).toBeNull();
		expect(postsIn(world.control)).toEqual([line]);
		expect(rowsOf(BOT_LOG_EVENTS.DERO_VOICE_LEFT)).toEqual([expect.objectContaining({ reason })]);
	});

	it("kicked, seen as a 4014 close that never comes back: removed, and never rejoined uninvited", async () => {
		vi.useFakeTimers();
		const world = makeWorld();
		const { connection } = await joinCall(world);
		connection.drop(4014);
		await vi.advanceTimersByTimeAsync(BOT_CONSTANTS.DERO_VOICE_RECOVER_WINDOW_MS);

		expect(connection.rejoinCalls).toBe(0);
		expect(postsIn(world.control)).toEqual([voiceCopy.call.removed(VC)]);
		expect(rowsOf(BOT_LOG_EVENTS.DERO_VOICE_LEFT)).toEqual([expect.objectContaining({ reason: "removed", rejoins: 0 })]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("the voice channel is deleted: the call ends with its line and a leave row", async () => {
		const world = makeWorld();
		await joinCall(world);
		const watcher = createVoiceSessionWatcher({
			sessions: world.sessions,
			findConfig: (id) => deroVoiceConfigStore.findByGuildId(id),
			idleLeaveMs: BOT_CONSTANTS.DERO_VOICE_IDLE_LEAVE_MS,
		});
		watcher.onChannelDelete({ isDMBased: () => false, guildId: GUILD_ID, id: VC } as unknown as Parameters<typeof watcher.onChannelDelete>[0]);

		expect(world.sessions.get(GUILD_ID)).toBeNull();
		expect(postsIn(world.control)).toEqual([voiceCopy.call.channelDeleted]);
		expect(rowsOf(BOT_LOG_EVENTS.DERO_VOICE_LEFT)).toEqual([expect.objectContaining({ reason: "channel_deleted" })]);
	});
});

// ── people and switches ────────────────────────────────────────────────────

describe("people and switches", () => {
	it("the speaker leaves mid turn: the executor's fresh read finds nobody, nothing is posted, Dero says why", async () => {
		const world = makeWorld();
		await joinCall(world);
		const row = await voiceTurn(world, (jobId) => {
			// Gone from the guild while the brain was thinking.
			world.members.set(SPEAKER_ID, null);
			return ok(jobId, [{ type: "post_message", channelId: GENERAL, text: "hello world 👋" }]);
		});

		expect(world.general.send).not.toHaveBeenCalled();
		expect(row).toMatchObject({ outcome: "ok", actions: ["post_message:not_authorized"] });
		expect(world.tts.rendered).toEqual([deroBrainCopy.result.notAuthorized]);
	});

	it("the kill switch flips mid call: Dero leaves at once with a text line, and the running turn renders nothing more", async () => {
		const world = makeWorld();
		const { connection, speaker } = await joinCall(world);
		const delivered = world.queue.next(BOT_CONSTANTS.DERO_BRAIN_MAX_POLL_WAIT_MS);
		world.loop?.submit(utterance());
		const job = await delivered;

		const reply = vi.fn(async () => undefined);
		const startedAt = Date.now();
		await deroConfigCommand({
			guildId: GUILD_ID,
			user: { id: OWNER_ID },
			reply,
			options: { getSubcommandGroup: () => null, getSubcommand: () => "disable" },
		} as unknown as ChatInputCommandInteraction);
		const elapsedMs = Date.now() - startedAt;

		expect(elapsedMs).toBeLessThan(5_000);
		expect(world.sessions.get(GUILD_ID)).toBeNull();
		expect(connection.destroyCalls).toBe(1);
		expect(postsIn(world.control)).toEqual([voiceCopy.call.switchedOff(VC)]);
		expect(rowsOf(BOT_LOG_EVENTS.DERO_VOICE_LEFT)).toEqual([expect.objectContaining({ reason: "switched_off" })]);
		const adminReply = (reply.mock.calls[0] as unknown as [{ embeds: EmbedBuilder[] }])[0].embeds[0];
		expect(adminReply.data.description).toContain(voiceCopy.config.leftCall(VC));

		// The brain answers after the switch: the executor's fresh read refuses,
		// and the closed call gets no render and no further post.
		const rendersBefore = world.tts.calls;
		world.queue.submitResult(job?.jobId ?? "", ok(job?.jobId ?? "", [{ type: "post_message", channelId: GENERAL, text: "hello world 👋" }]));
		const [row] = await turnsAudited(1);
		expect(row).toMatchObject({ outcome: "ok", actions: ["post_message:switched_off"], delivery: "call_ended" });
		expect(world.general.send).not.toHaveBeenCalled();
		expect(world.tts.calls).toBe(rendersBefore);
		expect(speaker.speak).not.toHaveBeenCalled();
		expect(postsIn(world.control)).toHaveLength(1);
	});

	it("two members on the task list speak at once: one turn at a time, both answered in order", async () => {
		const world = makeWorld();
		await joinCall(world);
		world.stt.transcripts = ["Dero, post one in general", "Dero, post two in general"];
		const brain = (async () => {
			await brainAnswers(world.queue, (jobId) => ok(jobId, [{ type: "post_message", channelId: GENERAL, text: "one" }]));
			await brainAnswers(world.queue, (jobId) => ok(jobId, [{ type: "post_message", channelId: GENERAL, text: "two" }]));
		})();
		expect(world.loop?.submit(utterance(SPEAKER_ID))).toBe("started");
		expect(world.loop?.submit(utterance(SECOND_SPEAKER_ID))).toBe("queued");
		await brain;
		const rows = await turnsAudited(2);

		expect(rows.map((row) => row.speakerId)).toEqual([SPEAKER_ID, SECOND_SPEAKER_ID]);
		expect(rows.every((row) => row.outcome === "ok")).toBe(true);
		expect(postsIn(world.general)).toEqual(["one", "two"]);
		expect(world.speakers[0].speak).toHaveBeenCalledTimes(2);
		expect(world.stt.calls).toBe(2);
	});
});

// ── the launcher and restarts ──────────────────────────────────────────────

describe("the launcher and restarts", () => {
	it("the launcher stops mid long poll: the slot frees, the waiting turn times out, then Dero reads as offline", async () => {
		const world = makeWorld();
		await joinCall(world);
		const hangUp = new AbortController();
		const poll = world.queue.next(BOT_CONSTANTS.DERO_BRAIN_MAX_POLL_WAIT_MS, hangUp.signal);
		hangUp.abort();
		expect(await poll).toBeNull();

		// Still inside the online window, so the turn makes a job nobody takes.
		world.loop?.submit(utterance());
		await vi.waitFor(() => expect(world.queue.openJobCount()).toBe(1));
		world.queueClock.advance(BOT_CONSTANTS.DERO_BRAIN_TURN_TIMEOUT_MS);
		const [timedOut] = await turnsAudited(1);
		expect(timedOut).toMatchObject({ outcome: "timeout" });

		// Past the 45 second window since the last poll: offline, and no job at all.
		world.queueClock.advance(BOT_CONSTANTS.DERO_BRAIN_ONLINE_WINDOW_MS);
		world.loop?.submit(utterance());
		const [, offline] = await turnsAudited(2);
		expect(offline).toMatchObject({ outcome: "offline", jobId: null });
		expect(world.tts.rendered).toEqual([voiceCopy.turn.spoken.timeout, voiceCopy.turn.spoken.brainOffline]);
		expect(world.queue.openJobCount()).toBe(0);
	});

	it("a Railway restart mid session: every call ends with no timer left, a waiting table card answers expired, the table plays on", async () => {
		vi.useFakeTimers();
		const world = makeWorld();
		await joinCall(world);
		const card = createHoldemRequest({ guildId: GUILD_ID, speakerId: SPEAKER_ID, terms: { maxSeats: 6, startingStack: 5000, smallBlind: 100, bigBlind: 200 } });
		const table = tableMidHand();

		// The old process: SIGTERM runs leaveAll.
		expect(world.sessions.leaveAll()).toBe(1);
		expect(rowsOf(BOT_LOG_EVENTS.DERO_VOICE_LEFT)).toEqual([expect.objectContaining({ reason: "shutdown" })]);
		expect(vi.getTimerCount()).toBe(0);

		// The new process: memory starts empty, the room row does not.
		_clearHoldemRequests();
		_clearDealerTables();
		const fresh = createVoiceSessions(world.sessionDeps);
		expect(fresh.get(GUILD_ID)).toBeNull();
		expect(fresh.stats()).toEqual({ guildIds: [], rejoinsTotal: 0 });

		const reply = vi.fn(async () => undefined);
		await handleRulesCardButton({
			customId: `${HOLDEM_CARD_PREFIX}:public:${card.id}`,
			guild: world.guild,
			user: { id: SPEAKER_ID },
			reply,
		} as unknown as ButtonInteraction);
		// Dero offline and an expired card are states: the notice's private fallback is plain text (owner rule 1, Phase 1c).
		expect((reply.mock.calls[0] as unknown as [{ content: string }])[0].content).toContain(deroBrainCopy.holdem.expired);

		const reloaded = JSON.parse(JSON.stringify(table)) as HoldemTable;
		playToHandEnd(reloaded);
		expect(handInProgress(reloaded)).toBe(false);
		expect(chipsOn(reloaded)).toBe(6 * 5000);
	});

	it("a restart mid hand: narration stops quietly, the table resumes from its row", async () => {
		const table = tableMidHand();
		const postText = vi.fn(async () => undefined);
		const render = vi.fn();
		const deps: DealerDeps = { sessionIn: () => null, loadConfig: async () => null, render, postText };
		const client = {} as Client;
		registerDealerTable({ roomId: "room-1", guildId: GUILD_ID, channelId: GENERAL, voice: true });
		announceDealer({ client, roomId: "room-1", before: toPublicView(createTable(0)), after: toPublicView(table) }, deps);
		await vi.waitFor(() => expect(postText).toHaveBeenCalled());
		const linesBefore = postText.mock.calls.length;

		_clearDealerTables();
		const reloaded = JSON.parse(JSON.stringify(table)) as HoldemTable;
		expect(() => playToHandEnd(reloaded, (before, after) => announceDealer({ client, roomId: "room-1", before, after }, deps))).not.toThrow();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(dealerTableOf("room-1")).toBeNull();
		expect(postText).toHaveBeenCalledTimes(linesBefore);
		expect(render).not.toHaveBeenCalled();
		expect(handInProgress(reloaded)).toBe(false);
		expect(chipsOn(reloaded)).toBe(6 * 5000);
	});
});

// ── privacy proof: what members are told, and what the switches stop ───────
// Phase 5's mechanical proof of two promises, on the same rig as the matrix:
// the join notice is posted on every join and says plainly what happens to a
// member's speech; and with the kill switch off or a cap of 0, no surface sends
// a single request to ElevenLabs in either direction.

function commandInteraction(world: World, sub: "join" | "leave") {
	const reply = vi.fn(async () => undefined);
	const editReply = vi.fn(async () => undefined);
	const voiceChannel = { id: VC, permissionsFor: () => ({ has: () => true }) };
	const interaction = {
		guildId: GUILD_ID,
		channelId: CONTROL,
		inCachedGuild: () => true,
		guild: world.guild,
		member: { ...fakeMember(SPEAKER_ID, [ROLE]), voice: { channel: voiceChannel, channelId: VC } },
		options: { getSubcommand: () => sub },
		replied: false,
		deferred: false,
		reply,
		deferReply: vi.fn(async () => undefined),
		editReply,
	} as unknown as ChatInputCommandInteraction;
	return { interaction, reply, editReply };
}

// /dero join as a member runs it. The clock steps past the per guild join
// cooldown first (Date only is faked), and the fake connection reaches Ready
// once the command has asked for it. The step only ever moves forward, because
// the cooldown lives in dero.ts for the whole file while each test's fake clock
// starts again from real time.
let joinClockMs = 0;
async function runJoinCommand(world: World) {
	joinClockMs = Math.max(Date.now(), joinClockMs) + BOT_CONSTANTS.DERO_VOICE_JOIN_COOLDOWN_MS + 1;
	vi.setSystemTime(joinClockMs);
	const before = world.connections.length;
	const command = commandInteraction(world, "join");
	const running = deroCommand(command.interaction);
	await vi.waitFor(() => expect(world.connections.length + command.reply.mock.calls.length).toBeGreaterThan(before));
	world.connections[before]?.setStatus(VoiceConnectionStatus.Ready);
	await running;
	return command;
}

const embedText = (mock: ReturnType<typeof vi.fn>): string => {
	const embed = (mock.mock.calls[0] as unknown as [{ embeds: EmbedBuilder[] }])[0].embeds[0];
	return embed.data.description ?? "";
};

describe("privacy proof: the join notice", () => {
	it("says listening, speech to text, not recorded and /dero leave", () => {
		const notice = voiceCopy.call.joinNotice(VC);
		for (const words of ["listening", "speech to text", "not recorded", "/dero leave"]) expect(notice).toContain(words);
	});

	it("is posted on every join, with no pings, before Dero says a word", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const world = makeWorld();
		await runJoinCommand(world);
		await deroCommand(commandInteraction(world, "leave").interaction);
		await runJoinCommand(world);

		const sends = world.control.send.mock.calls.map((call) => call[0] as { content: string; allowedMentions: unknown });
		const notices = sends.filter((message) => message.content === voiceCopy.call.joinNotice(VC));
		expect(notices).toHaveLength(2);
		for (const notice of notices) expect(notice.allowedMentions).toEqual(NO_PINGS);
		for (const [index, speaker] of world.speakers.entries()) {
			expect(world.control.send.mock.invocationCallOrder[index]).toBeLessThan(speaker.speak.mock.invocationCallOrder[0]);
		}
	});
});

describe("privacy proof: the kill switch and a cap of 0 stop every provider call", () => {
	const SWITCHES: Array<[string, (config: Record<string, unknown>) => void, "off" | "cap"]> = [
		["the kill switch", (config) => (config.enabled = false), "off"],
		["a cap of 0", (config) => (config.monthlyCapUsd = 0), "cap"],
	];

	it.each(SWITCHES)("%s: Listen, a voice turn, the brain's say, the dealer and /dero join make zero ElevenLabs calls", async (_label, flip, kind) => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const world = makeWorld();
		const { session } = await joinCall(world);
		// Flipped in the store directly, under a live call, so every surface has to
		// re-check for itself rather than rely on /dero-config ending the call.
		flip(hoisted.state.config as Record<string, unknown>);

		// Listen
		const listenReply = vi.fn(async () => undefined);
		await handleListen({
			guildId: GUILD_ID,
			user: { id: SPEAKER_ID },
			message: { content: "A fortune for you: the river is kind today.", embeds: [] },
			inCachedGuild: () => false,
			deferReply: vi.fn(async () => undefined),
			editReply: listenReply,
		} as unknown as ButtonInteraction);
		const listenLine = (listenReply.mock.calls[0] as unknown as [{ content: string }])[0].content;
		expect(listenLine).toBe(kind === "off" ? voiceCopy.listen.voiceOff : voiceCopy.listen.capReached);

		// A voice turn: nothing transcribed, nothing spoken.
		world.loop?.submit(utterance());
		const [turn] = await turnsAudited(1);
		expect(turn.outcome).toBe(kind === "off" ? "switched_off" : "cap_reached");

		// The brain's say, executed against a fresh read.
		const [say] = await executeActions({
			guild: world.guild,
			speakerId: SPEAKER_ID,
			actions: [{ type: "say", text: "Hello everyone, I am Dero." }],
			voiceConfig: await deroVoiceConfigStore.findByGuildId(GUILD_ID),
			deps: { fetchMember: world.fetchMember, voice: defaultExecutorVoiceDeps },
		});
		expect(say).toMatchObject(kind === "off" ? { outcome: "switched_off" } : { outcome: "cap_reached", line: deroBrainCopy.result.sayCapReached });

		// The dealer of a table opened from this call.
		const postText = vi.fn(async () => undefined);
		registerDealerTable({ roomId: "room-switch", guildId: GUILD_ID, channelId: GENERAL, voice: true });
		announceDealer(
			{ client: {} as Client, roomId: "room-switch", before: toPublicView(createTable(0)), after: toPublicView(tableMidHand()) },
			{ ...defaultDealerDeps, postText },
		);
		await vi.waitFor(() => expect(postText).toHaveBeenCalled());
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(session.speaker.speak).not.toHaveBeenCalled();

		// /dero join: refused outright when off; with a cap of 0 Dero joins in silence.
		world.sessions.leave(GUILD_ID);
		const join = await runJoinCommand(world);
		if (kind === "off") expect((join.reply.mock.calls[0] as unknown as [{ content: string }])[0].content).toContain(voiceCopy.call.voiceOffForMember[0]);
		else expect(embedText(join.editReply)).toBe(voiceCopy.call.joined.capReached(VC));

		expect(world.tts.calls).toBe(0);
		expect(world.stt.calls).toBe(0);
	});
});

// ── hold em helpers ──

function seededRng(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state * 1664525 + 1013904223) % 4294967296;
		return state / 4294967296;
	};
}

function tableMidHand(): HoldemTable {
	const table = createTable(5, { maxSeats: 6, startingStack: 5000, smallBlind: 100, bigBlind: 200 });
	for (let index = 0; index < 6; index++) joinTable(table, `p${index}`, `Player ${index}`);
	table.status = "playing";
	dealHand(table, seededRng(3));
	return table;
}

function playToHandEnd(table: HoldemTable, onChange?: (before: ReturnType<typeof toPublicView>, after: ReturnType<typeof toPublicView>) => void): void {
	const rng = seededRng(9);
	let guard = 0;
	while (handInProgress(table) && guard++ < 100) {
		const actor = whoActs(table) as string;
		const legal = actionsFor(table, actor).map((entry) => entry.action);
		const before = toPublicView(table);
		act(table, actor, legal.includes("check") ? "check" : "call", 0, rng);
		onChange?.(before, toPublicView(table));
	}
}

// Every chip on the table, the same total holdemTable.terms.test.ts conserves:
// the pot is the hand's commitments, so stacks plus commitments is the table.
function chipsOn(table: HoldemTable): number {
	return table.seats.reduce((sum, seat) => sum + seat.stack + seat.totalCommitted, 0);
}
