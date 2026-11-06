import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatInputCommandInteraction, EmbedBuilder } from "discord.js";

// ── /platform ──────────────────────────────────────────────────────────────
// The platform owner's command keeps its own check: ADMIN_COMMANDS never sees it, so
// all four of its doors, the network group, analytics, the Verse and the birthday gift, must refuse everyone but
// CREATOR_DISCORD_ID before they read or write anything.

const mocks = vi.hoisted(() => ({
	ban: vi.fn(),
	unban: vi.fn(),
	buildReport: vi.fn(),
	buildVerse: vi.fn(),
}));

vi.mock("@utils/config.js", () => ({ creatorId: "owner-1" }));
vi.mock("@db/stores/networkBanStore.js", () => ({ networkBanStore: { ban: mocks.ban, unban: mocks.unban } }));
vi.mock("@features/game-rooms/networkBoard.js", () => ({ scheduleNetworkBoardRefresh: vi.fn() }));
vi.mock("@features/game-rooms/satelliteSeats.js", () => ({ seatOutBannedMember: vi.fn(async () => 0), seatOutBannedServer: vi.fn(async () => 0) }));
vi.mock("@features/renderer/renderAnalytics.js", () => ({
	RENDER_ANALYTICS_PERIODS: ["this-month", "last-month", "all-time"],
	buildRenderAnalyticsReport: mocks.buildReport,
}));

vi.mock("@features/platform/verseProgress.js", () => ({ buildVerseProgress: mocks.buildVerse }));

import { data, execute } from "./platform.js";

function interaction(userId: string, group: string | null, sub: string) {
	const reply = vi.fn(async () => undefined);
	const fake = {
		user: { id: userId },
		client: { guilds: { cache: new Map() } },
		reply,
		deferReply: vi.fn(async () => undefined),
		editReply: vi.fn(async () => undefined),
		options: {
			getSubcommandGroup: () => group,
			getSubcommand: () => sub,
			getString: (name: string) => (name === "target" ? "member" : null),
			getUser: () => ({ id: "member-1" }),
		},
	} as unknown as ChatInputCommandInteraction;
	return { fake, reply };
}

// The network refusals are notices since 2026-10 item 263 R3-12 (plain text where the fake cannot
// open a modal); analytics and the Verse still refuse with the error embed.
const firstText = (reply: ReturnType<typeof vi.fn>): string => {
	const payload = (reply.mock.calls[0] as unknown as [{ content?: string; embeds?: EmbedBuilder[] }])[0];
	return payload.content ?? payload.embeds?.[0]?.data.description ?? "";
};

beforeEach(() => {
	mocks.ban.mockReset().mockResolvedValue(true);
	mocks.unban.mockReset().mockResolvedValue(true);
	mocks.buildReport.mockReset();
});

describe("/platform", () => {
	it("holds the network group, analytics, the Verse and the birthday gift, with no Discord default permission", () => {
		const json = data.toJSON();
		expect(json.default_member_permissions).toBeUndefined();
		expect((json.options ?? []).map((option) => option.name)).toEqual(["network", "analytics", "verse", "birthday-gift"]);
	});

	it.each([
		["network", "ban"],
		["network", "unban"],
	])("refuses /platform %s %s to anybody but the platform owner, writing nothing", async (group, sub) => {
		const { fake, reply } = interaction("admin-1", group, sub);
		await execute(fake);
		expect(firstText(reply)).toContain("Only the platform owner");
		expect(mocks.ban).not.toHaveBeenCalled();
		expect(mocks.unban).not.toHaveBeenCalled();
	});

	it("refuses /platform analytics to anybody but the platform owner, reading nothing", async () => {
		const { fake, reply } = interaction("admin-1", null, "analytics");
		await execute(fake);
		expect(firstText(reply)).toContain("Only the platform owner");
		expect(mocks.buildReport).not.toHaveBeenCalled();
	});

	it("refuses /platform verse to anybody but the platform owner, reading nothing and never reaching analytics", async () => {
		const { fake, reply } = interaction("admin-1", null, "verse");
		await execute(fake);
		expect(firstText(reply)).toContain("Only the platform owner can read the Verse");
		expect(mocks.buildVerse).not.toHaveBeenCalled();
		expect(mocks.buildReport).not.toHaveBeenCalled();
	});

	it("refuses /platform birthday-gift to anybody but the platform owner, never reaching analytics", async () => {
		const { fake, reply } = interaction("admin-1", null, "birthday-gift");
		await execute(fake);
		expect(firstText(reply)).toContain("Only the platform owner can set a birthday gift");
		expect(mocks.buildReport).not.toHaveBeenCalled();
	});

	it("lets the platform owner ban through the network group", async () => {
		const { fake } = interaction("owner-1", "network", "ban");
		await execute(fake);
		expect(mocks.ban).toHaveBeenCalledWith("user", "member-1", "", expect.any(Date));
	});
});
