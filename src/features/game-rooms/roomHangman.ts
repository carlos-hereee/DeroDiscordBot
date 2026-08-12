import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	MessageFlags,
	ModalBuilder,
	TextInputBuilder,
	TextInputStyle,
	type ButtonInteraction,
	type ModalSubmitInteraction,
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
	type HangmanState,
} from "@features/games/hangmanState.js";
import { awardMultiPlayerResult } from "@features/games/gameXp.js";
import { resolveGameAsset } from "@features/games/gamesAssets.js";
import { roomTrail } from "./roomTrail.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { GAME_ROOM_PREFIX, GAME_ROOM_MODAL_PREFIX } from "./gameRoomActions.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import type { RoomSecret } from "./roomTypes.js";

// ── roomHangman ──────────────────────────────────────────────────────
// What:  hangman played inside a room: the host authors a word behind a modal, and
//        every letter anyone plays becomes its own attributed message.
// Who:   the `gameroom:move` button (guess), the `gameroom:author` button (set the
//        word), and the two `gameroomModal:` submits.
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
// Search this file for `.word` and there should be two hits, the authoring write
// and that render. If a third appears, the word is leaking.

// The round's live state is rebuilt from the row on every interaction rather than
// cached in a Map, because a Map is what died on every Railway deploy in the old
// handler. `guessed` is persisted as a plain array on the secret and rehydrated
// into the Set the pure module wants.
interface HangmanSecret extends RoomSecret {
	guessedLetters?: string[];
	wrong?: number;
}

function rehydrate(room: IGameRoom): HangmanState | null {
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

function persist(room: IGameRoom, state: HangmanState) {
	const secret = room.secret as HangmanSecret;
	return gameRoomStore.update(room.guildId, room.roomId, {
		secret: {
			...secret,
			guessedLetters: [...state.guessed],
			wrong: state.wrong,
			revealedHints: state.revealedHints,
		} as never,
	});
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
	hintContainsWord: "That hint gives the word away. Say something true about it instead.",
	tooManyExtraHints: "Three extra hints at most, one per line.",
	extraHintTooLong: `Keep each extra hint under ${HANGMAN_HINT_MAX} characters.`,
	extraHintContainsWord: "One of those extra hints gives the word away.",
};

export async function handleAuthoringModal(interaction: ModalSubmitInteraction): Promise<void> {
	const [prefix, action, roomId] = interaction.customId.split(":");
	if (prefix !== GAME_ROOM_MODAL_PREFIX || action !== "word" || !roomId) return;

	const guildId = interaction.guildId;
	if (!guildId) return;

	const room = await gameRoomStore.findByRoomId(guildId, roomId);
	if (!room || room.status !== "playing") {
		await interaction.reply({ content: gameRoomsCopy.errors.notFound, flags: MessageFlags.Ephemeral });
		return;
	}
	// Only the host sets the word, and only once. A second submit would replace a
	// word the room has already been guessing at.
	if (room.hostId !== interaction.user.id || (room.secret as HangmanSecret | null)?.word) {
		await interaction.reply({ content: gameRoomsCopy.errors.notYours, flags: MessageFlags.Ephemeral });
		return;
	}

	const result = validateHangmanAuthoring(
		interaction.fields.getTextInputValue("word"),
		interaction.fields.getTextInputValue("hint"),
		splitExtraHints(interaction.fields.getTextInputValue("extraHints"))
	);

	if (!result.ok) {
		await interaction.reply({ content: REJECTION_COPY[result.reason], flags: MessageFlags.Ephemeral });
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
	await gameRoomStore.update(guildId, roomId, { secret: secret as never });

	// ⚠️ THE HINT, NEVER THE WORD. The host knows the word already; echoing it buys
	// nothing and puts it one mis-click from a public channel.
	await interaction.reply({
		content: gameRoomsCopy.hangman.authored(result.hint, result.extraHints.length),
		flags: MessageFlags.Ephemeral,
	});

	// The public opener carries the hint and swaps the control from authoring to
	// guessing, which is what tells the room it has started.
	await roomTrail.postMove(interaction.client, room, {
		actorId: interaction.user.id,
		kind: "system",
		text: gameRoomsCopy.hangman.opener(interaction.user.id, result.hint),
	});
}

// ── guessing ──────────────────────────────────────────────────────────
export async function openGuessModal(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	const state = rehydrate(room);
	if (!state) {
		await interaction.reply({ content: gameRoomsCopy.hangman.waitingForWord(room.hostId), flags: MessageFlags.Ephemeral });
		return;
	}

	// ⚠️ THE HOST DOES NOT GUESS, and it is refused here as well as being said on the
	// opener card. A host guessing their own word is the obvious exploit and the
	// obvious complaint, and hiding the button would only be a suggestion.
	if (state.authoredBy && state.authoredBy === interaction.user.id) {
		await interaction.reply({ content: gameRoomsCopy.hangman.hostCannotGuess, flags: MessageFlags.Ephemeral });
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

	const room = await gameRoomStore.findByRoomId(guildId, roomId);
	if (!room || room.status !== "playing") {
		await interaction.reply({ content: gameRoomsCopy.hangman.closed, flags: MessageFlags.Ephemeral });
		return;
	}

	const state = rehydrate(room);
	if (!state) {
		await interaction.reply({ content: gameRoomsCopy.hangman.waitingForWord(room.hostId), flags: MessageFlags.Ephemeral });
		return;
	}
	// Re-gated: a modal submit is reachable without the button that opened it.
	if (state.authoredBy && state.authoredBy === interaction.user.id) {
		await interaction.reply({ content: gameRoomsCopy.hangman.hostCannotGuess, flags: MessageFlags.Ephemeral });
		return;
	}

	const outcome = applyGuess(state, interaction.fields.getTextInputValue("letter"));

	// The three no-cost outcomes stay EPHEMERAL. A public "that is not a letter" per
	// fat-fingered submit would bury the actual game in noise, and none of them
	// changed the round.
	if (outcome.status === "invalid" || outcome.status === "repeat" || outcome.status === "closed") {
		const message =
			outcome.status === "invalid"
				? gameRoomsCopy.hangman.invalid
				: outcome.status === "repeat"
				  ? gameRoomsCopy.hangman.repeat(outcome.letter)
				  : gameRoomsCopy.hangman.closed;
		await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
		return;
	}

	await interaction.reply({ content: `You played ${outcome.letter.toUpperCase()}.`, flags: MessageFlags.Ephemeral });
	await persist(room, state);

	const mask = maskedWord(state);
	const remaining = remainingAttempts(state);

	// ⚠️ A NEW MESSAGE PER MOVE, never an edit, and never a files attachment (R8).
	// The scroll IS the history, which is the entire reason this game earns a room.
	await roomTrail.postMove(interaction.client, room, {
		actorId: interaction.user.id,
		kind: "guess",
		text:
			outcome.status === "hit"
				? gameRoomsCopy.hangman.hit(interaction.user.id, outcome.letter, mask, remaining)
				: gameRoomsCopy.hangman.miss(interaction.user.id, outcome.letter, mask, wrongLetters(state), remaining),
		meta: { letter: outcome.letter, hit: outcome.status === "hit", wrong: state.wrong },
	});

	// A hint reveal is its OWN post, so scrolling the room shows when it was earned
	// rather than making a reader infer it from the miss count.
	if (outcome.status === "miss" && outcome.revealedHint) {
		await roomTrail.postMove(interaction.client, room, {
			actorId: interaction.user.id,
			kind: "hint",
			text: gameRoomsCopy.hangman.hintRevealed(outcome.revealedHint),
		});
	}

	const won = outcome.status === "hit" && outcome.solved;
	const lost = outcome.status === "miss" && outcome.lost;
	if (!won && !lost) return;

	// ⚠️ THE ONLY PLACE THE WORD IS EVER RENDERED, and it is after the round is over.
	await roomTrail.postMove(interaction.client, room, {
		actorId: interaction.user.id,
		kind: "system",
		text: won ? gameRoomsCopy.hangman.wonLine(state.word) : gameRoomsCopy.hangman.lostLine(state.word),
	});

	// A hangman room has no single winner: the guessers win or lose together, and the
	// host is not competing. winnerId stays null and the XP hook takes the whole
	// participant list.
	// ⚠️ THE RESULT CARD CARRIES THE GALLOWS (plan task 5.7), and it is the ONLY
	// message in the room that carries art at all. A move card stays text and embed
	// (R8): a round can run to thirty of them, and re-uploading a PNG per move is
	// bandwidth and a rate limit for nothing.
	await roomLifecycle.finish(interaction.client, room, {
		winnerId: null,
		art: resolveGameAsset(won ? "hangmanWin" : "hangmanLose"),
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
	});
}
