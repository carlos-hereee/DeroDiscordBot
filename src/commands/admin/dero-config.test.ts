import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatInputCommandInteraction, EmbedBuilder } from "discord.js";

// ── /dero-config ───────────────────────────────────────────────────────────
// The admin command's promises: there is no voice step (Dero speaks with
// DERO_DEFAULT_VOICE_ID, so enable works straight away), disable never deletes,
// every write is idempotent, and no reply ever shows a whole voice id.

const mocks = vi.hoisted(() => ({
	guildConfig: vi.fn(),
	guildConfigUpdate: vi.fn(),
	findByGuildId: vi.fn(),
	upsert: vi.fn(),
	addToList: vi.fn(),
	removeFromList: vi.fn(),
	currentMonthCents: vi.fn(),
}));

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.guildConfig, update: mocks.guildConfigUpdate } }));
vi.mock("@db/stores/deroVoiceConfigStore.js", () => ({
	deroVoiceConfigStore: {
		findByGuildId: mocks.findByGuildId,
		upsert: mocks.upsert,
		addToList: mocks.addToList,
		removeFromList: mocks.removeFromList,
	},
}));
vi.mock("@features/voice/spendMeter.js", () => ({ currentMonthCents: mocks.currentMonthCents }));
vi.mock("@features/voice/elevenLabsTts.js", () => ({ isTtsKeyConfigured: () => true }));

import { execute, voiceIdTail, data } from "./dero-config.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";

const VOICE_ID = "abcDEF1234567890wxyz";
const STORED = {
	guildId: "g1",
	enabled: false,
	voiceId: VOICE_ID,
	listenEnabled: true,
	allowedRoleIds: ["r1"],
	allowedChannelIds: [],
	allowedVoiceChannelIds: [],
	monthlyCapUsd: 25,
};

type Options = { group?: string | null; sub: string; id?: string; enabled?: boolean; dollars?: number; roleId?: string; channelId?: string };

function run(options: Options, guildId: string | null = "g1") {
	const reply = vi.fn(async () => undefined);
	const interaction = {
		guildId,
		reply,
		options: {
			getSubcommandGroup: () => options.group ?? null,
			getSubcommand: () => options.sub,
			getString: () => options.id,
			getBoolean: () => options.enabled,
			getInteger: () => options.dollars,
			getRole: () => ({ id: options.roleId }),
			getChannel: () => ({ id: options.channelId }),
		},
	} as unknown as ChatInputCommandInteraction;
	return { interaction, reply };
}

async function replyText(options: Options, guildId: string | null = "g1"): Promise<string> {
	const { interaction, reply } = run(options, guildId);
	await execute(interaction);
	const embed = (reply.mock.calls[0] as unknown as [{ embeds: EmbedBuilder[] }])[0].embeds[0];
	return `${embed.data.title ?? ""}\n${embed.data.description ?? ""}`;
}

beforeEach(() => {
	mocks.guildConfig.mockReset().mockResolvedValue({ guildId: "g1" });
	mocks.guildConfigUpdate.mockReset().mockResolvedValue({ guildId: "g1" });
	mocks.findByGuildId.mockReset().mockResolvedValue(STORED);
	mocks.upsert.mockReset().mockResolvedValue(STORED);
	mocks.addToList.mockReset().mockResolvedValue(STORED);
	mocks.removeFromList.mockReset().mockResolvedValue(STORED);
	mocks.currentMonthCents.mockReset().mockResolvedValue(312);
});

describe("the voice id tail", () => {
	it("shows only the last four characters", () => {
		expect(voiceIdTail(VOICE_ID)).toBe("wxyz");
	});
});

describe("the builder", () => {
	// No default permission: it would hide the command from the /setup admin role,
	// and ADMIN_COMMANDS in main.ts is the gate. No voice subcommand: the voice is not a setting.
	it("carries no default permission, no voice subcommand, and every other subcommand and group", () => {
		const json = data.toJSON();
		expect(json.default_member_permissions).toBeUndefined();
		const names = (json.options ?? []).map((option) => option.name);
		expect(names).toEqual(["status", "enable", "disable", "listen", "cap", "role", "channel", "voicechannel", "arcade"]);
	});

	it("carries the arcade group's monthly-post switch as a required boolean, like listen", () => {
		const arcade = (data.toJSON().options ?? []).find((option) => option.name === "arcade") as
			| { options?: Array<{ name: string; options?: Array<{ name: string; type: number; required?: boolean }> }> }
			| undefined;
		const monthlyPost = arcade?.options?.find((sub) => sub.name === "monthly-post");
		// 5 is Discord's BOOLEAN option type.
		expect(monthlyPost?.options).toEqual([expect.objectContaining({ name: "enabled", type: 5, required: true })]);
	});
});

describe("arcade monthly-post (2026-10 item 244 Phase 3b)", () => {
	it("turns the post off on GuildConfig and never reads the voice config", async () => {
		const text = await replyText({ group: "arcade", sub: "monthly-post", enabled: false });
		expect(mocks.guildConfigUpdate).toHaveBeenCalledWith("g1", { arcadeMonthlyPost: false });
		expect(mocks.findByGuildId).not.toHaveBeenCalled();
		expect(text).toContain("Monthly arcade post: **OFF**");
	});

	it("reads a row that never stored the switch as ON, so turning it on changes nothing", async () => {
		expect(await replyText({ group: "arcade", sub: "monthly-post", enabled: true })).toContain("already **ON**");
		expect(mocks.guildConfigUpdate).not.toHaveBeenCalled();
	});

	it("turns it back on, and repeats an OFF idempotently", async () => {
		mocks.guildConfig.mockResolvedValue({ guildId: "g1", arcadeMonthlyPost: false });
		expect(await replyText({ group: "arcade", sub: "monthly-post", enabled: true })).toContain("Monthly arcade post: **ON**");
		expect(mocks.guildConfigUpdate).toHaveBeenCalledWith("g1", { arcadeMonthlyPost: true });
		expect(await replyText({ group: "arcade", sub: "monthly-post", enabled: false })).toContain("already **OFF**");
		expect(mocks.guildConfigUpdate).toHaveBeenCalledTimes(1);
	});
});

describe("gates", () => {
	it("refuses a DM", async () => {
		expect(await replyText({ sub: "status" }, null)).toContain("not a DM");
	});

	it("refuses a guild that never ran /setup", async () => {
		mocks.guildConfig.mockResolvedValue(null);
		expect(await replyText({ sub: "status" })).toContain("Run /setup first");
		expect(mocks.findByGuildId).not.toHaveBeenCalled();
	});
});

describe("enable and disable", () => {
	it("enables straight away on a row that stored no voice id, because Dero speaks with the default", async () => {
		mocks.findByGuildId.mockResolvedValue({ ...STORED, voiceId: null });
		expect(await replyText({ sub: "enable" })).toContain("voice is ON");
		expect(mocks.upsert).toHaveBeenCalledWith("g1", { enabled: true });
	});

	it("enables a guild that never touched /dero-config before", async () => {
		mocks.findByGuildId.mockResolvedValue(null);
		await replyText({ sub: "enable" });
		expect(mocks.upsert).toHaveBeenCalledWith("g1", { enabled: true });
	});

	it("disable flips enabled and nothing else", async () => {
		mocks.findByGuildId.mockResolvedValue({ ...STORED, enabled: true });
		await replyText({ sub: "disable" });
		expect(mocks.upsert).toHaveBeenCalledWith("g1", { enabled: false });
	});

	it("is idempotent both ways", async () => {
		mocks.findByGuildId.mockResolvedValue({ ...STORED, enabled: true });
		expect(await replyText({ sub: "enable" })).toContain("already ON");
		mocks.findByGuildId.mockResolvedValue(null);
		expect(await replyText({ sub: "disable" })).toContain("already OFF");
		expect(mocks.upsert).not.toHaveBeenCalled();
	});
});

describe("listen and cap", () => {
	it("sets Listen and the cap, idempotently", async () => {
		await replyText({ sub: "listen", enabled: false });
		expect(mocks.upsert).toHaveBeenCalledWith("g1", { listenEnabled: false });
		expect(await replyText({ sub: "listen", enabled: true })).toContain("already");

		await replyText({ sub: "cap", dollars: 0 });
		expect(mocks.upsert).toHaveBeenCalledWith("g1", { monthlyCapUsd: 0 });
		expect(await replyText({ sub: "cap", dollars: 25 })).toContain("already $25");
	});
});

describe("allowlists", () => {
	it("adds a role once and reports a repeat", async () => {
		await replyText({ group: "role", sub: "add", roleId: "r2" });
		expect(mocks.addToList).toHaveBeenCalledWith("g1", "allowedRoleIds", "r2");
		expect(await replyText({ group: "role", sub: "add", roleId: "r1" })).toContain("already on the list");
		expect(mocks.addToList).toHaveBeenCalledTimes(1);
	});

	it("removes only what is there", async () => {
		await replyText({ group: "role", sub: "remove", roleId: "r1" });
		expect(mocks.removeFromList).toHaveBeenCalledWith("g1", "allowedRoleIds", "r1");
		expect(await replyText({ group: "voicechannel", sub: "remove", channelId: "v9" })).toContain("not on the list");
		expect(mocks.removeFromList).toHaveBeenCalledTimes(1);
	});

	it("files text and voice channels on their own lists", async () => {
		await replyText({ group: "channel", sub: "add", channelId: "c1" });
		await replyText({ group: "voicechannel", sub: "add", channelId: "v1" });
		expect(mocks.addToList).toHaveBeenCalledWith("g1", "allowedChannelIds", "c1");
		expect(mocks.addToList).toHaveBeenCalledWith("g1", "allowedVoiceChannelIds", "v1");
	});
});

describe("status", () => {
	it("shows state, list sizes and spend against the cap, and only the voice id's tail", async () => {
		const text = await replyText({ sub: "status" });
		expect(text).toContain("Voice: **OFF**");
		expect(text).toContain("Speaking voice: id ending in `wxyz`");
		expect(text).not.toContain(VOICE_ID);
		expect(text).toContain("Allowed roles: 1");
		expect(text).toContain("$3.12 of a $25 cap");
	});

	it("names George, by tail only, for a row that stored no voice id", async () => {
		mocks.findByGuildId.mockResolvedValue({ ...STORED, voiceId: null });
		const text = await replyText({ sub: "status" });
		expect(text).toContain(`Speaking voice: George, id ending in \`${voiceIdTail(BOT_CONSTANTS.DERO_DEFAULT_VOICE_ID)}\``);
		expect(text).not.toContain(BOT_CONSTANTS.DERO_DEFAULT_VOICE_ID);
	});
});

describe("a failed write", () => {
	it("reports plainly instead of throwing", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		mocks.upsert.mockRejectedValue(new Error("connection lost"));
		expect(await replyText({ sub: "enable" })).toContain("Could not save");
		error.mockRestore();
	});
});
