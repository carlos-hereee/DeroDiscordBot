import { describe, it, expect, vi, beforeEach } from "vitest";
import { TextChannel, type GuildMember } from "discord.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";

// ── welcomeLog (2026-10 item 247 Phase 2) ───────────────────────────────────
// One short line per join and leave in 👋welcome. These pin that it posts both,
// never for a bot, never past the throttle (in its OWN bucket, so it cannot eat
// the greeter's), never pings, and that a member's display name cannot restyle
// the line.

const mocks = vi.hoisted(() => ({
	findByGuildId: vi.fn(),
	greetAllowed: vi.fn(),
}));

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findByGuildId } }));
vi.mock("@features/greeter/welcomeNewMember.js", () => ({ greetAllowed: mocks.greetAllowed }));

import { postWelcomeLogEntry, registerWelcomeLog } from "./welcomeLog.js";

const welcomeCopy = rokCommanderCopy.channelContent.welcome;

function rig(options: { bot?: boolean; displayName?: string } = {}) {
	const send = vi.fn(async () => ({ id: "line-1" }));
	const channel = Object.assign(Object.create(TextChannel.prototype) as TextChannel, { id: "welcome-1", send });
	const fetch = vi.fn(async () => channel);
	const member = {
		id: "u1",
		displayName: options.displayName ?? "Silent Warrior",
		user: { id: "u1", bot: options.bot ?? false },
		guild: { id: "g1" },
		client: { channels: { fetch } },
	} as unknown as GuildMember;
	return { member, send, fetch };
}

type SentEmbed = { embeds: Array<{ data: { title?: string; description?: string; timestamp?: string } }>; allowedMentions: unknown };
const sentPayload = (send: ReturnType<typeof vi.fn>): SentEmbed => send.mock.calls[0]![0] as SentEmbed;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.greetAllowed.mockReturnValue(true);
	mocks.findByGuildId.mockResolvedValue({ guildId: "g1", welcomeChannelId: "welcome-1", homebaseDestroyed: false });
});

describe("postWelcomeLogEntry", () => {
	it("posts a join line naming the member, stamped, pinging nobody", async () => {
		const { member, send, fetch } = rig();
		expect(await postWelcomeLogEntry(member, "join")).toBe(true);
		expect(fetch).toHaveBeenCalledWith("welcome-1");
		const payload = sentPayload(send);
		expect(payload.embeds[0]!.data.title).toBe(welcomeCopy.joinTitle);
		expect(payload.embeds[0]!.data.description).toBe(welcomeCopy.joinLine("Silent Warrior"));
		expect(payload.embeds[0]!.data.timestamp).toBeDefined();
		expect(payload.allowedMentions).toEqual({ parse: [] });
	});

	it("posts a leave line", async () => {
		const { member, send } = rig();
		expect(await postWelcomeLogEntry(member, "leave")).toBe(true);
		expect(sentPayload(send).embeds[0]!.data.description).toBe(welcomeCopy.leaveLine("Silent Warrior"));
	});

	it("never logs a bot, and spends no throttle slot on one", async () => {
		const { member, send } = rig({ bot: true });
		expect(await postWelcomeLogEntry(member, "join")).toBe(false);
		expect(send).not.toHaveBeenCalled();
		expect(mocks.greetAllowed).not.toHaveBeenCalled();
	});

	it("respects the greeter's throttle, in a bucket of its own", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		mocks.greetAllowed.mockReturnValue(false);
		const { member, send } = rig();
		expect(await postWelcomeLogEntry(member, "join")).toBe(false);
		expect(send).not.toHaveBeenCalled();
		expect(mocks.greetAllowed).toHaveBeenCalledWith("g1", "welcome-log");
		warn.mockRestore();
	});

	it("posts nothing where no welcome channel is stored, or the homebase was demolished", async () => {
		const { member, send } = rig();
		mocks.findByGuildId.mockResolvedValueOnce({ guildId: "g1", welcomeChannelId: null });
		expect(await postWelcomeLogEntry(member, "join")).toBe(false);
		mocks.findByGuildId.mockResolvedValueOnce({ guildId: "g1", welcomeChannelId: "welcome-1", homebaseDestroyed: true });
		expect(await postWelcomeLogEntry(member, "join")).toBe(false);
		expect(send).not.toHaveBeenCalled();
	});

	it("escapes a display name so it cannot restyle the line", async () => {
		const { member, send } = rig({ displayName: "**loud**" });
		await postWelcomeLogEntry(member, "join");
		expect(sentPayload(send).embeds[0]!.data.description).toBe(welcomeCopy.joinLine("\\*\\*loud\\*\\*"));
	});

	it("never throws when the post fails", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const { member, send } = rig();
		send.mockRejectedValueOnce(new Error("Missing Permissions"));
		expect(await postWelcomeLogEntry(member, "leave")).toBe(false);
		warn.mockRestore();
	});
});

describe("registerWelcomeLog", () => {
	it("listens to both joins and leaves", () => {
		const on = vi.fn();
		registerWelcomeLog({ on } as never);
		expect(on.mock.calls.map((call) => call[0])).toEqual(["guildMemberAdd", "guildMemberRemove"]);
	});
});
