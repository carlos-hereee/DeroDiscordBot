import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ModalBuilder,
	StringSelectMenuBuilder,
	TextInputBuilder,
	TextInputStyle,
	type ButtonInteraction,
	type Client,
	type ModalSubmitInteraction,
	type StringSelectMenuInteraction,
} from "discord.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import {
	validateHangmanAuthoring,
	splitExtraHints,
	HANGMAN_WORD_MAX,
	HANGMAN_HINT_MAX,
	type HangmanAuthoringRejection,
} from "@features/games/hangmanAuthoring.js";
import {
	createHangmanState,
	applyGuess,
	maskedWord,
	wrongLetters,
	remainingAttempts,
	type HangmanGuess,
	type HangmanState,
} from "@features/games/hangmanState.js";
import { awardMultiPlayerResult } from "@features/games/gameXp.js";
import { resolveGameAsset } from "@features/games/gamesAssets.js";
import { hangmanCardView, renderHangmanCard } from "@features/games/hangmanRenderer.js";
import { playingBoardPicture } from "@features/games/hangmanBoard.js";
import {
	HANGMAN_CATEGORIES,
	isHangmanCategory,
	pickWord,
	pickWordFromCategory,
	type HangmanCategory,
	type PickedHangmanWord,
} from "@features/games/hangmanWords.js";
import { withRenderFallback } from "@features/renderer/index.js";
import { roomTrail, resolveRoomChannel, type RoomMoveInput } from "./roomTrail.js";
import { postTurnBoard } from "./turnBoard.js";
import { turnBlockLines } from "./turnLog.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { hangmanOutcome } from "./matchOutcome.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { GAME_ROOM_PREFIX, GAME_ROOM_SELECT_PREFIX, GAME_ROOM_MODAL_PREFIX } from "./gameRoomActions.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import type { RoomSecret } from "./roomTypes.js";
import { answerInChannel } from "@utils/answerInChannel.js";
import { acknowledgeTextModal, showNotice } from "@utils/textModal.js";

// ── roomHangman ──────────────────────────────────────────────────────
// What:  hangman played inside a room: the host authors a word behind a modal or
//        lets Dero draw one from a category, and every letter anyone plays becomes
//        its own attributed message.
// Who:   the `gameroom:move` button (guess), the `gameroom:author` button (set the
//        word), the `gameroomSelect:hcategory` select (Dero picks), the two
//        `gameroomModal:` submits, and RoomProvisioner's solo seed.
// When:  once per room, from the host's first press to the result card.
// Where: the ROOM ROW carries the word. It is written once, read on every guess,
//        and rendered exactly once, in the result card. Nothing else in this file
//        may put it in an embed, a customId, a log line or a move.
// How:   the pure halves do the thinking. hangmanAuthoring validates, hangmanState
//        decides what a guess did, and this file only translates between them and
//        Discord.
//
// ⚠️ RISK R12, AND IT IS THE WHOLE POINT OF THE FEATURE. `secret.word` reaches
// Discord in exactly ONE place: the result line, posted after the round is over.
// Search this file for `.word` and every hit should be a write into a secret
// (the modal's validated word, a bank pick) or that render. Anything else means
// the word is leaking.

// The room as the round's start needs it: where to write, where to post, and the
// pinned opener to swap. A subset of IGameRoom so the provisioner can start a solo
// round from the ids it holds without re-reading the row it just wrote.
type HangmanRoomRef = Pick<IGameRoom, "guildId" | "roomId" | "channelId" | "openerMessageId" | "hostId">;

// The round's live state is rebuilt from the row on every interaction rather than
// cached in a Map, because a Map is what died on every Railway deploy in the old
// handler. `guessed` is persisted as a plain array on the secret and rehydrated
// into the Set the pure module wants.
interface HangmanSecret extends RoomSecret {
	guessedLetters?: string[];
	wrong?: number;
	// The newest gallows card, the one carrying the guess controls (post-launch plan
	// item 3). Kept so the next card can take the controls off it.
	gallowsMessageId?: string | null;
}

function rehydrate(room: Pick<IGameRoom, "secret">): HangmanState | null {
	const secret = room.secret as HangmanSecret | null;
	if (!secret?.word) return null;

	const state = createHangmanState(secret.word, {
		hints: secret.extraHints ?? [],
		authoredBy: secret.authoredBy ?? null,
	});
	for (const letter of secret.guessedLetters ?? []) state.guessed.add(letter);
	state.wrong = secret.wrong ?? 0;
	state.revealedHints = secret.revealedHints ?? 0;
	// Status is derived, never stored: two sources for "is this round over" is two
	// things to disagree, and the room's own status already answers it for everything
	// outside this module.
	if (state.wrong >= 6) state.status = "lost";
	return state;
}

// ── saving a guess (2026-10 item 276, audit P1-6) ─────────────────────
// A guess is a compare and swap on the round as it was read: the letters guessed and the misses.
// Every guess that counts adds a letter, so the count of guessed letters is the round's version,
// and two guesses read from one row cannot both land; the old unconditional write let the second
// erase the first (a miss forgotten, a revealed letter hidden again). Only the three fields a
// guess moves are written, so the gallows card id the last guess's card claimed is never put back
// (gameRoomStore.setSecretFieldsIf). The store also refuses a room that is no longer playing, so a
// guess read before a give up or a solving letter finished the round writes nothing.
// `$size` needs the array to exist, and every round starts through startRoomHangmanRound, which
// writes `guessedLetters: []`.
const roundVersion = (room: Pick<IGameRoom, "secret">): Record<string, unknown> => {
	const secret = room.secret as HangmanSecret;
	return { "secret.guessedLetters": { $size: (secret.guessedLetters ?? []).length }, "secret.wrong": secret.wrong ?? 0 };
};

// A guess the round took, on the row as written, or the answer for one it did not take.
type GuessLanding =
	| { landed: true; room: IGameRoom; state: HangmanState; outcome: Extract<HangmanGuess, { status: "hit" | "miss" }> }
	| { landed: false; answer: string };

// Reads beyond the first, when another guess landed between the read and the write: one re-read
// plays the letter on top of that guess, and a second loss answers busy rather than spinning.
const GUESS_RETRIES = 1;

/**
 * Apply one letter to the round and save it, re-reading once when another guess won the write.
 * A letter the re-read round no longer takes (guessed meanwhile, the round over) answers the way a
 * first read would. The one path a guess is saved through.
 */
async function landGuess(read: IGameRoom, letter: string, userId: string): Promise<GuessLanding> {
	let room: IGameRoom | null = read;
	for (let attempt = 0; attempt <= GUESS_RETRIES; attempt++) {
		if (attempt > 0) room = await gameRoomStore.findByRoomId(read.guildId, read.roomId);
		if (!room || room.status !== "playing") return { landed: false, answer: gameRoomsCopy.hangman.closed };
		const state = rehydrate(room);
		if (!state) return { landed: false, answer: gameRoomsCopy.hangman.waitingForWord(room.hostId) };
		// Re-gated: a modal submit is reachable without the button that opened it.
		if (state.authoredBy && state.authoredBy === userId) return { landed: false, answer: gameRoomsCopy.hangman.hostCannotGuess };

		const outcome = applyGuess(state, letter);
		// The three no-cost outcomes stay OUT OF THE ROOM. A "that is not a letter" there per
		// fat-fingered submit would bury the actual game in noise, and none of them changed
		// the round, so they post where it was pressed (2026-10 item 257 Phase 5).
		if (outcome.status === "invalid") return { landed: false, answer: gameRoomsCopy.hangman.invalid };
		if (outcome.status === "repeat") return { landed: false, answer: gameRoomsCopy.hangman.repeat(outcome.letter) };
		if (outcome.status === "closed") return { landed: false, answer: gameRoomsCopy.hangman.closed };

		const written = await gameRoomStore.setSecretFieldsIf(room.guildId, room.roomId, roundVersion(room), {
			guessedLetters: [...state.guessed],
			wrong: state.wrong,
			revealedHints: state.revealedHints,
		});
		if (written) return { landed: true, room: written, state, outcome };
	}
	// The board's own busy words: nothing landed, and the guesser can simply submit again.
	return { landed: false, answer: gameRoomsCopy.monopoly.boardBusy };
}

// ── the controls ──────────────────────────────────────────────────────
// Two rows over the room's life: before a word exists only the host can act, and
// after it exists only everyone else can.
export function hangmanRow(room: Pick<IGameRoom, "roomId">, hasWord: boolean): ActionRowBuilder<ButtonBuilder> {
	const primary = hasWord
		? new ButtonBuilder()
				.setCustomId(`${GAME_ROOM_PREFIX}:move:${room.roomId}`)
				.setLabel(gameRoomsCopy.hangman.guessButtonLabel)
				.setEmoji("🔤")
				.setStyle(ButtonStyle.Primary)
		: new ButtonBuilder()
				.setCustomId(`${GAME_ROOM_PREFIX}:author:${room.roomId}`)
				.setLabel(gameRoomsCopy.hangman.authorButtonLabel)
				.setEmoji("✍️")
				.setStyle(ButtonStyle.Primary);

	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		primary,
		new ButtonBuilder()
			.setCustomId(`${GAME_ROOM_PREFIX}:forfeit:${room.roomId}`)
			.setLabel("Give up")
			.setStyle(ButtonStyle.Secondary)
	);
}

// The host's other way to start: let Dero draw a word from one of the bank's ten
// categories. Its own row because Discord gives a select menu a whole action row to
// itself, so it sits directly under the authoring button. Rides the opener only
// until a word exists: swapOpenerToGuessing replaces both rows with the guess row.
export function hangmanCategoryRow(room: Pick<IGameRoom, "roomId">): ActionRowBuilder<StringSelectMenuBuilder> {
	const labels = gameRoomsCopy.hangman.categoryLabels;
	return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
		new StringSelectMenuBuilder()
			.setCustomId(`${GAME_ROOM_SELECT_PREFIX}:hcategory:${room.roomId}`)
			.setPlaceholder(gameRoomsCopy.hangman.categoryPlaceholder)
			.setMinValues(1)
			.setMaxValues(1)
			.addOptions(HANGMAN_CATEGORIES.map((category) => ({ label: labels[category], value: category })))
	);
}

// ── authoring ─────────────────────────────────────────────────────────
export async function openAuthoringModal(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	const modal = new ModalBuilder()
		.setCustomId(`${GAME_ROOM_MODAL_PREFIX}:word:${room.roomId}`)
		.setTitle(gameRoomsCopy.hangman.modalTitle)
		.addComponents(
			new ActionRowBuilder<TextInputBuilder>().addComponents(
				new TextInputBuilder()
					.setCustomId("word")
					.setLabel(gameRoomsCopy.hangman.wordLabel)
					.setPlaceholder(gameRoomsCopy.hangman.wordPlaceholder)
					.setStyle(TextInputStyle.Short)
					.setMaxLength(HANGMAN_WORD_MAX)
					.setRequired(true)
			),
			new ActionRowBuilder<TextInputBuilder>().addComponents(
				new TextInputBuilder()
					.setCustomId("hint")
					.setLabel(gameRoomsCopy.hangman.hintLabel)
					.setPlaceholder(gameRoomsCopy.hangman.hintPlaceholder)
					.setStyle(TextInputStyle.Short)
					.setMaxLength(HANGMAN_HINT_MAX)
					.setRequired(true)
			),
			new ActionRowBuilder<TextInputBuilder>().addComponents(
				new TextInputBuilder()
					.setCustomId("extraHints")
					.setLabel(gameRoomsCopy.hangman.extraHintsLabel)
					.setPlaceholder(gameRoomsCopy.hangman.extraHintsPlaceholder)
					.setStyle(TextInputStyle.Paragraph)
					.setRequired(false)
			)
		);

	await interaction.showModal(modal);
}

// One message per rejection reason, so a host is told what to fix rather than that
// something was wrong. None of these carries the word (R12).
const REJECTION_COPY: Record<HangmanAuthoringRejection, string> = {
	wordMissing: "You need to write a word.",
	wordNotLetters: "Letters A to Z only. No spaces, digits, accents or punctuation, because the mask would show them.",
	wordTooShort: "That word is too short. Use at least 4 letters.",
	wordTooLong: `That word is too long. Use at most ${HANGMAN_WORD_MAX} letters.`,
	wordTooFewDistinct: "That word repeats too few letters to be a game. Use at least 3 different ones.",
	wordDenied: "Pick a different word. A half revealed version of that one would read badly on the board.",
	hintMissing: "A hint is required. The room is playing your word, not reading your mind.",
	hintTooLong: `Keep the hint under ${HANGMAN_HINT_MAX} characters.`,
	tooManyExtraHints: "Three extra hints at most, one per line.",
	extraHintTooLong: `Keep each extra hint under ${HANGMAN_HINT_MAX} characters.`,
};

// The word modal's answers post where it was pressed (2026-10 item 257 Phase 5): a modal Submit
// cannot open a notice. None of them carries the word, only a refusal or the hint.
export async function handleAuthoringModal(interaction: ModalSubmitInteraction): Promise<void> {
	const [prefix, action, roomId] = interaction.customId.split(":");
	if (prefix !== GAME_ROOM_MODAL_PREFIX || action !== "word" || !roomId) return;

	const guildId = interaction.guildId;
	if (!guildId) return;

	const room = await gameRoomStore.findByRoomId(guildId, roomId);
	if (!room || room.status !== "playing") {
		await answerInChannel(interaction, "here", { content: gameRoomsCopy.errors.notFound });
		return;
	}
	// Only the host sets the word, and only once. A second submit would replace a
	// word the room has already been guessing at.
	if (room.hostId !== interaction.user.id || (room.secret as HangmanSecret | null)?.word) {
		await answerInChannel(interaction, "here", { content: gameRoomsCopy.errors.notYours });
		return;
	}

	const result = validateHangmanAuthoring(
		interaction.fields.getTextInputValue("word"),
		interaction.fields.getTextInputValue("hint"),
		splitExtraHints(interaction.fields.getTextInputValue("extraHints"))
	);

	if (!result.ok) {
		await answerInChannel(interaction, "here", { content: REJECTION_COPY[result.reason] });
		return;
	}

	const secret: HangmanSecret = {
		word: result.word,
		hint: result.hint,
		extraHints: result.extraHints,
		revealedHints: 0,
		authoredBy: interaction.user.id,
		guessedLetters: [],
		wrong: 0,
	};

	await startRoomHangmanRound(
		interaction.client,
		room,
		secret,
		{ actorId: interaction.user.id, text: gameRoomsCopy.hangman.opener(interaction.user.id, result.hint) },
		// ⚠️ THE HINT, NEVER THE WORD. The host knows the word already; echoing it buys
		// nothing and puts it one mis-click from a public channel.
		() => answerInChannel(interaction, "here", { content: gameRoomsCopy.hangman.authored(result.hint, result.extraHints.length) })
	);
}

// ── letting Dero pick ─────────────────────────────────────────────────
// The category select's submit (the 1.7.0 test fixes, item 12). Dero draws a random
// word and its hint from the chosen shelf, and the round starts through the same
// path the modal uses. authoredBy stays null, which is what lets the host past the
// host-cannot-guess gate: they never saw this word.
export async function handleCategorySelect(interaction: StringSelectMenuInteraction): Promise<void> {
	const [prefix, action, roomId] = interaction.customId.split(":");
	if (prefix !== GAME_ROOM_SELECT_PREFIX || action !== "hcategory" || !roomId) return;

	const guildId = interaction.guildId;
	if (!guildId) return;

	// Guild scoped like every room read (invariant 2): the roomId rides a customId
	// anyone can replay.
	const room = await gameRoomStore.findByRoomId(guildId, roomId);
	if (!room || room.status !== "playing" || room.game !== "hangman") {
		await showNotice(interaction, { title: gameRoomsCopy.notices.hangman, sections: [gameRoomsCopy.errors.notFound] });
		return;
	}
	// Re-gated here: the router does not gate selects, and a select's customId and
	// values are user input whoever built the menu. Host only, like the modal.
	if (room.hostId !== interaction.user.id) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.hangman, sections: [gameRoomsCopy.errors.notYours] });
		return;
	}
	if ((room.secret as HangmanSecret | null)?.word) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.hangman, sections: [gameRoomsCopy.hangman.wordAlreadySet] });
		return;
	}

	const category = interaction.values[0] ?? "";
	if (!isHangmanCategory(category)) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.hangman, sections: [gameRoomsCopy.errors.notFound] });
		return;
	}

	const pick = pickWordFromCategory(category);
	const label = gameRoomsCopy.hangman.categoryLabels[category];
	await startRoomHangmanRound(
		interaction.client,
		room,
		bankSecret(pick),
		{ actorId: interaction.user.id, text: gameRoomsCopy.hangman.categoryOpener(interaction.user.id, label, pick.hint) },
		// Which shelf Dero drew from is an answer (owner rule 1, 2026-10 item 263 R3-11), so it
		// posts where it was pressed like the authoring modal's own answer, and names no word.
		() => answerInChannel(interaction, "here", { content: gameRoomsCopy.hangman.categoryPicked(label) })
	);
}

/**
 * Seed a SOLO hangman room with a word and hint from the bank and start it: from the
 * whole bank, or from one shelf when the member picked it at the 🕹️games category
 * start (2026-10 item 245 Phase 4a). Called once by RoomProvisioner right after the
 * opener is posted. The host is the guesser, which a bank word's null author allows.
 */
export async function startSoloHangmanRound(client: Client, room: HangmanRoomRef, category?: HangmanCategory): Promise<void> {
	const pick = category ? pickWordFromCategory(category) : pickWord();
	await startRoomHangmanRound(client, room, bankSecret(pick), {
		actorId: room.hostId,
		text: category
			? gameRoomsCopy.hangman.soloCategoryOpener(gameRoomsCopy.hangman.categoryLabels[category], pick.hint)
			: gameRoomsCopy.hangman.soloOpener(pick.hint),
	});
}

// A secret for a word Dero drew from the bank: its hint, no extra hints, and no
// author, so nobody is barred from guessing.
function bankSecret(pick: PickedHangmanWord): HangmanSecret {
	return {
		word: pick.word,
		hint: pick.hint,
		extraHints: [],
		revealedHints: 0,
		authoredBy: null,
		guessedLetters: [],
		wrong: 0,
	};
}

// ── starting the round ────────────────────────────────────────────────
/**
 * Store the round's word, then make the room playable. THE ONE PATH every room
 * hangman round starts through: the host's modal, the category select and the solo
 * seed all call it, so none of them can forget a step and leave guessers without a
 * control again.
 *
 * ① write the secret (the only write of a word), ② acknowledge the person who
 * started it, if anyone did, ③ post the public line with the hint, ④ swap the
 * pinned opener to the guess button, ⑤ post the first gallows card. Steps ④ and ⑤
 * are cosmetic and swallow their own failures, because the word is already stored.
 */
async function startRoomHangmanRound(
	client: Client,
	room: HangmanRoomRef,
	secret: HangmanSecret,
	announcement: { actorId: string; text: string },
	acknowledge?: () => Promise<unknown>
): Promise<void> {
	await gameRoomStore.update(room.guildId, room.roomId, { secret: secret as never });
	if (acknowledge) await acknowledge();

	// Text only; the two steps after it are what actually let anyone play.
	await roomTrail.postMove(client, room, { actorId: announcement.actorId, kind: "system", text: announcement.text });

	await swapOpenerToGuessing(client, room);
	const state = rehydrate({ secret });
	if (state) await postGallowsCard(client, room, state, null);
}

// The pinned opener the provisioner posted still carries the host's authoring
// button and the category select, which have nothing left to do once a word exists,
// and they are the only controls in the channel. Without this edit the guessers have
// no way to play. A solo opener already carries the guess button, so there the edit
// is a harmless repeat. Fire and forget after the primary write (house rule 7): the
// word is stored, so a failed edit is logged rather than thrown back at the host.
async function swapOpenerToGuessing(client: Client, room: HangmanRoomRef): Promise<void> {
	if (!room.openerMessageId) return;
	try {
		const channel = await resolveRoomChannel(client, room.channelId);
		if (!channel) return;
		const opener = await channel.messages.fetch(room.openerMessageId);
		// Components only: an edit that names no files keeps the opener's logo and embed.
		await opener.edit({ components: [hangmanRow(room, true)] });
	} catch (error) {
		console.warn("[game-rooms] could not swap the hangman opener to the guess button", { roomId: room.roomId, error });
	}
}

// ── the gallows card ──────────────────────────────────────────────────
// A guess is a turn (2026-10 item 263 R3-29): a new gallows card after the word is set
// and after every guess, drawn by the same boardPicture the channel game uses, posted
// through the shared turn board with the guess (and the hint it earned) in its This
// turn block. Those lines are recorded once the card is posted and never also posted
// as lines of their own (risk R6). The round's last guess posts its card too, with no
// controls, under which the result line and the result card follow. Cosmetic, so a
// failure is logged and swallowed: the row is the truth and the next guess draws again.
//
// ⚠️ THE GUESS CONTROLS RIDE THE NEWEST CARD (post-launch plan item 3). The pinned
// opener sits above every move, so a guesser used to scroll back up past the whole
// round to press Guess. Each card carries the row under its own picture, and the card
// before it gives the row up and stays as that guess's record, so the only live
// controls in the scroll are the ones directly under the gallows the room is looking
// at. The opener keeps its row too: it is the pinned way back in for anyone arriving late.
async function postGallowsCard(
	client: Client,
	room: Pick<IGameRoom, "guildId" | "roomId" | "channelId">,
	state: HangmanState,
	previousCardId: string | null,
	turn: { moves: readonly RoomMoveInput[]; roundOver: boolean } = { moves: [], roundOver: false }
): Promise<void> {
	try {
		const channel = await resolveRoomChannel(client, room.channelId);
		if (!channel) return;
		const block = turnBlockLines(turn.moves.map((move) => move.text));
		const description = [gameRoomsCopy.hangman.boardDescription(state.authoredBy), ...(block.length > 0 ? ["", ...block] : [])].join("\n");
		const picture = await playingBoardPicture(state, description);
		await postTurnBoard(channel, room, previousCardId, { ...picture, components: turn.roundOver ? [] : [hangmanRow(room, true)] }, { carried: turn.moves, boardField: "gallowsMessageId" });
	} catch (error) {
		console.warn("[game-rooms] could not post the hangman gallows card", { roomId: room.roomId, error });
	}
}

// ── guessing ──────────────────────────────────────────────────────────
export async function openGuessModal(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	const state = rehydrate(room);
	if (!state) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.hangman, sections: [gameRoomsCopy.hangman.waitingForWord(room.hostId)] });
		return;
	}

	// ⚠️ THE HOST DOES NOT GUESS, and it is refused here as well as being said on the
	// opener card. A host guessing their own word is the obvious exploit and the
	// obvious complaint, and hiding the button would only be a suggestion.
	if (state.authoredBy && state.authoredBy === interaction.user.id) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.hangman, sections: [gameRoomsCopy.hangman.hostCannotGuess] });
		return;
	}

	const modal = new ModalBuilder()
		.setCustomId(`${GAME_ROOM_MODAL_PREFIX}:guess:${room.roomId}`)
		.setTitle(gameRoomsCopy.hangman.guessModalTitle)
		.addComponents(
			new ActionRowBuilder<TextInputBuilder>().addComponents(
				new TextInputBuilder()
					.setCustomId("letter")
					.setLabel(gameRoomsCopy.hangman.guessLabel)
					.setStyle(TextInputStyle.Short)
					.setMaxLength(1)
					.setRequired(true)
			)
		);

	await interaction.showModal(modal);
}

export async function handleGuessModal(interaction: ModalSubmitInteraction): Promise<void> {
	const [prefix, action, roomId] = interaction.customId.split(":");
	if (prefix !== GAME_ROOM_MODAL_PREFIX || action !== "guess" || !roomId) return;

	const guildId = interaction.guildId;
	if (!guildId) return;

	const read = await gameRoomStore.findByRoomId(guildId, roomId);
	if (!read) {
		await answerInChannel(interaction, "here", { content: gameRoomsCopy.hangman.closed });
		return;
	}
	const landing = await landGuess(read, interaction.fields.getTextInputValue("letter"), interaction.user.id);
	if (!landing.landed) {
		await answerInChannel(interaction, "here", { content: landing.answer });
		return;
	}
	const { room, state, outcome } = landing;

	// The guess's own gallows card below IS the answer, so the Submit only closes
	// (2026-10 item 257 Phase 5, replacing a private "You played" line).
	await acknowledgeTextModal(interaction);

	const mask = maskedWord(state);
	const remaining = remainingAttempts(state);

	// ⚠️ A NEW MESSAGE PER GUESS, never an edit of an older one, and a move never carries a
	// file of its own (R8). The scroll IS the history, which is the entire reason this game
	// earns a room: each guess's card shows the gallows it left and, in its This turn block,
	// the guess and the hint it earned (2026-10 item 263 R3-29).
	const moves: RoomMoveInput[] = [
		{
			actorId: interaction.user.id,
			kind: "guess",
			text:
				outcome.status === "hit"
					? gameRoomsCopy.hangman.hit(interaction.user.id, outcome.letter, mask, remaining)
					: gameRoomsCopy.hangman.miss(interaction.user.id, outcome.letter, mask, wrongLetters(state), remaining),
			meta: { letter: outcome.letter, hit: outcome.status === "hit", wrong: state.wrong },
		},
	];
	// A hint reveal is its OWN line, so scrolling the room shows when it was earned rather
	// than making a reader infer it from the miss count.
	if (outcome.status === "miss" && outcome.revealedHint) {
		moves.push({ actorId: interaction.user.id, kind: "hint", text: gameRoomsCopy.hangman.hintRevealed(outcome.revealedHint) });
	}

	const won = outcome.status === "hit" && outcome.solved;
	const lost = outcome.status === "miss" && outcome.lost;
	const previousCardId = (room.secret as HangmanSecret).gallowsMessageId ?? null;
	// The round's last guess is a turn like any other and posts its card, with no Guess or
	// Give up left on it since the round is over.
	await postGallowsCard(interaction.client, room, state, previousCardId, { moves, roundOver: won || lost });
	if (!won && !lost) return;

	// A hangman room has no single winner: the guessers win or lose together, and the
	// host is not competing. winnerId stays null and the XP hook takes the whole
	// participant list.
	// The result card carries the ending's gallows: the hangman end card when it draws (2026-10
	// item 243 Phase 3), the gallows art or its Dero stand in when it does not. The
	// card takes revealedLetters, never the word, so this line adds no third read of it.
	// A solved word closes the challenge card as the room's win (post-launch plan item
	// 21), clean or one miss from the rope; a lost round closes it with no winner.
	const claimed = await roomLifecycle.finish(interaction.client, room, {
		winnerId: null,
		...(won ? { outcome: { bucket: hangmanOutcome(state.wrong), roomWon: true } } : {}),
		art: await withRenderFallback(
			() => renderHangmanCard(hangmanCardView(state, won ? "solved" : "lost")),
			() => resolveGameAsset(won ? "hangmanWin" : "hangmanLose")
		),
	});
	// The word line and the pay belong to the call that won finish's claim (2026-10 item 276,
	// audit P1-7), the shape giveUpHangmanRound has: a give up or another ending that finished
	// the round first already said how it ended, and a second line or a second XP award would
	// end the round twice.
	if (!claimed) return;

	// ⚠️ THE ONLY PLACE THE WORD IS EVER RENDERED, and it is after the round is over. A
	// result, not a guess, so it posts as its own line under the last card.
	await roomTrail.postMove(interaction.client, room, {
		actorId: interaction.user.id,
		kind: "system",
		text: won ? gameRoomsCopy.hangman.wonLine(state.word) : gameRoomsCopy.hangman.lostLine(state.word),
	});

	// The host is excluded from the award list: they set the word, so they were never
	// playing. Display names come from the guild cache with the id as a last resort,
	// which is the same fallback every other award site uses.
	const participants = room.playerIds
		.filter((id) => id !== state.authoredBy)
		.map((id) => {
			const member = interaction.guild?.members.cache.get(id);
			return { userId: id, username: member?.displayName ?? member?.user.username ?? id };
		});

	awardMultiPlayerResult({
		client: interaction.client,
		guildId: room.guildId,
		channelId: room.channelId,
		game: "hangman",
		participants,
		winnerId: won ? interaction.user.id : null,
		resultKey: room.roomId,
		coinGame: room.game === "solo-hangman" ? "solo-hangman" : "hangman",
	});
}

// ── giving up, and leaving (2026-10 item 276, audit P2-6 and P1-4) ──
// What:  the round's two ways to end with nobody winning: the host's Give up, and a departure
//        that leaves the round with nobody to set the word or nobody to guess it.
// Who:   roomDeparture, for the Give up confirm's Submit and for the server leave watcher, so a
//        departure has one path whoever reaches it.
// Why:   the round is cooperative and the host is not competing, so a Give up names no winner
//        and pays no win (the old forfeit named the host the winner whenever one guesser gave
//        up, which two members could farm). Only the host may give up, since one guesser
//        giving up would end the round for every other guesser.

/** True for the two hangman room games, the shared and the solo one. */
export const isHangmanRoom = (room: Pick<IGameRoom, "game">): boolean => room.game === "hangman" || room.game === "solo-hangman";

/**
 * End the round with no winner and show the word, once: the line posts only for the call that
 * won finish's claim, so a give up racing the solving letter never shows a second ending. A round
 * whose word was never set ends the same way with no word to show. Answers whether it ended it.
 */
export async function giveUpHangmanRound(client: Client, room: IGameRoom): Promise<boolean> {
	const state = rehydrate(room);
	const claimed = await roomLifecycle.finish(client, room, {
		winnerId: null,
		outcome: { bucket: "forfeit" },
		...(state
			? { art: await withRenderFallback(() => renderHangmanCard(hangmanCardView(state, "lost")), () => resolveGameAsset("hangmanLose")) }
			: {}),
	});
	if (!claimed || !state) return claimed;
	// ⚠️ The one other render of the word (risk R12), and it is after the round is over.
	await roomTrail.postMove(client, room, { actorId: room.hostId, kind: "system", text: gameRoomsCopy.hangman.gaveUpLine(state.word) });
	return true;
}

/**
 * A member left the round's server. The round goes on while it still has a host to have set the
 * word and someone to guess it; otherwise it is given up. The guessers are the players other
 * than the word's author, or other than the host while no word is set.
 */
export async function leaveHangmanRound(client: Client, room: IGameRoom, userId: string): Promise<void> {
	if (userId === room.hostId) {
		await giveUpHangmanRound(client, room);
		return;
	}
	const state = rehydrate(room);
	// A word Dero drew has no author, so every player guesses it; before a word, the host is setting one.
	const setter = state ? state.authoredBy : room.hostId;
	const guessersLeft = room.playerIds.filter((id) => id !== userId && id !== setter);
	if (guessersLeft.length === 0) await giveUpHangmanRound(client, room);
}
