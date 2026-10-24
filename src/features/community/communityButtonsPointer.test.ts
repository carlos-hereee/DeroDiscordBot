import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TextChannel, type Client, type Guild } from "discord.js";
import { BOT_LOG_EVENTS } from "@base/constants/BOT_LOG_EVENTS.js";

// ── communityButtonsPointer (2026-10 item 247 Phase 3) ──────────────────────
// The one time #inner-sanctum pointer at the community buttons: it posts once per
// setup complete guild, never again once its BotLog key is written (so a restart
// does not repost), waits while the admin guide does not show the buttons yet, and
// logs the key only after the post landed so a failure retries next boot.

const mocks = vi.hoisted(() => ({
	has: vi.fn(),
	log: vi.fn(),
	findByGuildId: vi.fn(),
}));

vi.mock("@db/stores/botLogStore.js", () => ({ botLogStore: { has: mocks.has, log: mocks.log } }));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findByGuildId } }));

import { CommunityButtonsPointer, postCommunityButtonsPointers, type ICommunityPointerConfig } from "./communityButtonsPointer.js";
import { buildCommunityControlButtons } from "./communityButtons.js";
import { communityCopy } from "./communityCopy.js";

const storedRow: ICommunityPointerConfig = {
	setupComplete: true,
	homebaseDestroyed: false,
	adminChannelId: "inner-sanctum",
	adminCommandsChannelId: "admin-commands",
	introMessageIds: { adminCommandsChannelId: "guide-msg" },
};

const textChannel = (overrides: Record<string, unknown>): TextChannel => Object.assign(Object.create(TextChannel.prototype) as TextChannel, overrides);

function rig(options: { guideRows?: Array<{ toJSON(): unknown }>; sendFails?: boolean } = {}) {
	const guide = { id: "guide-msg", components: options.guideRows ?? [buildCommunityControlButtons()] };
	const adminChannel = textChannel({
		id: "inner-sanctum",
		send: vi.fn(async () => {
			if (options.sendFails) throw new Error("Missing Access");
			return { id: "pointer-msg" };
		}),
	});
	const adminCommandsChannel = textChannel({ id: "admin-commands", messages: { fetch: vi.fn(async (id: string) => (id === "guide-msg" ? guide : null)) } });
	const client = {
		channels: {
			fetch: vi.fn(async (id: string) => {
				if (id === "inner-sanctum") return adminChannel;
				if (id === "admin-commands") return adminCommandsChannel;
				return null;
			}),
		},
	} as unknown as Client;
	const guild = { id: "g1" } as Guild;
	return { client, guild, adminChannel: adminChannel as TextChannel & { send: ReturnType<typeof vi.fn> } };
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.has.mockResolvedValue(false);
	mocks.log.mockResolvedValue(undefined);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("CommunityButtonsPointer.post", () => {
	it("posts once to #inner-sanctum, admin only, no pings, then logs its key", async () => {
		const { client, guild, adminChannel } = rig();
		expect(await CommunityButtonsPointer.post(client, guild, storedRow)).toBe("posted");

		expect(adminChannel.send).toHaveBeenCalledOnce();
		const message = adminChannel.send.mock.calls[0]![0] as { embeds: Array<{ data: { title?: string; description?: string } }>; allowedMentions: unknown };
		expect(message.embeds[0]!.data.title).toBe(communityCopy.pointer.title);
		expect(message.embeds[0]!.data.description).toContain("<#admin-commands>");
		expect(message.allowedMentions).toEqual({ parse: [] });
		expect(mocks.log).toHaveBeenCalledWith("g1", BOT_LOG_EVENTS.COMMUNITY_BUTTONS_AVAILABLE_NOTICE, { adminChannelId: "inner-sanctum", adminCommandsChannelId: "admin-commands" });
		// Only #inner-sanctum is ever fetched to post in; #announcements is never touched.
		expect((client.channels.fetch as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0])).not.toContain("announcements");
	});

	it("does not repost once its key is logged, which is what keeps a restart quiet", async () => {
		mocks.has.mockResolvedValue(true);
		const { client, guild, adminChannel } = rig();
		expect(await CommunityButtonsPointer.post(client, guild, storedRow)).toBe("already-posted");
		expect(adminChannel.send).not.toHaveBeenCalled();
		expect(mocks.log).not.toHaveBeenCalled();
	});

	it("skips a guild that never finished /setup, or whose homebase was self destructed", async () => {
		const { client, guild, adminChannel } = rig();
		expect(await CommunityButtonsPointer.post(client, guild, { ...storedRow, setupComplete: false })).toBe("not-set-up");
		expect(await CommunityButtonsPointer.post(client, guild, { ...storedRow, homebaseDestroyed: true })).toBe("not-set-up");
		expect(mocks.has).not.toHaveBeenCalled();
		expect(adminChannel.send).not.toHaveBeenCalled();
	});

	it("waits, logging nothing, while the admin guide does not show the buttons yet", async () => {
		const { client, guild, adminChannel } = rig({ guideRows: [] });
		expect(await CommunityButtonsPointer.post(client, guild, storedRow)).toBe("deferred");
		expect(adminChannel.send).not.toHaveBeenCalled();
		expect(mocks.log).not.toHaveBeenCalled();
	});

	it("waits when a channel id is missing", async () => {
		const { client, guild } = rig();
		expect(await CommunityButtonsPointer.post(client, guild, { ...storedRow, adminChannelId: null })).toBe("deferred");
		expect(mocks.log).not.toHaveBeenCalled();
	});

	it("logs nothing when the post fails, so the next boot retries, and never throws", async () => {
		const { client, guild } = rig({ sendFails: true });
		expect(await CommunityButtonsPointer.post(client, guild, storedRow)).toBe("failed");
		expect(mocks.log).not.toHaveBeenCalled();
	});
});

describe("postCommunityButtonsPointers", () => {
	it("offers the pointer to every cached guild, skipping one with no config", async () => {
		const { client, adminChannel } = rig();
		(client as unknown as { guilds: { cache: Map<string, Guild> } }).guilds = {
			cache: new Map([
				["g1", { id: "g1" } as Guild],
				["g2", { id: "g2" } as Guild],
			]),
		};
		mocks.findByGuildId.mockImplementation(async (guildId: string) => (guildId === "g1" ? storedRow : null));
		await postCommunityButtonsPointers(client);
		expect(adminChannel.send).toHaveBeenCalledOnce();
		expect(mocks.log).toHaveBeenCalledWith("g1", BOT_LOG_EVENTS.COMMUNITY_BUTTONS_AVAILABLE_NOTICE, expect.any(Object));
	});
});
