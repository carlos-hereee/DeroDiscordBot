import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import type { StringSelectMenuInteraction } from "discord.js";

// ── the hangman category start on 🕹️games (2026-10 item 245 Phase 4a) ──────
// The select is the one new way into a solo room this phase adds, so what is pinned is
// its contract with soloRooms: the shelf the member picked reaches openSoloRoom, a value
// the bank does not know opens nothing, and the reply is private.
vi.mock("@features/game-rooms/soloRooms.js", () => ({
	openSoloRoom: vi.fn(),
	describeSoloOpenFailure: vi.fn(() => "refused"),
	readPrivateQuotaStatus: vi.fn(async () => null),
}));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn() } }));
vi.mock("./blackjackHandler.js", () => ({ startBlackjackTable: vi.fn() }));

import { buildHangmanCategoryStartRow, registerArcadeHostHandlers } from "./arcadeHost.js";
import { dispatchSelectMenu } from "@handlers/interactionRegistry.js";
import { openSoloRoom } from "@features/game-rooms/soloRooms.js";
import { HANGMAN_CATEGORIES } from "./hangmanWords.js";

const openMock = openSoloRoom as unknown as ReturnType<typeof vi.fn>;

function makeSelect(values: string[]) {
	return {
		customId: "arcade_host:hcategory",
		values,
		guild: { id: "guild-1", members: { cache: new Map([["member-1", { displayName: "Member" }]]) } },
		user: { id: "member-1", username: "member", globalName: "Member" },
		deferReply: vi.fn(async () => undefined),
		editReply: vi.fn(async () => undefined),
	};
}

beforeAll(() => {
	registerArcadeHostHandlers();
});

beforeEach(() => {
	vi.clearAllMocks();
	openMock.mockResolvedValue({ ok: true, room: { roomId: "room-1" }, channel: { id: "room-ch-1" } });
});

describe("the hangman category start", () => {
	it("offers every shelf of the word bank", () => {
		const select = buildHangmanCategoryStartRow("pick").toJSON().components[0] as { options: Array<{ value: string }> };
		expect(select.options.map((option) => option.value)).toEqual([...HANGMAN_CATEGORIES]);
	});

	it("opens a solo hangman room with the picked shelf and answers privately", async () => {
		const interaction = makeSelect(["space"]);
		await dispatchSelectMenu(interaction as unknown as StringSelectMenuInteraction);

		expect(interaction.deferReply).toHaveBeenCalledWith(expect.objectContaining({ flags: expect.any(Number) }));
		expect(openMock).toHaveBeenCalledWith(interaction.guild, "solo-hangman", expect.objectContaining({ userId: "member-1" }), { hangmanCategory: "space" });
		expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("room-ch-1") }));
	});

	it("opens nothing for a shelf the bank does not have", async () => {
		const interaction = makeSelect(["dragons"]);
		await dispatchSelectMenu(interaction as unknown as StringSelectMenuInteraction);

		expect(openMock).not.toHaveBeenCalled();
	});
});
