import { describe, it, expect, vi, beforeEach } from "vitest";
import { type Client, type RepliableInteraction, type User } from "discord.js";

const mocks = vi.hoisted(() => ({ findByUserInGuild: vi.fn(), findByGuildId: vi.fn() }));
// The view posts in 💬dero-commands (2026-10 item 257 Phase 5). With no commands channel
// stored it answers privately, which is what most tests below read; one posts in the channel.
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findByGuildId } }));
vi.mock("@db/stores/gameRoomStore.js", () => ({ gameRoomStore: { findByUserInGuild: mocks.findByUserInGuild } }));

import { MATCH_HISTORY_SHOWN, resultFor, savedMatchLine, showMatchHistory } from "./savedMatches.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── savedMatches: the match history (2026-10 item 263 decision 2) ─────────────
// /account view:saved lists a member's last finished matches, with no save step. The store is
// mocked: what is pinned is what the list shows and how many rows it asks for.

const client = {} as Client;

const room = (overrides: Record<string, unknown> = {}): IGameRoom =>
	({
		roomId: "room-1",
		guildId: "guild-1",
		game: "hangman",
		status: "finished",
		playerIds: ["me", "rival"],
		botSeats: 0,
		network: false,
		winnerId: "me",
		endedAt: new Date("2026-10-20T12:00:00Z"),
		...overrides,
	}) as unknown as IGameRoom;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.findByUserInGuild.mockResolvedValue([]);
	mocks.findByGuildId.mockResolvedValue(null);
});

describe("resultFor", () => {
	it("reads won, lost or no winner for the member", () => {
		expect(resultFor({ winnerId: "me" }, "me")).toBe("Won");
		expect(resultFor({ winnerId: "rival" }, "me")).toBe("Lost");
		expect(resultFor({ winnerId: null }, "me")).toBe("No winner");
	});
});

describe("savedMatchLine", () => {
	it("names the game, the result, the opponent and the finish date", async () => {
		const line = await savedMatchLine(client, room(), "me");
		expect(line).toBe("**Hangman** · Won · against <@rival> · <t:1792497600:D>");
	});

	it("labels a Dero bot seat by name instead of mentioning it, after the people", async () => {
		const line = await savedMatchLine(client, room({ game: "holdem", playerIds: ["me", "rival"], botSeats: 1, winnerId: "rival" }), "me");
		expect(line).toContain("Texas hold em");
		expect(line).toContain("Lost");
		expect(line).toContain("<@rival>, 🤖 **Dero Red**");
		expect(line).not.toContain("dero-bot-");
	});

	it("says a solo round was against Dero", async () => {
		const line = await savedMatchLine(client, room({ game: "solo-coinflip", playerIds: ["me"], winnerId: null }), "me");
		expect(line).toContain("Coin flip against Dero");
		expect(line).toContain("No winner");
		expect(line).toContain("against Dero");
	});
});

describe("showMatchHistory", () => {
	const target = { id: "me", bot: false, globalName: "Me", username: "me" } as unknown as User;
	function command(guildId: string | null = "guild-1") {
		return {
			guildId,
			client,
			guild: { members: { cache: new Map() } },
			deferred: false,
			replied: false,
			reply: vi.fn(async () => undefined),
			showModal: vi.fn(async () => undefined),
			deferReply: vi.fn(async () => undefined),
			editReply: vi.fn(async () => undefined),
		} as unknown as RepliableInteraction & { deferReply: ReturnType<typeof vi.fn>; editReply: ReturnType<typeof vi.fn>; showModal: ReturnType<typeof vi.fn> };
	}
	type Embed = { data: { title?: string; description?: string } };

	it("asks the store for the member's last ten in this guild, and lists them newest first as the store returns them", async () => {
		mocks.findByUserInGuild.mockResolvedValue([room({ roomId: "new", endedAt: new Date("2026-10-21T00:00:00Z") }), room({ roomId: "old" })]);
		const interaction = command();

		await showMatchHistory(interaction, target);

		expect(mocks.findByUserInGuild).toHaveBeenCalledExactlyOnceWith("guild-1", "me", MATCH_HISTORY_SHOWN);
		expect(MATCH_HISTORY_SHOWN).toBe(10);
		const embed = (interaction.editReply.mock.calls[0]![0] as { embeds: Embed[] }).embeds[0]!;
		expect(embed.data.title).toBe("📜 Me's match history");
		const lines = embed.data.description!.split("\n").filter((line) => line.startsWith("**"));
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("<t:1792540800:D>");
	});

	// A match the member never saved lists like any other, and one an older Save marked lists once.
	it("lists every finished match the store returns, saved or not", async () => {
		mocks.findByUserInGuild.mockResolvedValue([room({ roomId: "unsaved", savedBy: [] }), room({ roomId: "saved", savedBy: ["me"] })]);
		const interaction = command();

		await showMatchHistory(interaction, target);

		const embed = (interaction.editReply.mock.calls[0]![0] as { embeds: Embed[] }).embeds[0]!;
		expect(embed.data.description!.split("\n").filter((line) => line.startsWith("**"))).toHaveLength(2);
	});

	it("says so, and shows no list, when nothing has finished", async () => {
		const interaction = command();
		await showMatchHistory(interaction, target);
		const embed = (interaction.editReply.mock.calls[0]![0] as { embeds: Embed[] }).embeds[0]!;
		expect(embed.data.description).toContain("No finished matches yet");
	});

	it("answers a bot, or a command outside a server, with a notice and reads nothing", async () => {
		const bot = command();
		await showMatchHistory(bot, { ...target, bot: true } as User);
		const dm = command(null);
		await showMatchHistory(dm, target);
		expect(mocks.findByUserInGuild).not.toHaveBeenCalled();
		expect(bot.deferReply).not.toHaveBeenCalled();
		expect(bot.showModal).toHaveBeenCalledOnce();
		expect(dm.showModal).toHaveBeenCalledOnce();
	});

	it("posts the list in the commands channel, pinging the member, after a quiet acknowledgement, when the server has one", async () => {
		mocks.findByGuildId.mockResolvedValue({ commandOutputChannelId: "c-commands" });
		const send = vi.fn(async (_payload: unknown) => ({ id: "m-1" }));
		const commands = { id: "c-commands", isSendable: () => true, send };
		const fake: Record<string, unknown> = { ...command(), id: "int-1", user: { id: "me" }, isModalSubmit: () => false, client: { channels: { fetch: vi.fn(async () => commands) } } };
		// A slash command has no silent acknowledgement: a private defer, deleted at once.
		fake.isMessageComponent = () => false;
		fake.deferReply = vi.fn(async () => {
			fake.deferred = true;
		});
		fake.deleteReply = vi.fn(async () => undefined);
		const interaction = fake as unknown as ReturnType<typeof command>;

		await showMatchHistory(interaction, target);

		expect(interaction.showModal).not.toHaveBeenCalled();
		expect(interaction.deferReply).toHaveBeenCalledOnce();
		expect(fake.deleteReply).toHaveBeenCalledOnce();
		const posted = send.mock.calls[0]![0] as { content: string; embeds: Embed[]; allowedMentions: unknown };
		expect(posted.content).toBe("<@me>");
		expect(posted.allowedMentions).toEqual({ parse: [], users: ["me"] });
		expect(posted.embeds[0]!.data.description).toContain("No finished matches yet");
	});

	it("answers a failed read with the error line instead of throwing", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		mocks.findByUserInGuild.mockRejectedValue(new Error("db down"));
		const interaction = command();
		await expect(showMatchHistory(interaction, target)).resolves.toBeUndefined();
		expect((interaction.editReply.mock.calls[0]![0] as { content: string }).content).toContain("could not read");
	});
});
