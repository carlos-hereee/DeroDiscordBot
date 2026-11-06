import { describe, it, expect, vi, beforeEach } from "vitest";
import { MessageFlags, type RepliableInteraction } from "discord.js";

// ── no member answer builds a channel (2026-11 item 289) ──
// A server with no 💬dero-commands stays without one until an admin adds it from its step card,
// and a member answer there stays private. The onDemandChannel fake stays here to fail these
// tests if a build ever comes back.

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

// A build used to run after the answer, through a lazy import; this gives a stray one its chance to show.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	vi.clearAllMocks();
	mocks.findByGuildId.mockResolvedValue({ commandOutputChannelId: null });
});

describe("a member answer on a server with no 💬dero-commands", () => {
	it("stays private and builds nothing", async () => {
		const asked = interaction();

		const place = await answerInChannel(asked, "member", { content: "your fortune" });
		await settle();

		expect(place).toEqual({ channelId: null });
		expect(asked.reply).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral }));
		expect(mocks.ensureOnDemandChannel).not.toHaveBeenCalled();
	});
});

describe("a member answer on a server with 💬dero-commands", () => {
	it("posts there and builds nothing", async () => {
		mocks.findByGuildId.mockResolvedValue({ commandOutputChannelId: "c-commands" });
		const send = vi.fn(async () => ({ id: "m" }));
		const channels = new Map([["c-commands", { id: "c-commands", isSendable: () => true, send }]]);

		await answerInChannel(interaction(channels), "member", { content: "x" });
		await settle();

		expect(send).toHaveBeenCalledTimes(1);
		expect(mocks.ensureOnDemandChannel).not.toHaveBeenCalled();
	});
});

describe("an admin answer with no channel", () => {
	it("stays private and builds nothing", async () => {
		mocks.findByGuildId.mockResolvedValue({ serverConfigChannelId: null });

		await expect(answerInChannel(interaction(), "admin", { content: "x" })).resolves.toEqual({ channelId: null });
		await settle();

		expect(mocks.ensureOnDemandChannel).not.toHaveBeenCalled();
	});
});
