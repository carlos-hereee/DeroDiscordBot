import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Client } from "discord.js";

// ── render analytics weekly digest ───────────────────────────────────
// Pins the Monday owner DM (2026-10 item 244, Phase 2a): no owner id or the
// kill switch off means one log line and no DM; with an owner it sends exactly
// one DM carrying this month's report; a failed read or send never throws into
// the cron that fires it. The report builder is mocked; its math is pinned in
// renderAnalytics.test.ts.

const settings = vi.hoisted(() => ({ creatorId: "900000000000000001", enabled: true }));

vi.mock("@utils/config.js", () => ({
	get creatorId() {
		return settings.creatorId;
	},
	get renderAnalyticsEnabled() {
		return settings.enabled;
	},
}));

vi.mock("./renderAnalytics.js", () => ({
	RENDER_ANALYTICS_PERIODS: ["this-month", "last-month", "all-time"],
	buildRenderAnalyticsReport: vi.fn(),
}));

import { buildRenderAnalyticsReport, type RenderAnalyticsReport } from "./renderAnalytics.js";
import { renderAnalyticsCopy } from "./renderAnalyticsCopy.js";
import { sendRenderAnalyticsDigest } from "./renderAnalyticsDigest.js";

const buildMock = vi.mocked(buildRenderAnalyticsReport);

const REPORT: RenderAnalyticsReport = {
	period: "this-month",
	months: ["2026-10"],
	surface: null,
	surfaces: [],
	memory: { cards: 3, cardCapacity: 100, avatars: 7, avatarCapacity: 500, growMemoryTier: false },
	top: [],
	droppedWrites: 0,
};

interface FakeClient {
	client: Client;
	fetchUser: ReturnType<typeof vi.fn>;
	send: ReturnType<typeof vi.fn>;
}

// Only client.users.fetch and user.send, the two calls the digest makes.
function fakeClient(): FakeClient {
	const send = vi.fn(async () => undefined);
	const fetchUser = vi.fn(async () => ({ send }));
	const client = { users: { fetch: fetchUser } } as unknown as Client;
	return { client, fetchUser, send };
}

beforeEach(() => {
	settings.creatorId = "900000000000000001";
	settings.enabled = true;
	buildMock.mockReset();
	buildMock.mockResolvedValue(REPORT);
	vi.spyOn(console, "log").mockImplementation(() => undefined);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

// spyOn over a live spy reuses it, so without a restore each test would count the last one's log lines too.
afterEach(() => {
	vi.restoreAllMocks();
});

describe("sendRenderAnalyticsDigest", () => {
	it("skips quietly with one log line and no DM when CREATOR_DISCORD_ID is empty", async () => {
		settings.creatorId = "";
		const { client, fetchUser } = fakeClient();
		const outcome = await sendRenderAnalyticsDigest(client);
		expect(outcome).toBe("skipped-no-owner");
		expect(fetchUser).not.toHaveBeenCalled();
		expect(buildMock).not.toHaveBeenCalled();
		expect(console.log).toHaveBeenCalledTimes(1);
	});

	it("skips quietly with one log line and no DM when render analytics is off", async () => {
		settings.enabled = false;
		const { client, fetchUser } = fakeClient();
		const outcome = await sendRenderAnalyticsDigest(client);
		expect(outcome).toBe("skipped-disabled");
		expect(fetchUser).not.toHaveBeenCalled();
		expect(buildMock).not.toHaveBeenCalled();
		expect(console.log).toHaveBeenCalledTimes(1);
	});

	it("sends exactly one DM to the owner with this month's report", async () => {
		const now = new Date("2026-10-26T14:15:00Z");
		const { client, fetchUser, send } = fakeClient();
		const outcome = await sendRenderAnalyticsDigest(client, now);
		expect(outcome).toBe("sent");
		expect(buildMock).toHaveBeenCalledWith({ period: "this-month", now });
		expect(fetchUser).toHaveBeenCalledWith("900000000000000001");
		expect(send).toHaveBeenCalledTimes(1);
		const [{ embeds }] = send.mock.calls[0] as [{ embeds: Array<{ data: { title?: string } }> }];
		expect(embeds).toHaveLength(1);
		expect(embeds[0].data.title).toBe(renderAnalyticsCopy.digestTitle);
	});

	it("answers failed instead of throwing when the DM is refused", async () => {
		const { client, send } = fakeClient();
		send.mockRejectedValue(new Error("Cannot send messages to this user"));
		await expect(sendRenderAnalyticsDigest(client)).resolves.toBe("failed");
		expect(console.warn).toHaveBeenCalledTimes(1);
	});

	it("answers failed instead of throwing when the report read fails, and sends nothing", async () => {
		buildMock.mockRejectedValue(new Error("atlas unreachable"));
		const { client, fetchUser } = fakeClient();
		await expect(sendRenderAnalyticsDigest(client)).resolves.toBe("failed");
		expect(fetchUser).not.toHaveBeenCalled();
	});
});
