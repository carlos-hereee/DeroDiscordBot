import { describe, it, expect, vi, beforeEach } from "vitest";
import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";

// ── /render-analytics ─────────────────────────────────────────────────────
// Pins the owner gate (2026-10 item 244): the rows are platform wide, so only
// CREATOR_DISCORD_ID may read them and an unset id refuses everyone; every reply
// is ephemeral; the period defaults to this month; and the command stays out of
// BOT_CONSTANTS.ADMIN_COMMANDS, whose gate needs a /setup config the owner may
// not have in the server they run it from.

const owner = vi.hoisted(() => ({ id: "900000000000000001" }));

vi.mock("@utils/config.js", () => ({
	get creatorId() {
		return owner.id;
	},
}));

vi.mock("@features/renderer/renderAnalytics.js", () => ({
	RENDER_ANALYTICS_PERIODS: ["this-month", "last-month", "all-time"],
	buildRenderAnalyticsReport: vi.fn(),
}));

import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { buildRenderAnalyticsReport, type RenderAnalyticsReport } from "@features/renderer/renderAnalytics.js";
import { data, execute, formatRenderAnalyticsReport, RENDER_ANALYTICS_SUBCOMMANDS } from "./render-analytics.js";

const buildMock = vi.mocked(buildRenderAnalyticsReport);

const EMPTY_REPORT: RenderAnalyticsReport = {
	period: "this-month",
	months: ["2026-10"],
	surface: null,
	surfaces: [],
	memory: { cards: 3, cardCapacity: 100, avatars: 7, avatarCapacity: 500, growMemoryTier: false },
	top: [],
	droppedWrites: 0,
};

interface FakeInteraction {
	interaction: ChatInputCommandInteraction;
	reply: ReturnType<typeof vi.fn>;
	deferReply: ReturnType<typeof vi.fn>;
	editReply: ReturnType<typeof vi.fn>;
}

// Only the members execute touches, so a change that reaches for more fails loudly here.
function fakeInteraction(userId: string, options: { period?: string; surface?: string } = {}): FakeInteraction {
	const reply = vi.fn(async () => undefined);
	const deferReply = vi.fn(async () => undefined);
	const editReply = vi.fn(async () => undefined);
	const interaction = {
		user: { id: userId },
		options: {
			getSubcommand: () => "top10",
			getString: (name: string) => (name === "period" ? options.period ?? null : options.surface ?? null),
		},
		reply,
		deferReply,
		editReply,
	} as unknown as ChatInputCommandInteraction;
	return { interaction, reply, deferReply, editReply };
}

beforeEach(() => {
	owner.id = "900000000000000001";
	buildMock.mockReset();
	buildMock.mockResolvedValue(EMPTY_REPORT);
});

describe("/render-analytics owner gate", () => {
	it("refuses a member who is not the platform owner, ephemerally, without reading anything", async () => {
		const { interaction, reply } = fakeInteraction("123");

		await execute(interaction);

		expect(reply).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral }));
		expect(buildMock).not.toHaveBeenCalled();
	});

	it("refuses everyone when CREATOR_DISCORD_ID is unset, even an empty user id", async () => {
		owner.id = "";
		const { interaction, reply } = fakeInteraction("");

		await execute(interaction);

		expect(reply).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral }));
		expect(buildMock).not.toHaveBeenCalled();
	});

	it("answers the owner ephemerally, defaulting the period to this month", async () => {
		const { interaction, deferReply, editReply } = fakeInteraction(owner.id);

		await execute(interaction);

		expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
		expect(buildMock).toHaveBeenCalledWith({ period: "this-month", surface: null });
		expect(editReply).toHaveBeenCalledTimes(1);
	});

	it("passes a chosen period and surface through", async () => {
		const { interaction } = fakeInteraction(owner.id, { period: "all-time", surface: " Hangman " });

		await execute(interaction);

		expect(buildMock).toHaveBeenCalledWith({ period: "all-time", surface: "hangman" });
	});

	it("answers an honest error, still ephemeral, when the read fails", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		buildMock.mockRejectedValueOnce(new Error("Atlas down"));
		const { interaction, deferReply, editReply } = fakeInteraction(owner.id);

		await execute(interaction);

		expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
		expect(editReply).toHaveBeenCalledTimes(1);
	});
});

describe("/render-analytics builder", () => {
	// No Discord default: the platform owner check in execute is the whole gate, and the
	// admin command pin test allows a default only on /setup and /self-destruct.
	it("declares only top10, with no Discord default permission", () => {
		const json = data.toJSON() as { default_member_permissions?: string; options?: Array<{ name: string }> };
		expect((json.options ?? []).map((option) => option.name)).toEqual([...RENDER_ANALYTICS_SUBCOMMANDS]);
		expect(json.default_member_permissions).toBeUndefined();
	});

	it("is not in BOT_CONSTANTS.ADMIN_COMMANDS", () => {
		expect(BOT_CONSTANTS.ADMIN_COMMANDS.has("render-analytics")).toBe(false);
	});
});

describe("/render-analytics report text", () => {
	it("says so honestly when a surface has no rows in the period", () => {
		const text = formatRenderAnalyticsReport({ ...EMPTY_REPORT, surface: "hangman" });
		expect(text).toBe("No rows for hangman in this month.");
	});

	it("stays inside Discord's 4096 character description limit", () => {
		const many = Array.from({ length: 200 }, (_, index) => ({
			surface: `surface-${index}-${"x".repeat(20)}`,
			rows: 1,
			bytes: 1,
			hits: 1,
			memoryHits: 1,
			s3Hits: 0,
			draws: 1,
			hitRate: 0.5,
			hint: "none" as const,
		}));
		expect(formatRenderAnalyticsReport({ ...EMPTY_REPORT, surfaces: many }).length).toBeLessThanOrEqual(4096);
	});
});
