import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatInputCommandInteraction, EmbedBuilder } from "discord.js";

// ── /dero-config ───────────────────────────────────────────────────────────
// The admin command's promises: there is no voice step (Dero speaks with
// DERO_DEFAULT_VOICE_ID, so enable works straight away), disable never deletes,
// every write is idempotent, and no reply ever shows a whole voice id.

const mocks = vi.hoisted(() => ({
	guildConfig: vi.fn(),
	findByGuildId: vi.fn(),
	upsert: vi.fn(),
	addToList: vi.fn(),
	removeFromList: vi.fn(),
	currentMonthCents: vi.fn(),
	emit: vi.fn(),
}));

vi.mock("@db/stores/guildConfigStore.js", () => ({
	guildConfigStore: {
		findByGuildId: mocks.guildConfig,
	},
}));
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
vi.mock("@features/setup/adminLog.js", () => ({ adminLog: { emit: mocks.emit } }));

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
		user: { id: "admin-1" },
		guild: { id: guildId },
		reply,
		deferReply: vi.fn(async () => undefined),
		editReply: reply,
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
	// A state's private fallback is its plain text since Phase 1c (owner rule 1); an answer is an embed.
	const sent = (reply.mock.calls[0] as unknown as [{ embeds?: EmbedBuilder[]; content?: string }])[0];
	if (sent.content) return sent.content;
	const embed = sent.embeds![0];
	return `${embed.data.title ?? ""}\n${embed.data.description ?? ""}`;
}

beforeEach(() => {
	mocks.guildConfig.mockReset().mockResolvedValue({ guildId: "g1" });
	mocks.findByGuildId.mockReset().mockResolvedValue(STORED);
	mocks.upsert.mockReset().mockResolvedValue(STORED);
	mocks.addToList.mockReset().mockResolvedValue(STORED);
	mocks.removeFromList.mockReset().mockResolvedValue(STORED);
	mocks.currentMonthCents.mockReset().mockResolvedValue(312);
	mocks.emit.mockReset();
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
		// The cap is hidden and the text channel group retired (2026-10 item 263 Phase 4b).
		expect(names).toEqual(["status", "enable", "disable", "listen", "role", "voicechannel"]);
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

describe("listen and the hidden cap", () => {
	it("sets Listen, idempotently", async () => {
		await replyText({ sub: "listen", enabled: false });
		expect(mocks.upsert).toHaveBeenCalledWith("g1", { listenEnabled: false });
		expect(await replyText({ sub: "listen", enabled: true })).toContain("already");
	});

	// A cap press from a command registered before the hide answers the status and writes
	// nothing, so the stored cap keeps being the one spendMeter enforces.
	it("writes no cap from a stale cap subcommand", async () => {
		await replyText({ sub: "cap", dollars: 0 });
		expect(mocks.upsert).not.toHaveBeenCalled();
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

	it("files voice channels on their list, and a stale text channel press files nothing", async () => {
		await replyText({ group: "channel", sub: "add", channelId: "c1" });
		await replyText({ group: "voicechannel", sub: "add", channelId: "v1" });
		expect(mocks.addToList).toHaveBeenCalledTimes(1);
		expect(mocks.addToList).toHaveBeenCalledWith("g1", "allowedVoiceChannelIds", "v1");
	});
});

describe("status", () => {
	it("shows state and list sizes with no text channel count and no budget, and only the voice id's tail", async () => {
		const text = await replyText({ sub: "status" });
		expect(text).toContain("Voice: **OFF**");
		expect(text).toContain("Speaking voice: id ending in `wxyz`");
		expect(text).not.toContain(VOICE_ID);
		expect(text).toContain("Allowed roles: 1");
		expect(text).not.toContain("text channels");
		expect(text).not.toContain("cap");
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

// ── the admin log (post-launch plan item 11) ──
describe("admin log lines", () => {
	const kinds = () => mocks.emit.mock.calls.map((call) => (call[0] as { kind: string }).kind);

	it("logs a voice channel added as voice.allowlist, by the member who ran it", async () => {
		await replyText({ group: "voicechannel", sub: "add", channelId: "v1" });
		expect(kinds()).toEqual(["voice.allowlist"]);
		expect(mocks.emit.mock.calls[0]![0]).toMatchObject({ actor: { userId: "admin-1" }, guild: { id: "g1" } });
	});

	it("logs a role added to the task list as voice.allowlist", async () => {
		await replyText({ group: "role", sub: "add", roleId: "r2" });
		expect(kinds()).toEqual(["voice.allowlist"]);
	});

	it("logs a real setting change as config.change and an unchanged one not at all", async () => {
		await replyText({ sub: "enable" });
		await replyText({ sub: "listen", enabled: true });
		expect(kinds()).toEqual(["config.change"]);
	});
});
