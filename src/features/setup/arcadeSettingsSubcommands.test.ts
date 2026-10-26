import { describe, it, expect, vi, beforeEach } from "vitest";
import { SlashCommandBuilder, SlashCommandSubcommandGroupBuilder, type ChatInputCommandInteraction, type EmbedBuilder } from "discord.js";

// ── /arcade settings ───────────────────────────────────────────────────────
// The arcade's own switches and lists: every write is idempotent and logged once,
// nothing reads the voice config, the reach and the block list refuse what they
// cannot check, and on and off go through arcadeSwitch.

const mocks = vi.hoisted(() => ({
	guildConfig: vi.fn(),
	guildConfigUpdate: vi.fn(),
	addBlocked: vi.fn(),
	removeBlocked: vi.fn(),
	findByGuildId: vi.fn(),
	seatOutBlocked: vi.fn(),
	emit: vi.fn(),
	turnArcadeOff: vi.fn(),
	turnArcadeOn: vi.fn(),
}));

vi.mock("@db/stores/guildConfigStore.js", () => ({
	guildConfigStore: {
		findByGuildId: mocks.guildConfig,
		update: mocks.guildConfigUpdate,
		addBlockedNetworkGuild: mocks.addBlocked,
		removeBlockedNetworkGuild: mocks.removeBlocked,
	},
}));
// Mocked only to prove an arcade setting never reads the voice config.
vi.mock("@db/stores/deroVoiceConfigStore.js", () => ({ deroVoiceConfigStore: { findByGuildId: mocks.findByGuildId } }));
vi.mock("@features/game-rooms/satelliteSeats.js", () => ({ seatOutBlockedServers: mocks.seatOutBlocked }));
vi.mock("@features/setup/adminLog.js", () => ({ adminLog: { emit: mocks.emit } }));
vi.mock("@features/setup/arcadeSwitch.js", () => ({ turnArcadeOff: mocks.turnArcadeOff, turnArcadeOn: mocks.turnArcadeOn }));

import { addArcadeSettingSubcommands, addServerBlockSubcommands, runArcadeSettingSubcommand } from "./arcadeSettingsSubcommands.js";

type Options = { group?: string | null; sub: string; id?: string; enabled?: boolean };

const settingsJson = () =>
	(addArcadeSettingSubcommands(new SlashCommandBuilder().setName("arcade").setDescription("arcade")).toJSON().options ?? []) as Array<{
		name: string;
		options?: { name: string; type: number; required?: boolean; choices?: { value: string }[] }[];
	}>;

async function replyText(options: Options, guildId: string | null = "g1"): Promise<string> {
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
		},
	} as unknown as ChatInputCommandInteraction;
	await runArcadeSettingSubcommand(interaction, interaction.options);
	const embed = (reply.mock.calls[0] as unknown as [{ embeds: EmbedBuilder[] }])[0].embeds[0];
	return `${embed.data.title ?? ""}\n${embed.data.description ?? ""}`;
}

beforeEach(() => {
	mocks.guildConfig.mockReset().mockResolvedValue({ guildId: "g1" });
	mocks.guildConfigUpdate.mockReset().mockResolvedValue({ guildId: "g1" });
	mocks.addBlocked.mockReset().mockResolvedValue({ guildId: "g1" });
	mocks.removeBlocked.mockReset().mockResolvedValue({ guildId: "g1" });
	mocks.findByGuildId.mockReset();
	mocks.seatOutBlocked.mockReset().mockResolvedValue(0);
	mocks.emit.mockReset();
	mocks.turnArcadeOff.mockReset().mockResolvedValue("off");
	mocks.turnArcadeOn.mockReset().mockResolvedValue("on");
});

describe("the /arcade settings builder", () => {
	it("adds on, off, bots, reach and monthly-post, in that order", () => {
		expect(settingsJson().map((sub) => sub.name)).toEqual(["on", "off", "bots", "reach", "monthly-post"]);
	});

	it("carries monthly-post and bots as required booleans", () => {
		for (const name of ["monthly-post", "bots"]) {
			// 5 is Discord's BOOLEAN option type.
			expect(settingsJson().find((sub) => sub.name === name)?.options).toEqual([expect.objectContaining({ name: "enabled", type: 5, required: true })]);
		}
	});
});

describe("gates", () => {
	it("refuses a DM", async () => {
		expect(await replyText({ sub: "bots", enabled: true }, null)).toContain("not a DM");
	});

	it("refuses a guild that never ran /setup, writing nothing", async () => {
		mocks.guildConfig.mockResolvedValue(null);
		expect(await replyText({ sub: "bots", enabled: true })).toContain("Run /setup first");
		expect(mocks.guildConfigUpdate).not.toHaveBeenCalled();
	});
});

describe("/arcade monthly-post (2026-10 item 244 Phase 3b)", () => {
	it("turns the post off on GuildConfig and never reads the voice config", async () => {
		const text = await replyText({ sub: "monthly-post", enabled: false });
		expect(mocks.guildConfigUpdate).toHaveBeenCalledWith("g1", { arcadeMonthlyPost: false });
		expect(mocks.findByGuildId).not.toHaveBeenCalled();
		expect(text).toContain("Monthly arcade post: **OFF**");
	});

	it("reads a row that never stored the switch as ON, so turning it on changes nothing", async () => {
		expect(await replyText({ sub: "monthly-post", enabled: true })).toContain("already **ON**");
		expect(mocks.guildConfigUpdate).not.toHaveBeenCalled();
	});

	it("turns it back on, and repeats an OFF idempotently", async () => {
		mocks.guildConfig.mockResolvedValue({ guildId: "g1", arcadeMonthlyPost: false });
		expect(await replyText({ sub: "monthly-post", enabled: true })).toContain("Monthly arcade post: **ON**");
		expect(mocks.guildConfigUpdate).toHaveBeenCalledWith("g1", { arcadeMonthlyPost: true });
		expect(await replyText({ sub: "monthly-post", enabled: false })).toContain("already **OFF**");
		expect(mocks.guildConfigUpdate).toHaveBeenCalledTimes(1);
	});
});

describe("/arcade bots (2026-10 item 250 Phase 5)", () => {
	it("turns bot opponents off on GuildConfig, logs it, and never reads the voice config", async () => {
		const text = await replyText({ sub: "bots", enabled: false });
		expect(mocks.guildConfigUpdate).toHaveBeenCalledWith("g1", { botOpponentsEnabled: false });
		expect(mocks.findByGuildId).not.toHaveBeenCalled();
		expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "config.change", payload: { subject: "Dero bot opponents", detail: "off" } }));
		expect(text).toContain("Dero bot opponents: **OFF**");
	});

	it("reads a row that never stored the switch as ON, and writes nothing when it is unchanged", async () => {
		expect(await replyText({ sub: "bots", enabled: true })).toContain("already **ON**");
		expect(mocks.guildConfigUpdate).not.toHaveBeenCalled();
		expect(mocks.emit).not.toHaveBeenCalled();
	});
});

describe("/arcade reach (2026-10 item 244 Phase 4)", () => {
	it("carries the reach as a required string with exactly the three reaches as choices", () => {
		const reach = settingsJson().find((sub) => sub.name === "reach");
		expect(reach?.options?.[0]).toMatchObject({ name: "mode", required: true });
		expect(reach?.options?.[0].choices?.map((choice) => choice.value)).toEqual(["invite-only", "server", "network"]);
	});

	it("stores a new reach and says what hosts may now open", async () => {
		const text = await replyText({ sub: "reach", id: "invite-only" });
		expect(mocks.guildConfigUpdate).toHaveBeenCalledWith("g1", { challengeReach: "invite-only" });
		expect(text).toContain("Challenge reach: **Invite only**");
	});

	it("reads a row that never stored a reach as Server, and writes nothing when it is unchanged", async () => {
		expect(await replyText({ sub: "reach", id: "server" })).toContain("already **Server**");
		expect(mocks.guildConfigUpdate).not.toHaveBeenCalled();
	});

	// Phase 5b (2026-10 item 244) built the network tables, so the reply now says what
	// Network adds instead of promising it reads like Server until they arrive.
	it("stores Network and says it opens Hold'em tables to other network servers, with the notice and the block list", async () => {
		const text = await replyText({ sub: "reach", id: "network" });
		expect(mocks.guildConfigUpdate).toHaveBeenCalledWith("g1", { challengeReach: "network" });
		expect(text).toContain("other network servers");
		expect(text).toContain("network notice");
		expect(text).toContain("/arcade server block");
		expect(text).not.toContain("the same as Server");
	});

	it("refuses an unknown reach rather than reading it as a default, and writes nothing", async () => {
		mocks.guildConfig.mockResolvedValue({ guildId: "g1", challengeReach: "invite-only" });
		expect(await replyText({ sub: "reach", id: "everywhere" })).toContain("That is not a challenge reach");
		expect(mocks.guildConfigUpdate).not.toHaveBeenCalled();
	});
});

describe("/arcade network block list (2026-10 item 244 Phase 5b)", () => {
	const OTHER = "123456789012345678";

	it("offers block and unblock, each with a required server id", () => {
		const subs = (addServerBlockSubcommands(new SlashCommandSubcommandGroupBuilder().setName("server").setDescription("server")).toJSON().options ?? []) as Array<{
			name: string;
			options?: { name: string; required?: boolean }[];
		}>;
		for (const name of ["block", "unblock"]) {
			const sub = subs.find((option) => option.name === name);
			expect(sub?.options?.[0]).toMatchObject({ name: "server", required: true });
		}
	});

	it("blocks a server once, and says so without writing when it is already blocked", async () => {
		expect(await replyText({ group: "server", sub: "block", id: OTHER })).toContain(`Blocked server \`${OTHER}\``);
		expect(mocks.addBlocked).toHaveBeenCalledWith("g1", OTHER);

		mocks.addBlocked.mockClear();
		mocks.guildConfig.mockResolvedValue({ guildId: "g1", blockedNetworkGuildIds: [OTHER] });
		expect(await replyText({ group: "server", sub: "block", id: OTHER })).toContain("already blocked");
		expect(mocks.addBlocked).not.toHaveBeenCalled();
	});

	// Phase 5c (owner decision 2026-10-24): a new block reaches the seats already taken between the two servers.
	it("ends the satellites between this server and a newly blocked one, both ways, and says so", async () => {
		const text = await replyText({ group: "server", sub: "block", id: OTHER });
		expect(mocks.seatOutBlocked).toHaveBeenCalledWith(undefined, "g1", OTHER);
		expect(text).toContain("both ways, leave their tables now");
	});

	it("sweeps nothing for a block that already stood, an unblock, or a refused id", async () => {
		mocks.guildConfig.mockResolvedValue({ guildId: "g1", blockedNetworkGuildIds: [OTHER] });
		await replyText({ group: "server", sub: "block", id: OTHER });
		await replyText({ group: "server", sub: "unblock", id: OTHER });
		await replyText({ group: "server", sub: "block", id: "not-a-server" });
		expect(mocks.seatOutBlocked).not.toHaveBeenCalled();
	});

	it("replies to a new block even when the seat out fails", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
		mocks.seatOutBlocked.mockRejectedValue(new Error("atlas unreachable"));
		expect(await replyText({ group: "server", sub: "block", id: OTHER })).toContain(`Blocked server \`${OTHER}\``);
		await vi.waitFor(() => expect(consoleError).toHaveBeenCalled());
		consoleError.mockRestore();
	});

	it("unblocks a blocked server, and says so without writing when it was never blocked", async () => {
		mocks.guildConfig.mockResolvedValue({ guildId: "g1", blockedNetworkGuildIds: [OTHER] });
		expect(await replyText({ group: "server", sub: "unblock", id: OTHER })).toContain(`Unblocked server \`${OTHER}\``);
		expect(mocks.removeBlocked).toHaveBeenCalledWith("g1", OTHER);

		mocks.removeBlocked.mockClear();
		mocks.guildConfig.mockResolvedValue({ guildId: "g1", blockedNetworkGuildIds: [] });
		expect(await replyText({ group: "server", sub: "unblock", id: OTHER })).toContain("is not blocked");
		expect(mocks.removeBlocked).not.toHaveBeenCalled();
	});

	it("refuses anything that is not a server id, and this server's own id, writing nothing", async () => {
		expect(await replyText({ group: "server", sub: "block", id: "not-a-server" })).toContain("is not a server id");
		mocks.guildConfig.mockResolvedValue({ guildId: "111111111111111111" });
		expect(await replyText({ group: "server", sub: "block", id: "111111111111111111" }, "111111111111111111")).toContain("this server's own id");
		expect(mocks.addBlocked).not.toHaveBeenCalled();
	});
});

describe("/arcade off and on", () => {
	it("turns the arcade off through arcadeSwitch and logs it", async () => {
		const text = await replyText({ sub: "off" });
		expect(mocks.turnArcadeOff).toHaveBeenCalledOnce();
		expect(text).toContain("deleted");
		expect(mocks.emit).toHaveBeenCalledOnce();
	});

	it("says so and logs nothing when the arcade is already off", async () => {
		mocks.turnArcadeOff.mockResolvedValue("already-off");
		expect(await replyText({ sub: "off" })).toContain("already off");
		expect(mocks.emit).not.toHaveBeenCalled();
	});

	it("is honest when the arcade could not be rebuilt at once", async () => {
		mocks.turnArcadeOn.mockResolvedValue("pending");
		expect(await replyText({ sub: "on" })).toContain("could not all be built");
	});
});
