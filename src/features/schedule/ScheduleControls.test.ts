import type { ButtonInteraction } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Only the Go Live Now press is under test: its gate, its announcement and its answer are
// mocked, so the order of the acknowledgement and the ping is all that is left to observe.
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn().mockResolvedValue({ guildId: "guild-1" }) } }));
vi.mock("@utils/permissions.js", () => ({ gateOwnerOrAdmin: vi.fn().mockResolvedValue(true) }));
vi.mock("@features/schedule/postGoLiveAnnouncement.js", () => ({ postGoLiveAnnouncement: vi.fn() }));
vi.mock("@features/schedule/scheduleBulkControls.js", () => ({ pauseAllGuildEvents: vi.fn(), resumeAllGuildEvents: vi.fn() }));
vi.mock("@features/schedule/ScheduleBoard.js", () => ({ refreshSchedule: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@features/setup/adminLog.js", () => ({ adminLog: { emitFor: vi.fn() } }));
vi.mock("@utils/answerInChannel.js", () => ({ answerInChannel: vi.fn().mockResolvedValue({ channelId: "ch-config" }), beginChannelAnswer: vi.fn() }));
vi.mock("@features/schedule/goLiveSoon.js", () => ({ answerGoLiveRefusal: vi.fn().mockResolvedValue(undefined) }));

import { registerScheduleControlHandlers } from "./ScheduleControls.js";
import { dispatchButton } from "@handlers/interactionRegistry.js";
import { postGoLiveAnnouncement } from "@features/schedule/postGoLiveAnnouncement.js";

const postMock = postGoLiveAnnouncement as unknown as ReturnType<typeof vi.fn>;

function pressGoLive(): ButtonInteraction & { deferUpdate: ReturnType<typeof vi.fn> } {
	return {
		customId: "schedule_controls:go_live_now",
		guildId: "guild-1",
		guild: { id: "guild-1" },
		client: {},
		deferred: false,
		replied: false,
		deferUpdate: vi.fn().mockResolvedValue(undefined),
	} as unknown as ButtonInteraction & { deferUpdate: ReturnType<typeof vi.fn> };
}

// The registry refuses a second registration of one prefix, so the handler registers once.
registerScheduleControlHandlers();

beforeEach(() => {
	vi.clearAllMocks();
	postMock.mockResolvedValue({ ok: true });
});

// Bot audit 2026-10-30: the announcement used to post before the press was acknowledged, so a
// slow post showed "interaction failed" after its ping had gone out, and a second press pinged again.
describe("Go Live Now", () => {
	it("acknowledges the press before the announcement pings anyone", async () => {
		const press = pressGoLive();

		expect(await dispatchButton(press)).toBe(true);

		expect(press.deferUpdate).toHaveBeenCalledTimes(1);
		expect(postMock).toHaveBeenCalledTimes(1);
		expect(press.deferUpdate.mock.invocationCallOrder[0]).toBeLessThan(postMock.mock.invocationCallOrder[0]);
	});

	it("posts nothing when the press can no longer be acknowledged", async () => {
		const press = pressGoLive();
		press.deferUpdate.mockRejectedValueOnce(new Error("Unknown interaction"));

		await expect(dispatchButton(press)).rejects.toThrow("Unknown interaction");

		expect(postMock).not.toHaveBeenCalled();
	});
});
