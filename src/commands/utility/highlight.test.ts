import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatInputCommandInteraction } from "discord.js";

// ── /highlight and /count (Creator Lab live capture, 2026-11 item 284 Phase 3) ──
// Both are dark behind their flag, guild only, private from the first byte, and confirm only what the
// server confirmed. The server call is mocked at liveCaptureApi; its own test pins the wire.

const state = vi.hoisted(() => ({ liveEnabled: true }));

vi.mock("@utils/config.js", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return {
		...actual,
		get creatorLabLiveEnabled() {
			return state.liveEnabled;
		},
	};
});
vi.mock("@features/creator-lab/liveCaptureApi.js", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return { ...actual, logLiveHighlight: vi.fn(), logLiveCount: vi.fn() };
});
vi.mock("@utils/textModal.js", () => ({ showNotice: vi.fn() }));

import { execute as executeHighlight, data as highlightData } from "./highlight.js";
import { execute as executeCount, data as countData } from "./count.js";
import { logLiveCount, logLiveHighlight } from "@features/creator-lab/liveCaptureApi.js";
import { showNotice } from "@utils/textModal.js";

const highlightMock = logLiveHighlight as unknown as ReturnType<typeof vi.fn>;
const countMock = logLiveCount as unknown as ReturnType<typeof vi.fn>;

const makeInteraction = (options: Record<string, string | null> = {}, inGuild = true) => {
	const interaction = {
		guildId: inGuild ? "700000000000000001" : null,
		channelId: "700000000000000002",
		user: { id: "800000000000000001" },
		inGuild: () => inGuild,
		options: { getString: vi.fn((name: string) => options[name] ?? null) },
		deferReply: vi.fn(async () => undefined),
		editReply: vi.fn(async () => undefined),
	};
	return interaction as typeof interaction & ChatInputCommandInteraction;
};

const replyText = (interaction: ReturnType<typeof makeInteraction>): string => {
	const reply = interaction.editReply.mock.calls[0]?.[0] as unknown as { embeds: Array<{ data: { description?: string } }> };
	return reply.embeds[0]?.data.description ?? "";
};

describe("/highlight", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		state.liveEnabled = true;
	});

	it("is open to every member with an optional note", () => {
		const json = highlightData.toJSON();
		expect(json.name).toBe("highlight");
		expect(json.default_member_permissions ?? null).toBeNull();
		expect(json.options?.[0]).toMatchObject({ name: "note", required: false, max_length: 300 });
	});

	it("only says it is not on yet while the flag is off, and calls nothing", async () => {
		state.liveEnabled = false;
		const interaction = makeInteraction();
		await executeHighlight(interaction);
		expect(showNotice).toHaveBeenCalledTimes(1);
		expect(highlightMock).not.toHaveBeenCalled();
		expect(interaction.deferReply).not.toHaveBeenCalled();
	});

	it("refuses outside a server", async () => {
		const interaction = makeInteraction({}, false);
		await executeHighlight(interaction);
		expect(showNotice).toHaveBeenCalledTimes(1);
		expect(highlightMock).not.toHaveBeenCalled();
	});

	it("defers privately and confirms the offset the server saved", async () => {
		highlightMock.mockResolvedValueOnce({ kind: "saved", offsetSeconds: 3725 });
		const interaction = makeInteraction({ note: "the clutch" });
		await executeHighlight(interaction);
		expect(interaction.deferReply).toHaveBeenCalledWith({ flags: 64 });
		expect(highlightMock).toHaveBeenCalledWith(
			{ guildId: "700000000000000001", channelId: "700000000000000002", discordUserId: "800000000000000001" },
			"the clutch"
		);
		expect(replyText(interaction)).toContain("1:02:05");
	});

	it("tells the member to wait, or that the stream is not live, and never says saved", async () => {
		highlightMock.mockResolvedValueOnce({ kind: "refused", reason: "cooldown", retryAfterSeconds: 42 });
		const waiting = makeInteraction();
		await executeHighlight(waiting);
		expect(replyText(waiting)).toContain("42 seconds");

		highlightMock.mockResolvedValueOnce({ kind: "refused", reason: "notLive", retryAfterSeconds: null });
		const offline = makeInteraction();
		await executeHighlight(offline);
		expect(replyText(offline)).toContain("not live");
		expect(replyText(offline)).not.toContain("Saved");
	});
});

describe("/count", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		state.liveEnabled = true;
	});

	it("is open to every member with a required name and an optional note", () => {
		const json = countData.toJSON();
		expect(json.name).toBe("count");
		expect(json.default_member_permissions ?? null).toBeNull();
		expect(json.options?.map((option) => [option.name, option.required])).toEqual([
			["name", true],
			["note", false],
		]);
	});

	it("is dark while the flag is off", async () => {
		state.liveEnabled = false;
		const interaction = makeInteraction({ name: "death" });
		await executeCount(interaction);
		expect(showNotice).toHaveBeenCalledTimes(1);
		expect(countMock).not.toHaveBeenCalled();
	});

	it("answers the stream's new total in the counter's own spelling", async () => {
		countMock.mockResolvedValueOnce({ kind: "counted", counterName: "Death", count: 7, offsetSeconds: 90 });
		const interaction = makeInteraction({ name: "death", note: "lava" });
		await executeCount(interaction);
		expect(interaction.deferReply).toHaveBeenCalledWith({ flags: 64 });
		expect(countMock).toHaveBeenCalledWith(expect.objectContaining({ channelId: "700000000000000002" }), "death", "lava");
		expect(replyText(interaction)).toContain("**Death** is now at **7**");
	});

	it("says nothing was saved when Dero could not reach Creator Lab", async () => {
		countMock.mockResolvedValueOnce({ kind: "refused", reason: "unreachable", retryAfterSeconds: null });
		const interaction = makeInteraction({ name: "death" });
		await executeCount(interaction);
		expect(replyText(interaction)).toContain("Nothing was saved");
	});
});
