import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatInputCommandInteraction, EmbedBuilder } from "discord.js";

// ── /dero-config ───────────────────────────────────────────────────────────
// The admin command's promises: a voice id is validated by the bot rather than
// only by Discord's option bounds, enable refuses without a voice, disable never
// deletes, every write is idempotent, and no reply ever shows a whole voice id.

const mocks = vi.hoisted(() => ({
	guildConfig: vi.fn(),
	findByGuildId: vi.fn(),
	upsert: vi.fn(),
	addToList: vi.fn(),
	removeFromList: vi.fn(),
	currentMonthCents: vi.fn(),
}));

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.guildConfig } }));
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

import { execute, isValidVoiceId, voiceIdTail, data } from "./dero-config.js";

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
	mocks.findByGuildId.mockReset().mockResolvedValue(STORED);
	mocks.upsert.mockReset().mockResolvedValue(STORED);
	mocks.addToList.mockReset().mockResolvedValue(STORED);
	mocks.removeFromList.mockReset().mockResolvedValue(STORED);
	mocks.currentMonthCents.mockReset().mockResolvedValue(312);
});

describe("voice id rules", () => {
	it("accepts 10 to 64 letters and digits only", () => {
		expect(isValidVoiceId(VOICE_ID)).toBe(true);
		expect(isValidVoiceId("a".repeat(10))).toBe(true);
		expect(isValidVoiceId("a".repeat(64))).toBe(true);
		expect(isValidVoiceId("a".repeat(9))).toBe(false);
		expect(isValidVoiceId("a".repeat(65))).toBe(false);
		expect(isValidVoiceId("abc def 1234")).toBe(false);
		expect(isValidVoiceId("https://elevenlabs.io/x")).toBe(false);
	});

	it("shows only the last four characters", () => {
		expect(voiceIdTail(VOICE_ID)).toBe("wxyz");
	});
});

describe("the builder", () => {
	it("defaults to Administrator and carries every subcommand and group", () => {
		const json = data.toJSON();
		expect(json.default_member_permissions).toBe("8");
		const names = (json.options ?? []).map((option) => option.name);
		expect(names).toEqual(["status", "enable", "disable", "voice", "listen", "cap", "role", "channel", "voicechannel"]);
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
	it("refuses to enable with no voice set, and writes nothing", async () => {
		mocks.findByGuildId.mockResolvedValue({ ...STORED, voiceId: null });
		expect(await replyText({ sub: "enable" })).toContain("Set a voice first");
		expect(mocks.upsert).not.toHaveBeenCalled();
	});

	it("enables when a voice is set", async () => {
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

describe("voice, listen and cap", () => {
	it("refuses a malformed voice id and writes nothing", async () => {
		expect(await replyText({ sub: "voice", id: "not a voice id!" })).toContain("does not look like a voice id");
		expect(mocks.upsert).not.toHaveBeenCalled();
	});

	it("saves a new voice id and shows only its tail", async () => {
		const text = await replyText({ sub: "voice", id: "zyxWVU0987654321abcd" });
		expect(mocks.upsert).toHaveBeenCalledWith("g1", { voiceId: "zyxWVU0987654321abcd" });
		expect(text).toContain("abcd");
		expect(text).not.toContain("zyxWVU0987654321abcd");
	});

	it("does not rewrite the same voice id", async () => {
		expect(await replyText({ sub: "voice", id: VOICE_ID })).toContain("already set");
		expect(mocks.upsert).not.toHaveBeenCalled();
	});

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
		expect(text).toContain("ending in `wxyz`");
		expect(text).not.toContain(VOICE_ID);
		expect(text).toContain("Allowed roles: 1");
		expect(text).toContain("$3.12 of a $25 cap");
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
