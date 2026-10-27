import { describe, it, expect, vi, beforeEach } from "vitest";
import { MessageFlags, type ButtonInteraction, type ModalSubmitInteraction } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({ gameRoomStore: { update: vi.fn(), findByRoomId: vi.fn(), setSecretField: vi.fn() } }));
vi.mock("./roomTrail.js", () => ({ roomTrail: { postMove: vi.fn() }, resolveRoomChannel: vi.fn() }));
vi.mock("./roomLifecycle.js", () => ({ roomLifecycle: { finish: vi.fn() } }));
vi.mock("@features/games/gameXp.js", () => ({ awardMultiPlayerResult: vi.fn() }));
vi.mock("@features/games/gamesAssets.js", () => ({ resolveGameAsset: vi.fn(() => null) }));
// A modal Submit's answer posts in 💬dero-commands through answerInChannel (2026-10 item 257
// Phase 5); where it lands is that helper's own suite, so here only WHAT is answered, and
// to whom, is under test.
vi.mock("@utils/answerInChannel.js", () => ({ answerInChannel: vi.fn(async () => ({ channelId: "c-commands" })) }));
// The gallows card's drawing is the shared board module's business and is covered with
// the channel game; here only WHEN a card is posted is under test.
vi.mock("@features/games/hangmanBoard.js", () => ({
	playingBoardPicture: vi.fn(async () => ({ embeds: [], files: [] })),
}));

import {
	hangmanRow,
	hangmanCategoryRow,
	openAuthoringModal,
	handleAuthoringModal,
	handleCategorySelect,
	startSoloHangmanRound,
	openGuessModal,
	handleGuessModal,
} from "./roomHangman.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { answerInChannel } from "@utils/answerInChannel.js";
import { roomTrail, resolveRoomChannel } from "./roomTrail.js";
import { playingBoardPicture } from "@features/games/hangmanBoard.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { GAME_ROOM_PREFIX, GAME_ROOM_SELECT_PREFIX, GAME_ROOM_MODAL_PREFIX } from "./gameRoomActions.js";
import { HANGMAN_CATEGORIES, HANGMAN_ENTRIES, HANGMAN_WORD_BANK } from "@features/games/hangmanWords.js";
import { HANGMAN_HINT_MAX } from "@features/games/hangmanAuthoring.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── roomHangman ──────────────────────────────────────────────────────
// What:  the Discord half of hosted hangman, both ends of it: the host authoring a
//        word, and everybody else guessing at it.
// Who:   the `gameroom:author` and `gameroom:move` buttons, and the two
//        `gameroomModal:` submits.
// When:  once per hosted room for the authoring half, every guess for the other.
// Where: the pure halves are covered elsewhere and thoroughly (hangmanAuthoring
//        validates, hangmanState decides what a guess did). What is covered HERE is
//        the wiring that applies them, which is where the module's own risk lives:
//        R12 says `secret.word` reaches Discord in exactly ONE place, and every
//        line that could break that promise is in this file rather than in the
//        pure ones.
// How:   drive the real handlers against a room row, with the store, the trail and
//        the lifecycle mocked out.
//
// ⚠️ BOTH DIRECTIONS ARE THE POINT, EVERYWHERE BELOW. A test that only proves the
// host is refused passes just as happily when EVERYONE is refused, which is a
// broken game that looks like a working guard. Every refusal case here is paired
// with the case that proves the door is still open to whoever should get through.
//
// ⚠️ THIS FILE EXISTS BECAUSE THE GATES DELETED CLEANLY. Before it, replacing the
// host-cannot-guess check with `if (false)` left the whole suite green. Every case
// below was mutation checked the same way rather than trusted for being green.

const HOST = "host-1";
const GUESSER = "guesser-1";
const WORD = "planet";
const HINT = "it goes around a star";

const storeMock = gameRoomStore as unknown as {
	update: ReturnType<typeof vi.fn>;
	findByRoomId: ReturnType<typeof vi.fn>;
	setSecretField: ReturnType<typeof vi.fn>;
};
const trailMock = roomTrail as unknown as { postMove: ReturnType<typeof vi.fn> };
const resolveChannelMock = resolveRoomChannel as unknown as ReturnType<typeof vi.fn>;
const boardMock = playingBoardPicture as unknown as ReturnType<typeof vi.fn>;

// The room channel the opener lives in and the gallows cards land in. Rebuilt per test
// so every assertion reads only what that test caused.
let openerEdit: ReturnType<typeof vi.fn>;
let channelSend: ReturnType<typeof vi.fn>;
let openerFetch: ReturnType<typeof vi.fn>;

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
			hint: HINT,
			extraHints: [],
			revealedHints: 0,
			authoredBy,
			guessedLetters: [],
			wrong: 0,
		},
	} as unknown as IGameRoom;
}

// A room BEFORE anybody has authored: the provisioner opens it with no secret at
// all, which is the state the authoring modal is reachable from.
function makeUnwordedRoom(overrides: Partial<IGameRoom> = {}): IGameRoom {
	return {
		roomId: "room-1",
		guildId: "guild-1",
		game: "hangman",
		status: "playing",
		hostId: HOST,
		playerIds: [HOST, GUESSER],
		channelId: "ch-1",
		openerMessageId: "opener-1",
		secret: null,
		...overrides,
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
		// A played guess only closes the modal (acknowledgeTextModal): the room's move line answers it.
		isFromMessage: () => true,
		deferUpdate: vi.fn().mockResolvedValue(undefined),
	} as unknown as ModalSubmitInteraction;
}

interface AuthorFields {
	word?: string;
	hint?: string;
	extraHints?: string;
}

// The authoring submit reads three fields BY NAME. They are spelled here exactly as
// `openAuthoringModal` spells them, which is the contract the two halves share.
function makeAuthorSubmit(
	userId: string,
	fields: AuthorFields = {},
	customId = `${GAME_ROOM_MODAL_PREFIX}:word:room-1`
): ModalSubmitInteraction {
	const values: Record<string, string> = {
		word: fields.word ?? WORD,
		hint: fields.hint ?? HINT,
		extraHints: fields.extraHints ?? "",
	};
	return {
		customId,
		guildId: "guild-1",
		user: { id: userId },
		client: {},
		fields: { getTextInputValue: (key: string) => values[key] ?? "" },
		reply: vi.fn().mockResolvedValue(undefined),
	} as unknown as ModalSubmitInteraction;
}

const replyOf = (interaction: { reply: unknown }) =>
	(interaction.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as { content: string; flags?: number };

// The answer a modal Submit gave through answerInChannel: who it was for and what it said.
const answerMock = answerInChannel as unknown as ReturnType<typeof vi.fn>;
const answerOf = (interaction: unknown) => {
	const call = answerMock.mock.calls.find((args) => args[0] === interaction);
	if (!call) throw new Error("the submit gave no answer through answerInChannel");
	return { audience: call[1] as string, content: (call[2] as { content: string }).content };
};

// What the store was asked to persist, which is the only place `authoredBy` is ever
// written and therefore the root of the guess gate covered further down.
const savedSecret = () => storeMock.update.mock.calls[0][2].secret as Record<string, unknown>;

// The modals a press opened, and the text of its notice: a refusal or a short answer now
// opens a notice modal instead of a private reply (2026-10 item 254 Phase 5b).
const shownModals = (interaction: { showModal: unknown }) =>
	(interaction.showModal as ReturnType<typeof vi.fn>).mock.calls.map((call) => (call[0] as { toJSON(): { custom_id: string; components: { content?: string }[] } }).toJSON());
const noticeText = (interaction: { showModal: unknown }): string =>
	shownModals(interaction)
		.filter((modal) => modal.custom_id.startsWith("notice:"))
		.flatMap((modal) => modal.components.map((component) => component.content ?? ""))
		.join("\n");
// True when every modal the press opened is a notice, so no form or game modal opened.
const onlyNoticesShown = (interaction: { showModal: unknown }): boolean => shownModals(interaction).every((modal) => modal.custom_id.startsWith("notice:"));

beforeEach(() => {
	vi.clearAllMocks();
	storeMock.update.mockResolvedValue(undefined);
	trailMock.postMove.mockResolvedValue(undefined);
	openerEdit = vi.fn().mockResolvedValue(undefined);
	channelSend = vi.fn().mockResolvedValue(undefined);
	openerFetch = vi.fn().mockResolvedValue({ edit: openerEdit });
	resolveChannelMock.mockResolvedValue({ messages: { fetch: openerFetch }, send: channelSend });
});

// ── the control contract ──────────────────────────────────────────────
// `hangmanRow` chooses which customId the primary button carries, and
// `gameRoomHandlers` routes on the action inside it. Those two are a pair that
// nothing else enforces, and a mismatch produces a button that is silently dead
// rather than one that errors, so it is worth pinning both sides.
describe("hangmanRow", () => {
	it("offers the AUTHOR action before a word exists", () => {
		const [primary] = hangmanRow({ roomId: "room-1" }, false).toJSON().components;

		expect(primary.custom_id).toBe(`${GAME_ROOM_PREFIX}:author:room-1`);
	});

	it("swaps to the MOVE action once a word exists, so the host cannot re-author", () => {
		const [primary] = hangmanRow({ roomId: "room-1" }, true).toJSON().components;

		expect(primary.custom_id).toBe(`${GAME_ROOM_PREFIX}:move:room-1`);
	});
});

describe("openAuthoringModal", () => {
	it("stamps the customId handleAuthoringModal actually parses", async () => {
		const interaction = makeButton(HOST);

		await openAuthoringModal(interaction, makeUnwordedRoom());

		const modal = (interaction.showModal as ReturnType<typeof vi.fn>).mock.calls[0][0];
		// A drifted action here is not an error, it is a submit that returns silently
		// on its first line and a host who thinks the modal broke.
		expect(modal.toJSON().custom_id).toBe(`${GAME_ROOM_MODAL_PREFIX}:word:room-1`);
	});

	it("carries the three fields the submit reads by name", async () => {
		const interaction = makeButton(HOST);

		await openAuthoringModal(interaction, makeUnwordedRoom());

		const modal = (interaction.showModal as ReturnType<typeof vi.fn>).mock.calls[0][0];
		const ids = modal.toJSON().components.flatMap((row: { components: { custom_id: string }[] }) =>
			row.components.map((input) => input.custom_id)
		);
		// getTextInputValue throws on a name that is not there, so a rename on one side
		// only takes down the submit, not the modal that opened it.
		expect(ids).toEqual(["word", "hint", "extraHints"]);
	});
});

// ── who may author ────────────────────────────────────────────────────
describe("handleAuthoringModal, the write gate", () => {
	it("refuses anybody who is not the host, and writes nothing", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeUnwordedRoom());
		const interaction = makeAuthorSubmit(GUESSER);

		await handleAuthoringModal(interaction);

		expect(answerOf(interaction).content).toBe(gameRoomsCopy.errors.notYours);
		expect(storeMock.update).not.toHaveBeenCalled();
	});

	// The room is already guessing at a word. Replacing it mid-round would invalidate
	// every letter played so far, with no way for the room to tell it happened.
	it("refuses a SECOND word on a room that already has one", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom());
		const interaction = makeAuthorSubmit(HOST, { word: "cattle" });

		await handleAuthoringModal(interaction);

		expect(answerOf(interaction).content).toBe(gameRoomsCopy.errors.notYours);
		expect(storeMock.update).not.toHaveBeenCalled();
	});

	it("refuses a room that is no longer playing", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeUnwordedRoom({ status: "finished" } as Partial<IGameRoom>));
		const interaction = makeAuthorSubmit(HOST);

		await handleAuthoringModal(interaction);

		expect(answerOf(interaction).content).toBe(gameRoomsCopy.errors.notFound);
		expect(storeMock.update).not.toHaveBeenCalled();
	});

	it("ignores a submit that is not its own, without even reading the room", async () => {
		await handleAuthoringModal(makeAuthorSubmit(HOST, {}, `${GAME_ROOM_MODAL_PREFIX}:guess:room-1`));

		expect(storeMock.findByRoomId).not.toHaveBeenCalled();
		expect(storeMock.update).not.toHaveBeenCalled();
	});

	it("lets the host through, so the refusals above are not refusing everyone", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeUnwordedRoom());

		await handleAuthoringModal(makeAuthorSubmit(HOST));

		expect(storeMock.update).toHaveBeenCalledOnce();
	});
});

// ── validation is actually REACHED ────────────────────────────────────
// hangmanAuthoring is covered exhaustively on its own. What is unproven without
// these is that this handler calls it at all and renders what it returns.
describe("handleAuthoringModal, validation wiring", () => {
	beforeEach(() => storeMock.findByRoomId.mockResolvedValue(makeUnwordedRoom()));

	it("writes nothing and posts nothing when the word is refused", async () => {
		await handleAuthoringModal(makeAuthorSubmit(HOST, { word: "ice cream" }));

		expect(storeMock.update).not.toHaveBeenCalled();
		expect(trailMock.postMove).not.toHaveBeenCalled();
	});

	// ⚠️ THE POINT OF REJECTION_COPY IS THAT A HOST IS TOLD WHAT TO FIX. Collapsing it
	// to one generic "invalid word" would leave every case below still refused and
	// still green, which is why this asserts the messages are DISTINCT rather than
	// merely present.
	//
	// ⚠️ AND IT COVERS EVERY REASON THE HANDLER CAN REACH, not a sample. A five case
	// version of this test was written first and a mutation collapsing ONE entry
	// survived it, because the two reasons that ended up sharing a message were not
	// both in the sample. A partial collapse is the realistic regression here (two
	// branches pointed at one string), so a partial sample is the wrong instrument.
	//
	// `wordDenied` is the one reason deliberately absent: reaching it means putting a
	// slur in this file, and the denylist itself is covered in hangmanAuthoring's own
	// suite where the constant lives.
	it("gives each rejection reason its own message", async () => {
		const longText = "x".repeat(HANGMAN_HINT_MAX + 1);
		const cases: [string, AuthorFields][] = [
			["wordMissing", { word: "" }],
			["wordNotLetters", { word: "ice cream" }],
			["wordTooShort", { word: "cat" }],
			["wordTooLong", { word: "abcdefghijklm" }],
			["wordTooFewDistinct", { word: "aaaa" }],
			["hintMissing", { hint: "" }],
			["hintTooLong", { hint: longText }],
			["tooManyExtraHints", { extraHints: "one1\ntwo2\nthree3\nfour4" }],
			["extraHintTooLong", { extraHints: longText }],
		];

		const seen = new Map<string, string>();
		for (const [reason, fields] of cases) {
			const interaction = makeAuthorSubmit(HOST, fields);
			await handleAuthoringModal(interaction);
			const message = answerOf(interaction).content;

			expect(message, `${reason} produced no message`).toBeTruthy();
			// Naming the collision beats a bare count: a failure here should say WHICH
			// two reasons a host can no longer tell apart.
			expect(seen.get(message), `${reason} shares its message with ${seen.get(message)}`).toBeUndefined();
			seen.set(message, reason);
		}

		expect(seen.size).toBe(cases.length);
	});

	// The hint is the host's to write, giveaways included, so a hint naming the word
	// or a piece of it is stored like any other.
	it.each([
		["the hint contains the word", `the answer is ${WORD}`],
		["a hint token is contained by the word", "plan"],
	])("accepts a hint when %s", async (_label, hint) => {
		await handleAuthoringModal(makeAuthorSubmit(HOST, { hint }));

		expect(storeMock.update).toHaveBeenCalledOnce();
		expect(savedSecret().hint).toBe(hint);
	});
});

// ── the round starts ──────────────────────────────────────────────────
// The provisioner's opener carries only the host's authoring button. Before this
// swap existed a word could be set and nobody but the host had a control.
describe("handleAuthoringModal, starting the round", () => {
	beforeEach(() => storeMock.findByRoomId.mockResolvedValue(makeUnwordedRoom()));

	it("swaps the pinned opener from the author button to the guess button", async () => {
		await handleAuthoringModal(makeAuthorSubmit(HOST));

		expect(openerFetch).toHaveBeenCalledWith("opener-1");
		expect(openerEdit).toHaveBeenCalledOnce();
		const { components } = openerEdit.mock.calls[0][0] as { components: { toJSON(): { components: { custom_id: string }[] } }[] };
		expect(components[0].toJSON().components[0].custom_id).toBe(`${GAME_ROOM_PREFIX}:move:room-1`);
	});

	it("posts the first gallows card for the new word, naming the author and not the word", async () => {
		await handleAuthoringModal(makeAuthorSubmit(HOST));

		expect(channelSend).toHaveBeenCalledOnce();
		const [state, description] = boardMock.mock.calls[0] as [{ wrong: number }, string];
		expect(state.wrong).toBe(0);
		expect(description).toBe(gameRoomsCopy.hangman.boardDescription(HOST));
		expect(description).not.toMatch(new RegExp(WORD, "i"));
	});

	it("still confirms to the host when the opener cannot be edited", async () => {
		openerFetch.mockRejectedValue(new Error("Unknown Message"));
		const interaction = makeAuthorSubmit(HOST);

		await handleAuthoringModal(interaction);

		expect(answerOf(interaction).content).toContain(HINT);
		expect(channelSend).toHaveBeenCalledOnce();
	});

	it("touches neither the opener nor the channel when the word is refused", async () => {
		await handleAuthoringModal(makeAuthorSubmit(HOST, { word: "ice cream" }));

		expect(openerEdit).not.toHaveBeenCalled();
		expect(channelSend).not.toHaveBeenCalled();
	});
});

// ── a card per guess ──────────────────────────────────────────────────
describe("handleGuessModal, the gallows card", () => {
	it("posts a card after a guess that leaves the round open", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom());

		await handleGuessModal(makeSubmit(GUESSER, "z"));

		expect(channelSend).toHaveBeenCalledOnce();
		const [state] = boardMock.mock.calls[0] as [{ wrong: number }];
		expect(state.wrong).toBe(1);
	});

	it("posts no playing card on the guess that ends the round, because the result card carries it", async () => {
		const room = makeRoom();
		(room.secret as { guessedLetters: string[] }).guessedLetters = ["p", "l", "a", "n", "e"];
		storeMock.findByRoomId.mockResolvedValue(room);

		await handleGuessModal(makeSubmit(GUESSER, "t"));

		expect(boardMock).not.toHaveBeenCalled();
		expect(channelSend).not.toHaveBeenCalled();
	});

	it("posts nothing for a refused guess", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom());

		await handleGuessModal(makeSubmit(HOST));

		expect(channelSend).not.toHaveBeenCalled();
	});

	// Post-launch plan item 3: the guess controls sit under the newest gallows, so a
	// guesser never scrolls back to the pinned opener to play.
	it("puts Guess and Give up on the new card and remembers it", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom());
		channelSend.mockResolvedValue({ id: "card-2" });

		await handleGuessModal(makeSubmit(GUESSER, "z"));

		const { components } = channelSend.mock.calls[0][0] as { components: { toJSON(): { components: { custom_id: string }[] } }[] };
		const ids = components[0].toJSON().components.map((button) => button.custom_id);
		expect(ids).toEqual([`${GAME_ROOM_PREFIX}:move:room-1`, `${GAME_ROOM_PREFIX}:forfeit:room-1`]);
		expect(storeMock.setSecretField).toHaveBeenCalledWith("guild-1", "room-1", "gallowsMessageId", "card-2");
	});

	it("takes the controls off the previous card, and only that one", async () => {
		const room = makeRoom();
		(room.secret as unknown as { gallowsMessageId?: string }).gallowsMessageId = "card-1";
		storeMock.findByRoomId.mockResolvedValue(room);
		channelSend.mockResolvedValue({ id: "card-2" });

		await handleGuessModal(makeSubmit(GUESSER, "z"));

		expect(openerFetch).toHaveBeenCalledWith("card-1");
		expect(openerEdit).toHaveBeenCalledWith({ components: [] });
	});

	it("takes the controls off the last card when the guess ends the round", async () => {
		const room = makeRoom();
		(room.secret as unknown as { guessedLetters: string[] }).guessedLetters = ["p", "l", "a", "n", "e"];
		(room.secret as unknown as { gallowsMessageId?: string }).gallowsMessageId = "card-5";
		storeMock.findByRoomId.mockResolvedValue(room);

		await handleGuessModal(makeSubmit(GUESSER, "t"));

		expect(channelSend).not.toHaveBeenCalled();
		expect(openerFetch).toHaveBeenCalledWith("card-5");
		expect(openerEdit).toHaveBeenCalledWith({ components: [] });
	});
});

// ── what acceptance actually stores and says ──────────────────────────
describe("handleAuthoringModal, acceptance", () => {
	beforeEach(() => storeMock.findByRoomId.mockResolvedValue(makeUnwordedRoom()));

	it("stores the normalised word, the author, and a zeroed round", async () => {
		await handleAuthoringModal(makeAuthorSubmit(HOST, { word: "  PLANET  " }));

		expect(savedSecret()).toMatchObject({
			word: WORD,
			hint: HINT,
			// ⚠️ THE FIELD THE GUESS GATE READS. Without it every host can guess their
			// own word and the gate covered below never fires, which is a silent
			// failure in a different file.
			authoredBy: HOST,
			revealedHints: 0,
			guessedLetters: [],
			wrong: 0,
		});
	});

	it("keeps the extra hints the host wrote, one per line, and drops the blanks", async () => {
		await handleAuthoringModal(makeAuthorSubmit(HOST, { extraHints: "orbits a sun\n\nnot a moon\n" }));

		expect(savedSecret().extraHints).toEqual(["orbits a sun", "not a moon"]);
	});

	// ⚠️ RISK R12, AND THIS IS THE ASSERTION THAT GUARDS IT. The word is in scope on
	// both of these lines and neither may render it: the confirmation echoes the
	// HINT back to a host who already knows the word, and the opener is a real
	// message in a channel the whole room can read.
	it("puts the word in NEITHER the host's confirmation nor the public opener", async () => {
		const interaction = makeAuthorSubmit(HOST);

		await handleAuthoringModal(interaction);

		const confirmation = answerOf(interaction);
		const opener = trailMock.postMove.mock.calls[0][2] as { text: string };

		expect(confirmation.content).toContain(HINT);
		expect(confirmation.content).not.toMatch(new RegExp(WORD, "i"));
		expect(opener.text).toContain(HINT);
		expect(opener.text).not.toMatch(new RegExp(WORD, "i"));
	});

	it("posts the confirmation in the commands channel, so the room does not watch the host author", async () => {
		const interaction = makeAuthorSubmit(HOST);

		await handleAuthoringModal(interaction);

		expect(answerOf(interaction).audience).toBe("member");
		expect(interaction.reply).not.toHaveBeenCalled();
	});
});

// ── the button ────────────────────────────────────────────────────────
describe("openGuessModal, the host gate", () => {
	it("refuses the author and never opens the modal", async () => {
		const interaction = makeButton(HOST);

		await openGuessModal(interaction, makeRoom());

		expect(noticeText(interaction)).toBe(gameRoomsCopy.hangman.hostCannotGuess);
		expect(onlyNoticesShown(interaction)).toBe(true);
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

		expect(answerOf(interaction).content).toBe(gameRoomsCopy.hangman.hostCannotGuess);
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

	it("closes a played guess's modal without a message of its own: the move line answers it", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom());
		const interaction = makeSubmit(GUESSER);

		await handleGuessModal(interaction);

		expect(interaction.deferUpdate).toHaveBeenCalledOnce();
		expect(interaction.reply).not.toHaveBeenCalled();
		expect(answerMock).not.toHaveBeenCalled();
	});
});

// ── the refusal ───────────────────────────────────────────────────────
// A public refusal would tell the room that the host just tried to guess, which is
// a small thing that reads badly in a channel whose whole product is the scroll.
describe("the refusal itself", () => {
	it("is ephemeral, so refusing the host does not announce it to the room", async () => {
		const interaction = makeButton(HOST);

		await openGuessModal(interaction, makeRoom());

		// A notice modal is shown only to the member who pressed, like an ephemeral reply.
		expect(noticeText(interaction)).toBe(gameRoomsCopy.hangman.hostCannotGuess);
		expect(interaction.reply).not.toHaveBeenCalled();
	});
});

// ⚠️ A "the refusal never carries the word" case was written here and DELETED,
// because it survived both mutations above and could not have failed: the refusal
// is a static copy string with no access to the word. The R12 property it was
// reaching for is already covered better by "writes nothing when it refuses",
// which proves no trail post happens at all. A test that cannot go red is the
// vacuous-guard antipattern this codebase has already been bitten by once.

// ── letting Dero pick (the 1.7.0 test fixes, item 12) ─────────────────
// The host's other way to start a round: a category select beside the authoring
// button. It must start the round through the SAME three steps the modal takes
// (secret, opener swap, first card), or guessers are left with no control again.
function makeCategorySelect(userId: string, value = "realm", customId = `${GAME_ROOM_SELECT_PREFIX}:hcategory:room-1`) {
	return {
		customId,
		guildId: "guild-1",
		user: { id: userId },
		client: {},
		values: [value],
		reply: vi.fn().mockResolvedValue(undefined),
	} as unknown as Parameters<typeof handleCategorySelect>[0];
}

describe("hangmanCategoryRow", () => {
	it("offers all ten categories on the customId handleCategorySelect parses", () => {
		const [select] = hangmanCategoryRow({ roomId: "room-1" }).toJSON().components as unknown as {
			custom_id: string;
			options: { value: string; label: string }[];
		}[];

		expect(select.custom_id).toBe(`${GAME_ROOM_SELECT_PREFIX}:hcategory:room-1`);
		expect(select.options.map((option) => option.value)).toEqual([...HANGMAN_CATEGORIES]);
		expect(select.options.find((option) => option.value === "realm")?.label).toBe("Dero's realm");
	});
});

describe("handleCategorySelect, the gate", () => {
	it("refuses anybody who is not the host, and writes nothing", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeUnwordedRoom());
		const interaction = makeCategorySelect(GUESSER);

		await handleCategorySelect(interaction);

		expect(replyOf(interaction).content).toBe(gameRoomsCopy.errors.notYours);
		expect(storeMock.update).not.toHaveBeenCalled();
	});

	it("refuses a room that already has its word", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom());
		const interaction = makeCategorySelect(HOST);

		await handleCategorySelect(interaction);

		expect(replyOf(interaction).content).toBe(gameRoomsCopy.hangman.wordAlreadySet);
		expect(storeMock.update).not.toHaveBeenCalled();
	});

	it("refuses a category the bank does not have", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeUnwordedRoom());

		await handleCategorySelect(makeCategorySelect(HOST, "weapons"));

		expect(storeMock.update).not.toHaveBeenCalled();
	});

	it("refuses a solo room, which seeds its own word", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeUnwordedRoom({ game: "solo-hangman" } as Partial<IGameRoom>));

		await handleCategorySelect(makeCategorySelect(HOST));

		expect(storeMock.update).not.toHaveBeenCalled();
	});
});

describe("handleCategorySelect, starting the round", () => {
	beforeEach(() => storeMock.findByRoomId.mockResolvedValue(makeUnwordedRoom()));

	it("stores a word and hint from the chosen shelf with NO author, so the host may guess", async () => {
		await handleCategorySelect(makeCategorySelect(HOST, "space"));

		const secret = savedSecret() as { word: string; hint: string; authoredBy: string | null };
		expect(HANGMAN_WORD_BANK.space).toContainEqual({ word: secret.word, hint: secret.hint });
		expect(secret.authoredBy).toBeNull();
	});

	it("swaps the opener to the guess button and posts the first gallows card", async () => {
		await handleCategorySelect(makeCategorySelect(HOST));

		const { components } = openerEdit.mock.calls[0][0] as { components: { toJSON(): { components: { custom_id: string }[] } }[] };
		// One row: the guess button replaces both the author button and this select.
		expect(components).toHaveLength(1);
		expect(components[0].toJSON().components[0].custom_id).toBe(`${GAME_ROOM_PREFIX}:move:room-1`);
		expect(channelSend).toHaveBeenCalledOnce();
		expect(boardMock.mock.calls[0][1]).toBe(gameRoomsCopy.hangman.boardDescription(null));
	});

	it("tells the host the shelf privately and the room the hint publicly, never the word", async () => {
		const interaction = makeCategorySelect(HOST, "realm");

		await handleCategorySelect(interaction);

		const { word, hint } = savedSecret() as { word: string; hint: string };
		const confirmation = replyOf(interaction);
		const opener = trailMock.postMove.mock.calls[0][2] as { text: string };
		expect(confirmation.flags).toBe(MessageFlags.Ephemeral);
		expect(confirmation.content).toBe(gameRoomsCopy.hangman.categoryPicked("Dero's realm"));
		expect(opener.text).toBe(gameRoomsCopy.hangman.categoryOpener(HOST, "Dero's realm", hint));
		expect(confirmation.content).not.toMatch(new RegExp(word, "i"));
		expect(opener.text).not.toMatch(new RegExp(`\b${word}\b`, "i"));
	});

	it("lets the host guess the word Dero picked", async () => {
		await handleCategorySelect(makeCategorySelect(HOST));
		const picked = makeRoom(null);
		(picked.secret as unknown as Record<string, unknown>).word = (savedSecret() as { word: string }).word;
		const interaction = makeButton(HOST);

		await openGuessModal(interaction, picked);

		expect(interaction.showModal).toHaveBeenCalledOnce();
	});
});

// ── the solo seed ─────────────────────────────────────────────────────
describe("startSoloHangmanRound", () => {
	const soloRoom = { guildId: "guild-1", roomId: "room-1", channelId: "ch-1", openerMessageId: "opener-1", hostId: HOST };

	it("stores a bank word WITH its hint and no author", async () => {
		await startSoloHangmanRound({} as never, soloRoom);

		const secret = savedSecret() as { word: string; hint: string; authoredBy: string | null };
		expect(HANGMAN_ENTRIES).toContainEqual(expect.objectContaining({ word: secret.word, hint: secret.hint }));
		expect(secret.hint.length).toBeGreaterThan(0);
		expect(secret.authoredBy).toBeNull();
	});

	it("shows the hint in the opening line and posts the first gallows card", async () => {
		await startSoloHangmanRound({} as never, soloRoom);

		const { hint } = savedSecret() as { hint: string };
		expect((trailMock.postMove.mock.calls[0][2] as { text: string }).text).toBe(gameRoomsCopy.hangman.soloOpener(hint));
		expect(channelSend).toHaveBeenCalledOnce();
		expect(boardMock.mock.calls[0][0]).toMatchObject({ wrong: 0 });
	});

	it("draws from the shelf the 🕹️games category start picked, and names the shelf, never the word", async () => {
		await startSoloHangmanRound({} as never, soloRoom, "animals");

		const secret = savedSecret() as { word: string; hint: string; authoredBy: string | null };
		expect(HANGMAN_WORD_BANK.animals).toContainEqual({ word: secret.word, hint: secret.hint });
		expect(secret.authoredBy).toBeNull();
		const opener = (trailMock.postMove.mock.calls[0][2] as { text: string }).text;
		expect(opener).toBe(gameRoomsCopy.hangman.soloCategoryOpener(gameRoomsCopy.hangman.categoryLabels.animals, secret.hint));
		expect(opener.toLowerCase()).not.toContain(secret.word);
	});
});
