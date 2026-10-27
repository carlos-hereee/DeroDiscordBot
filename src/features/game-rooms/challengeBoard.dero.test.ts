import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ButtonInteraction } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({ gameRoomStore: { findByRoomId: vi.fn(), markArchived: vi.fn() } }));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn() } }));
vi.mock("./RoomProvisioner.js", () => ({ RoomProvisioner: { open: vi.fn() }, describeRoomOpenFailure: () => "nope" }));
vi.mock("./soloRooms.js", () => ({
	readPrivateQuotaStatus: vi.fn().mockResolvedValue(null),
	openSoloRoom: vi.fn(),
	describeSoloOpenFailure: () => "no room",
	soloLuckSlugFor: (game: string) => `solo-${game}`,
}));
vi.mock("./challengeCard.js", () => ({ cardStateFor: vi.fn(() => ({})), refreshCard: vi.fn(), editOpenerCard: vi.fn(), resolveChallengesChannel: vi.fn() }));

import { playDero } from "./challengeBoard.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { openSoloRoom } from "./soloRooms.js";
import { cardStateFor } from "./challengeCard.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── Play Dero instead (post-launch plan item 13) ─────────────────────
// A luck game's host plays one round against Dero from the challenge card. What is
// covered: which games offer it, that the draft frees the host's slot, that the round
// opens a solo room through soloRooms rather than playing in ⚔️challenges (2026-10 item
// 254, Arcade 1), and that rps asks nothing on the card, since its throw is asked in the
// room (2026-10 item 257 Phase 4b, soloLuckRoom).

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

// The modals a press opened, and the text of its notice: a refusal or a short answer now
// opens a notice modal instead of a private reply (2026-10 item 254 Phase 5b).
const shownModals = (interaction: { showModal: unknown }) =>
	(interaction.showModal as ReturnType<typeof vi.fn>).mock.calls.map((call) => (call[0] as { toJSON(): { custom_id: string; components: { content?: string }[] } }).toJSON());
const noticeText = (interaction: { showModal: unknown }): string =>
	shownModals(interaction)
		.filter((modal) => modal.custom_id.startsWith("notice:"))
		.flatMap((modal) => modal.components.map((component) => component.content ?? ""))
		.join("\n");

beforeEach(() => {
	vi.clearAllMocks();
	storeMock.markArchived.mockResolvedValue({});
	soloMock.mockResolvedValue({ ok: true, room: {}, channel: { id: "solo-room-1" } });
});

describe("playDero", () => {
	it.each(["coinflip", "diceroll", "rps"])("opens a %s round in a solo room, freeing the host's slot first", async (game) => {
		const interaction = makeButton();

		await playDero(interaction, makeRoom(game));

		expect(storeMock.markArchived).toHaveBeenCalledWith("guild-1", "room-1");
		expect(soloMock).toHaveBeenCalledWith(GUILD, `solo-${game}`, expect.objectContaining({ userId: HOST }));
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

	it("asks the rps host nothing on the card: the throw is asked in the room", async () => {
		const interaction = makeButton();

		await playDero(interaction, makeRoom("rps"));

		expect(interaction.showModal).not.toHaveBeenCalled();
	});

	it("refuses a game with no solo round", async () => {
		const interaction = makeButton();

		await playDero(interaction, makeRoom("battleship"));

		expect(noticeText(interaction)).toBe(gameRoomsCopy.errors.controlRetired);
		expect(storeMock.markArchived).not.toHaveBeenCalled();
	});
});
