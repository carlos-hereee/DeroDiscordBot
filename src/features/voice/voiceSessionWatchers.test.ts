import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { DMChannel, NonThreadGuildBasedChannel, VoiceState } from "discord.js";
import type { IDeroVoiceConfig } from "@db/models/DeroVoiceConfig.js";
import { createVoiceSessionWatcher, type VoiceWatcherDeps } from "./voiceSessionWatchers.js";
import type { VoiceSessionView } from "./voiceSessions.js";

// ── voice session watchers ─────────────────────────────────────────────────
// Against fake voice states and fake timers: Dero leaves exactly two minutes
// after the last authorized member walks out, a returning authorized member
// cancels that, an unauthorized member keeps nothing alive, and Dero being
// moved, disconnected or having its channel deleted ends the call at once.

const GUILD_ID = "g1";
const OWNER_ID = "owner";
const BOT_ID = "dero";
const ROLE = "role-taskers";
const VC = "vc-call";
const IDLE_MS = 120_000;

interface FakeMember {
	id: string;
	user: { bot: boolean };
	guild: { id: string };
	roles: { cache: Set<string> };
}

const member = (id: string, roles: string[], bot = false): FakeMember => ({
	id,
	user: { bot },
	guild: { id: GUILD_ID },
	roles: { cache: new Set(roles) },
});

const CONFIG = { guildId: GUILD_ID, allowedRoleIds: [ROLE] } as unknown as IDeroVoiceConfig;

let inCall: FakeMember[];
let session: VoiceSessionView | null;
let deps: VoiceWatcherDeps & { leave: ReturnType<typeof vi.fn>; findConfig: ReturnType<typeof vi.fn> };

const voiceChannel = { isVoiceBased: () => true, members: { some: (test: (m: FakeMember) => boolean) => inCall.some(test) } };
const guild = { id: GUILD_ID, ownerId: OWNER_ID, channels: { cache: new Map([[VC, voiceChannel]]) } };
const client = { user: { id: BOT_ID } };

function state(id: string, channelId: string | null): VoiceState {
	return { id, channelId, guild, client } as unknown as VoiceState;
}

const newSession = (): VoiceSessionView => ({ guildId: GUILD_ID, channelId: VC, controlChannelId: "t", status: "ready" }) as unknown as VoiceSessionView;

function makeWatcher() {
	const leave = vi.fn(() => {
		session = null;
		return true;
	});
	const findConfig = vi.fn(async () => CONFIG);
	deps = { sessions: { get: () => session, leave }, findConfig, idleLeaveMs: IDLE_MS, leave };
	return createVoiceSessionWatcher(deps);
}

// A member walks out of the call, or into it, as the gateway reports it.
async function walkOut(watcher: ReturnType<typeof makeWatcher>, who: FakeMember): Promise<void> {
	inCall = inCall.filter((m) => m !== who);
	await watcher.onVoiceStateUpdate(state(who.id, VC), state(who.id, null));
}

async function walkIn(watcher: ReturnType<typeof makeWatcher>, who: FakeMember): Promise<void> {
	inCall = [...inCall, who];
	await watcher.onVoiceStateUpdate(state(who.id, null), state(who.id, VC));
}

beforeEach(() => {
	vi.useFakeTimers();
	session = newSession();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("idle leave", () => {
	it("leaves exactly two minutes after the last authorized member walked out", async () => {
		const tasker = member("tasker", [ROLE]);
		inCall = [tasker];
		const watcher = makeWatcher();
		await walkOut(watcher, tasker);

		await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
		expect(deps.leave).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(deps.leave).toHaveBeenCalledWith(GUILD_ID, "idle");
	});

	it("cancels the leave when an authorized member comes back", async () => {
		const tasker = member("tasker", [ROLE]);
		inCall = [tasker];
		const watcher = makeWatcher();
		await walkOut(watcher, tasker);
		await vi.advanceTimersByTimeAsync(60_000);
		await walkIn(watcher, tasker);

		await vi.advanceTimersByTimeAsync(IDLE_MS * 2);
		expect(deps.leave).not.toHaveBeenCalled();
		expect(watcher.pendingIdleCount()).toBe(0);
	});

	it("counts the guild owner as authorized without a role", async () => {
		const owner = member(OWNER_ID, []);
		inCall = [owner];
		const watcher = makeWatcher();
		await walkIn(watcher, member("visitor", []));
		await vi.advanceTimersByTimeAsync(IDLE_MS);
		expect(deps.leave).not.toHaveBeenCalled();
	});

	it("is not kept in the call by members who may not give tasks, or by bots", async () => {
		const tasker = member("tasker", [ROLE]);
		inCall = [tasker, member("visitor", []), member("other-bot", [ROLE], true)];
		const watcher = makeWatcher();
		await walkOut(watcher, tasker);
		await vi.advanceTimersByTimeAsync(IDLE_MS);
		expect(deps.leave).toHaveBeenCalledWith(GUILD_ID, "idle");
	});

	it("runs the clock from the last authorized departure, never restarting it", async () => {
		const first = member("first", [ROLE]);
		const last = member("last", [ROLE]);
		const visitor = member("visitor", []);
		inCall = [first, last, visitor];
		const watcher = makeWatcher();

		await walkOut(watcher, first);
		expect(watcher.pendingIdleCount()).toBe(0);
		await walkOut(watcher, last);
		await vi.advanceTimersByTimeAsync(60_000);
		await walkOut(watcher, visitor);
		await vi.advanceTimersByTimeAsync(IDLE_MS - 60_000);
		expect(deps.leave).toHaveBeenCalledWith(GUILD_ID, "idle");
	});

	it("never ends a newer call with a timer armed for an older one", async () => {
		const tasker = member("tasker", [ROLE]);
		inCall = [tasker];
		const watcher = makeWatcher();
		await walkOut(watcher, tasker);
		session = newSession();

		await vi.advanceTimersByTimeAsync(IDLE_MS);
		expect(deps.leave).not.toHaveBeenCalled();
	});

	it("ignores updates for other channels and guilds with no call", async () => {
		inCall = [];
		const watcher = makeWatcher();
		await watcher.onVoiceStateUpdate(state("someone", "vc-other"), state("someone", null));
		session = null;
		await watcher.onVoiceStateUpdate(state("someone", VC), state("someone", null));
		expect(deps.findConfig).not.toHaveBeenCalled();
		expect(watcher.pendingIdleCount()).toBe(0);
	});
});

describe("Dero's own voice state", () => {
	it("ends the call at once when Dero is disconnected or kicked", async () => {
		const watcher = makeWatcher();
		await watcher.onVoiceStateUpdate(state(BOT_ID, VC), state(BOT_ID, null));
		expect(deps.leave).toHaveBeenCalledWith(GUILD_ID, "removed");
	});

	it("ends the call at once when Dero is moved to another channel", async () => {
		const watcher = makeWatcher();
		await watcher.onVoiceStateUpdate(state(BOT_ID, VC), state(BOT_ID, "vc-elsewhere"));
		expect(deps.leave).toHaveBeenCalledWith(GUILD_ID, "moved");
	});

	it("keeps the call through its own join and a change in place", async () => {
		const watcher = makeWatcher();
		await watcher.onVoiceStateUpdate(state(BOT_ID, null), state(BOT_ID, VC));
		await watcher.onVoiceStateUpdate(state(BOT_ID, VC), state(BOT_ID, VC));
		expect(deps.leave).not.toHaveBeenCalled();
	});
});

describe("a deleted channel", () => {
	const deleted = (id: string, guildId = GUILD_ID) =>
		({ id, guildId, isDMBased: () => false }) as unknown as NonThreadGuildBasedChannel;

	it("ends the call when its own channel is deleted", () => {
		const watcher = makeWatcher();
		watcher.onChannelDelete(deleted(VC));
		expect(deps.leave).toHaveBeenCalledWith(GUILD_ID, "channel_deleted");
	});

	it("leaves the call alone when another channel, or a DM, is deleted", () => {
		const watcher = makeWatcher();
		watcher.onChannelDelete(deleted("text-elsewhere"));
		watcher.onChannelDelete({ isDMBased: () => true } as unknown as DMChannel);
		expect(deps.leave).not.toHaveBeenCalled();
	});
});
