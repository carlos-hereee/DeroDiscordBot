import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Client, VoiceState } from "discord.js";

// A member who joins 🏛️ Meeting Hall mid meeting is asked once per meeting, and every hall join
// or leave recounts the room; a change elsewhere, or with no recording, does nothing.

const m = vi.hoisted(() => ({
	live: null as { meetingId: string; hallId: string; notesChannelId: string; title: string; hostId: string; copy: unknown; pinged: Set<string> } | null,
	notices: [] as string[][],
	checks: 0,
}));

vi.mock("./meetingLifecycle.js", () => ({
	liveMeetingIn: () => m.live,
	checkRoom: async () => {
		m.checks += 1;
	},
}));
vi.mock("./consentNotice.js", () => ({
	postConsentNotice: async (_c: unknown, _ch: string, _copy: unknown, input: { memberIds: string[] }) => {
		m.notices.push(input.memberIds);
		return true;
	},
}));

const { onMeetingVoiceState } = await import("./meetingPresence.js");

const client = {} as Client;
const state = (channelId: string | null, id = "dave", bot = false): VoiceState =>
	({ guild: { id: "g1" }, channelId, member: { id, user: { bot } } }) as unknown as VoiceState;

beforeEach(() => {
	m.live = { meetingId: "mtg1", hallId: "hall", notesChannelId: "notes", title: "Sync", hostId: "host", copy: {}, pinged: new Set(["host"]) };
	m.notices = [];
	m.checks = 0;
});

describe("onMeetingVoiceState", () => {
	it("asks a member who joins the hall once per meeting, however often they come back", async () => {
		await onMeetingVoiceState(client, state(null), state("hall"));
		await onMeetingVoiceState(client, state("hall"), state(null));
		await onMeetingVoiceState(client, state(null), state("hall"));
		expect(m.notices).toEqual([["dave"]]);
		expect(m.checks).toBe(3);
	});

	it("never asks a bot, nor a member already asked at the start", async () => {
		await onMeetingVoiceState(client, state(null, "dero", true), state("hall", "dero", true));
		await onMeetingVoiceState(client, state(null, "host"), state("hall", "host"));
		expect(m.notices).toEqual([]);
	});

	it("ignores a change that neither enters nor leaves the hall, and every change with no recording", async () => {
		await onMeetingVoiceState(client, state("lounge"), state("arcade"));
		m.live = null;
		await onMeetingVoiceState(client, state(null), state("hall"));
		expect(m.notices).toEqual([]);
		expect(m.checks).toBe(0);
	});
});
