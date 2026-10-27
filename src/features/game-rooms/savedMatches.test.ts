import { describe, it, expect, vi, beforeEach } from "vitest";
import { InteractionType, type Client, type ModalSubmitInteraction, type RepliableInteraction, type User } from "discord.js";

const mocks = vi.hoisted(() => ({ addSavedBy: vi.fn(), findSavedBy: vi.fn(), findByGuildId: vi.fn() }));
// The view posts in 💬dero-commands (2026-10 item 257 Phase 5). With no commands channel
// stored it answers privately, which is what most tests below read; one posts in the channel.
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findByGuildId } }));
vi.mock("@db/stores/gameRoomStore.js", () => ({ gameRoomStore: { addSavedBy: mocks.addSavedBy, findSavedBy: mocks.findSavedBy } }));

import { SAVED_MATCHES_SHOWN, archiveSaveSelect, canSaveMatch, resultFor, saveMatchIfChosen, savedMatchLine, showSavedMatches } from "./savedMatches.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── savedMatches (2026-10 item 257 Phase 3b) ─────────────────────────────────
// The archive confirm's save choice and /account view:saved. The store is mocked: what is
// pinned is who may save, what the list shows and how many rows it asks for.

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

const submitWith = (userId: string, values: string[]): ModalSubmitInteraction =>
	({ type: InteractionType.ModalSubmit, user: { id: userId }, fields: { getStringSelectValues: () => values } }) as unknown as ModalSubmitInteraction;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.addSavedBy.mockResolvedValue({});
	mocks.findSavedBy.mockResolvedValue([]);
	mocks.findByGuildId.mockResolvedValue(null);
});

describe("canSaveMatch", () => {
	it("allows a player of a finished match only", () => {
		expect(canSaveMatch(room(), "me")).toBe(true);
		expect(canSaveMatch(room(), "admin")).toBe(false);
		expect(canSaveMatch(room({ status: "playing" }), "me")).toBe(false);
		expect(canSaveMatch(room({ status: "archived" }), "me")).toBe(false);
	});
});

describe("archiveSaveSelect", () => {
	it("defaults to no, so an untouched Submit saves nothing", () => {
		const defaults = archiveSaveSelect().options.filter((option) => option.isDefault);
		expect(defaults.map((option) => option.value)).toEqual(["no"]);
	});
});

describe("saveMatchIfChosen", () => {
	it("adds the presser once, by the room, when they chose yes", async () => {
		await saveMatchIfChosen(submitWith("me", ["yes"]), room());
		expect(mocks.addSavedBy).toHaveBeenCalledExactlyOnceWith("guild-1", "room-1", "me");
	});

	it.each([
		["chose no", submitWith("me", ["no"]), room()],
		["answered nothing", submitWith("me", []), room()],
		["is not a player of the match", submitWith("admin", ["yes"]), room()],
		["pressed on a match still in play", submitWith("me", ["yes"]), room({ status: "playing" })],
	])("saves nothing when the presser %s", async (_label, interaction, target) => {
		await saveMatchIfChosen(interaction, target);
		expect(mocks.addSavedBy).not.toHaveBeenCalled();
	});

	it("logs and carries on when the write fails, so the archive after it still runs", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
		mocks.addSavedBy.mockRejectedValue(new Error("db down"));
		await expect(saveMatchIfChosen(submitWith("me", ["yes"]), room())).resolves.toBeUndefined();
		expect(logged).toHaveBeenCalled();
	});
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

describe("showSavedMatches", () => {
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
		mocks.findSavedBy.mockResolvedValue([room({ roomId: "new", endedAt: new Date("2026-10-21T00:00:00Z") }), room({ roomId: "old" })]);
		const interaction = command();

		await showSavedMatches(interaction, target);

		expect(mocks.findSavedBy).toHaveBeenCalledExactlyOnceWith("guild-1", "me", SAVED_MATCHES_SHOWN);
		expect(SAVED_MATCHES_SHOWN).toBe(10);
		const embed = (interaction.editReply.mock.calls[0]![0] as { embeds: Embed[] }).embeds[0]!;
		expect(embed.data.title).toBe("📌 Me's saved matches");
		const lines = embed.data.description!.split("\n").filter((line) => line.startsWith("**"));
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("<t:1792540800:D>");
	});

	it("says so, and shows no list, when nothing is saved", async () => {
		const interaction = command();
		await showSavedMatches(interaction, target);
		const embed = (interaction.editReply.mock.calls[0]![0] as { embeds: Embed[] }).embeds[0]!;
		expect(embed.data.description).toContain("No saved matches yet");
	});

	it("answers a bot, or a command outside a server, with a notice and reads nothing", async () => {
		const bot = command();
		await showSavedMatches(bot, { ...target, bot: true } as User);
		const dm = command(null);
		await showSavedMatches(dm, target);
		expect(mocks.findSavedBy).not.toHaveBeenCalled();
		expect(bot.deferReply).not.toHaveBeenCalled();
		expect(bot.showModal).toHaveBeenCalledOnce();
		expect(dm.showModal).toHaveBeenCalledOnce();
	});

	it("posts the list in the commands channel, naming the member without a ping, when the server has one", async () => {
		mocks.findByGuildId.mockResolvedValue({ commandOutputChannelId: "c-commands" });
		const send = vi.fn(async (_payload: unknown) => ({ id: "m-1" }));
		const commands = { id: "c-commands", isSendable: () => true, send };
		const fake: Record<string, unknown> = { ...command(), id: "int-1", user: { id: "me" }, isModalSubmit: () => false, client: { channels: { fetch: vi.fn(async () => commands) } } };
		// As discord.js does: an opened modal is the interaction's one answer.
		fake.showModal = vi.fn(async () => {
			fake.replied = true;
		});
		const interaction = fake as unknown as ReturnType<typeof command>;

		await showSavedMatches(interaction, target);

		expect(interaction.showModal).toHaveBeenCalledOnce();
		expect(interaction.deferReply).not.toHaveBeenCalled();
		const posted = send.mock.calls[0]![0] as { content: string; embeds: Embed[]; allowedMentions: unknown };
		expect(posted.content).toBe("<@me>");
		expect(posted.allowedMentions).toEqual({ parse: [] });
		expect(posted.embeds[0]!.data.description).toContain("No saved matches yet");
	});

	it("answers a failed read with the error line instead of throwing", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		mocks.findSavedBy.mockRejectedValue(new Error("db down"));
		const interaction = command();
		await expect(showSavedMatches(interaction, target)).resolves.toBeUndefined();
		expect((interaction.editReply.mock.calls[0]![0] as { content: string }).content).toContain("could not read");
	});
});
