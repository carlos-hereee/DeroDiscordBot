import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiscordAPIError, RESTJSONErrorCodes, type Client, type Guild, type GuildMember, type VoiceState } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { IMeeting, MeetingEndReason } from "@db/models/Meeting.js";

// The start and the one end of a recording, with every store, the voice session and Discord
// faked: the refusals, the D5 busy refusal leaving a scheduled row alone, each of the six end
// reasons ending once with one notes card and one job (or the nothing recorded card), the time
// and empty room clocks, and boot recovery.
// 2026-11 item 420: nobody is heard before their notice was accepted (L3), a notes channel that
// goes away ends the recording (L2), and a start that fails anywhere leaves nothing behind (L15).

interface FakeRecorder {
	meetingId: string;
	stopped: boolean;
	discarded: boolean;
	flushed: number;
	stop(): void;
	flush(): Promise<void>;
	discard(): Promise<void>;
	releaseSpeaker(userId: string): void;
}
interface FakeDeps {
	hasConsent(guildId: string, userId: string): Promise<boolean>;
	onSpendRefused(guildId: string, meetingId: string): void;
}

const m = vi.hoisted(() => ({
	recorders: new Map<string, FakeRecorder>(),
	deps: null as FakeDeps | null,
	factory: null as ((start: unknown) => { stop(): void }) | null,
	refusedNoticeFor: new Set<string>(),
	duringNotice: null as (() => void | Promise<void>) | null,
	cardRefused: false,
	duringCard: null as (() => void | Promise<void>) | null,
	claimFailures: 0,
	removeFailures: 0,
	jobFailures: 0,
	consentReadFails: false,
	flushGate: null as Promise<void> | null,
	deletedCards: [] as string[],
	channelFetch: async (): Promise<unknown> => ({}),
	notesChannelHook: null as ((guildId: string, outcome: "deleted" | "released") => Promise<void>) | null,
	wipeHook: null as ((guildId: string) => Promise<void>) | null,
	rows: new Map<string, IMeeting>(),
	config: { meetingNotesChannelId: "notes", meetingVoiceChannelId: "hall" } as Record<string, unknown> | null,
	voice: { enabled: true } as { enabled: boolean } | null,
	keyConfigured: true,
	isHost: true,
	hasAny: true,
	agreed: new Set<string>(["host"]),
	session: null as { guildId: string; channelId: string; mode: string; meetingId: string | null } | null,
	joinWorks: true,
	reserveOk: true,
	jobs: [] as Array<{ meetingId: string }>,
	cards: [] as Array<{ channelId: string; messageId: string | null; title: string }>,
	notices: [] as Array<{ memberIds: readonly string[] }>,
	endListeners: [] as Array<(ended: { guildId: string; channelId: string; reason: string }) => void>,
	spendRefusers: [] as Array<(guildId: string, meetingId: string) => void>,
	refunds: 0,
	leaves: 0,
	deleted: [] as string[],
	edits: [] as Array<{ messageId: string; description: string }>,
	cancels: [] as Array<{ id: string; fromDashboard: boolean }>,
	counter: 0,
}));

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: async () => m.config } }));
vi.mock("@db/stores/deroVoiceConfigStore.js", () => ({ deroVoiceConfigStore: { findByGuildId: async () => m.voice } }));
vi.mock("@db/stores/meetingStore.js", () => ({
	meetingStore: {
		insert: async (row: IMeeting) => {
			m.rows.set(row.meetingId, { ...row });
			return { ...row };
		},
		findById: async (_g: string, id: string) => (m.rows.has(id) ? { ...m.rows.get(id)! } : null),
		findRecording: async () => [...m.rows.values()].find((row) => row.status === "recording") ?? null,
		findAllRecording: async () => [...m.rows.values()].filter((row) => row.status === "recording"),
		claimTransition: async (_g: string, id: string, from: string, changes: Partial<IMeeting>) => {
			if (m.claimFailures > 0) {
				m.claimFailures -= 1;
				throw new Error("mongo down");
			}
			const row = m.rows.get(id);
			if (!row || row.status !== from) return null;
			Object.assign(row, changes);
			return { ...row };
		},
		update: async (_g: string, id: string, changes: Partial<IMeeting>) => {
			const row = m.rows.get(id);
			if (!row) return null;
			Object.assign(row, changes);
			return { ...row };
		},
		remove: async (_g: string, id: string) => {
			if (m.removeFailures > 0) {
				m.removeFailures -= 1;
				throw new Error("mongo down");
			}
			return m.rows.delete(id);
		},
	},
}));
vi.mock("@db/stores/meetingTranscriptStore.js", () => ({
	meetingTranscriptStore: {
		hasAny: async () => m.hasAny,
		deleteForMeeting: async (_g: string, id: string) => {
			m.deleted.push(`segments:${id}`);
		},
	},
}));
vi.mock("@db/stores/meetingSummaryJobStore.js", () => ({
	meetingSummaryJobStore: {
		create: async (job: { meetingId: string }) => {
			if (m.jobFailures > 0) {
				m.jobFailures -= 1;
				throw new Error("mongo down");
			}
			if (m.jobs.some((made) => made.meetingId === job.meetingId)) throw Object.assign(new Error("duplicate key"), { code: 11000 });
			m.jobs.push(job);
		},
		deleteForMeeting: async (_g: string, id: string) => {
			m.deleted.push(`job:${id}`);
		},
	},
}));
vi.mock("@features/voice/elevenLabsTts.js", () => ({ isTtsKeyConfigured: () => m.keyConfigured }));
vi.mock("@features/voice/spendMeter.js", () => ({
	tryReserve: async (guildId: string, cents: number) => (m.reserveOk ? { status: "ok", reservation: { guildId, month: "2026-11", cents, ttsChars: 0 } } : { status: "capReached" }),
	refund: async () => {
		m.refunds += 1;
	},
}));
vi.mock("@features/voice/voiceQueue.js", () => ({
	voiceQueue: {
		requestVoice: async (input: { guild: { id: string }; channelId: string; meeting?: { meetingId: string } }) => {
			if (!m.joinWorks) return null;
			m.session = { guildId: input.guild.id, channelId: input.channelId, mode: "meeting", meetingId: input.meeting?.meetingId ?? null };
			// As in production, the call starts listening the moment it is Ready, before startMeeting goes on.
			m.factory?.({ guild: input.guild, receiver: {}, mode: "meeting", meetingId: input.meeting?.meetingId ?? null });
			return null;
		},
		list: () => [],
		remove: () => null,
	},
}));
vi.mock("@features/voice/voiceSessions.js", () => ({
	voiceSessions: {
		get: () => m.session,
		leave: (guildId: string) => {
			const was = m.session;
			m.session = null;
			m.leaves += 1;
			if (was?.meetingId) m.recorders.get(was.meetingId)?.stop();
			if (was) for (const listener of m.endListeners) listener({ guildId, channelId: was.channelId, reason: "left" });
			return Boolean(was);
		},
		useListener: (factory: typeof m.factory) => (m.factory = factory),
		onEnd: (listener: (typeof m.endListeners)[number]) => m.endListeners.push(listener),
	},
}));
vi.mock("@features/reminders/dueReminders.js", () => ({ cancelRemindersFor: async () => undefined }));
vi.mock("@utils/cardMessage.js", () => ({
	syncCardMessage: async (_client: unknown, channelId: string, messageId: string | null, payload: { embeds: Array<{ data: { title?: string } }> }) => {
		await m.duringCard?.();
		if (m.cardRefused) return null;
		m.cards.push({ channelId, messageId, title: payload.embeds[0]?.data.title ?? "" });
		return messageId ?? `msg${++m.counter}`;
	},
	deleteCardMessage: async (_client: unknown, _channelId: string, messageId: string) => void m.deletedCards.push(messageId),
	editCardMessage: async (_client: unknown, _channelId: string, messageId: string, payload: { embeds: Array<{ data: { description?: string } }> }) => {
		m.edits.push({ messageId, description: payload.embeds[0]?.data.description ?? "" });
		return true;
	},
}));
vi.mock("./consentNotice.js", () => ({
	postConsentNotice: async (_c: unknown, _ch: string, _copy: unknown, input: { memberIds: readonly string[] }) => {
		m.notices.push(input);
		await m.duringNotice?.();
		return input.memberIds.filter((id) => !m.refusedNoticeFor.has(id));
	},
	registerConsentButtons: () => undefined,
}));
vi.mock("./meetingConsent.js", () => ({
	consentingMembers: async (_g: string, ids: readonly string[]) => {
		if (m.consentReadFails) throw new Error("mongo down");
		return new Set(ids.filter((id) => m.agreed.has(id)));
	},
	hasMeetingConsent: async (_g: string, id: string) => m.agreed.has(id),
}));
vi.mock("@features/setup/removeChannel.js", () => ({ useNotesChannelHook: (hook: typeof m.notesChannelHook) => (m.notesChannelHook = hook) }));
vi.mock("@features/setup/serverReset.js", () => ({ useWipeHook: (hook: typeof m.wipeHook) => (m.wipeHook = hook) }));
vi.mock("./meetingHosts.js", () => ({ isMeetingHost: async () => m.isHost }));
vi.mock("./meetingRecorder.js", () => ({
	PREPAID_CENTS: 1,
	defaultMeetingRecorderDeps: {},
	getMeetingRecorder: (meetingId: string) => m.recorders.get(meetingId) ?? null,
	startMeetingRecorder: (start: { meetingId: string }, deps: FakeDeps) => {
		m.spendRefusers.push(deps.onSpendRefused);
		m.deps = deps;
		let release: () => void = () => undefined;
		const released = new Promise<void>((resolve) => (release = resolve));
		const recorder: FakeRecorder = {
			meetingId: start.meetingId,
			stopped: false,
			discarded: false,
			flushed: 0,
			stop() {
				this.stopped = true;
			},
			// Like the real one: it waits for chunks at the provider, and a discard releases it.
			async flush() {
				this.stopped = true;
				this.flushed += 1;
				await Promise.race([m.flushGate ?? Promise.resolve(), released]);
				m.recorders.delete(start.meetingId);
			},
			async discard() {
				this.stopped = true;
				this.discarded = true;
				m.recorders.delete(start.meetingId);
				release();
			},
			releaseSpeaker: () => undefined,
		};
		m.recorders.set(start.meetingId, recorder);
		return recorder;
	},
}));
vi.mock("./scheduledMeetings.js", () => ({
	MEETING_ACTIONS: { record: "rec", end: "end" },
	meetingCustomId: (action: string, id?: string) => (id ? `mtg:${action}:${id}` : `mtg:${action}`),
	redrawScheduledMeetingCard: async () => undefined,
	cancelScheduledMeeting: async (_c: unknown, _g: string, id: string, options: { fromDashboard?: boolean }) => {
		const row = m.rows.get(id);
		if (!row) return { ok: false, reason: "notFound" };
		if (row.status !== "scheduled") return { ok: false, reason: "notScheduled" };
		row.status = "cancelled";
		m.cancels.push({ id, fromDashboard: options.fromDashboard === true });
		return { ok: true, meeting: { ...row } };
	},
	useRecordingControls: () => undefined,
}));

const lifecycle = await import("./meetingLifecycle.js");
const { _resetLiveMeetings, createMeetingListener, deleteMeeting, endMeeting, registerMeetingRecording, startMeeting } = lifecycle;
const { onMeetingVoiceState, registerMeetingPresence } = await import("./meetingPresence.js");
const { recoverInterruptedMeetings } = await import("./meetingBootRecovery.js");

const hallMembers = new Map<string, { id: string; user: { bot: boolean } }>([
	["host", { id: "host", user: { bot: false } }],
	["carol", { id: "carol", user: { bot: false } }],
	["bot", { id: "bot", user: { bot: true } }],
]);
const guild = { id: "g1", channels: { cache: new Map([["hall", { isVoiceBased: () => true, members: hallMembers }]]) } } as unknown as Guild;
const listeners = new Map<string, (payload: unknown) => void>();
const client = {
	guilds: { cache: new Map([["g1", guild]]) },
	channels: { fetch: () => m.channelFetch() },
	on: (event: string, listener: (payload: unknown) => void) => listeners.set(event, listener),
} as unknown as Client;
const host = { id: "host", voice: { channelId: "hall" } } as unknown as GuildMember;

function scheduledRow(id = "sched1"): IMeeting {
	const row = { meetingId: id, guildId: "g1", title: "Weekly", status: "scheduled", endReason: null, hostId: "host", scheduledFor: new Date(), rsvpIds: [], startedAt: null, endedAt: null, speakerIds: [], notesChannelId: "notes", notesMessageId: null, scheduleMessageId: "sm1", summary: null, sttSeconds: 0, spentCents: 0 } as unknown as IMeeting;
	m.rows.set(id, row);
	return row;
}

async function started(): Promise<IMeeting> {
	const result = await startMeeting(client, guild, host, { title: "Planning" });
	if (!result.ok) throw new Error(`start refused: ${result.reason}`);
	return result.meeting;
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	Object.assign(m, { config: { meetingNotesChannelId: "notes", meetingVoiceChannelId: "hall" }, voice: { enabled: true }, keyConfigured: true, isHost: true, hasAny: true, session: null, joinWorks: true, reserveOk: true, refunds: 0, leaves: 0 });
	Object.assign(m, { deps: null, factory: null, duringNotice: null, cardRefused: false, duringCard: null, claimFailures: 0, removeFailures: 0, jobFailures: 0, consentReadFails: false, flushGate: null, deletedCards: [], channelFetch: async () => ({}) });
	m.recorders.clear();
	m.refusedNoticeFor.clear();
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	m.rows.clear();
	m.agreed = new Set(["host"]);
	m.jobs.length = 0;
	m.cards.length = 0;
	m.notices.length = 0;
	m.endListeners.length = 0;
	m.spendRefusers.length = 0;
	_resetLiveMeetings();
	registerMeetingRecording(client);
});

afterEach(() => {
	_resetLiveMeetings();
	vi.useRealTimers();
});

describe("startMeeting", () => {
	it("marks the meeting recording, joins in meeting mode and asks exactly the humans in the hall", async () => {
		const meeting = await started();
		expect(m.rows.get(meeting.meetingId)?.status).toBe("recording");
		expect(m.session).toMatchObject({ mode: "meeting", meetingId: meeting.meetingId, channelId: "hall" });
		expect(m.notices).toEqual([expect.objectContaining({ memberIds: ["host", "carol"] })]);
		expect(m.cards.at(-1)).toMatchObject({ channelId: "notes", title: "🔴 Recording: Planning" });
	});

	it("starts a scheduled meeting's own row", async () => {
		scheduledRow();
		const result = await startMeeting(client, guild, host, { scheduledMeetingId: "sched1" });
		expect(result.ok).toBe(true);
		expect(m.rows.get("sched1")?.status).toBe("recording");
		expect(m.rows.size).toBe(1);
	});

	it.each([
		["noChannel", () => (m.config = { meetingVoiceChannelId: "hall" })],
		["notHost", () => (m.isHost = false)],
		["voiceOff", () => (m.voice = { enabled: false })],
		["unavailable", () => (m.keyConfigured = false)],
		["unavailable", () => (m.reserveOk = false)],
	])("refuses with %s and writes nothing", async (reason, arrange) => {
		arrange();
		const result = await startMeeting(client, guild, host, { title: "Planning" });
		expect(result).toMatchObject({ ok: false, reason });
		expect(m.rows.size).toBe(0);
	});

	it("refuses a host outside 🏛️ Meeting Hall", async () => {
		const elsewhere = { id: "host", voice: { channelId: "lounge" } } as unknown as GuildMember;
		expect(await startMeeting(client, guild, elsewhere, {})).toMatchObject({ ok: false, reason: "notInHall" });
	});

	it("D5: Dero in another call refuses, names that call, queues nothing and leaves the scheduled row scheduled", async () => {
		scheduledRow();
		m.session = { guildId: "g1", channelId: "lounge", mode: "command", meetingId: null };
		const result = await startMeeting(client, guild, host, { scheduledMeetingId: "sched1" });
		expect(result).toEqual({ ok: false, reason: "busyElsewhere", busyChannelId: "lounge" });
		expect(m.rows.get("sched1")?.status).toBe("scheduled");
		expect(m.session).toMatchObject({ channelId: "lounge" });
	});

	it("a join that never lands puts the scheduled row back and refunds the prepaid cent", async () => {
		scheduledRow();
		m.joinWorks = false;
		const result = await startMeeting(client, guild, host, { scheduledMeetingId: "sched1" });
		expect(result).toMatchObject({ ok: false, reason: "joinFailed" });
		expect(m.rows.get("sched1")?.status).toBe("scheduled");
		expect(m.refunds).toBe(1);
	});
});

const state = (channelId: string | null, id: string): VoiceState => ({ id, guild: { id: "g1" }, channelId, member: { id, user: { bot: false } } }) as unknown as VoiceState;
const hears = (userId: string): Promise<boolean> => m.deps!.hasConsent("g1", userId);

async function joinsHall(id: string): Promise<void> {
	hallMembers.set(id, { id, user: { bot: false } });
	await onMeetingVoiceState(client, state(null, id), state("hall", id));
}

// No notice, no capture (2026-11 item 420, L3): the recorder the join starts hears nobody until
// Discord accepted every notice and the live card, and a start that stops short is undone whole.
describe("a member is heard only once Discord accepted a notice naming them (L3)", () => {
	afterEach(() => {
		hallMembers.delete("dave");
	});

	it("L3: hears nobody between the join and the last accepted post, then exactly the members asked", async () => {
		const heard: boolean[] = [];
		m.duringNotice = async () => void heard.push(await hears("host"));
		m.duringCard = async () => void heard.push(await hears("host"));
		await started();
		expect(heard).toEqual([false, false]);
		expect(await hears("host")).toBe(true);
		m.agreed.add("stranger");
		expect(await hears("stranger")).toBe(false);
	});

	it.each([
		["a refused notice", () => ["host", "carol"].forEach((id) => m.refusedNoticeFor.add(id))],
		["one refused batch", () => m.refusedNoticeFor.add("carol")],
		["a refused live card", () => (m.cardRefused = true)],
	])("L3: %s undoes the start with nothing heard, the cent back, the call left and no recorder kept", async (_label, arrange) => {
		arrange();
		scheduledRow();
		const result = await startMeeting(client, guild, host, { scheduledMeetingId: "sched1" });
		expect(result).toEqual({ ok: false, reason: "noticeNotPosted" });
		expect(await hears("host")).toBe(false);
		expect(m.refunds).toBe(1);
		expect(m.session).toBeNull();
		expect(m.recorders.size).toBe(0);
		expect(m.rows.get("sched1")).toMatchObject({ status: "scheduled", startedAt: null, spentCents: 0 });
		expect(m.jobs).toEqual([]);
		expect(m.cards).toEqual([]);
		expect(lifecycle.liveMeetingIn("g1")).toBeNull();
		// The refused start holds nothing, so the next one works.
		m.cardRefused = false;
		m.refusedNoticeFor.clear();
		expect((await startMeeting(client, guild, host, { scheduledMeetingId: "sched1" })).ok).toBe(true);
	});

	it("L3: a newcomer whose notice failed is unheard even with an old yes, and is asked again on the next hall change", async () => {
		await started();
		m.agreed.add("dave");
		m.refusedNoticeFor.add("dave");
		await joinsHall("dave");
		expect(await hears("dave")).toBe(false);
		m.refusedNoticeFor.clear();
		await onMeetingVoiceState(client, state("hall", "erin"), state(null, "erin"));
		expect(m.notices.filter((notice) => notice.memberIds.includes("dave"))).toHaveLength(2);
		expect(await hears("dave")).toBe(true);
	});

	it("L3: two hall changes at once ask a newcomer once", async () => {
		await started();
		let release: () => void = () => undefined;
		m.duringNotice = () => new Promise<void>((resolve) => (release = resolve));
		hallMembers.set("dave", { id: "dave", user: { bot: false } });
		const both = [onMeetingVoiceState(client, state(null, "dave"), state("hall", "dave")), onMeetingVoiceState(client, state(null, "dave"), state("hall", "dave"))];
		await vi.advanceTimersByTimeAsync(0);
		release();
		await Promise.all(both);
		expect(m.notices.filter((notice) => notice.memberIds.includes("dave"))).toHaveLength(1);
	});

	it("L15: a call that ended while the notices were posting undoes the start instead of ending a meeting", async () => {
		scheduledRow();
		m.duringNotice = () => {
			m.session = null;
			for (const listener of m.endListeners) listener({ guildId: "g1", channelId: "hall", reason: "removed" });
		};
		expect(await startMeeting(client, guild, host, { scheduledMeetingId: "sched1" })).toEqual({ ok: false, reason: "joinFailed" });
		expect(m.rows.get("sched1")).toMatchObject({ status: "scheduled", startedAt: null, spentCents: 0 });
		expect(m.refunds).toBe(1);
		expect(m.cards).toEqual([]);
	});
});

// A start that never came to be leaves a scheduled meeting as it was found (2026-11 item 420, L15).
describe("a failed start restores the scheduled meeting (L15)", () => {
	const before = { status: "scheduled", hostId: "planner", notesChannelId: "old-notes", notesMessageId: "old-card", startedAt: null, spentCents: 7 } as const;
	const failures: Array<[string, string, () => void]> = [
		["failed to join", "joinFailed", () => (m.joinWorks = false)],
		["failed to post the notices", "noticeNotPosted", () => m.refusedNoticeFor.add("carol")],
		["failed to post the live card", "noticeNotPosted", () => (m.cardRefused = true)],
		["failed to stay in the call", "joinFailed", () => (m.duringCard = () => void (m.session = null))],
	];

	it.each(failures)("L15: a start that %s restores the host, channel, card, status and spend", async (_label, reason, arrange) => {
		Object.assign(scheduledRow(), before);
		arrange();
		expect(await startMeeting(client, guild, host, { scheduledMeetingId: "sched1" })).toEqual({ ok: false, reason });
		expect(m.rows.get("sched1")).toMatchObject(before);
		expect(m.refunds).toBe(1);
	});

	it("L15: a meeting scheduled from the dashboard goes back to no host and no channel", async () => {
		Object.assign(scheduledRow(), { hostId: null, notesChannelId: null });
		m.joinWorks = false;
		await startMeeting(client, guild, host, { scheduledMeetingId: "sched1" });
		expect(m.rows.get("sched1")).toMatchObject({ status: "scheduled", hostId: null, notesChannelId: null });
	});

	it("L15: an undo retried by the repair pass restores the same", async () => {
		Object.assign(scheduledRow(), before);
		m.cardRefused = true;
		m.duringCard = () => void (m.claimFailures = 1);
		await startMeeting(client, guild, host, { scheduledMeetingId: "sched1" });
		expect(m.rows.get("sched1")?.status).toBe("recording");
		await lifecycle.retryOwedUndos();
		expect(m.rows.get("sched1")).toMatchObject(before);
	});
});

// 📝meeting-notes gone, and every withdraw button with it (2026-11 item 420, L2).
describe("a notes channel that goes away ends the recording (L2)", () => {
	const deleteChannel = async (id: string): Promise<void> => {
		registerMeetingPresence(client);
		listeners.get("channelDelete")?.({ id });
		await vi.advanceTimersByTimeAsync(0);
	};

	it("L2: a deleted channel drops unsent audio, ends once as session_end, makes no job and deletes no stored word", async () => {
		m.deleted = [];
		const meeting = await started();
		const recorder = m.recorders.get(meeting.meetingId)!;
		await deleteChannel("notes");
		expect(recorder).toMatchObject({ stopped: true, discarded: true, flushed: 0 });
		expect(m.rows.get(meeting.meetingId)).toMatchObject({ status: "failed", endReason: "session_end" });
		expect(m.jobs).toEqual([]);
		expect(m.deleted).toEqual([]);
		expect(m.session).toBeNull();
		expect(m.leaves).toBe(1);
		await deleteChannel("notes");
		expect(m.leaves).toBe(1);
	});

	it("L2: a deleted channel with nothing recorded closes the meeting as done", async () => {
		m.hasAny = false;
		const meeting = await started();
		await deleteChannel("notes");
		expect(m.rows.get(meeting.meetingId)).toMatchObject({ status: "done", endReason: "session_end" });
	});

	it("L2: another channel's delete ends nothing", async () => {
		const meeting = await started();
		await deleteChannel("lounge");
		expect(m.rows.get(meeting.meetingId)?.status).toBe("recording");
	});

	it("L2: a released channel keeps its notices, so the meeting ends as usual and is summarized", async () => {
		const meeting = await started();
		await m.notesChannelHook!("g1", "released");
		expect(m.rows.get(meeting.meetingId)).toMatchObject({ status: "summarizing", endReason: "session_end" });
		expect(m.jobs).toHaveLength(1);
	});

	it("L2: a channel Dero deleted itself ends without a summary even when the delete event lags", async () => {
		const meeting = await started();
		await m.notesChannelHook!("g1", "deleted");
		await deleteChannel("notes");
		expect(m.rows.get(meeting.meetingId)).toMatchObject({ status: "failed", endReason: "session_end" });
		expect(m.jobs).toEqual([]);
	});

	it("L2: a failed fetch after a refused notice ends nothing, and Unknown Channel does", async () => {
		const meeting = await started();
		m.refusedNoticeFor.add("dave");
		m.channelFetch = async () => Promise.reject(new Error("socket hang up"));
		await joinsHall("dave");
		expect(m.rows.get(meeting.meetingId)?.status).toBe("recording");
		const gone = new DiscordAPIError({ code: RESTJSONErrorCodes.UnknownChannel, message: "Unknown Channel" }, RESTJSONErrorCodes.UnknownChannel, 404, "GET", "https://discord.test", {});
		m.channelFetch = async () => Promise.reject(gone);
		await onMeetingVoiceState(client, state("hall", "erin"), state(null, "erin"));
		expect(m.rows.get(meeting.meetingId)).toMatchObject({ status: "failed", endReason: "session_end" });
		hallMembers.delete("dave");
	});
});

describe("every end path ends once, with one notes card and one job", () => {
	const ends: Array<[MeetingEndReason, (meeting: IMeeting) => Promise<void>]> = [
		["host", async (meeting) => void (await endMeeting(client, "g1", meeting.meetingId, "host"))],
		["cap_time", async () => void (await vi.advanceTimersByTimeAsync(BOT_CONSTANTS.MEETINGS.MAX_MS))],
		[
			"cap_spend",
			async (meeting) => {
				createMeetingListener(client)({ guild, receiver: {} as never, mode: "meeting", meetingId: meeting.meetingId } as never);
				m.spendRefusers.at(-1)?.("g1", meeting.meetingId);
				await vi.advanceTimersByTimeAsync(0);
			},
		],
		[
			"empty_room",
			async () => {
				m.agreed = new Set();
				hallMembers.delete("host");
				await vi.advanceTimersByTimeAsync(0);
				const { checkRoom } = await import("./meetingLifecycle.js");
				await checkRoom(client, "g1");
				await vi.advanceTimersByTimeAsync(BOT_CONSTANTS.MEETINGS.EMPTY_ROOM_END_MS);
				hallMembers.set("host", { id: "host", user: { bot: false } });
			},
		],
		[
			"session_end",
			async () => {
				const was = m.session!;
				m.session = null;
				for (const listener of m.endListeners) listener({ guildId: "g1", channelId: was.channelId, reason: "moved" });
				await vi.advanceTimersByTimeAsync(0);
			},
		],
	];

	it.each(ends)("%s", async (reason, trigger) => {
		const meeting = await started();
		const liveMessageId = m.rows.get(meeting.meetingId)?.notesMessageId;
		await trigger(meeting);
		const row = m.rows.get(meeting.meetingId);
		expect(row).toMatchObject({ status: "summarizing", endReason: reason });
		expect(m.jobs).toEqual([expect.objectContaining({ meetingId: meeting.meetingId })]);
		expect(m.cards.filter((card) => card.title === "📝 Planning")).toEqual([{ channelId: "notes", messageId: liveMessageId, title: "📝 Planning" }]);
		expect(m.session).toBeNull();
		// A second end of any kind does nothing more.
		expect(await endMeeting(client, "g1", meeting.meetingId, "host")).toBe(false);
		expect(m.jobs).toHaveLength(1);
	});

	it("interrupted: boot recovery ends a recording no process holds", async () => {
		const row = scheduledRow("orphan");
		Object.assign(row, { status: "recording", startedAt: new Date(), notesMessageId: "live1" });
		expect(await recoverInterruptedMeetings(client)).toBe(1);
		expect(m.rows.get("orphan")).toMatchObject({ status: "summarizing", endReason: "interrupted" });
		expect(m.jobs).toEqual([expect.objectContaining({ meetingId: "orphan" })]);
		expect(m.cards).toEqual([{ channelId: "notes", messageId: "live1", title: "📝 Weekly" }]);
		expect(await recoverInterruptedMeetings(client)).toBe(0);
	});

	it("with no segment written: the nothing recorded card, status done, and no job", async () => {
		m.hasAny = false;
		const meeting = await started();
		await endMeeting(client, "g1", meeting.meetingId, "host");
		expect(m.rows.get(meeting.meetingId)?.status).toBe("done");
		expect(m.jobs).toEqual([]);
		expect(m.cards.at(-1)?.title).toBe("📝 Planning");
	});
});

// A stop at any point leaves something the next pass finishes (2026-11 item 420): L7, L4, L11.
describe("an end whose first write failed is retried (L7)", () => {
	const settle = () => vi.advanceTimersByTimeAsync(0);
	const ends: Array<[MeetingEndReason, (meeting: IMeeting) => Promise<void>]> = [
		["host", async (meeting) => void (await endMeeting(client, "g1", meeting.meetingId, "host").catch(() => undefined))],
		["cap_time", async () => void (await vi.advanceTimersByTimeAsync(BOT_CONSTANTS.MEETINGS.MAX_MS))],
		[
			"cap_spend",
			async (meeting) => {
				m.spendRefusers.at(-1)?.("g1", meeting.meetingId);
				await settle();
			},
		],
		[
			"empty_room",
			async () => {
				m.agreed = new Set();
				await lifecycle.checkRoom(client, "g1");
				await vi.advanceTimersByTimeAsync(BOT_CONSTANTS.MEETINGS.EMPTY_ROOM_END_MS);
			},
		],
		[
			"session_end",
			async () => {
				m.session = null;
				for (const listener of m.endListeners) listener({ guildId: "g1", channelId: "hall", reason: "moved" });
				await settle();
			},
		],
	];

	it.each(ends)("L7: %s: hears nobody meanwhile, and the next pass ends it with one card and one job", async (reason, trigger) => {
		const meeting = await started();
		const recorder = m.recorders.get(meeting.meetingId)!;
		m.claimFailures = 1;
		await trigger(meeting);
		expect(m.rows.get(meeting.meetingId)?.status).toBe("recording");
		expect(recorder.stopped).toBe(true);
		expect(m.jobs).toEqual([]);

		await lifecycle.retryOwedEnds(client);
		expect(m.rows.get(meeting.meetingId)).toMatchObject({ status: "summarizing", endReason: reason });
		expect(recorder.flushed).toBe(1);
		await lifecycle.retryOwedEnds(client);
		expect(m.jobs).toHaveLength(1);
		expect(m.cards.filter((card) => card.title === "📝 Planning")).toHaveLength(1);
		expect(lifecycle.liveMeetingIn("g1")).toBeNull();
	});

	it("L7: a write that landed but answered an error is finished, not dropped", async () => {
		const meeting = await started();
		m.claimFailures = 1;
		await endMeeting(client, "g1", meeting.meetingId, "host").catch(() => undefined);
		Object.assign(m.rows.get(meeting.meetingId)!, { status: "summarizing", endReason: "host" });
		await lifecycle.retryOwedEnds(client);
		expect(m.jobs).toHaveLength(1);
		expect(m.session).toBeNull();
	});

	it("a recording another process already ended is let go here: discarded, left and forgotten", async () => {
		const meeting = await started();
		const recorder = m.recorders.get(meeting.meetingId)!;
		m.rows.get(meeting.meetingId)!.status = "done";
		expect(await endMeeting(client, "g1", meeting.meetingId, "host")).toBe(false);
		expect(recorder.discarded).toBe(true);
		expect(m.session).toBeNull();
		expect(lifecycle.liveMeetingIn("g1")).toBeNull();
	});

	it("L2: a deleted notes channel whose write failed is retried, still with no summary", async () => {
		const meeting = await started();
		m.claimFailures = 1;
		await lifecycle.endForDeletedNotesChannel(client, "notes").catch(() => undefined);
		await lifecycle.retryOwedEnds(client);
		expect(m.rows.get(meeting.meetingId)).toMatchObject({ status: "failed", endReason: "session_end" });
		expect(m.jobs).toEqual([]);
	});
});

describe("the empty room clock counts again before it ends (L7)", () => {
	it("L7: a member who agreed since is counted, and the clock can arm again", async () => {
		const meeting = await started();
		m.agreed = new Set();
		await lifecycle.checkRoom(client, "g1");
		// Agreed with no recount following: the stale count would have ended the meeting.
		m.agreed = new Set(["carol"]);
		await vi.advanceTimersByTimeAsync(BOT_CONSTANTS.MEETINGS.EMPTY_ROOM_END_MS);
		expect(m.rows.get(meeting.meetingId)?.status).toBe("recording");
		m.agreed = new Set();
		await lifecycle.checkRoom(client, "g1");
		await vi.advanceTimersByTimeAsync(BOT_CONSTANTS.MEETINGS.EMPTY_ROOM_END_MS);
		expect(m.rows.get(meeting.meetingId)).toMatchObject({ status: "summarizing", endReason: "empty_room" });
	});

	it("L7: a count that cannot be read ends nothing and is taken again", async () => {
		const meeting = await started();
		m.consentReadFails = true;
		await lifecycle.checkRoom(client, "g1");
		await vi.advanceTimersByTimeAsync(BOT_CONSTANTS.MEETINGS.EMPTY_ROOM_END_MS);
		expect(m.rows.get(meeting.meetingId)?.status).toBe("recording");
		m.consentReadFails = false;
		m.agreed = new Set();
		await vi.advanceTimersByTimeAsync(BOT_CONSTANTS.MEETINGS.EMPTY_ROOM_END_MS);
		expect(m.rows.get(meeting.meetingId)).toMatchObject({ endReason: "empty_room" });
	});
});

describe("an end cut off after its first write (L4)", () => {
	it("L4: a job that could not be made is made by the same step the repair calls, once", async () => {
		const meeting = await started();
		m.jobFailures = 1;
		await endMeeting(client, "g1", meeting.meetingId, "host").catch(() => undefined);
		expect(m.jobs).toEqual([]);
		await lifecycle.finishEndedMeeting(client, "g1", meeting.meetingId);
		await lifecycle.finishEndedMeeting(client, "g1", meeting.meetingId);
		expect(m.jobs).toHaveLength(1);
	});

	it("L4: an end still flushing is reported in flight, and shutdown can wait for it", async () => {
		const meeting = await started();
		let open: () => void = () => undefined;
		m.flushGate = new Promise<void>((resolve) => (open = resolve));
		const ending = endMeeting(client, "g1", meeting.meetingId, "host");
		await vi.advanceTimersByTimeAsync(0);
		expect(lifecycle.isEndInFlight(meeting.meetingId)).toBe(true);
		expect(lifecycle.meetingWorkInFlight()).toHaveLength(1);
		open();
		await Promise.all(lifecycle.meetingWorkInFlight());
		await ending;
		expect(lifecycle.isEndInFlight(meeting.meetingId)).toBe(false);
		expect(m.jobs).toHaveLength(1);
	});

	it("L4 L15: an undo whose write failed is kept and retried, and never touches a meeting recording again", async () => {
		scheduledRow();
		m.cardRefused = true;
		// The start's claim passes, and the undo's write is the one that fails.
		m.duringCard = () => void (m.claimFailures = 1);
		expect((await startMeeting(client, guild, host, { scheduledMeetingId: "sched1" })).ok).toBe(false);
		expect(m.rows.get("sched1")?.status).toBe("recording");
		expect(m.refunds).toBe(1);
		await lifecycle.retryOwedUndos();
		expect(m.rows.get("sched1")).toMatchObject({ status: "scheduled", startedAt: null, spentCents: 0 });
		m.rows.get("sched1")!.status = "recording";
		await lifecycle.retryOwedUndos();
		expect(m.rows.get("sched1")?.status).toBe("recording");
	});
});

describe("a delete or a wipe while the last chunks are transcribed (L11)", () => {
	beforeEach(() => {
		m.deleted = [];
		m.edits = [];
	});

	it("L11: Delete waits for the end it interrupts, and leaves no segment, job or reposted card", async () => {
		const meeting = await started();
		m.flushGate = new Promise<void>(() => undefined);
		const ending = endMeeting(client, "g1", meeting.meetingId, "host");
		await vi.advanceTimersByTimeAsync(0);
		const recorder = m.recorders.get(meeting.meetingId)!;
		expect(await deleteMeeting(client, "g1", meeting.meetingId)).toEqual({ ok: true, outcome: "deleted" });
		await ending;
		expect(recorder.discarded).toBe(true);
		expect(m.rows.has(meeting.meetingId)).toBe(false);
		// The interrupted end finished first, so its job and its words were there to delete.
		expect(m.deleted).toEqual([`job:${meeting.meetingId}`, `segments:${meeting.meetingId}`]);
		await vi.waitFor(() => expect(m.edits).toHaveLength(1));
		const cardsAfter = m.cards.length;
		await vi.advanceTimersByTimeAsync(0);
		expect(m.cards).toHaveLength(cardsAfter);
	});

	it("L11: an end that finds its row gone deletes the leftover words and makes no job and no card", async () => {
		const meeting = await started();
		let open: () => void = () => undefined;
		m.flushGate = new Promise<void>((resolve) => (open = resolve));
		const ending = endMeeting(client, "g1", meeting.meetingId, "host");
		await vi.advanceTimersByTimeAsync(0);
		const cardsBefore = m.cards.length;
		m.rows.delete(meeting.meetingId);
		open();
		await ending;
		expect(m.deleted).toEqual([`segments:${meeting.meetingId}`]);
		expect(m.jobs).toEqual([]);
		expect(m.cards).toHaveLength(cardsBefore);
	});

	it("L11: Delete my data ends the call, discards the recorder and makes no job before anything is wiped", async () => {
		const meeting = await started();
		const recorder = m.recorders.get(meeting.meetingId)!;
		await m.wipeHook!("g1");
		expect(recorder.discarded).toBe(true);
		expect(m.session).toBeNull();
		expect(m.jobs).toEqual([]);
		expect(lifecycle.liveMeetingIn("g1")).toBeNull();
	});

	it("L11: Delete my data releases and waits for an end already flushing", async () => {
		const meeting = await started();
		m.flushGate = new Promise<void>(() => undefined);
		const ending = endMeeting(client, "g1", meeting.meetingId, "host");
		await vi.advanceTimersByTimeAsync(0);
		await m.wipeHook!("g1");
		expect(lifecycle.isEndInFlight(meeting.meetingId)).toBe(false);
		await ending;
	});

	it("L11: a hook whose end could not be written fails, so the wipe can name it", async () => {
		await started();
		m.claimFailures = 1;
		await expect(m.wipeHook!("g1")).rejects.toThrow();
		expect(m.session).toBeNull();
	});

	it("L11: the hook does nothing in a server with no recording, and leaves a command call alone", async () => {
		m.session = { guildId: "g1", channelId: "lounge", mode: "command", meetingId: null };
		await m.wipeHook!("g1");
		expect(m.leaves).toBe(0);
	});
});

describe("the clocks", () => {
	it("does not end before MAX_MS", async () => {
		const meeting = await started();
		await vi.advanceTimersByTimeAsync(BOT_CONSTANTS.MEETINGS.MAX_MS - 1);
		expect(m.rows.get(meeting.meetingId)?.status).toBe("recording");
	});

	it("a member who agreed coming back clears the empty room clock", async () => {
		const meeting = await started();
		const { checkRoom } = await import("./meetingLifecycle.js");
		m.agreed = new Set();
		await checkRoom(client, "g1");
		await vi.advanceTimersByTimeAsync(BOT_CONSTANTS.MEETINGS.EMPTY_ROOM_END_MS - 1);
		m.agreed = new Set(["carol"]);
		await checkRoom(client, "g1");
		await vi.advanceTimersByTimeAsync(BOT_CONSTANTS.MEETINGS.EMPTY_ROOM_END_MS);
		expect(m.rows.get(meeting.meetingId)?.status).toBe("recording");
	});
});

// The dashboard's DELETE (2026-11 item 388 Phase 5a): a scheduled meeting is cancelled through
// scheduledMeetings, a recording one is refused, any other is deleted with its job and its
// words, job first, and its cards say it was removed; its todos are never touched here.
describe("deleteMeeting", () => {
	beforeEach(() => {
		m.deleted = [];
		m.edits = [];
		m.cancels = [];
	});

	it("cancels a scheduled meeting from the dashboard and keeps its row", async () => {
		scheduledRow("s1");
		expect(await deleteMeeting(client, "g1", "s1")).toEqual({ ok: true, outcome: "cancelled" });
		expect(m.cancels).toEqual([{ id: "s1", fromDashboard: true }]);
		expect(m.rows.get("s1")?.status).toBe("cancelled");
		expect(m.deleted).toEqual([]);
	});

	it("refuses a meeting that is recording and deletes nothing", async () => {
		const meeting = await started();
		expect(await deleteMeeting(client, "g1", meeting.meetingId)).toEqual({ ok: false, reason: "recording" });
		expect(m.rows.has(meeting.meetingId)).toBe(true);
		expect(m.deleted).toEqual([]);
	});

	it("deletes a finished meeting: the job first, then its words and its row, and edits both cards to removed", async () => {
		const row = scheduledRow("d1");
		Object.assign(row, { status: "done", notesMessageId: "nm1", scheduleMessageId: "sm1" });
		expect(await deleteMeeting(client, "g1", "d1")).toEqual({ ok: true, outcome: "deleted" });
		expect(m.deleted).toEqual(["job:d1", "segments:d1"]);
		expect(m.rows.has("d1")).toBe(false);
		await vi.waitFor(() => expect(m.edits.map((edit) => edit.messageId)).toEqual(["nm1", "sm1"]));
		expect(m.edits[0].description).toContain("from the dashboard");
	});

	it("answers notFound for a meeting this guild does not hold", async () => {
		expect(await deleteMeeting(client, "g1", "missing")).toEqual({ ok: false, reason: "notFound" });
	});
});
