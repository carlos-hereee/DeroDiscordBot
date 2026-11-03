import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Creator Lab live capture, the bot's half of the wire (2026-11 item 284 Phase 3) ──
// Pins the bodies the bot signs and sends (the server parses them with strict schemas, so an extra
// key is a 400) and how every server answer becomes one outcome. serverApi is mocked at its export;
// the real ServerResponseError class is kept so the refusal path reads a real error.

vi.mock("@utils/serverApi.js", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return { ...actual, serverApi: { post: vi.fn() } };
});

import { serverApi, ServerResponseError, ServerUnreachableError } from "@utils/serverApi.js";
import { formatStreamOffset, LIVE_COUNTER_EVENTS_PATH, LIVE_HIGHLIGHTS_PATH, logLiveCount, logLiveHighlight } from "./liveCaptureApi.js";

const postMock = serverApi.post as unknown as ReturnType<typeof vi.fn>;
const context = { guildId: "700000000000000001", channelId: "700000000000000002", discordUserId: "800000000000000001" };

describe("logLiveHighlight", () => {
	beforeEach(() => vi.clearAllMocks());

	it("posts the channel and member, the note only when there is one, and reads the offset", async () => {
		postMock.mockResolvedValueOnce({ data: { highlightUid: "h1", offsetSeconds: 3725 } });
		expect(await logLiveHighlight(context, "clutch")).toEqual({ kind: "saved", offsetSeconds: 3725 });
		expect(postMock).toHaveBeenCalledWith(LIVE_HIGHLIGHTS_PATH, { ...context, note: "clutch" });

		postMock.mockResolvedValueOnce({ data: { highlightUid: "h2", offsetSeconds: 10 } });
		await logLiveHighlight(context, null);
		expect(postMock).toHaveBeenLastCalledWith(LIVE_HIGHLIGHTS_PATH, context);
	});

	it("turns each server code into its reason, with the cooldown's wait", async () => {
		const cases: Array<[number, string, string]> = [
			[503, "CREATOR_LAB_LIVE_DISABLED", "disabled"],
			[404, "CREATOR_LAB_LIVE_NOT_LINKED", "notLinked"],
			[409, "CREATOR_LAB_LIVE_NOT_LIVE", "notLive"],
			[429, "CREATOR_LAB_LIVE_CAP_REACHED", "capReached"],
			[400, "CREATOR_LAB_LIVE_INVALID_BODY", "invalid"],
			[500, "SOMETHING_ELSE", "unreachable"],
		];
		for (const [status, code, reason] of cases) {
			postMock.mockRejectedValueOnce(new ServerResponseError(status, { error: "x", code }));
			expect(await logLiveHighlight(context, null)).toEqual({ kind: "refused", reason, retryAfterSeconds: null });
		}
		postMock.mockRejectedValueOnce(new ServerResponseError(429, { error: "x", code: "CREATOR_LAB_LIVE_COOLDOWN", retryAfterSeconds: 42 }));
		expect(await logLiveHighlight(context, null)).toEqual({ kind: "refused", reason: "cooldown", retryAfterSeconds: 42 });
	});

	it("never claims a save the server did not confirm", async () => {
		postMock.mockRejectedValueOnce(new ServerUnreachableError(new Error("ECONNREFUSED")));
		expect((await logLiveHighlight(context, null)).kind).toBe("refused");
		postMock.mockResolvedValueOnce({ data: { highlightUid: "h1" } });
		expect(await logLiveHighlight(context, null)).toEqual({ kind: "refused", reason: "unreachable", retryAfterSeconds: null });
	});
});

describe("logLiveCount", () => {
	beforeEach(() => vi.clearAllMocks());

	it("posts the counter name as typed and reads the stream's total", async () => {
		postMock.mockResolvedValueOnce({ data: { counterName: "Death", count: 7, offsetSeconds: 90 } });
		expect(await logLiveCount(context, "  DEATH ", "fell")).toEqual({ kind: "counted", counterName: "Death", count: 7, offsetSeconds: 90 });
		expect(postMock).toHaveBeenCalledWith(LIVE_COUNTER_EVENTS_PATH, { ...context, counterName: "  DEATH ", note: "fell" });
	});

	it("reads a malformed answer as unreachable", async () => {
		postMock.mockResolvedValueOnce({ data: { counterName: "Death", count: "7", offsetSeconds: 90 } });
		expect(await logLiveCount(context, "death", null)).toEqual({ kind: "refused", reason: "unreachable", retryAfterSeconds: null });
	});
});

describe("formatStreamOffset", () => {
	it("writes minutes and seconds, and hours only when there are any", () => {
		expect(formatStreamOffset(0)).toBe("0:00");
		expect(formatStreamOffset(125)).toBe("2:05");
		expect(formatStreamOffset(3725)).toBe("1:02:05");
	});
});
