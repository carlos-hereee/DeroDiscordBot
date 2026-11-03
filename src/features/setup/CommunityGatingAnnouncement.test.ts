import { describe, it, expect, vi, beforeEach } from "vitest";
import { TextChannel } from "discord.js";
import type { Client, Guild } from "discord.js";

// An in-memory BotLog, so "the second call skips" is the store's own answer rather
// than a canned one, and the Mongoose model never loads.
const loggedKeys = new Set<string>();
vi.mock("@db/stores/botLogStore.js", () => ({
	botLogStore: {
		has: vi.fn(async (guildId: string, event: string) => loggedKeys.has(`${guildId}:${event}`)),
		log: vi.fn(async (guildId: string, event: string) => {
			loggedKeys.add(`${guildId}:${event}`);
		}),
	},
}));

import { CommunityGatingAnnouncement } from "./CommunityGatingAnnouncement.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { BOT_LOG_EVENTS } from "@base/constants/BOT_LOG_EVENTS.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { generalEventsCopy } from "@base/copy/packs/general-events.pack.js";

const botLogMock = botLogStore as unknown as { has: ReturnType<typeof vi.fn>; log: ReturnType<typeof vi.fn> };

// ── fixtures ──────────────────────────────────────────────────────────

const GUILD_ID = "guild-1";
const MEMBER_ROLE_ID = "role-member";
const LONG_DASH = /[\u2013\u2014]/;
// Discord's embed limits.
const EMBED_TITLE_MAX = 256;
const EMBED_DESCRIPTION_MAX = 4096;

interface ISentPost {
	embeds: Array<{ data: { title?: string; description?: string } }>;
	allowedMentions?: { parse?: unknown[] };
}

function makeTextChannel(id: string, order: string[]): TextChannel & { send: ReturnType<typeof vi.fn> } {
	const channel = Object.create(TextChannel.prototype) as TextChannel & { send: ReturnType<typeof vi.fn> };
	Object.assign(channel, {
		id,
		send: vi.fn(async () => {
			order.push(id);
			return { id: `msg-${id}` };
		}),
	});
	return channel;
}

function makeWorld(storedOverrides: Record<string, unknown> = {}) {
	const order: string[] = [];
	const announcements = makeTextChannel("ch-announcements", order);
	const admin = makeTextChannel("ch-admin", order);
	const byId: Record<string, unknown> = { "ch-announcements": announcements, "ch-admin": admin };
	const client = { channels: { fetch: vi.fn(async (id: string) => byId[id] ?? null) } } as unknown as Client;
	const guild = { id: GUILD_ID } as unknown as Guild;
	const stored = {
		announcementsChannelId: "ch-announcements",
		adminChannelId: "ch-admin",
		memberRoleId: MEMBER_ROLE_ID,
		pluginId: "rok-commander",
		...storedOverrides,
	};
	return { client, guild, stored, announcements, admin, order };
}

function sentPost(channel: { send: ReturnType<typeof vi.fn> }): ISentPost {
	return channel.send.mock.calls[0][0] as ISentPost;
}

// ── tests ─────────────────────────────────────────────────────────────

describe("CommunityGatingAnnouncement.post", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		loggedKeys.clear();
		vi.spyOn(console, "log").mockImplementation(() => undefined);
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
	});

	it("posts once: the first call posts both embeds and logs the key, the second skips", async () => {
		const { client, guild, stored, announcements, admin } = makeWorld();

		expect(await CommunityGatingAnnouncement.post(client, guild, stored)).toBe("posted");
		expect(await CommunityGatingAnnouncement.post(client, guild, stored)).toBe("already-announced");

		expect(admin.send).toHaveBeenCalledOnce();
		expect(announcements.send).toHaveBeenCalledOnce();
		expect(botLogMock.log).toHaveBeenCalledOnce();
		expect(botLogMock.log).toHaveBeenCalledWith(GUILD_ID, BOT_LOG_EVENTS.MEMBER_ROLE_GATING_ANNOUNCED, {
			announcementsChannelId: "ch-announcements",
			adminChannelId: "ch-admin",
		});
	});

	it("posts the admin embed first, so a failure between the two repeats the private post, not the public one", async () => {
		const { client, guild, stored, order } = makeWorld();

		await CommunityGatingAnnouncement.post(client, guild, stored);

		expect(order).toEqual(["ch-admin", "ch-announcements"]);
	});

	it("uses the admin voice in #inner-sanctum and the member voice in #announcements", async () => {
		const { client, guild, stored, announcements, admin } = makeWorld();
		const copy = rokCommanderCopy.channelContent.gatingAnnouncement;

		await CommunityGatingAnnouncement.post(client, guild, stored);

		expect(sentPost(admin).embeds[0].data).toMatchObject({ title: copy.admin.title, description: copy.admin.description(MEMBER_ROLE_ID) });
		expect(sentPost(announcements).embeds[0].data).toMatchObject({
			title: copy.member.title,
			description: copy.member.description(MEMBER_ROLE_ID),
		});
	});

	it("pings nobody on either post", async () => {
		const { client, guild, stored, announcements, admin } = makeWorld();

		await CommunityGatingAnnouncement.post(client, guild, stored);

		for (const channel of [admin, announcements]) {
			expect(sentPost(channel).allowedMentions).toEqual({ parse: [] });
		}
	});

	it("renders the general-events pack on a non-ROK guild", async () => {
		const { client, guild, stored, announcements } = makeWorld({ pluginId: "general-events" });

		await CommunityGatingAnnouncement.post(client, guild, stored);

		expect(sentPost(announcements).embeds[0].data.title).toBe(generalEventsCopy.channelContent.gatingAnnouncement.member.title);
	});

	it("leaves the key unset when a post fails, so the next boot retries", async () => {
		const { client, guild, stored, announcements } = makeWorld();
		announcements.send.mockRejectedValueOnce(new Error("Missing Access"));

		expect(await CommunityGatingAnnouncement.post(client, guild, stored)).toBe("failed");
		expect(botLogMock.log).not.toHaveBeenCalled();

		expect(await CommunityGatingAnnouncement.post(client, guild, stored)).toBe("posted");
		expect(botLogMock.log).toHaveBeenCalledOnce();
	});

	it("defers without logging when a channel is missing", async () => {
		const { client, guild, stored, admin } = makeWorld({ announcementsChannelId: "ch-gone" });

		expect(await CommunityGatingAnnouncement.post(client, guild, stored)).toBe("deferred");
		expect(await CommunityGatingAnnouncement.post(client, guild, { ...stored, adminChannelId: null })).toBe("deferred");

		expect(admin.send).not.toHaveBeenCalled();
		expect(botLogMock.log).not.toHaveBeenCalled();
	});

	it("never throws into the caller, even when the store does", async () => {
		const { client, guild, stored } = makeWorld();
		botLogMock.has.mockRejectedValueOnce(new Error("connection reset"));

		await expect(CommunityGatingAnnouncement.post(client, guild, stored)).resolves.toBe("failed");
	});
});

// ── the copy ──────────────────────────────────────────────────────────

describe("channelContent.gatingAnnouncement in every pack", () => {
	const PACKS = [
		{ name: "rok-commander", copy: rokCommanderCopy },
		{ name: "general-events", copy: generalEventsCopy },
	] as const;
	const EMBEDS = PACKS.flatMap(({ name, copy }) => [
		{ label: `${name} member`, ...copy.channelContent.gatingAnnouncement.member },
		{ label: `${name} admin`, ...copy.channelContent.gatingAnnouncement.admin },
	]);

	it.each(EMBEDS)("$label fits Discord's limits and carries no long dash", ({ title, description }) => {
		const body = description(MEMBER_ROLE_ID);
		expect(title.length).toBeLessThanOrEqual(EMBED_TITLE_MAX);
		expect(body.length).toBeLessThanOrEqual(EMBED_DESCRIPTION_MAX);
		expect(`${title}\n${body}`).not.toMatch(LONG_DASH);
	});

	it.each(EMBEDS)("$label names the member role and the way back in", ({ description }) => {
		const body = description(MEMBER_ROLE_ID);
		expect(body).toContain(`<@&${MEMBER_ROLE_ID}>`);
		expect(body).toContain("Onboarding");
		expect(body).toContain("Channels & Roles");
		expect(body).toContain("Retake Onboarding");
	});

	it.each(EMBEDS)("$label pings nobody by text either", ({ description }) => {
		expect(description(MEMBER_ROLE_ID)).not.toMatch(/@everyone|@here/);
	});
});
