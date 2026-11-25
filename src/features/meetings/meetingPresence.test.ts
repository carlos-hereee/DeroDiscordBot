import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Client, VoiceState } from "discord.js";

// Every join to and leave from 🏛️ Meeting Hall during a recording asks whoever in it was not
// asked yet and recounts the room (meetingLifecycle decides who that is); a change elsewhere, or
// with no recording, does nothing.

const m = vi.hoisted(() => ({
	live: null as { meetingId: string; hallId: string } | null,
	asks: 0,
	checks: 0,
	deletedChannels: [] as string[],
	released: [] as string[],
}));

vi.mock("./meetingRecorder.js", () => ({
	getMeetingRecorder: (meetingId: string) => ({ releaseSpeaker: (userId: string) => void m.released.push(`${meetingId}:${userId}`) }),
}));
vi.mock("./meetingLifecycle.js", () => ({
	liveMeetingIn: () => m.live,
	checkRoom: async () => {
		m.checks += 1;
	},
	askUnaskedInHall: async () => {
		m.asks += 1;
	},
	endForDeletedNotesChannel: async (_client: unknown, channelId: string) => {
		m.deletedChannels.push(channelId);
	},
}));

const { onMeetingVoiceState, registerMeetingPresence } = await import("./meetingPresence.js");

const client = {} as Client;
const state = (channelId: string | null, id = "dave", bot = false): VoiceState =>
	({ id, guild: { id: "g1" }, channelId, member: { id, user: { bot } } }) as unknown as VoiceState;

beforeEach(() => {
	m.live = { meetingId: "mtg1", hallId: "hall" };
	Object.assign(m, { asks: 0, checks: 0, deletedChannels: [], released: [] });
});

describe("onMeetingVoiceState", () => {
	it("L3: asks whoever was not asked yet and recounts, on every hall join and leave", async () => {
		await onMeetingVoiceState(client, state(null), state("hall"));
		await onMeetingVoiceState(client, state("hall"), state(null));
		await onMeetingVoiceState(client, state(null), state("hall"));
		expect(m.asks).toBe(3);
		expect(m.checks).toBe(3);
	});

	it("L12: a leave gives the leaver's recording slot back, and a join does not", async () => {
		await onMeetingVoiceState(client, state(null), state("hall"));
		expect(m.released).toEqual([]);
		await onMeetingVoiceState(client, state("hall"), state("lounge"));
		expect(m.released).toEqual(["mtg1:dave"]);
	});

	it("L2: hands every deleted channel to the lifecycle, which knows the one that matters", async () => {
		const handlers = new Map<string, (payload: unknown) => void>();
		registerMeetingPresence({ on: (event: string, handler: (payload: unknown) => void) => handlers.set(event, handler) } as unknown as Client);
		handlers.get("channelDelete")?.({ id: "c9" });
		expect(m.deletedChannels).toEqual(["c9"]);
	});

	it("ignores a change that neither enters nor leaves the hall, and every change with no recording", async () => {
		await onMeetingVoiceState(client, state("lounge"), state("arcade"));
		m.live = null;
		await onMeetingVoiceState(client, state(null), state("hall"));
		expect(m.asks).toBe(0);
		expect(m.checks).toBe(0);
	});
});
