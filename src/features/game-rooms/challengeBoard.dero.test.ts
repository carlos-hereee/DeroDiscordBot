import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ButtonInteraction, ModalSubmitInteraction } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({ gameRoomStore: { findByRoomId: vi.fn(), markArchived: vi.fn() } }));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn() } }));
vi.mock("./RoomProvisioner.js", () => ({ RoomProvisioner: { open: vi.fn() }, describeRoomOpenFailure: () => "nope" }));
vi.mock("./soloRooms.js", () => ({
	readPrivateQuotaStatus: vi.fn().mockResolvedValue(null),
	openSoloRoom: vi.fn(),
	describeSoloOpenFailure: () => "no room",
	soloLuckSlugFor: (play: { game: string }) => `solo-${play.game}`,
}));
vi.mock("./challengeCard.js", () => ({ cardStateFor: vi.fn(() => ({})), refreshCard: vi.fn(), editOpenerCard: vi.fn(), resolveChallengesChannel: vi.fn() }));

import { playDero, handleDeroThrowModal } from "./challengeBoard.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { openSoloRoom } from "./soloRooms.js";
import { cardStateFor } from "./challengeCard.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { GAME_ROOM_MODAL_PREFIX } from "./gameRoomActions.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── Play Dero instead (post-launch plan item 13) ─────────────────────
// A luck game's host plays one round against Dero from the challenge card. What is
// covered: which games offer it, that the draft frees the host's slot, that the round
// opens a solo room through soloRooms rather than playing in ⚔️challenges (2026-10 item
// 254, Arcade 1), and that the rps throw modal re-gates its submit.

const HOST = "host-1";
const storeMock = gameRoomStore as unknown as { findByRoomId: ReturnType<typeof vi.fn>; markArchived: ReturnType<typeof vi.fn> };
const soloMock = openSoloRoom as unknown as ReturnType<typeof vi.fn>;
const cardStateMock = cardStateFor as unknown as ReturnType<typeof vi.fn>;

function makeRoom(game: string, overrides: Partial<IGameRoom> = {}): IGameRoom {
	return { roomId: "room-1", guildId: "guild-1", game, hostId: HOST, status: "draft", visibility: "invite", spectatorIds: [], boardMessageId: null, ...overrides } as unknown as IGameRoom;
}

const GUILD = { id: "guild-1", members: { cache: new Map() } };

function makeButton(): ButtonInteraction {
	return {
		guildId: "guild-1",
		guild: GUILD,
		user: { id: HOST, username: "host" },
		reply: vi.fn().mockResolvedValue(undefined),
		deferReply: vi.fn().mockResolvedValue(undefined),
		editReply: vi.fn().mockResolvedValue(undefined),
		showModal: vi.fn().mockResolvedValue(undefined),
	} as unknown as ButtonInteraction;
}

function makeThrowSubmit(userId: string, values: string[]): ModalSubmitInteraction {
	return {
		customId: `${GAME_ROOM_MODAL_PREFIX}:dero:room-1`,
		guildId: "guild-1",
		guild: GUILD,
		user: { id: userId, username: "member" },
		fields: { getStringSelectValues: () => values },
		reply: vi.fn().mockResolvedValue(undefined),
		deferReply: vi.fn().mockResolvedValue(undefined),
		editReply: vi.fn().mockResolvedValue(undefined),
	} as unknown as ModalSubmitInteraction;
}

const replyText = (interaction: { reply: unknown }): string =>
	((interaction.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as { content: string }).content;

beforeEach(() => {
	vi.clearAllMocks();
	storeMock.markArchived.mockResolvedValue({});
	soloMock.mockResolvedValue({ ok: true, room: {}, channel: { id: "solo-room-1" } });
});

describe("playDero", () => {
	it.each(["coinflip", "diceroll"])("opens a %s round in a solo room, freeing the host's slot first", async (game) => {
		const interaction = makeButton();

		await playDero(interaction, makeRoom(game));

		expect(storeMock.markArchived).toHaveBeenCalledWith("guild-1", "room-1");
		expect(soloMock).toHaveBeenCalledWith(GUILD, `solo-${game}`, expect.objectContaining({ userId: HOST }), { luckPlay: { game } });
		// The draft must free the host's one room slot before the solo room claims it.
		expect(storeMock.markArchived.mock.invocationCallOrder[0]).toBeLessThan(soloMock.mock.invocationCallOrder[0]);
		// Answered privately with the room, and the card points at the room: nothing is
		// posted into ⚔️challenges but the card's own edit.
		expect(interaction.deferReply).toHaveBeenCalledWith(expect.objectContaining({ flags: expect.any(Number) }));
		expect(interaction.editReply).toHaveBeenCalledWith({ content: gameRoomsCopy.board.cardStarted("solo-room-1") });
		expect(cardStateMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ resultLine: gameRoomsCopy.board.cardPlayedDero(HOST, "solo-room-1") }));
		expect(interaction.reply).not.toHaveBeenCalled();
	});

	it("tells the host privately why when the solo room cannot open, and closes the card", async () => {
		soloMock.mockResolvedValue({ ok: false, reason: "guildFull" });
		const interaction = makeButton();

		await playDero(interaction, makeRoom("coinflip"));

		expect(interaction.editReply).toHaveBeenCalledWith({ embeds: [expect.anything()] });
		expect(cardStateMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ resultLine: gameRoomsCopy.board.cardDeroUnavailable(HOST) }));
	});

	it("asks for the rps throw in a modal, and changes nothing yet", async () => {
		const interaction = makeButton();

		await playDero(interaction, makeRoom("rps"));

		const modal = (interaction.showModal as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as { toJSON(): { custom_id: string } };
		expect(modal.toJSON().custom_id).toBe(`${GAME_ROOM_MODAL_PREFIX}:dero:room-1`);
		expect(storeMock.markArchived).not.toHaveBeenCalled();
		expect(soloMock).not.toHaveBeenCalled();
	});

	it("refuses a game with no solo round", async () => {
		const interaction = makeButton();

		await playDero(interaction, makeRoom("battleship"));

		expect(replyText(interaction)).toBe(gameRoomsCopy.errors.controlRetired);
		expect(storeMock.markArchived).not.toHaveBeenCalled();
	});
});

describe("handleDeroThrowModal", () => {
	it("plays the host's throw against Dero", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom("rps"));
		const interaction = makeThrowSubmit(HOST, ["paper"]);

		await handleDeroThrowModal(interaction);

		expect(storeMock.markArchived).toHaveBeenCalledOnce();
		expect(soloMock).toHaveBeenCalledWith(GUILD, "solo-rps", expect.objectContaining({ userId: HOST }), { luckPlay: { game: "rps", memberThrow: "paper" } });
	});

	// A modal submit is reachable without the button, so it re-checks the host.
	it("refuses anyone but the host", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom("rps"));
		const interaction = makeThrowSubmit("member-2", ["rock"]);

		await handleDeroThrowModal(interaction);

		expect(replyText(interaction)).toBe(gameRoomsCopy.board.onlyHostStarts);
		expect(soloMock).not.toHaveBeenCalled();
	});

	it("refuses a challenge that already closed", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom("rps", { status: "archived" }));
		const interaction = makeThrowSubmit(HOST, ["rock"]);

		await handleDeroThrowModal(interaction);

		expect(replyText(interaction)).toBe(gameRoomsCopy.board.draftGone);
		expect(soloMock).not.toHaveBeenCalled();
	});

	it("refuses a throw that is not one of the three", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom("rps"));
		const interaction = makeThrowSubmit(HOST, ["lizard"]);

		await handleDeroThrowModal(interaction);

		expect(soloMock).not.toHaveBeenCalled();
		expect(storeMock.markArchived).not.toHaveBeenCalled();
	});
});
