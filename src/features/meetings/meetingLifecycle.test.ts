import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client, Guild, GuildMember } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { IMeeting, MeetingEndReason } from "@db/models/Meeting.js";

// The start and the one end of a recording, with every store, the voice session and Discord
// faked: the refusals, the D5 busy refusal leaving a scheduled row alone, each of the six end
// reasons ending once with one notes card and one job (or the nothing recorded card), the time
// and empty room clocks, and boot recovery.

const m = vi.hoisted(() => ({
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
		remove: async (_g: string, id: string) => m.rows.delete(id),
	},
}));
vi.mock("@db/stores/meetingTranscriptStore.js", () => ({ meetingTranscriptStore: { hasAny: async () => m.hasAny } }));
vi.mock("@db/stores/meetingSummaryJobStore.js", () => ({
	meetingSummaryJobStore: {
		create: async (job: { meetingId: string }) => {
			m.jobs.push(job);
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
			if (m.joinWorks) m.session = { guildId: input.guild.id, channelId: input.channelId, mode: "meeting", meetingId: input.meeting?.meetingId ?? null };
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
			if (was) for (const listener of m.endListeners) listener({ guildId, channelId: was.channelId, reason: "left" });
			return Boolean(was);
		},
		useListener: () => undefined,
		onEnd: (listener: (typeof m.endListeners)[number]) => m.endListeners.push(listener),
	},
}));
vi.mock("@features/reminders/dueReminders.js", () => ({ cancelRemindersFor: async () => undefined }));
vi.mock("@utils/cardMessage.js", () => ({
	syncCardMessage: async (_client: unknown, channelId: string, messageId: string | null, payload: { embeds: Array<{ data: { title?: string } }> }) => {
		m.cards.push({ channelId, messageId, title: payload.embeds[0]?.data.title ?? "" });
		return messageId ?? `msg${++m.counter}`;
	},
}));
vi.mock("./consentNotice.js", () => ({
	postConsentNotice: async (_c: unknown, _ch: string, _copy: unknown, input: { memberIds: readonly string[] }) => {
		m.notices.push(input);
		return true;
	},
	registerConsentButtons: () => undefined,
}));
vi.mock("./meetingConsent.js", () => ({ consentingMembers: async (_g: string, ids: readonly string[]) => new Set(ids.filter((id) => m.agreed.has(id))) }));
vi.mock("./meetingHosts.js", () => ({ isMeetingHost: async () => m.isHost }));
vi.mock("./meetingRecorder.js", () => ({
	PREPAID_CENTS: 1,
	defaultMeetingRecorderDeps: {},
	getMeetingRecorder: () => null,
	startMeetingRecorder: (_start: unknown, deps: { onSpendRefused: (guildId: string, meetingId: string) => void }) => {
		m.spendRefusers.push(deps.onSpendRefused);
		return { stop: () => undefined };
	},
}));
vi.mock("./scheduledMeetings.js", () => ({
	MEETING_ACTIONS: { record: "rec", end: "end" },
	meetingCustomId: (action: string, id?: string) => (id ? `mtg:${action}:${id}` : `mtg:${action}`),
	redrawScheduledMeetingCard: async () => undefined,
	useRecordingControls: () => undefined,
}));

const { _resetLiveMeetings, createMeetingListener, endMeeting, registerMeetingRecording, startMeeting } = await import("./meetingLifecycle.js");
const { recoverInterruptedMeetings } = await import("./meetingBootRecovery.js");

const hallMembers = new Map<string, { id: string; user: { bot: boolean } }>([
	["host", { id: "host", user: { bot: false } }],
	["carol", { id: "carol", user: { bot: false } }],
	["bot", { id: "bot", user: { bot: true } }],
]);
const guild = { id: "g1", channels: { cache: new Map([["hall", { isVoiceBased: () => true, members: hallMembers }]]) } } as unknown as Guild;
const client = { guilds: { cache: new Map([["g1", guild]]) } } as unknown as Client;
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
