import { describe, it, expect, vi, beforeEach } from "vitest";
import { SlashCommandSubcommandGroupBuilder, type ChatInputCommandInteraction, type EmbedBuilder } from "discord.js";

const mocks = vi.hoisted(() => ({
	ban: vi.fn(),
	unban: vi.fn(),
	scheduleRefresh: vi.fn(),
	seatOutMember: vi.fn(),
	seatOutServer: vi.fn(),
}));

vi.mock("@utils/config.js", () => ({ creatorId: "owner-1" }));
vi.mock("@db/stores/networkBanStore.js", () => ({ networkBanStore: { ban: mocks.ban, unban: mocks.unban } }));
vi.mock("@features/game-rooms/networkBoard.js", () => ({ scheduleNetworkBoardRefresh: mocks.scheduleRefresh }));
vi.mock("@features/game-rooms/satelliteSeats.js", () => ({ seatOutBannedMember: mocks.seatOutMember, seatOutBannedServer: mocks.seatOutServer }));

import { addNetworkBanSubcommands, runNetworkBanSubcommand } from "./networkBanSubcommands.js";

// ── /platform network (2026-10 item 244 Phase 5b) ──────────────────────────
// The platform owner's network bans: the owner check refuses everyone else before
// anything is read, the option the target names must be filled, a typed server id is
// checked for shape, every write is idempotent with an honest reply, and a change
// redraws the network boards.

const SERVER = "123456789012345678";

type Options = { userId?: string; sub: string; target: string; server?: string; reason?: string | null; noMember?: boolean };

async function run(options: Options): Promise<{ text: string; flags?: number }> {
	const reply = vi.fn(async () => undefined);
	const interaction = {
		user: { id: options.userId ?? "owner-1" },
		client: { guilds: { cache: new Map([[SERVER, { name: "Some_Server" }]]) } },
		reply,
		options: {
			getSubcommand: () => options.sub,
			getUser: () => (options.noMember ? null : { id: "member-1" }),
			getString: (name: string) => ({ target: options.target, server: options.server ?? null, reason: options.reason ?? null })[name] ?? null,
		},
	} as unknown as ChatInputCommandInteraction;
	await runNetworkBanSubcommand(interaction);
	const payload = (reply.mock.calls[0] as unknown as [{ embeds: EmbedBuilder[]; flags?: number }])[0];
	return { text: payload.embeds[0].data.description ?? "", flags: payload.flags };
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.ban.mockResolvedValue(true);
	mocks.unban.mockResolvedValue(true);
	mocks.seatOutMember.mockResolvedValue(0);
	mocks.seatOutServer.mockResolvedValue(0);
});

describe("the builder", () => {
	it("offers ban and unban, each with a required member or server target before its optional member and server", () => {
		const json = addNetworkBanSubcommands(new SlashCommandSubcommandGroupBuilder().setName("network").setDescription("network")).toJSON();
		const subs = (json.options ?? []) as unknown as { name: string; options: { name: string; required?: boolean; choices?: { value: string }[] }[] }[];
		expect(subs.map((sub) => [sub.name, sub.options.map((option) => option.name)])).toEqual([
			["ban", ["target", "user", "server", "reason"]],
			["unban", ["target", "user", "server"]],
		]);
		for (const sub of subs) {
			const [target, ...rest] = sub.options;
			expect(target?.required).toBe(true);
			expect(target?.choices?.map((choice) => choice.value)).toEqual(["member", "server"]);
			expect(rest.every((option) => !option.required)).toBe(true);
		}
	});
});

describe("running a ban", () => {
	it("refuses anybody but the platform owner, privately, before touching the ban list", async () => {
		const { text, flags } = await run({ userId: "admin-1", sub: "ban", target: "member" });
		expect(text).toContain("Only the platform owner");
		expect(flags).toBeDefined();
		expect(mocks.ban).not.toHaveBeenCalled();
	});

	it("bans a member with the owner's note and redraws the boards", async () => {
		const { text } = await run({ sub: "ban", target: "member", reason: "  spam  " });
		expect(mocks.ban).toHaveBeenCalledWith("user", "member-1", "spam", expect.any(Date));
		expect(text).toContain("Banned member <@member-1>");
		expect(mocks.scheduleRefresh).toHaveBeenCalled();
	});

	it("bans a server by its id, naming it when Dero is in it", async () => {
		const { text } = await run({ sub: "ban", target: "server", server: SERVER });
		expect(mocks.ban).toHaveBeenCalledWith("guild", SERVER, "", expect.any(Date));
		expect(text).toContain("Some\\_Server");
	});

	it("says a ban already stands without redrawing anything", async () => {
		mocks.ban.mockResolvedValue(false);
		expect((await run({ sub: "ban", target: "member" })).text).toContain("already banned");
		expect(mocks.scheduleRefresh).not.toHaveBeenCalled();
	});

	// Phase 5c (owner decision 2026-10-24): a new ban reaches the seats it names that are already taken.
	it("seats out a newly banned member's seats at network tables, and says so", async () => {
		const { text } = await run({ sub: "ban", target: "member" });
		expect(mocks.seatOutMember).toHaveBeenCalledWith(expect.anything(), "member-1");
		expect(mocks.seatOutServer).not.toHaveBeenCalled();
		expect(text).toContain("leave those tables now");
		expect(text).toContain("A room in their own server keeps them");
	});

	it("ends a newly banned server's satellites and the satellites of the tables it hosts", async () => {
		const { text } = await run({ sub: "ban", target: "server", server: SERVER });
		expect(mocks.seatOutServer).toHaveBeenCalledWith(expect.anything(), SERVER);
		expect(mocks.seatOutMember).not.toHaveBeenCalled();
		expect(text).toContain("leave those tables now");
	});

	it("never shows the owner's ban note in the reply, and replies even when the seat out fails", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
		mocks.seatOutMember.mockRejectedValue(new Error("atlas unreachable"));
		const { text } = await run({ sub: "ban", target: "member", reason: "private note" });
		expect(text).toContain("Banned member <@member-1>");
		expect(text).not.toContain("private note");
		await vi.waitFor(() => expect(consoleError).toHaveBeenCalled());
		consoleError.mockRestore();
	});

	it("sweeps nothing for a ban that already stood, or for an unban", async () => {
		mocks.ban.mockResolvedValue(false);
		await run({ sub: "ban", target: "member" });
		await run({ sub: "unban", target: "server", server: SERVER });
		expect(mocks.seatOutMember).not.toHaveBeenCalled();
		expect(mocks.seatOutServer).not.toHaveBeenCalled();
	});

	it("lifts a ban, and says so honestly when there was none", async () => {
		expect((await run({ sub: "unban", target: "server", server: SERVER })).text).toContain("Lifted the network ban");
		expect(mocks.unban).toHaveBeenCalledWith("guild", SERVER);
		mocks.unban.mockResolvedValue(false);
		expect((await run({ sub: "unban", target: "member" })).text).toContain("is not banned");
	});

	it.each([
		["member", { noMember: true }],
		["server", {}],
	] as const)("refuses a %s target whose option is empty, writing nothing", async (target, extra) => {
		const { text } = await run({ sub: "ban", target, ...extra });
		expect(text).toContain("Nothing changed");
		expect(mocks.ban).not.toHaveBeenCalled();
	});

	it("refuses a server id that is not a snowflake, writing nothing", async () => {
		expect((await run({ sub: "ban", target: "server", server: "my server" })).text).toContain("is not a server id");
		expect(mocks.ban).not.toHaveBeenCalled();
	});
});
