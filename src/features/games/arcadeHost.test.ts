import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import type { ButtonInteraction, StringSelectMenuInteraction } from "discord.js";

// ── the hangman category start on 🕹️games (2026-10 item 245 Phase 4a) ──────
// The select is the one new way into a solo room this phase adds, so what is pinned is
// its contract with soloRooms: the shelf the member picked reaches openSoloRoom, a value
// the bank does not know opens nothing, and the reply is private.
vi.mock("@features/game-rooms/soloRooms.js", () => ({
	openSoloRoom: vi.fn(),
	describeSoloOpenFailure: vi.fn(() => "refused"),
	readPrivateQuotaStatus: vi.fn(async () => null),
}));
// The table's door is the challenge card (2026-10 item 254, Arcade 1), so the board is
// mocked: what is pinned is that the press reaches it, not what the card then does.
vi.mock("@features/game-rooms/challengeBoard.js", () => ({ offerChallengeDraft: vi.fn() }));

import { buildHangmanCategoryStartRow, registerArcadeHostHandlers } from "./arcadeHost.js";
import { dispatchButton, dispatchSelectMenu } from "@handlers/interactionRegistry.js";
import { openSoloRoom } from "@features/game-rooms/soloRooms.js";
import { offerChallengeDraft } from "@features/game-rooms/challengeBoard.js";
import { HANGMAN_CATEGORIES } from "./hangmanWords.js";

const openMock = openSoloRoom as unknown as ReturnType<typeof vi.fn>;
const draftMock = offerChallengeDraft as unknown as ReturnType<typeof vi.fn>;

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

// ── the host row (2026-10 item 254, Arcade 1): nothing is played in ⚔️challenges ──
describe("the host row", () => {
	function makeButton(choice: string) {
		const challengesSend = vi.fn();
		return {
			challengesSend,
			interaction: {
				customId: `arcade_host:${choice}`,
				guild: { id: "guild-1", members: { cache: new Map([["member-1", { displayName: "Member" }]]) }, channels: { fetch: vi.fn(async () => ({ send: challengesSend })) } },
				user: { id: "member-1", username: "member", globalName: "Member" },
				deferReply: vi.fn(async () => undefined),
				editReply: vi.fn(async () => undefined),
			},
		};
	}

	it("posts a multi seat table as a challenge card, the door every room game uses, and posts no table", async () => {
		const { interaction, challengesSend } = makeButton("blackjack-table");
		await dispatchButton(interaction as unknown as ButtonInteraction);

		expect(draftMock).toHaveBeenCalledWith(interaction, "blackjack");
		// offerChallengeDraft answers the press itself (its confirm), so the host row must not defer first.
		expect(interaction.deferReply).not.toHaveBeenCalled();
		expect(openMock).not.toHaveBeenCalled();
		expect(challengesSend).not.toHaveBeenCalled();
	});

	it("opens a table against Dero alone as a solo room with no card", async () => {
		const { interaction, challengesSend } = makeButton("blackjack");
		await dispatchButton(interaction as unknown as ButtonInteraction);

		expect(openMock).toHaveBeenCalledWith(interaction.guild, "solo-blackjack", expect.objectContaining({ userId: "member-1" }), {});
		expect(draftMock).not.toHaveBeenCalled();
		expect(challengesSend).not.toHaveBeenCalled();
	});
});
