import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { Guild, VoiceState } from "discord.js";
import { VoiceConnectionStatus, type VoiceConnection } from "@discordjs/voice";
import { createVoiceSessions, type StartListening, type VoiceSessionDeps } from "./voiceSessions.js";
import { createVoiceSessionWatcher } from "./voiceSessionWatchers.js";
import type { VoiceSpeaker } from "./voiceSpeaker.js";

// Mode exclusivity (2026-11 item 388, owner decision D24): a meeting mode session starts the
// meeting factory and never the command listener, a command session the reverse, a join with no
// mode is a command session, and the watcher's idle rule leaves a meeting session alone (R5).
// Kept apart from voiceSessions.test.ts so that suite stays exactly as it was.

class FakeConnection extends EventEmitter {
	state = { status: VoiceConnectionStatus.Ready };
	receiver = { fake: "receiver" };
	subscribe(): object {
		return {};
	}
	destroy(): void {
		this.state = { status: VoiceConnectionStatus.Destroyed };
		this.emit(VoiceConnectionStatus.Destroyed);
	}
}

function makeSessions() {
	const deps: VoiceSessionDeps = {
		joinChannel: () => new FakeConnection() as unknown as VoiceConnection,
		waitForStatus: async (_connection, status) => status === VoiceConnectionStatus.Ready,
		createSpeaker: () => ({ player: {}, close: vi.fn() }) as unknown as VoiceSpeaker,
		postNotice: async () => undefined,
		audit: () => undefined,
		dependencyReport: () => "",
		now: () => Date.now(),
	};
	const sessions = createVoiceSessions(deps);
	const command = vi.fn<StartListening>(() => ({ stop: vi.fn() }));
	const meeting = vi.fn<StartListening>(() => ({ stop: vi.fn() }));
	sessions.useListener(command);
	sessions.useListener(meeting, "meeting");
	return { sessions, command, meeting };
}

const guild = { id: "g1", voiceAdapterCreator: () => ({}) } as unknown as Guild;

describe("session modes", () => {
	it("a meeting session starts only the meeting factory, with its meeting id", async () => {
		const { sessions, command, meeting } = makeSessions();
		const outcome = await sessions.join({ guild, channel: { id: "hall" }, controlChannelId: "notes", mode: "meeting", meetingId: "mtg1" });
		expect(outcome.status).toBe("joined");
		expect(command).not.toHaveBeenCalled();
		expect(meeting).toHaveBeenCalledWith(expect.objectContaining({ mode: "meeting", meetingId: "mtg1", channelId: "hall" }));
		expect(sessions.get("g1")).toMatchObject({ mode: "meeting", meetingId: "mtg1" });
	});

	it("a join with no mode is a command session, as every caller before meetings expects", async () => {
		const { sessions, command, meeting } = makeSessions();
		await sessions.join({ guild, channel: { id: "lounge" }, controlChannelId: "cmds", meetingId: "ignored" });
		expect(meeting).not.toHaveBeenCalled();
		expect(command).toHaveBeenCalledWith(expect.objectContaining({ mode: "command", meetingId: null }));
	});

	it("the idle rule never leaves a meeting session", async () => {
		const { sessions } = makeSessions();
		await sessions.join({ guild, channel: { id: "hall" }, controlChannelId: "notes", mode: "meeting", meetingId: "mtg1" });
		const watcher = createVoiceSessionWatcher({ sessions, findConfig: async () => null, idleLeaveMs: 10 });
		const voiceState = { guild, id: "member", channelId: null, client: { user: { id: "dero" } } } as unknown as VoiceState;
		await watcher.onVoiceStateUpdate({ ...voiceState, channelId: "hall" } as VoiceState, voiceState);
		expect(watcher.pendingIdleCount()).toBe(0);
		expect(sessions.get("g1")).not.toBeNull();
	});
});
