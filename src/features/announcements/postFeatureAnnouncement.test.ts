import { beforeEach, describe, expect, it, vi } from "vitest";
import { TextChannel, type Client } from "discord.js";

// ── the once per version rule, and its dev exception ─────────────────────────
// A dev bot reposts on every boot so release copy can be checked; any other bot posts once
// per guild per version, because a repost there lands in every server on every restart.

const mocks = vi.hoisted(() => ({ isDev: false, has: vi.fn(), log: vi.fn(), findByGuildId: vi.fn(), copy: undefined as unknown }));

vi.mock("@utils/config.js", () => ({
	get isDev() {
		return mocks.isDev;
	},
}));
vi.mock("@db/stores/botLogStore.js", () => ({ botLogStore: { has: mocks.has, log: mocks.log } }));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findByGuildId } }));
// The poster reads whichever release copy the packs hold today, so the cases pin a copy of
// their own: a fixture with a public block for the two post release, and the live packs for
// the admin only release they carry now.
vi.mock("@base/copy/getCopy.js", () => ({ getPluginCopy: () => mocks.copy }));
vi.mock("@features/suggestion-box/SuggestionBox.js", async () => {
	const { ButtonBuilder, ButtonStyle } = await import("discord.js");
	return { buildSuggestionBoxButton: () => new ButtonBuilder().setCustomId("suggestion").setLabel("Suggest").setStyle(ButtonStyle.Primary) };
});

import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { linkReleaseChannels, postFeatureAnnouncements } from "./postFeatureAnnouncement.js";

const TWO_POST_RELEASE = {
	...rokCommanderCopy,
	featureAnnouncement: {
		public: { title: "MEMBERS", description: "What changed for members." },
		innerSanctum: { title: "ADMINS", description: "What changed, in 🛠️server-config." },
	},
};

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
	const fetch = vi.fn(async (id: string) => channels[id]);
	const client = {
		guilds: { cache: new Map([["guild-1", { id: "guild-1" }]]) },
		channels: { fetch },
	} as unknown as Client;
	await postFeatureAnnouncements(client);
	return { publicSend: announcements.send, adminSend: admin.send, fetch };
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.isDev = false;
	mocks.copy = TWO_POST_RELEASE;
	mocks.has.mockResolvedValue(true);
	mocks.findByGuildId.mockResolvedValue({ setupComplete: true, announcementsChannelId: "announcements", adminChannelId: "admin" });
});

describe("linkReleaseChannels", () => {
	it("links a channel the server has and leaves one it lacks as a plain name", () => {
		expect(linkReleaseChannels("⚙️dero-config and 🧭onboarding", { deroConfigChannelId: "111", onboardingConfigChannelId: null })).toBe("<#111> and 🧭onboarding");
	});
});

describe("postFeatureAnnouncements", () => {
	it("puts Claim beside the Suggestion Box on the public post only, and links the admin post's channels", async () => {
		mocks.has.mockResolvedValue(false);
		mocks.findByGuildId.mockResolvedValue({ setupComplete: true, announcementsChannelId: "announcements", adminChannelId: "admin", serverConfigChannelId: "222" });
		const { publicSend, adminSend } = await boot();

		const publicPost = publicSend.mock.calls[0][0] as { components: { toJSON(): { components: { label?: string }[] } }[] };
		expect(publicPost.components[0].toJSON().components.map((button) => button.label)).toEqual(["Claim", "Suggest"]);
		const adminPost = adminSend.mock.calls[0][0] as { components?: unknown[]; embeds: { data: { description: string } }[] };
		expect(adminPost.components).toBeUndefined();
		expect(adminPost.embeds[0].data.description).toContain("<#222>");
	});

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

describe("postFeatureAnnouncements for an admin only release (a null public block)", () => {
	type AdminPost = { components?: unknown[]; embeds: { data: { title: string; description: string } }[] };

	beforeEach(() => {
		mocks.copy = rokCommanderCopy;
		mocks.has.mockResolvedValue(false);
	});

	it("is what the packs carry now", () => {
		expect(rokCommanderCopy.featureAnnouncement.public).toBeNull();
	});

	it("posts one inner-sanctum embed with no buttons, linked, and never touches #announcements", async () => {
		mocks.findByGuildId.mockResolvedValue({ setupComplete: true, announcementsChannelId: "announcements", adminChannelId: "admin", onboardingConfigChannelId: "333" });
		const { publicSend, adminSend, fetch } = await boot();

		expect(publicSend).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalledWith("announcements");
		expect(adminSend).toHaveBeenCalledTimes(1);
		const adminPost = adminSend.mock.calls[0][0] as AdminPost;
		expect(adminPost.components).toBeUndefined();
		expect(adminPost.embeds[0].data.title).toMatch(/^🧭 CONFIGURE ONBOARDING IS FIXED \(v.+\)$/);
		expect(adminPost.embeds[0].data.description).toContain("Press Configure Onboarding in <#333>");
		expect(mocks.log).toHaveBeenCalledTimes(1);
	});

	it("posts to a guild with no #announcements stored", async () => {
		mocks.findByGuildId.mockResolvedValue({ setupComplete: true, adminChannelId: "admin" });
		const { adminSend } = await boot();
		expect(adminSend).toHaveBeenCalledTimes(1);
		expect(mocks.log).toHaveBeenCalledTimes(1);
	});

	it("defers with no record when the guild has no inner-sanctum", async () => {
		mocks.findByGuildId.mockResolvedValue({ setupComplete: true, announcementsChannelId: "announcements" });
		const { publicSend, adminSend } = await boot();
		expect(publicSend).not.toHaveBeenCalled();
		expect(adminSend).not.toHaveBeenCalled();
		expect(mocks.log).not.toHaveBeenCalled();
	});

	it("records the guild once and skips it on the next boot", async () => {
		const first = await boot();
		expect(first.adminSend).toHaveBeenCalledTimes(1);
		expect(mocks.log).toHaveBeenCalledTimes(1);

		mocks.has.mockResolvedValue(true);
		const second = await boot();
		expect(second.adminSend).not.toHaveBeenCalled();
		expect(mocks.log).toHaveBeenCalledTimes(1);
	});
});
