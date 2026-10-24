import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ButtonInteraction, ModalSubmitInteraction } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({ gameRoomStore: { findByRoomId: vi.fn(), markArchived: vi.fn() } }));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn() } }));
vi.mock("./RoomProvisioner.js", () => ({ RoomProvisioner: { open: vi.fn() }, describeRoomOpenFailure: () => "nope" }));
vi.mock("./soloRooms.js", () => ({ readPrivateQuotaStatus: vi.fn().mockResolvedValue(null) }));
vi.mock("@features/games/soloLuck.js", () => ({ playSoloLuck: vi.fn() }));

import { playDero, handleDeroThrowModal } from "./challengeBoard.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { playSoloLuck } from "@features/games/soloLuck.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { GAME_ROOM_MODAL_PREFIX } from "./gameRoomActions.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── Play Dero instead (post-launch plan item 13) ─────────────────────
// A luck game's host plays one round against Dero from the challenge card. What is
// covered: which games offer it, that the draft frees the host's slot, that the ONE
// solo round (soloLuck) plays it, and that the rps throw modal re-gates its submit.

const HOST = "host-1";
const storeMock = gameRoomStore as unknown as { findByRoomId: ReturnType<typeof vi.fn>; markArchived: ReturnType<typeof vi.fn> };
const soloMock = playSoloLuck as unknown as ReturnType<typeof vi.fn>;

function makeRoom(game: string, overrides: Partial<IGameRoom> = {}): IGameRoom {
	return { roomId: "room-1", guildId: "guild-1", game, hostId: HOST, status: "draft", visibility: "invite", spectatorIds: [], boardMessageId: null, ...overrides } as unknown as IGameRoom;
}

function makeButton(): ButtonInteraction {
	return {
		guildId: "guild-1",
		guild: { id: "guild-1" },
		user: { id: HOST },
		reply: vi.fn().mockResolvedValue(undefined),
		showModal: vi.fn().mockResolvedValue(undefined),
	} as unknown as ButtonInteraction;
}

function makeThrowSubmit(userId: string, values: string[]): ModalSubmitInteraction {
	return {
		customId: `${GAME_ROOM_MODAL_PREFIX}:dero:room-1`,
		guildId: "guild-1",
		guild: { id: "guild-1" },
		user: { id: userId },
		fields: { getStringSelectValues: () => values },
		reply: vi.fn().mockResolvedValue(undefined),
	} as unknown as ModalSubmitInteraction;
}

const replyText = (interaction: { reply: unknown }): string =>
	((interaction.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as { content: string }).content;

beforeEach(() => {
	vi.clearAllMocks();
	storeMock.markArchived.mockResolvedValue({});
	soloMock.mockResolvedValue(undefined);
});

describe("playDero", () => {
	it.each(["coinflip", "diceroll"])("plays a %s round at once and frees the host's slot first", async (game) => {
		const interaction = makeButton();

		await playDero(interaction, makeRoom(game));

		expect(storeMock.markArchived).toHaveBeenCalledWith("guild-1", "room-1");
		expect(soloMock).toHaveBeenCalledWith(interaction, { game });
		expect(storeMock.markArchived.mock.invocationCallOrder[0]).toBeLessThan(soloMock.mock.invocationCallOrder[0]);
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
		expect(soloMock).toHaveBeenCalledWith(interaction, { game: "rps", memberThrow: "paper" });
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
