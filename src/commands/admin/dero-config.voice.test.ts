import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatInputCommandInteraction, EmbedBuilder } from "discord.js";

// ── /dero-config, the kill switch and a live call ──────────────────────────
// Split from dero-config.test.ts by concern: disable and a cap of 0 end the
// guild's live voice call at once, before the write, and say so in the admin's
// reply; any other change leaves the call alone. The session map is a fake.

const mocks = vi.hoisted(() => ({
	guildConfig: vi.fn(),
	findByGuildId: vi.fn(),
	upsert: vi.fn(),
	sessionGet: vi.fn(),
	sessionLeave: vi.fn(),
	order: [] as string[],
}));

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.guildConfig } }));
vi.mock("@db/stores/deroVoiceConfigStore.js", () => ({
	deroVoiceConfigStore: { findByGuildId: mocks.findByGuildId, upsert: mocks.upsert },
}));
vi.mock("@features/voice/spendMeter.js", () => ({ currentMonthCents: async () => 0 }));
vi.mock("@features/voice/elevenLabsTts.js", () => ({ isTtsKeyConfigured: () => true }));
vi.mock("@features/voice/voiceSessions.js", () => ({
	voiceSessions: { get: mocks.sessionGet, leave: mocks.sessionLeave },
}));

import { execute } from "./dero-config.js";
import { voiceCopy } from "@features/voice/voiceCopy.js";

const VC = "vc-live";
const STORED = { guildId: "g1", enabled: true, voiceId: "abcDEF1234567890wxyz", listenEnabled: true, monthlyCapUsd: 25, allowedRoleIds: [], allowedChannelIds: [], allowedVoiceChannelIds: [] };

async function replyText(options: { sub: string; dollars?: number; enabled?: boolean }): Promise<string> {
	const reply = vi.fn(async () => undefined);
	const interaction = {
		guildId: "g1",
		reply,
		options: {
			getSubcommandGroup: () => null,
			getSubcommand: () => options.sub,
			getInteger: () => options.dollars,
			getBoolean: () => options.enabled,
		},
	} as unknown as ChatInputCommandInteraction;
	await execute(interaction);
	const embed = (reply.mock.calls[0] as unknown as [{ embeds: EmbedBuilder[] }])[0].embeds[0];
	return `${embed.data.title ?? ""}\n${embed.data.description ?? ""}`;
}

beforeEach(() => {
	mocks.order.length = 0;
	mocks.guildConfig.mockReset().mockResolvedValue({ guildId: "g1" });
	mocks.findByGuildId.mockReset().mockResolvedValue(STORED);
	mocks.upsert.mockReset().mockImplementation(async () => {
		mocks.order.push("write");
		return STORED;
	});
	mocks.sessionGet.mockReset().mockReturnValue({ channelId: VC });
	mocks.sessionLeave.mockReset().mockImplementation(() => {
		mocks.order.push("leave");
		return true;
	});
});

describe("the kill switch ends a live call", () => {
	it("disable ends the call before the write and says so", async () => {
		const text = await replyText({ sub: "disable" });
		expect(mocks.sessionLeave).toHaveBeenCalledWith("g1", "switched_off");
		expect(mocks.order).toEqual(["leave", "write"]);
		expect(text).toContain(voiceCopy.config.disabledBody);
		expect(text).toContain(voiceCopy.config.leftCall(VC));
	});

	it("a disable that finds voice already off still ends the call", async () => {
		mocks.findByGuildId.mockResolvedValue({ ...STORED, enabled: false });
		const text = await replyText({ sub: "disable" });
		expect(mocks.sessionLeave).toHaveBeenCalledWith("g1", "switched_off");
		expect(text).toContain(voiceCopy.config.leftCall(VC));
	});

	it("a cap of 0 ends the call too", async () => {
		const text = await replyText({ sub: "cap", dollars: 0 });
		expect(mocks.sessionLeave).toHaveBeenCalledWith("g1", "switched_off");
		expect(text).toContain(voiceCopy.config.capSet(0));
		expect(text).toContain(voiceCopy.config.leftCall(VC));
	});

	it("ends the call even when the write that follows fails", async () => {
		mocks.upsert.mockRejectedValue(new Error("mongo down"));
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		await replyText({ sub: "disable" });
		expect(mocks.sessionLeave).toHaveBeenCalledTimes(1);
	});
});

describe("everything else leaves the call alone", () => {
	it.each([
		["a cap above 0", { sub: "cap", dollars: 10 }],
		["listen toggled", { sub: "listen", enabled: false }],
		["status", { sub: "status" }],
	])("%s", async (_label, options) => {
		const text = await replyText(options);
		expect(mocks.sessionLeave).not.toHaveBeenCalled();
		expect(text).not.toContain(voiceCopy.config.leftCall(VC));
	});

	it("a disable with no call adds no line", async () => {
		mocks.sessionGet.mockReturnValue(null);
		const text = await replyText({ sub: "disable" });
		expect(mocks.sessionLeave).not.toHaveBeenCalled();
		expect(text).not.toContain("also left");
	});
});
