import { describe, it, expect, vi, beforeEach } from "vitest";
import { TextChannel, type APIEmbed, type Client, type EmbedBuilder } from "discord.js";

vi.mock("@db/stores/botLogStore.js", () => ({ botLogStore: { log: vi.fn() } }));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn() } }));

import { adminLog, ADMIN_LOG_KINDS } from "./adminLog.js";
import { setupCopy } from "./setupCopy.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";

// ── adminLog (post-launch plan item 11) ──────────────────────────────────
// The emitter's contract: every entry is persisted first, posted second as one embed
// (2026-10 item 254 Phase 1) with the text line as its fallback, never pings anyone,
// and never throws into the action it records.

const logMock = botLogStore as unknown as { log: ReturnType<typeof vi.fn> };
const configMock = guildConfigStore as unknown as { findByGuildId: ReturnType<typeof vi.fn> };

const GUILD_ID = "guild-1";
const LOG_CHANNEL_ID = "ch-adminlog";

function makeLogChannel(): TextChannel & { send: ReturnType<typeof vi.fn> } {
	const channel = Object.create(TextChannel.prototype) as TextChannel & { send: ReturnType<typeof vi.fn> };
	Object.assign(channel, { id: LOG_CHANNEL_ID, send: vi.fn().mockResolvedValue({ id: "msg-1" }) });
	return channel;
}

function makeGuild(channel: unknown): { id: string; client: Client } {
	const client = { channels: { fetch: vi.fn(async (id: string) => (id === LOG_CHANNEL_ID ? channel : null)) } } as unknown as Client;
	return { id: GUILD_ID, client };
}

type SentPayload = { content?: string; embeds?: EmbedBuilder[]; allowedMentions?: unknown };

// The embed a send carried, as Discord receives it.
function sentEmbed(channel: { send: ReturnType<typeof vi.fn> }, call = 0): APIEmbed {
	const payload = channel.send.mock.calls[call]![0] as SentPayload;
	const embed = payload.embeds?.[0];
	if (!embed) throw new Error("the send carried no embed");
	return embed.toJSON();
}

// Every word an embed shows, so a test can ask whether a value appears anywhere in it.
const embedText = (embed: APIEmbed): string => [embed.title, ...(embed.fields ?? []).flatMap((field) => [field.name, field.value])].join("\n");

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	logMock.log.mockResolvedValue(undefined);
	configMock.findByGuildId.mockResolvedValue({ guildId: GUILD_ID, adminLogChannelId: LOG_CHANNEL_ID });
});

describe("adminLog.write", () => {
	it("persists the row under admin_log:<kind> with the actor and only the payload keys that were given", async () => {
		const guild = makeGuild(makeLogChannel());

		await adminLog.write({
			guild,
			kind: "schedule.update",
			actor: { userId: "user-1" },
			payload: { subject: "KvK Season", detail: "paused", eventId: "evt-1", skipped: undefined },
		});

		expect(logMock.log).toHaveBeenCalledWith(GUILD_ID, "admin_log:schedule.update", {
			actorId: "user-1",
			subject: "KvK Season",
			detail: "paused",
			eventId: "evt-1",
		});
	});

	it("posts one embed naming the action, the actor, the subject and the detail, with its time, and pings nobody", async () => {
		const channel = makeLogChannel();

		const result = await adminLog.write({
			guild: makeGuild(channel),
			kind: "voice.allowlist",
			actor: { userId: "user-1" },
			payload: { subject: "roles", detail: "added <@&role-1>" },
		});

		expect(result).toEqual({ persisted: true, posted: true });
		expect(channel.send).toHaveBeenCalledOnce();
		const sent = channel.send.mock.calls[0]![0] as SentPayload;
		expect(sent.allowedMentions).toEqual({ parse: [] });
		expect(sent.content).toBeUndefined();
		const embed = sentEmbed(channel);
		expect(embed.title).toBe(setupCopy.adminLog.title("voice.allowlist"));
		expect(embed.fields?.map((field) => field.value)).toEqual(["<@user-1>", "roles", "added <@&role-1>"]);
		expect(embed.timestamp).toBeDefined();
	});

	it("leaves out a field the entry has nothing for", async () => {
		const channel = makeLogChannel();

		await adminLog.write({ guild: makeGuild(channel), kind: "config.change", actor: { userId: "user-1" }, payload: { subject: "auto heal" } });

		expect(sentEmbed(channel).fields?.map((field) => field.value)).toEqual(["<@user-1>", "auto heal"]);
	});

	it("colors each kind by its family: settings, schedules and events, destructive, economy and bots", async () => {
		const colorOf = async (kind: (typeof ADMIN_LOG_KINDS)[number]): Promise<number | undefined> => {
			const channel = makeLogChannel();
			await adminLog.write({ guild: makeGuild(channel), kind, actor: { source: "dero" } });
			return sentEmbed(channel).color;
		};
		const families = [
			["config.change", "powerup.toggle", "voice.allowlist", "voice.cap"],
			["schedule.create", "schedule.update", "schedule.delete", "event.create", "event.update", "event.delete", "party.open"],
			["selfdestruct.attempt"],
			["chip.grant", "vault.topup"],
			["bot.slot"],
		] as const;
		const familyColors: Array<number | undefined> = [];
		for (const family of families) {
			const colors = new Set(await Promise.all(family.map(colorOf)));
			expect(colors.size, family.join(", ")).toBe(1);
			familyColors.push([...colors][0]);
		}
		expect(new Set(familyColors).size).toBe(families.length);
		expect(families.flat().sort()).toEqual([...ADMIN_LOG_KINDS].sort());
	});

	it("falls back to the text line when Discord refuses the embed, still pinging nobody", async () => {
		const channel = makeLogChannel();
		channel.send.mockRejectedValueOnce(new Error("Missing Permissions: Embed Links")).mockResolvedValueOnce({ id: "msg-2" });

		const result = await adminLog.write({
			guild: makeGuild(channel),
			kind: "chip.grant",
			actor: { userId: "user-1" },
			payload: { subject: "<@user-2>", detail: "500 chips" },
		});

		expect(result).toEqual({ persisted: true, posted: true });
		expect(channel.send).toHaveBeenCalledTimes(2);
		const fallback = channel.send.mock.calls[1]![0] as SentPayload;
		expect(fallback.embeds).toBeUndefined();
		expect(fallback.allowedMentions).toEqual({ parse: [] });
		expect(fallback.content).toContain(setupCopy.adminLog.label("chip.grant"));
		expect(fallback.content).toContain("500 chips");
		expect(fallback.content?.split("\n")).toHaveLength(1);
	});

	it("names the dashboard when the action carries no Discord member", async () => {
		const channel = makeLogChannel();

		await adminLog.write({ guild: makeGuild(channel), kind: "event.delete", actor: { source: "dashboard" }, payload: { subject: "Ark" } });

		expect(logMock.log).toHaveBeenCalledWith(GUILD_ID, "admin_log:event.delete", { actorSource: "dashboard", subject: "Ark" });
		expect(embedText(sentEmbed(channel))).toContain(setupCopy.adminLog.actorDashboard);
	});

	it("still persists when the guild has no admin log channel yet, and posts nothing", async () => {
		configMock.findByGuildId.mockResolvedValue({ guildId: GUILD_ID, adminLogChannelId: null });
		const channel = makeLogChannel();

		const result = await adminLog.write({ guild: makeGuild(channel), kind: "config.change", actor: { userId: "user-1" } });

		expect(result).toEqual({ persisted: true, posted: false });
		expect(channel.send).not.toHaveBeenCalled();
	});

	it("still posts when persisting fails, and never throws either way", async () => {
		logMock.log.mockRejectedValue(new Error("mongo down"));
		const channel = makeLogChannel();

		const result = await adminLog.write({ guild: makeGuild(channel), kind: "powerup.toggle", actor: { userId: "user-1" } });

		expect(result).toEqual({ persisted: false, posted: true });
	});

	it("reports a failed post, the embed and its fallback both refused, rather than throwing it, and keeps the row", async () => {
		const channel = makeLogChannel();
		channel.send.mockRejectedValue(new Error("Missing Access"));

		await expect(adminLog.write({ guild: makeGuild(channel), kind: "selfdestruct.attempt", actor: { userId: "owner-1" } })).resolves.toEqual({
			persisted: true,
			posted: false,
		});
		expect(logMock.log).toHaveBeenCalledWith(GUILD_ID, "admin_log:selfdestruct.attempt", { actorId: "owner-1" });
	});

	it.each(ADMIN_LOG_KINDS)("posts %s as one embed under its own label, pinging nobody", async (kind) => {
		const channel = makeLogChannel();
		await adminLog.write({ guild: makeGuild(channel), kind, actor: { userId: "user-1" }, payload: { subject: "a subject" } });
		expect(channel.send).toHaveBeenCalledOnce();
		const sent = channel.send.mock.calls[0]![0] as SentPayload;
		expect(sent.allowedMentions).toEqual({ parse: [] });
		expect(sent.embeds).toHaveLength(1);
		expect(sentEmbed(channel).title).toBe(setupCopy.adminLog.title(kind));
	});

	it.each(ADMIN_LOG_KINDS)("keeps the %s row when its post fails", async (kind) => {
		const channel = makeLogChannel();
		channel.send.mockRejectedValue(new Error("Missing Access"));
		const result = await adminLog.write({ guild: makeGuild(channel), kind, actor: { userId: "user-1" } });
		expect(result).toEqual({ persisted: true, posted: false });
		expect(logMock.log).toHaveBeenCalledWith(GUILD_ID, `admin_log:${kind}`, { actorId: "user-1" });
	});

	it("gives every declared kind its own label", () => {
		expect(new Set(ADMIN_LOG_KINDS.map((kind) => setupCopy.adminLog.label(kind))).size).toBe(ADMIN_LOG_KINDS.length);
	});
});

// ── the designed card (2026-10 item 257 Phase 2b) ──
describe("adminLog embed design", () => {
	// A guild the client has cached, holding one member with a server nickname and avatar.
	function makeGuildWithMember(channel: unknown): { id: string; client: Client } {
		const member = { displayName: "Server Nick", displayAvatarURL: () => "https://cdn.example/member.png" };
		const guild = makeGuild(channel);
		Object.assign(guild.client, {
			guilds: { cache: new Map([[GUILD_ID, { members: { cache: new Map([["user-1", member]]), fetch: vi.fn() } }]]) },
		});
		return guild;
	}

	it.each(ADMIN_LOG_KINDS)("posts %s with its emoji title, the acting admin as author, its family footer and its time", async (kind) => {
		const channel = makeLogChannel();
		await adminLog.write({ guild: makeGuildWithMember(channel), kind, actor: { userId: "user-1" }, payload: { subject: "s", detail: "d" } });
		const embed = sentEmbed(channel);
		expect(embed.title?.startsWith(`${setupCopy.adminLog.emoji(kind)} `)).toBe(true);
		expect(embed.author).toEqual({ name: "Server Nick", icon_url: "https://cdn.example/member.png" });
		expect(embed.footer?.text).toMatch(/^Admin log · /);
		expect(embed.timestamp).toBeDefined();
	});

	it("lays By and What side by side and Change full width", async () => {
		const channel = makeLogChannel();
		await adminLog.write({ guild: makeGuild(channel), kind: "config.change", actor: { userId: "user-1" }, payload: { subject: "auto heal", detail: "off" } });
		expect(sentEmbed(channel).fields?.map((field) => field.inline)).toEqual([true, true, false]);
	});

	it("falls back to the user Discord knows when the member is not cached, and posts with no author when both fail", async () => {
		const channel = makeLogChannel();
		const guild = makeGuild(channel);
		Object.assign(guild.client, { users: { fetch: vi.fn().mockResolvedValue({ displayName: "Global Name", displayAvatarURL: () => "https://cdn.example/user.png" }) } });
		await adminLog.write({ guild, kind: "config.change", actor: { userId: "user-1" } });
		expect(sentEmbed(channel).author?.name).toBe("Global Name");

		const bare = makeLogChannel();
		const result = await adminLog.write({ guild: makeGuild(bare), kind: "config.change", actor: { userId: "user-1" } });
		expect(result.posted).toBe(true);
		expect(sentEmbed(bare).author).toBeUndefined();
	});

	it("shows Dero as the author of his own work and the dashboard by name", async () => {
		const deroChannel = makeLogChannel();
		await adminLog.write({ guild: makeGuild(deroChannel), kind: "party.open", actor: { source: "dero" } });
		expect(sentEmbed(deroChannel).author?.name).toBe("Dero");

		const dashboardChannel = makeLogChannel();
		await adminLog.write({ guild: makeGuild(dashboardChannel), kind: "event.create", actor: { source: "dashboard" } });
		expect(sentEmbed(dashboardChannel).author?.name).toBe(setupCopy.adminLog.authorDashboard);
	});

	it("gives every kind an emoji", () => {
		for (const kind of ADMIN_LOG_KINDS) expect(setupCopy.adminLog.emoji(kind).length).toBeGreaterThan(0);
	});
});

describe("adminLog.emit", () => {
	it("returns at once and swallows every failure, so the audited action is never failed by its log line", async () => {
		logMock.log.mockRejectedValue(new Error("mongo down"));
		configMock.findByGuildId.mockRejectedValue(new Error("mongo down"));

		expect(() => adminLog.emit({ guild: makeGuild(null), kind: "event.create", actor: { userId: "user-1" } })).not.toThrow();
		// Let the detached write settle so an unhandled rejection would surface here.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(logMock.log).toHaveBeenCalledOnce();
	});
});
