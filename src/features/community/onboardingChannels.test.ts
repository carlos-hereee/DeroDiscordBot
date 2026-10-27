import { describe, expect, it, vi } from "vitest";
import { Collection, DiscordAPIError } from "discord.js";
import { channelsOnboardingUses, mustStayReadable, readOnboardingSafeChannels } from "./onboardingChannels.js";

// The safe set decides which channels the gating reconcile and the adoption move
// leave readable by @everyone, the fix for DiscordAPIError 350003 (2026-10 item 257).

function liveOnboarding(defaults: string[], answerChannels: string[][] = []) {
	const prompts = new Collection(
		answerChannels.map((channels, index) => [
			`prompt-${index}`,
			{
				id: `prompt-${index}`,
				title: "Pick",
				singleSelect: false,
				required: false,
				inOnboarding: true,
				type: 0,
				options: new Collection([
					[`option-${index}`, { id: `option-${index}`, title: "A", description: null, roles: new Collection(), channels: new Collection(channels.map((id) => [id, undefined])), emoji: null }],
				]),
			},
		])
	);
	return { enabled: true, prompts, defaultChannels: new Collection(defaults.map((id) => [id, undefined])) };
}

function makeGuild(options: { community?: boolean; rulesChannelId?: string | null; live?: unknown; refuse?: boolean } = {}) {
	return {
		id: "guild-1",
		features: options.community === false ? [] : ["COMMUNITY"],
		rulesChannelId: options.rulesChannelId === undefined ? "ch-rules" : options.rulesChannelId,
		fetchOnboarding: vi.fn(async () => {
			if (options.refuse) throw new DiscordAPIError({ code: 50013, message: "Missing Permissions" }, 50013, 403, "GET", "url", {});
			return options.live ?? liveOnboarding([]);
		}),
	};
}

describe("channelsOnboardingUses", () => {
	it("collects the default channels and every channel an answer opens, each once", () => {
		const ids = channelsOnboardingUses({
			defaultChannelIds: ["ch-a", "ch-b"],
			prompts: [{ options: [{ channelIds: ["ch-b", "ch-c"] }] }] as never,
		});
		expect([...ids].sort()).toEqual(["ch-a", "ch-b", "ch-c"]);
	});
});

describe("readOnboardingSafeChannels", () => {
	it("holds the rules channel, the defaults and the answer channels", async () => {
		const guild = makeGuild({ live: liveOnboarding(["ch-welcome"], [["ch-games"]]) });
		const safe = await readOnboardingSafeChannels(guild as never);
		expect(safe.onboardingRead).toBe(true);
		expect([...safe.ids].sort()).toEqual(["ch-games", "ch-rules", "ch-welcome"]);
	});

	it("spends no API call on a guild without Community, which cannot have Onboarding", async () => {
		const guild = makeGuild({ community: false, rulesChannelId: null });
		const safe = await readOnboardingSafeChannels(guild as never);
		expect(guild.fetchOnboarding).not.toHaveBeenCalled();
		expect(safe).toEqual({ onboardingRead: true, ids: new Set() });
	});

	it("keeps the rules channel and reports the refused read in one line, no stack", async () => {
		const guild = makeGuild({ refuse: true });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const safe = await readOnboardingSafeChannels(guild as never);
		expect(safe.onboardingRead).toBe(false);
		expect([...safe.ids]).toEqual(["ch-rules"]);
		expect(warn).toHaveBeenCalledOnce();
		expect(warn.mock.calls[0]).toHaveLength(1);
		warn.mockRestore();
	});
});

describe("mustStayReadable", () => {
	it("keeps a safe channel readable, and every adopted channel when Onboarding could not be read", () => {
		const read = { onboardingRead: true, ids: new Set(["ch-rules"]) };
		const unread = { onboardingRead: false, ids: new Set(["ch-rules"]) };
		expect(mustStayReadable(read, "ch-rules", false)).toBe(true);
		expect(mustStayReadable(read, "ch-welcome", true)).toBe(false);
		expect(mustStayReadable(unread, "ch-welcome", true)).toBe(true);
		expect(mustStayReadable(unread, "ch-announcements", false)).toBe(false);
	});
});
