import { describe, it, expect, vi, beforeEach } from "vitest";
import { MessageFlags, SlashCommandSubcommandBuilder, type ChatInputCommandInteraction } from "discord.js";

// ── /platform verse (2026-10 item 257 Phase 3b) ─────────────────────────────
// Pins the owner gate, as /platform analytics does: the counts span every server, so only
// CREATOR_DISCORD_ID may read them, an unset id refuses everyone, and the answer is always
// ephemeral. Nothing here may post to a channel.

const owner = vi.hoisted(() => ({ id: "900000000000000001" }));
vi.mock("@utils/config.js", () => ({
	get creatorId() {
		return owner.id;
	},
}));
vi.mock("./verseProgress.js", () => ({ buildVerseProgress: vi.fn() }));

import { buildVerseProgress, type VerseProgress } from "./verseProgress.js";
import { addVerseSubcommand, runVerseSubcommand } from "./verseSubcommand.js";

const buildMock = vi.mocked(buildVerseProgress);

const PROGRESS: VerseProgress = {
	players: 12,
	monthlyActivePlayers: 5,
	servers: { setUp: 3, onNetwork: 1 },
	gamesCompleted: { total: 7, byGame: [{ game: "hangman", count: 7 }] },
	coins: { total: 400, thisMonth: 40 },
};

function fakeInteraction(userId: string) {
	const reply = vi.fn(async () => undefined);
	const deferReply = vi.fn(async () => undefined);
	const editReply = vi.fn(async () => undefined);
	const send = vi.fn();
	const interaction = { user: { id: userId }, reply, deferReply, editReply, channel: { send } } as unknown as ChatInputCommandInteraction;
	return { interaction, reply, deferReply, editReply, send };
}

beforeEach(() => {
	owner.id = "900000000000000001";
	buildMock.mockReset();
	buildMock.mockResolvedValue(PROGRESS);
});

describe("/platform verse", () => {
	it("refuses a member who is not the platform owner, ephemerally, reading nothing", async () => {
		const { interaction, reply } = fakeInteraction("123");

		await runVerseSubcommand(interaction);

		expect(reply).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral }));
		expect(buildMock).not.toHaveBeenCalled();
	});

	it("refuses everyone when CREATOR_DISCORD_ID is unset, even an empty user id", async () => {
		owner.id = "";
		const { interaction, reply } = fakeInteraction("");

		await runVerseSubcommand(interaction);

		expect(reply).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral }));
		expect(buildMock).not.toHaveBeenCalled();
	});

	it("answers the owner ephemerally with the four counts, and posts nowhere", async () => {
		const { interaction, deferReply, editReply, send } = fakeInteraction(owner.id);

		await runVerseSubcommand(interaction);

		expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
		const description = (editReply.mock.calls[0]![0] as { embeds: Array<{ data: { description: string } }> }).embeds[0]!.data.description;
		expect(description).toContain("**Players:** 12 (5 active in the last 30 days)");
		expect(description).toContain("**Servers:** 3 set up, 1 on the network");
		expect(description).toContain("**Games completed:** 7");
		expect(description).toContain("**Dero coins collected:** 400 in total, 40 this month (UTC)");
		expect(send).not.toHaveBeenCalled();
	});

	it("answers an honest error, still ephemeral, when the read fails", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		buildMock.mockRejectedValueOnce(new Error("Atlas down"));
		const { interaction, deferReply, editReply } = fakeInteraction(owner.id);

		await runVerseSubcommand(interaction);

		expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
		expect(editReply).toHaveBeenCalledTimes(1);
	});

	it("registers as the verse subcommand with no options", () => {
		const json = addVerseSubcommand(new SlashCommandSubcommandBuilder()).toJSON();
		expect(json.name).toBe("verse");
		expect(json.options ?? []).toHaveLength(0);
	});
});
