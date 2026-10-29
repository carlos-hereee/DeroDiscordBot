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
	// The press check (2026-10 item 263): null lets the press go on to open the room.
	readSoloRefusalAtPress: vi.fn(async () => null),
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

// A solo Blackjack table's buy in at the press (2026-10 item 267); its wallet rules have their own suite.
const PAID_SEATS = { buyIn: 1000, userIds: ["member-1"], charged: true };
vi.mock("@features/game-rooms/holdemDraftBuyIn.js", () => ({ chargeSoloTable: vi.fn(async () => ({ ok: true, seats: PAID_SEATS })) }));

import { buildHangmanCategoryStartRow, registerArcadeHostHandlers } from "./arcadeHost.js";
import { chargeSoloTable } from "@features/game-rooms/holdemDraftBuyIn.js";
import { dispatchButton, dispatchModal, dispatchSelectMenu } from "@handlers/interactionRegistry.js";
import type { ModalSubmitInteraction } from "discord.js";
import { openSoloRoom, readSoloRefusalAtPress } from "@features/game-rooms/soloRooms.js";
import { closeHeldDraft, offerChallengeDraft, offerToFreeSlot } from "@features/game-rooms/challengeBoard.js";
import { HANGMAN_CATEGORIES } from "./hangmanWords.js";
import { gameRoomsCopy } from "@features/game-rooms/gameRoomsCopy.js";

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

		// The buy in taken at the press rides along, so the room's table holds it on its ledger.
		expect(openMock).toHaveBeenCalledWith(interaction.guild, "solo-blackjack", expect.objectContaining({ userId: "member-1" }), { blackjackSeats: PAID_SEATS });
		expect(draftMock).not.toHaveBeenCalled();
		expect(challengesSend).not.toHaveBeenCalled();
	});
});

// ── a solo Blackjack buy in the wallet cannot cover (2026-10 item 267) ──
describe("a solo blackjack press with a short wallet", () => {
	it("opens the refusal as a notice at the press, before any acknowledgement, and opens nothing", async () => {
		(chargeSoloTable as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, reason: gameRoomsCopy.holdem.notEnoughChips(1000) });
		const interaction = {
			id: "press-bj",
			customId: "arcade_host:blackjack",
			isModalSubmit: () => false,
			deferred: false,
			replied: false,
			guild: { id: "guild-1", members: { cache: new Map() } },
			user: { id: "member-1", username: "member", globalName: "Member" },
			showModal: vi.fn(async () => undefined),
			deferReply: vi.fn(async () => undefined),
			deferUpdate: vi.fn(async () => undefined),
		};
		openMock.mockClear();

		await dispatchButton(interaction as unknown as ButtonInteraction);

		expect(interaction.showModal).toHaveBeenCalledOnce();
		expect(JSON.stringify(interaction.showModal.mock.calls[0][0])).toContain("1,000");
		expect(interaction.deferReply).not.toHaveBeenCalled();
		expect(openMock).not.toHaveBeenCalled();
	});
});

// ── a refusal the press can read is a notice there (2026-10 item 263, owner rule 1) ──
describe("a solo start the server refuses", () => {
	it("opens the refusal as a notice at the press, before any acknowledgement, and opens nothing", async () => {
		(readSoloRefusalAtPress as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, reason: "guildFull" });
		const interaction = {
			id: "press-1",
			customId: "arcade_host:hangman",
			isModalSubmit: () => false,
			deferred: false,
			replied: false,
			guild: { id: "guild-1", members: { cache: new Map() } },
			user: { id: "member-1", username: "member", globalName: "Member" },
			showModal: vi.fn(async () => undefined),
			deferReply: vi.fn(async () => undefined),
			deferUpdate: vi.fn(async () => undefined),
		};
		await dispatchButton(interaction as unknown as ButtonInteraction);

		const modal = interaction.showModal.mock.calls[0]?.[0] as { toJSON(): { title: string; components: Array<{ content?: string }> } };
		expect(modal.toJSON().title).toBe(gameRoomsCopy.notices.room);
		expect(modal.toJSON().components[0]?.content).toBe("refused");
		expect(interaction.deferReply).not.toHaveBeenCalled();
		expect(interaction.deferUpdate).not.toHaveBeenCalled();
		expect(openMock).not.toHaveBeenCalled();
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
