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
// mocked: what is pinned is that the press reaches it, not what the card then does. The held
// slot offer (2026-10 item 263 R3-9) is the board's too: false is a free slot.
vi.mock("@features/game-rooms/challengeBoard.js", () => ({
	offerChallengeDraft: vi.fn(),
	offerToFreeSlot: vi.fn(async () => false),
	closeHeldDraft: vi.fn(async () => true),
	answerSoloRefusal: vi.fn(),
}));

import { buildHangmanCategoryStartRow, registerArcadeHostHandlers } from "./arcadeHost.js";
import { dispatchButton, dispatchModal, dispatchSelectMenu } from "@handlers/interactionRegistry.js";
import type { ModalSubmitInteraction } from "discord.js";
import { openSoloRoom } from "@features/game-rooms/soloRooms.js";
import { closeHeldDraft, offerChallengeDraft, offerToFreeSlot } from "@features/game-rooms/challengeBoard.js";
import { HANGMAN_CATEGORIES } from "./hangmanWords.js";

const openMock = openSoloRoom as unknown as ReturnType<typeof vi.fn>;
const draftMock = offerChallengeDraft as unknown as ReturnType<typeof vi.fn>;
const offerMock = offerToFreeSlot as unknown as ReturnType<typeof vi.fn>;
const closeMock = closeHeldDraft as unknown as ReturnType<typeof vi.fn>;

function makeSelect(values: string[]) {
	return {
		customId: "arcade_host:hcategory",
		values,
		isModalSubmit: () => false,
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
				isModalSubmit: () => false,
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

// ── a held slot never locks a member out (2026-10 item 263 R3-9) ──
describe("a solo start with the slot held", () => {
	function makeButton() {
		return {
			customId: "arcade_host:hangman",
			isModalSubmit: () => false,
			guild: { id: "guild-1", members: { cache: new Map([["member-1", { displayName: "Member" }]]) } },
			user: { id: "member-1", username: "member", globalName: "Member" },
			deferReply: vi.fn(async () => undefined),
			editReply: vi.fn(async () => undefined),
		};
	}

	it("answers at the press with the board's offer and opens nothing, so the offer can be a modal", async () => {
		offerMock.mockResolvedValueOnce(true);
		const interaction = makeButton();
		await dispatchButton(interaction as unknown as ButtonInteraction);

		expect(offerMock).toHaveBeenCalledWith(interaction, expect.any(Function));
		// The confirm's Submit names the solo room to open and the draft to close first.
		expect(offerMock.mock.calls[0][1]("draft-9")).toBe("arcade_host:replace:solo-hangman:draft-9");
		expect(interaction.deferReply).not.toHaveBeenCalled();
		expect(openMock).not.toHaveBeenCalled();
	});

	it("closes the held draft on the confirm's Submit, then opens the room without asking again", async () => {
		const submit = {
			customId: "arcade_host:replace:solo-hangman:draft-9:space",
			isModalSubmit: () => true,
			isFromMessage: () => true,
			deferUpdate: vi.fn(async () => undefined),
			guild: { id: "guild-1", members: { cache: new Map([["member-1", { displayName: "Member" }]]) } },
			user: { id: "member-1", username: "member", globalName: "Member" },
			deferReply: vi.fn(async () => undefined),
			editReply: vi.fn(async () => undefined),
		};
		await dispatchModal(submit as unknown as ModalSubmitInteraction);

		expect(closeMock).toHaveBeenCalledWith(submit.guild, "draft-9", "member-1");
		expect(offerMock).not.toHaveBeenCalled();
		expect(openMock).toHaveBeenCalledWith(submit.guild, "solo-hangman", expect.objectContaining({ userId: "member-1" }), { hangmanCategory: "space" });
		expect(closeMock.mock.invocationCallOrder[0]).toBeLessThan(openMock.mock.invocationCallOrder[0]);
	});

	it("opens nothing for a confirm naming a room no solo start opens", async () => {
		const submit = { customId: "arcade_host:replace:holdem:draft-9", isModalSubmit: () => true, guild: { id: "guild-1" }, user: { id: "member-1" } };
		await dispatchModal(submit as unknown as ModalSubmitInteraction);
		expect(closeMock).not.toHaveBeenCalled();
		expect(openMock).not.toHaveBeenCalled();
	});
});
