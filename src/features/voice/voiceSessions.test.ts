import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Guild } from "discord.js";
import { VoiceConnectionDisconnectReason, VoiceConnectionStatus, type VoiceConnection } from "@discordjs/voice";
import { BOT_LOG_EVENTS } from "@base/constants/BOT_LOG_EVENTS.js";
import { createVoiceSessions, type VoiceSessionDeps, type VoiceSessions } from "./voiceSessions.js";
import type { VoiceSpeaker } from "./voiceSpeaker.js";
import { voiceCopy } from "./voiceCopy.js";

// ── voice sessions ─────────────────────────────────────────────────────────
// The session state machine against a fake connection and fake timers: Ready
// within the limit or a clean teardown, one session per guild, the documented
// disconnect recovery, the bounded rejoin budget, the kick that is never
// rejoined, and leave / leaveAll clearing every timer. No real library call is
// made: every one goes through the injected deps.

const READY = VoiceConnectionStatus.Ready;

class FakeConnection extends EventEmitter {
	state: { status: VoiceConnectionStatus; reason?: VoiceConnectionDisconnectReason; closeCode?: number } = {
		status: VoiceConnectionStatus.Signalling,
	};
	rejoinCalls = 0;
	destroyCalls = 0;
	subscribed: unknown[] = [];

	subscribe(player: unknown): object {
		this.subscribed.push(player);
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

// entersState's contract: true at once when already there, true when the status
// arrives, false on the timeout or the session's abort.
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

interface Rig {
	sessions: VoiceSessions;
	connections: FakeConnection[];
	speakers: Array<{ player: object; close: ReturnType<typeof vi.fn> }>;
	joinChannel: ReturnType<typeof vi.fn>;
	postNotice: ReturnType<typeof vi.fn>;
	audit: ReturnType<typeof vi.fn>;
	dependencyReport: ReturnType<typeof vi.fn>;
}

function makeRig(): Rig {
	const connections: FakeConnection[] = [];
	const speakers: Rig["speakers"] = [];
	const joinChannel = vi.fn(() => {
		const connection = new FakeConnection();
		connections.push(connection);
		return connection as unknown as VoiceConnection;
	});
	const postNotice = vi.fn(async () => undefined);
	const audit = vi.fn();
	const dependencyReport = vi.fn(() => "dependency report");
	const deps: VoiceSessionDeps = {
		joinChannel,
		waitForStatus: fakeWaitForStatus,
		createSpeaker: () => {
			const speaker = { player: {}, close: vi.fn() };
			speakers.push(speaker);
			return speaker as unknown as VoiceSpeaker;
		},
		postNotice,
		audit,
		dependencyReport,
		now: () => Date.now(),
	};
	return { sessions: createVoiceSessions(deps), connections, speakers, joinChannel, postNotice, audit, dependencyReport };
}

const guildFor = (id: string): Guild => ({ id, voiceAdapterCreator: () => ({}) }) as unknown as Guild;

function startJoin(rig: Rig, guildId = "g1") {
	const outcome = rig.sessions.join({ guild: guildFor(guildId), channel: { id: `vc-${guildId}` }, controlChannelId: `text-${guildId}` });
	return { outcome, connection: rig.connections.at(-1) as FakeConnection };
}

async function joined(rig: Rig, guildId = "g1"): Promise<FakeConnection> {
	const { outcome, connection } = startJoin(rig, guildId);
	connection.setStatus(READY);
	expect((await outcome).status).toBe("joined");
	return connection;
}

const flush = (): Promise<void> => vi.advanceTimersByTimeAsync(0);

let rig: Rig;

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(console, "info").mockImplementation(() => undefined);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	rig = makeRig();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("join", () => {
	it("joins deafened, unmuted, with DAVE left at the library default", async () => {
		await joined(rig);
		const [options] = rig.joinChannel.mock.calls[0] as unknown as [Record<string, unknown>];
		expect(options).toMatchObject({ guildId: "g1", channelId: "vc-g1", selfDeaf: true, selfMute: false });
		expect(options).not.toHaveProperty("daveEncryption");
		expect(rig.connections[0].subscribed).toEqual([rig.speakers[0].player]);
	});

	it("reports the time to Ready and audits the join with ids and the duration only", async () => {
		const { outcome, connection } = startJoin(rig);
		await vi.advanceTimersByTimeAsync(1_500);
		connection.setStatus(READY);
		expect(await outcome).toMatchObject({ status: "joined", readyMs: 1_500 });
		expect(rig.audit).toHaveBeenCalledWith("g1", BOT_LOG_EVENTS.DERO_VOICE_JOINED, { channelId: "vc-g1", readyMs: 1_500 });
		expect(rig.sessions.get("g1")).toMatchObject({ channelId: "vc-g1", controlChannelId: "text-g1", status: "ready" });
	});

	it("tears the attempt down when Ready does not come within 20 seconds", async () => {
		const { outcome, connection } = startJoin(rig);
		await vi.advanceTimersByTimeAsync(19_999);
		expect(rig.sessions.get("g1")).not.toBeNull();
		await vi.advanceTimersByTimeAsync(1);

		expect(await outcome).toEqual({ status: "failed", reason: "ready_timeout" });
		expect(connection.destroyCalls).toBe(1);
		expect(rig.speakers[0].close).toHaveBeenCalled();
		expect(rig.sessions.get("g1")).toBeNull();
		expect(rig.audit).toHaveBeenCalledWith("g1", BOT_LOG_EVENTS.DERO_VOICE_LEFT, expect.objectContaining({ reason: "ready_timeout" }));
		expect(vi.getTimerCount()).toBe(0);
	});

	it("holds one session per guild, even while the first is still connecting", async () => {
		startJoin(rig);
		const second = await rig.sessions.join({ guild: guildFor("g1"), channel: { id: "vc-other" }, controlChannelId: "t" });
		expect(second).toEqual({ status: "alreadyInGuild", channelId: "vc-g1" });
		expect(rig.joinChannel).toHaveBeenCalledTimes(1);
	});

	it("keeps guilds apart and logs the dependency report once per process", async () => {
		await joined(rig, "g1");
		await joined(rig, "g2");
		expect(rig.sessions.get("g1")?.channelId).toBe("vc-g1");
		expect(rig.sessions.get("g2")?.channelId).toBe("vc-g2");
		expect(rig.dependencyReport).toHaveBeenCalledTimes(1);
	});

	it("leaves a disconnect before the first Ready to the join's own wait", async () => {
		const { outcome, connection } = startJoin(rig);
		connection.drop();
		await vi.advanceTimersByTimeAsync(20_000);
		expect(await outcome).toEqual({ status: "failed", reason: "ready_timeout" });
		expect(connection.rejoinCalls).toBe(0);
	});
});

describe("disconnect handling", () => {
	it("recovers without a rejoin when the connection re-enters connecting by itself", async () => {
		const connection = await joined(rig);
		connection.drop();
		expect(rig.sessions.get("g1")?.status).toBe("recovering");
		await vi.advanceTimersByTimeAsync(1_000);
		connection.setStatus(VoiceConnectionStatus.Connecting);
		connection.setStatus(READY);
		await flush();

		expect(rig.sessions.get("g1")?.status).toBe("ready");
		expect(connection.rejoinCalls).toBe(0);
		expect(connection.destroyCalls).toBe(0);
		expect(rig.postNotice).not.toHaveBeenCalled();
	});

	it("rejoins after the 5 second window with a doubling backoff", async () => {
		const connection = await joined(rig);
		connection.drop();
		await vi.advanceTimersByTimeAsync(5_000 + 1_999);
		expect(connection.rejoinCalls).toBe(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(connection.rejoinCalls).toBe(1);

		connection.setStatus(READY);
		await flush();
		expect(rig.sessions.get("g1")?.status).toBe("ready");
	});

	it("gives up after 3 failed rejoins, destroys the connection and says so in text", async () => {
		const connection = await joined(rig);
		connection.drop();
		// 5 s window, then (backoff + 20 s Ready wait) for each of 2, 4 and 8 s.
		await vi.advanceTimersByTimeAsync(5_000 + 22_000 + 24_000 + 27_999);
		expect(connection.rejoinCalls).toBe(3);
		expect(rig.sessions.get("g1")).not.toBeNull();
		await vi.advanceTimersByTimeAsync(1);

		expect(connection.destroyCalls).toBe(1);
		expect(rig.sessions.get("g1")).toBeNull();
		expect(rig.postNotice).toHaveBeenCalledWith(expect.objectContaining({ id: "g1" }), "text-g1", voiceCopy.call.reconnectFailed("vc-g1", 3));
		expect(rig.audit).toHaveBeenCalledWith("g1", BOT_LOG_EVENTS.DERO_VOICE_LEFT, expect.objectContaining({ reason: "reconnect_failed", rejoins: 3 }));
		expect(vi.getTimerCount()).toBe(0);
	});

	it("never rejoins after a 4014 close that did not come back, and says the call ended", async () => {
		const connection = await joined(rig);
		connection.drop(4014);
		await vi.advanceTimersByTimeAsync(5_000);

		expect(connection.rejoinCalls).toBe(0);
		expect(connection.destroyCalls).toBe(1);
		expect(rig.sessions.get("g1")).toBeNull();
		expect(rig.postNotice).toHaveBeenCalledWith(expect.anything(), "text-g1", voiceCopy.call.removed("vc-g1"));
	});

	it("rides out a 4014 that comes back by itself, which is a voice server change", async () => {
		const connection = await joined(rig);
		connection.drop(4014);
		connection.setStatus(VoiceConnectionStatus.Signalling);
		connection.setStatus(READY);
		await flush();
		expect(rig.sessions.get("g1")?.status).toBe("ready");
		expect(connection.destroyCalls).toBe(0);
	});

	it("spends one budget across a link that flaps without staying up", async () => {
		const connection = await joined(rig);
		for (const backoff of [2_000, 4_000, 8_000]) {
			connection.drop();
			await vi.advanceTimersByTimeAsync(5_000 + backoff);
			connection.setStatus(READY);
			await flush();
		}
		expect(connection.rejoinCalls).toBe(3);

		connection.drop();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(connection.rejoinCalls).toBe(3);
		expect(rig.sessions.get("g1")).toBeNull();
		expect(rig.postNotice).toHaveBeenCalledWith(expect.anything(), "text-g1", voiceCopy.call.reconnectFailed("vc-g1", 3));
	});

	it("earns a fresh budget after staying Ready for a minute", async () => {
		const connection = await joined(rig);
		for (const backoff of [2_000, 4_000]) {
			connection.drop();
			await vi.advanceTimersByTimeAsync(5_000 + backoff);
			connection.setStatus(READY);
			await flush();
		}
		await vi.advanceTimersByTimeAsync(60_000);

		connection.drop();
		await vi.advanceTimersByTimeAsync(5_000 + 2_000);
		expect(connection.rejoinCalls).toBe(3);
		connection.setStatus(READY);
		await flush();
		expect(rig.sessions.get("g1")?.status).toBe("ready");
	});

	it("forgets a session whose connection was destroyed elsewhere", async () => {
		const connection = await joined(rig);
		connection.destroy();
		expect(rig.sessions.get("g1")).toBeNull();
		expect(rig.audit).toHaveBeenCalledWith("g1", BOT_LOG_EVENTS.DERO_VOICE_LEFT, expect.objectContaining({ reason: "destroyed" }));
	});
});

describe("leave and leaveAll", () => {
	it("leave ends the call, closes the speaker and audits the reason", async () => {
		const connection = await joined(rig);
		expect(rig.sessions.leave("g1")).toBe(true);
		expect(connection.destroyCalls).toBe(1);
		expect(rig.speakers[0].close).toHaveBeenCalled();
		expect(rig.sessions.get("g1")).toBeNull();
		expect(rig.audit).toHaveBeenCalledWith("g1", BOT_LOG_EVENTS.DERO_VOICE_LEFT, expect.objectContaining({ reason: "left", channelId: "vc-g1" }));
		expect(rig.sessions.leave("g1")).toBe(false);
	});

	it("leave during a reconnect backoff clears every timer and never rejoins", async () => {
		const connection = await joined(rig);
		connection.drop();
		await vi.advanceTimersByTimeAsync(5_000 + 500);
		rig.sessions.leave("g1");
		await flush();
		expect(vi.getTimerCount()).toBe(0);

		await vi.advanceTimersByTimeAsync(100_000);
		expect(connection.rejoinCalls).toBe(0);
		expect(rig.postNotice).not.toHaveBeenCalled();
	});

	it("leave while connecting cancels the join at once", async () => {
		const { outcome, connection } = startJoin(rig);
		rig.sessions.leave("g1");
		expect(await outcome).toEqual({ status: "failed", reason: "left" });
		expect(connection.destroyCalls).toBe(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("leaveAll ends every guild's call for shutdown", async () => {
		const first = await joined(rig, "g1");
		const second = await joined(rig, "g2");
		expect(rig.sessions.leaveAll()).toBe(2);
		expect(first.destroyCalls).toBe(1);
		expect(second.destroyCalls).toBe(1);
		expect(rig.sessions.get("g1")).toBeNull();
		expect(rig.sessions.get("g2")).toBeNull();
		expect(rig.audit).toHaveBeenCalledWith("g2", BOT_LOG_EVENTS.DERO_VOICE_LEFT, expect.objectContaining({ reason: "shutdown" }));
		expect(rig.sessions.leaveAll()).toBe(0);
	});
});
