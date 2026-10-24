import { describe, it, expect, vi, beforeEach } from "vitest";
import { TextChannel, type Client } from "discord.js";

vi.mock("@db/stores/botLogStore.js", () => ({ botLogStore: { log: vi.fn() } }));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn() } }));

import { adminLog, ADMIN_LOG_KINDS } from "./adminLog.js";
import { setupCopy } from "./setupCopy.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";

// ── adminLog (post-launch plan item 11) ──────────────────────────────────
// The emitter's contract: every line is persisted first, posted second, never pings
// anyone, and never throws into the action it records.

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

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "error").mockImplementation(() => undefined);
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

	it("posts one line to the admin log channel naming the action, the actor, the subject and the detail, and pings nobody", async () => {
		const channel = makeLogChannel();

		const result = await adminLog.write({
			guild: makeGuild(channel),
			kind: "voice.allowlist",
			actor: { userId: "user-1" },
			payload: { subject: "roles", detail: "added <@&role-1>" },
		});

		expect(result).toEqual({ persisted: true, posted: true });
		expect(channel.send).toHaveBeenCalledOnce();
		const sent = channel.send.mock.calls[0]![0] as { content: string; allowedMentions: unknown };
		expect(sent.allowedMentions).toEqual({ parse: [] });
		expect(sent.content).toContain(setupCopy.adminLog.label("voice.allowlist"));
		expect(sent.content).toContain("<@user-1>");
		expect(sent.content).toContain("roles");
		expect(sent.content).toContain("added <@&role-1>");
		expect(sent.content.split("\n")).toHaveLength(1);
	});

	it("names the dashboard when the action carries no Discord member", async () => {
		const channel = makeLogChannel();

		await adminLog.write({ guild: makeGuild(channel), kind: "event.delete", actor: { source: "dashboard" }, payload: { subject: "Ark" } });

		expect(logMock.log).toHaveBeenCalledWith(GUILD_ID, "admin_log:event.delete", { actorSource: "dashboard", subject: "Ark" });
		expect((channel.send.mock.calls[0]![0] as { content: string }).content).toContain(setupCopy.adminLog.actorDashboard);
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

	it("reports a failed post rather than throwing it", async () => {
		const channel = makeLogChannel();
		channel.send.mockRejectedValue(new Error("Missing Access"));

		await expect(adminLog.write({ guild: makeGuild(channel), kind: "selfdestruct.attempt", actor: { userId: "owner-1" } })).resolves.toEqual({
			persisted: true,
			posted: false,
		});
	});

	it("gives every declared kind its own label in the line", async () => {
		for (const kind of ADMIN_LOG_KINDS) {
			const channel = makeLogChannel();
			await adminLog.write({ guild: makeGuild(channel), kind, actor: { source: "dero" } });
			expect((channel.send.mock.calls[0]![0] as { content: string }).content, kind).toContain(setupCopy.adminLog.label(kind));
		}
		expect(new Set(ADMIN_LOG_KINDS.map((kind) => setupCopy.adminLog.label(kind))).size).toBe(ADMIN_LOG_KINDS.length);
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
