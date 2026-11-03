import { describe, it, expect, vi, beforeEach } from "vitest";
import { EmbedBuilder, type Client } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({ gameRoomStore: { appendMove: vi.fn().mockResolvedValue({}) } }));

import { labelEmbedForRoom, labelForRoom } from "./satelliteRooms.js";
import { postMove } from "./roomTrail.js";

// ── Dero bots in a room's lines (2026-10 item 250 Phase 5) ──────────────────
// The one choke point every room line and table embed passes names a bot seat in every
// room, network or not, and a move made by a bot pings nobody: Discord refuses a whole
// send whose allowed mentions name an id that is not a snowflake.

const client = { channels: { fetch: vi.fn() }, users: { cache: new Map(), fetch: vi.fn().mockResolvedValue(null) } } as unknown as Client;

beforeEach(() => vi.clearAllMocks());

describe("labelling a room's lines", () => {
	it("names a bot at a server room, leaving members' mentions as they were", async () => {
		await expect(labelForRoom(client, { network: false }, "<@dero-bot-red> raises. <@123> folds.")).resolves.toBe("🤖 **Dero Red** raises. <@123> folds.");
	});

	it("names a bot in a table embed's description", async () => {
		const embed = await labelEmbedForRoom(client, { network: false }, new EmbedBuilder().setDescription("▶️ <@dero-bot-blue> (980)"));
		expect(embed.data.description).toBe("▶️ 🤖 **Dero Blue** (980)");
	});
});

describe("a bot's move on the trail", () => {
	it("is sent with no user in allowed mentions", async () => {
		const send = vi.fn().mockResolvedValue({});
		const channel = { send, isTextBased: () => true, isDMBased: () => false };
		(client.channels.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(channel);

		await postMove(client, { guildId: "g1", roomId: "r1", channelId: "c1" }, { actorId: "dero-bot-red", kind: "guess", text: "<@dero-bot-red> calls." });

		expect(send).toHaveBeenCalledWith({ content: "🤖 **Dero Red** calls.", allowedMentions: { users: [] } });
	});
});
