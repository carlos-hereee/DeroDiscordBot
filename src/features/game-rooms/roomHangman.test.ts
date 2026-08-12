import { describe, it, expect, vi, beforeEach } from "vitest";
import { MessageFlags, type ButtonInteraction, type ModalSubmitInteraction } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({ gameRoomStore: { update: vi.fn(), findByRoomId: vi.fn() } }));
vi.mock("./roomTrail.js", () => ({ roomTrail: { postMove: vi.fn() } }));
vi.mock("./roomLifecycle.js", () => ({ roomLifecycle: { finish: vi.fn() } }));
vi.mock("@features/games/gameXp.js", () => ({ awardMultiPlayerResult: vi.fn() }));
vi.mock("@features/games/gamesAssets.js", () => ({ resolveGameAsset: vi.fn(() => null) }));

import { openGuessModal, handleGuessModal } from "./roomHangman.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { roomTrail } from "./roomTrail.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { GAME_ROOM_MODAL_PREFIX } from "./gameRoomActions.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── roomHangman, the host gate ───────────────────────────────────────
// What:  pins "the host does not guess their own word" at BOTH places it is
//        enforced, and pins that everyone else still gets through.
// Who:   the `gameroom:move` button (openGuessModal) and the `gameroomModal:guess`
//        submit (handleGuessModal).
// When:  every guess, for the whole life of a hosted round.
// Where: this gate is the difference between a game and a host solving their own
//        puzzle, and until this file existed nothing asserted it. Deleting the
//        check outright left the full suite green, which is how it got written.
// How:   drive the two real handlers against a rehydrated room row, once as the
//        author and once as a guesser.
//
// ⚠️ BOTH DIRECTIONS ARE THE POINT. A test that only proves the host is refused
// passes just as happily when EVERYONE is refused, which is a broken game that
// looks like a working guard. The refusal cases below are each paired with the
// guesser case that proves the door is still open.

const HOST = "host-1";
const GUESSER = "guesser-1";
const WORD = "planet";

const storeMock = gameRoomStore as unknown as {
	update: ReturnType<typeof vi.fn>;
	findByRoomId: ReturnType<typeof vi.fn>;
};
const trailMock = roomTrail as unknown as { postMove: ReturnType<typeof vi.fn> };

// A room mid-round: the host has authored, nobody has guessed yet. `authoredBy` is
// what the gate reads, and it is written by the authoring modal in real life.
function makeRoom(authoredBy: string | null = HOST): IGameRoom {
	return {
		roomId: "room-1",
		guildId: "guild-1",
		game: "hangman",
		status: "playing",
		hostId: HOST,
		playerIds: [HOST, GUESSER],
		channelId: "ch-1",
		secret: {
			word: WORD,
			hint: "it goes around a star",
			extraHints: [],
			revealedHints: 0,
			authoredBy,
			guessedLetters: [],
			wrong: 0,
		},
	} as unknown as IGameRoom;
}

function makeButton(userId: string): ButtonInteraction {
	return {
		guildId: "guild-1",
		user: { id: userId },
		client: {},
		reply: vi.fn().mockResolvedValue(undefined),
		showModal: vi.fn().mockResolvedValue(undefined),
	} as unknown as ButtonInteraction;
}

// "p" is a HIT that does not solve "planet", which keeps the happy path away from
// the win branch and its lifecycle and XP calls. The gate is what is under test,
// not the ending.
function makeSubmit(userId: string, letter = "p"): ModalSubmitInteraction {
	return {
		customId: `${GAME_ROOM_MODAL_PREFIX}:guess:room-1`,
		guildId: "guild-1",
		user: { id: userId },
		client: {},
		guild: { members: { cache: { get: () => undefined } } },
		fields: { getTextInputValue: (key: string) => (key === "letter" ? letter : "") },
		reply: vi.fn().mockResolvedValue(undefined),
	} as unknown as ModalSubmitInteraction;
}

const replyOf = (interaction: { reply: unknown }) =>
	(interaction.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as { content: string; flags?: number };

beforeEach(() => {
	vi.clearAllMocks();
	storeMock.update.mockResolvedValue(undefined);
	trailMock.postMove.mockResolvedValue(undefined);
});

// ── the button ────────────────────────────────────────────────────────
describe("openGuessModal, the host gate", () => {
	it("refuses the author and never opens the modal", async () => {
		const interaction = makeButton(HOST);

		await openGuessModal(interaction, makeRoom());

		expect(replyOf(interaction).content).toBe(gameRoomsCopy.hangman.hostCannotGuess);
		expect(interaction.showModal).not.toHaveBeenCalled();
	});

	it("opens the modal for anybody who is not the author", async () => {
		const interaction = makeButton(GUESSER);

		await openGuessModal(interaction, makeRoom());

		expect(interaction.showModal).toHaveBeenCalledOnce();
		expect(interaction.reply).not.toHaveBeenCalled();
	});
});

// ── the modal submit ──────────────────────────────────────────────────
// Re-gated on purpose: a modal submit is reachable without the button that opened
// it, so a host who never sees the button can still post the payload by hand.
describe("handleGuessModal, the host gate", () => {
	it("refuses the author even though the button already refused them", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom());
		const interaction = makeSubmit(HOST);

		await handleGuessModal(interaction);

		expect(replyOf(interaction).content).toBe(gameRoomsCopy.hangman.hostCannotGuess);
	});

	it("writes nothing when it refuses, so a refused guess cannot burn a letter", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom());

		await handleGuessModal(makeSubmit(HOST));

		expect(storeMock.update).not.toHaveBeenCalled();
		expect(trailMock.postMove).not.toHaveBeenCalled();
	});

	it("lets a guesser through, so the refusal is the host's and not everyone's", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom());

		await handleGuessModal(makeSubmit(GUESSER));

		expect(storeMock.update).toHaveBeenCalledOnce();
		expect(trailMock.postMove).toHaveBeenCalledOnce();
	});
});

// ── the refusal ───────────────────────────────────────────────────────
// A public refusal would tell the room that the host just tried to guess, which is
// a small thing that reads badly in a channel whose whole product is the scroll.
describe("the refusal itself", () => {
	it("is ephemeral, so refusing the host does not announce it to the room", async () => {
		const interaction = makeButton(HOST);

		await openGuessModal(interaction, makeRoom());

		expect(replyOf(interaction).flags).toBe(MessageFlags.Ephemeral);
	});
});

// ⚠️ A "the refusal never carries the word" case was written here and DELETED,
// because it survived both mutations above and could not have failed: the refusal
// is a static copy string with no access to the word. The R12 property it was
// reaching for is already covered better by "writes nothing when it refuses",
// which proves no trail post happens at all. A test that cannot go red is the
// vacuous-guard antipattern this codebase has already been bitten by once.
