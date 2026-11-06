import { beforeEach, describe, expect, it, vi } from "vitest";
import { TextChannel, type Client } from "discord.js";

// ── the once per version rule, and its dev exception ─────────────────────────
// A dev bot reposts on every boot so release copy can be checked; any other bot posts once
// per guild per version, because a repost there lands in every server on every restart.

const mocks = vi.hoisted(() => ({ isDev: false, has: vi.fn(), log: vi.fn(), findByGuildId: vi.fn() }));

vi.mock("@utils/config.js", () => ({
	get isDev() {
		return mocks.isDev;
	},
}));
vi.mock("@db/stores/botLogStore.js", () => ({ botLogStore: { has: mocks.has, log: mocks.log } }));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findByGuildId } }));
vi.mock("@features/suggestion-box/SuggestionBox.js", async () => {
	const { ButtonBuilder, ButtonStyle } = await import("discord.js");
	return { buildSuggestionBoxButton: () => new ButtonBuilder().setCustomId("suggestion").setLabel("Suggest").setStyle(ButtonStyle.Primary) };
});

import { postFeatureAnnouncements } from "./postFeatureAnnouncement.js";

const makeChannel = () => {
	const channel = Object.create(TextChannel.prototype) as TextChannel;
	const send = vi.fn().mockResolvedValue(undefined);
	Object.defineProperty(channel, "send", { value: send });
	return { channel, send };
};

const boot = async () => {
	const announcements = makeChannel();
	const admin = makeChannel();
	const channels: Record<string, TextChannel> = { announcements: announcements.channel, admin: admin.channel };
	const client = {
		guilds: { cache: new Map([["guild-1", { id: "guild-1" }]]) },
		channels: { fetch: vi.fn(async (id: string) => channels[id]) },
	} as unknown as Client;
	await postFeatureAnnouncements(client);
	return { publicSend: announcements.send, adminSend: admin.send };
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.isDev = false;
	mocks.has.mockResolvedValue(true);
	mocks.findByGuildId.mockResolvedValue({ setupComplete: true, announcementsChannelId: "announcements", adminChannelId: "admin" });
});

describe("postFeatureAnnouncements", () => {
	it("posts nothing to a guild that already has this version outside dev", async () => {
		const { publicSend, adminSend } = await boot();
		expect(publicSend).not.toHaveBeenCalled();
		expect(adminSend).not.toHaveBeenCalled();
	});

	it("posts once to a guild that has not seen this version outside dev", async () => {
		mocks.has.mockResolvedValue(false);
		const { publicSend, adminSend } = await boot();
		expect(publicSend).toHaveBeenCalledTimes(1);
		expect(adminSend).toHaveBeenCalledTimes(1);
		expect(mocks.log).toHaveBeenCalledTimes(1);
	});

	it("reposts on a dev boot though the guild already has this version", async () => {
		mocks.isDev = true;
		const { publicSend, adminSend } = await boot();
		expect(publicSend).toHaveBeenCalledTimes(1);
		expect(adminSend).toHaveBeenCalledTimes(1);
	});

	it("still skips a guild that never finished setup on a dev boot", async () => {
		mocks.isDev = true;
		mocks.findByGuildId.mockResolvedValue({ setupComplete: false });
		const { publicSend } = await boot();
		expect(publicSend).not.toHaveBeenCalled();
	});
});
