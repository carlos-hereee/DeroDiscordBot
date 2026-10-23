import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	MessageFlags,
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
	type PickedHangmanWord,
} from "@features/games/hangmanWords.js";
import { withRenderFallback } from "@features/renderer/index.js";
import { roomTrail, resolveRoomChannel } from "./roomTrail.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { GAME_ROOM_PREFIX, GAME_ROOM_SELECT_PREFIX, GAME_ROOM_MODAL_PREFIX } from "./gameRoomActions.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import type { RoomSecret } from "./roomTypes.js";

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

	await startRoomHangmanRound(
		interaction.client,
		room,
		secret,
		{ actorId: interaction.user.id, text: gameRoomsCopy.hangman.opener(interaction.user.id, result.hint) },
		// ⚠️ THE HINT, NEVER THE WORD. The host knows the word already; echoing it buys
		// nothing and puts it one mis-click from a public channel.
		() =>
			interaction.reply({
				content: gameRoomsCopy.hangman.authored(result.hint, result.extraHints.length),
				flags: MessageFlags.Ephemeral,
			})
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
		await interaction.reply({ content: gameRoomsCopy.errors.notFound, flags: MessageFlags.Ephemeral });
		return;
	}
	// Re-gated here: the router does not gate selects, and a select's customId and
	// values are user input whoever built the menu. Host only, like the modal.
	if (room.hostId !== interaction.user.id) {
		await interaction.reply({ content: gameRoomsCopy.errors.notYours, flags: MessageFlags.Ephemeral });
		return;
	}
	if ((room.secret as HangmanSecret | null)?.word) {
		await interaction.reply({ content: gameRoomsCopy.hangman.wordAlreadySet, flags: MessageFlags.Ephemeral });
		return;
	}

	const category = interaction.values[0] ?? "";
	if (!isHangmanCategory(category)) {
		await interaction.reply({ content: gameRoomsCopy.errors.notFound, flags: MessageFlags.Ephemeral });
		return;
	}

	const pick = pickWordFromCategory(category);
	const label = gameRoomsCopy.hangman.categoryLabels[category];
	await startRoomHangmanRound(
		interaction.client,
		room,
		bankSecret(pick),
		{ actorId: interaction.user.id, text: gameRoomsCopy.hangman.categoryOpener(interaction.user.id, label, pick.hint) },
		() => interaction.reply({ content: gameRoomsCopy.hangman.categoryPicked(label), flags: MessageFlags.Ephemeral })
	);
}

/**
 * Seed a SOLO hangman room with a word and hint from the whole bank and start it.
 * Called once by RoomProvisioner right after the opener is posted. The host is the
 * guesser, which a bank word's null author already allows.
 */
export async function startSoloHangmanRound(client: Client, room: HangmanRoomRef): Promise<void> {
	const pick = pickWord();
	await startRoomHangmanRound(client, room, bankSecret(pick), {
		actorId: room.hostId,
		text: gameRoomsCopy.hangman.soloOpener(pick.hint),
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
	if (state) await postGallowsCard(client, room, state);
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
// A new message after the word is set and after every guess that leaves the round
// open, drawn by the same boardPicture the channel game uses. It is NOT a move: the
// trail line above it stays the text transcript, and this card never enters it.
// The round's last guess posts no card, because the result card from
// roomLifecycle.finish carries the ending's gallows. Cosmetic, so a failure is
// logged and swallowed: the row is the truth and the next guess draws again.
async function postGallowsCard(client: Client, room: Pick<IGameRoom, "roomId" | "channelId">, state: HangmanState): Promise<void> {
	try {
		const channel = await resolveRoomChannel(client, room.channelId);
		if (!channel) return;
		const picture = await playingBoardPicture(state, gameRoomsCopy.hangman.boardDescription(state.authoredBy));
		await channel.send({ ...picture, allowedMentions: { parse: [] } });
	} catch (error) {
		console.warn("[game-rooms] could not post the hangman gallows card", { roomId: room.roomId, error });
	}
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

	// ⚠️ A NEW MESSAGE PER MOVE, never an edit, and the move line never carries a
	// file (R8). The scroll IS the history, which is the entire reason this game
	// earns a room; the picture rides its own gallows card below.
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
	if (!won && !lost) {
		await postGallowsCard(interaction.client, room, state);
		return;
	}

	// ⚠️ THE ONLY PLACE THE WORD IS EVER RENDERED, and it is after the round is over.
	await roomTrail.postMove(interaction.client, room, {
		actorId: interaction.user.id,
		kind: "system",
		text: won ? gameRoomsCopy.hangman.wonLine(state.word) : gameRoomsCopy.hangman.lostLine(state.word),
	});

	// A hangman room has no single winner: the guessers win or lose together, and the
	// host is not competing. winnerId stays null and the XP hook takes the whole
	// participant list.
	// The result card carries the ending's gallows, which is why the final guess
	// posted no playing card above. The hangman end card when it draws (2026-10
	// item 243 Phase 3), the gallows art or its Dero stand in when it does not. The
	// card takes revealedLetters, never the word, so this line adds no third read of it.
	await roomLifecycle.finish(interaction.client, room, {
		winnerId: null,
		art: await withRenderFallback(
			() => renderHangmanCard(hangmanCardView(state, won ? "solved" : "lost")),
			() => resolveGameAsset(won ? "hangmanWin" : "hangmanLose")
		),
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
