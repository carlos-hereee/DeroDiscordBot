import { describe, it, expect, vi, beforeEach } from "vitest";
import { MessageFlags, type RepliableInteraction } from "discord.js";

// ── 💬dero-commands, built by the first member answer that needs it (2026-11 item 285 Phase 3) ──
// A Headquarters only server has no 💬dero-commands. The first member answer starts its
// build through onDemandChannel and is answered privately, because a first build cannot fit
// in the three second window the channel is resolved in; the next answer finds the channel.

const mocks = vi.hoisted(() => ({ findByGuildId: vi.fn(), registerModal: vi.fn(), ensureOnDemandChannel: vi.fn() }));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findByGuildId } }));
vi.mock("@handlers/interactionRegistry.js", () => ({ registerModal: mocks.registerModal }));
vi.mock("@features/setup/onDemandChannel.js", () => ({ ensureOnDemandChannel: mocks.ensureOnDemandChannel }));

import { answerInChannel } from "./answerInChannel.js";

const guild = { id: "g-1" };

function interaction(channels: Map<string, unknown> = new Map()): RepliableInteraction & { reply: ReturnType<typeof vi.fn> } {
	return {
		id: "int-1",
		guildId: "g-1",
		guild,
		user: { id: "u-asker" },
		deferred: false,
		replied: false,
		client: { channels: { cache: channels, fetch: vi.fn(async (id: string) => channels.get(id) ?? null) } },
		reply: vi.fn(async () => undefined),
		followUp: vi.fn(async () => undefined),
		editReply: vi.fn(async () => undefined),
		deferReply: vi.fn(async () => undefined),
		deleteReply: vi.fn(async () => undefined),
		isModalSubmit: () => false,
		isMessageComponent: () => false,
	} as unknown as RepliableInteraction & { reply: ReturnType<typeof vi.fn> };
}

// The build runs after the answer, through a lazy import; this lets it settle.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	mocks.findByGuildId.mockResolvedValue({ commandOutputChannelId: null });
	mocks.ensureOnDemandChannel.mockResolvedValue({ id: "c-commands" });
});

describe("a member answer on a server with no 💬dero-commands", () => {
	it("starts the build and answers privately this once", async () => {
		const asked = interaction();
		const place = await answerInChannel(asked, "member", { content: "your fortune" });
		await settle();

		expect(mocks.ensureOnDemandChannel).toHaveBeenCalledWith(guild, "commandOutputChannelId");
		expect(place).toEqual({ channelId: null });
		expect(asked.reply).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral }));
	});

	it("never throws into the answer when the build fails", async () => {
		mocks.ensureOnDemandChannel.mockRejectedValue(new Error("50013"));
		await expect(answerInChannel(interaction(), "member", { content: "x" })).resolves.toEqual({ channelId: null });
		await settle();
	});
});

describe("what does not build it", () => {
	it("a server whose 💬dero-commands is stored", async () => {
		mocks.findByGuildId.mockResolvedValue({ commandOutputChannelId: "c-commands" });
		const channels = new Map([["c-commands", { id: "c-commands", isSendable: () => true, send: vi.fn(async () => ({ id: "m" })) }]]);
		await answerInChannel(interaction(channels), "member", { content: "x" });
		await settle();
		expect(mocks.ensureOnDemandChannel).not.toHaveBeenCalled();
	});

	it("an admin audience with no channel", async () => {
		mocks.findByGuildId.mockResolvedValue({ serverConfigChannelId: null });
		await answerInChannel(interaction(), "admin", { content: "x" });
		await settle();
		expect(mocks.ensureOnDemandChannel).not.toHaveBeenCalled();
	});
});
