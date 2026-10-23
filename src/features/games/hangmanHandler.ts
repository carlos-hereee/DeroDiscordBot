import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ComponentType,
	MessageFlags,
	ModalBuilder,
	TextChannel,
	TextInputBuilder,
	TextInputStyle,
	type ButtonInteraction,
	type ChatInputCommandInteraction,
	type Message,
} from "discord.js";
import { errorEmbed } from "@utils/embedBuilder.js";
import { CooldownManager } from "@utils/cooldownManager.js";
import { gamesCopy } from "./gamesCopy.js";
import { resolveGameAsset } from "./gamesAssets.js";
import { buildHangmanEndEmbed } from "./gamesEmbeds.js";
import { hangmanCardView } from "./hangmanRenderer.js";
import { boardPicture, playingBoardPicture } from "./hangmanBoard.js";
import { pickWord } from "./hangmanWords.js";
import { createHangmanState, applyGuess, type HangmanState } from "./hangmanState.js";
import { awardMultiPlayerResult } from "./gameXp.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";

// ── /mini-game hangman ─────────────────────────────────────────────────────
// What:  a PUBLIC, channel wide round. The board is a normal channel message
//        that updates in place, and anyone in that channel can guess a letter
//        through a modal. There is no opponent, so this game does not touch
//        challengeFlow at all.
// Who:   MINI_GAME_HANDLERS for the slash path, and PowerUps' admin dashboard
//        button for the "post a round to the command center" path. Both go
//        through startHangmanRound so the two entry points cannot drift, the
//        same shape /fortune and its invite card button already use.
// When:  a round lives until it is won, lost, or the round window closes.
// Where: the board is a channel.send() message, NOT an interaction reply, and
//        that is load bearing. An interaction token dies after 15 minutes, so a
//        board built on editReply would become uneditable mid round; a plain
//        message can be edited for as long as the bot can see it.
// How:   ① claim the channel slot synchronously, ② post the board, ③ an inline
//        collector routes every Guess click into a modal, ④ the modal submit is
//        scored by the pure hangmanState and the board is redrawn, ⑤ the
//        collector's end handler is the single cleanup path.

// Long enough that a channel can wander off and come back, short enough that an
// abandoned board cleans itself up instead of sitting live until a redeploy.
export const HANGMAN_ROUND_TIMEOUT_MS = 15 * 60_000;

// How long a guesser has inside the modal once it opens. Generous: a modal that
// times out costs the round nothing.
const HANGMAN_MODAL_WINDOW_MS = 120_000;

// Per starter, so one member cannot carpet the server with boards. Rounds are
// already one per channel, so this only gates how fast someone opens new ones.
const HANGMAN_COOLDOWN_MS = 15_000;
const cooldown = new CooldownManager(HANGMAN_COOLDOWN_MS);

const HANGMAN_CUSTOM_ID_PREFIX = "minigame:hangman";
const MODAL_FIELD = "letter";

interface HangmanRound {
	starterId: string;
	state: HangmanState;
	// ── who actually played ──
	// What:  every member who submitted a guess this round, plus the starter.
	// Who:   the leveling award at the end of the round reads it, and it is the
	//        ONLY record of participation that exists: the state carries the
	//        letters guessed but not who guessed them.
	// When:  seeded with the starter at round creation, and added to on every
	//        modal submit that reaches the round, including repeats and invalid
	//        characters, because taking part is what is being rewarded rather
	//        than guessing well.
	// Where: this is what makes the ASSIST outcome possible at all. Hangman is
	//        the only current game with a genuine assist, because a public round
	//        is solved by one member on top of letters several others revealed.
	//        Without this set the round could only ever reward two people, the
	//        starter and whoever happened to land the final letter.
	participants: Set<string>;
	// Stops the collector, whose end handler is the one cleanup path. Assigned
	// once the collector exists.
	stop: () => void;
}

// ── in-memory round state ──
// One round per CHANNEL, not per user, because the board is public and the whole
// channel plays it together. Process-scoped and single-process, the same accepted
// v1 tradeoff the other two games make: a round open when Railway redeploys is
// lost. Deleted unconditionally in the collector's end handler, which fires on a
// win, a loss, and a timeout alike.
const hangmanRounds = new Map<string, HangmanRound>();

// Test seams, matching earlyAccess.ts' `_clearEarlyAccessCache` convention.
export const _clearHangmanRounds = (): void => hangmanRounds.clear();
export const _activeHangmanRoundCount = (): number => hangmanRounds.size;

export type HangmanStartResult = "started" | "alreadyRunning" | "failed";

// ── the shared core, used by BOTH entry points ─────────────────────────────
export async function startHangmanRound(channel: TextChannel, starterId: string): Promise<HangmanStartResult> {
	// ① Claim the channel slot SYNCHRONOUSLY. The check and the write sit
	// adjacent with no await between them, so two members racing /mini-game
	// hangman in the same channel cannot both open a board. Same discipline as
	// the challenge engine's pair key and rpsRound's reveal claim.
	if (hangmanRounds.has(channel.id)) return "alreadyRunning";
	const round: HangmanRound = {
		starterId,
		state: createHangmanState(pickWord()),
		// The starter counts as a participant from the outset: they opened the
		// round, which is participation even if they never guess a letter.
		participants: new Set<string>([starterId]),
		stop: () => undefined,
	};
	hangmanRounds.set(channel.id, round);

	try {
		// ② Post the board. Nothing is clickable until the collector is wired
		// below, and the gap is one tick, so a click cannot arrive early.
		const picture = await roundBoardPicture(round);
		const board = await channel.send({
			...picture,
			components: [guessRow(channel.id)],
			allowedMentions: { parse: [] },
		});

		// ③ Route every Guess click. No `max`: a public board takes many clicks,
		// and the window is the round's own lifetime.
		const collector = board.createMessageComponentCollector({
			componentType: ComponentType.Button,
			filter: (i) => i.customId === guessCustomId(channel.id),
			time: HANGMAN_ROUND_TIMEOUT_MS,
		});
		round.stop = () => collector.stop();

		collector.on("collect", (click) => {
			void onGuessClick(click as ButtonInteraction, channel.id, board);
		});

		// ⑤ The single cleanup path. Fires on stop() AND on the time limit, so
		// there is no exit that leaves the map entry behind.
		collector.on("end", () => {
			void finishRound(channel.id, board);
		});

		return "started";
	} catch (error) {
		// The send failed (missing permission, deleted channel). Release the slot
		// so the channel is not locked out of hangman for the life of the process.
		hangmanRounds.delete(channel.id);
		console.warn(`[mini-game] hangman could not post a board in channel ${channel.id}`, error);
		return "failed";
	}
}

// ── the slash entry point ──────────────────────────────────────────────────
export async function runHangman(interaction: ChatInputCommandInteraction): Promise<void> {
	// Deferred first so every branch below answers the same way, and because
	// posting the board is Discord I/O that eats into the three second ack window.
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });

	const channel = interaction.channel;
	if (!(channel instanceof TextChannel)) {
		await interaction.editReply({ embeds: [errorEmbed(gamesCopy.outsideGuild)] });
		return;
	}

	// ── casual mode vs room mode (game rooms plan task 5.8) ──
	// What:  refuse the CASUAL board inside a game room channel.
	// Why:   a room's hangman is a different game: the host authors the word, the
	//        host may not guess, and every move is its own message. Posting the
	//        casual in-place board on top of that would put a SECOND round in the
	//        channel, drawn from the bundled word bank, with no author and no
	//        host bar, and the two boards would race each other for the scroll.
	// Where: the selector is the existence of a GameRoom row for this channel,
	//        exactly as the plan specifies, rather than a channel name or a
	//        category check, both of which an admin can change.
	// How:   casual behaviour OUTSIDE a room is untouched by this branch, which is
	//        the other half of 5.8: everything below this point is the code that
	//        shipped before rooms existed.
	if (interaction.guildId) {
		const room = await gameRoomStore.findByChannelId(interaction.guildId, channel.id).catch(() => null);
		if (room && room.status === "playing") {
			await interaction.editReply({ embeds: [errorEmbed(gamesCopy.hangmanInRoom)] });
			return;
		}
	}

	const cooldownKey = `${interaction.guildId ?? "dm"}:${interaction.user.id}`;
	const gate = cooldown.check(cooldownKey);
	if (gate.onCooldown) {
		await interaction.editReply({
			embeds: [errorEmbed(gamesCopy.hangman.cooldownMessage(Math.ceil(gate.remainingMs / 1000)))],
		});
		return;
	}

	const result = await startHangmanRound(channel, interaction.user.id);
	if (result === "alreadyRunning") {
		await interaction.editReply({ embeds: [errorEmbed(gamesCopy.hangman.alreadyRunning)] });
		return;
	}
	if (result === "failed") {
		await interaction.editReply({ embeds: [errorEmbed(gamesCopy.hangman.noChannel)] });
		return;
	}

	// Recorded only once a board is genuinely up, so a failed start does not burn
	// the starter's window.
	cooldown.record(cooldownKey);
	// Ephemeral: the BOARD is the visible feedback, and a public "round started"
	// on top of it would just be a second message saying the same thing.
	await interaction.editReply({ content: gamesCopy.hangman.started });
}

// ── private ────────────────────────────────────────────────────────────────

const guessCustomId = (channelId: string): string => `${HANGMAN_CUSTOM_ID_PREFIX}:${channelId}:guess`;

function guessRow(channelId: string): ActionRowBuilder<ButtonBuilder> {
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder()
			.setCustomId(guessCustomId(channelId))
			.setLabel(gamesCopy.hangman.guessButtonLabel)
			.setEmoji("🔤")
			.setStyle(ButtonStyle.Primary)
	);
}

// The board while the round is live, from the shared hangmanBoard module that game
// rooms draw with too. The endings below build their own embeds on boardPicture.
function roundBoardPicture(round: HangmanRound) {
	return playingBoardPicture(round.state, gamesCopy.hangman.startedBy(round.starterId));
}

// The alphabet is 26 letters and a message caps at 25 buttons, a select at 25
// options, so a modal text input is the only control that can take an arbitrary
// letter. setMinLength(1) and setMaxLength(1) make Discord enforce a single
// character before our own validation runs; content is still unchecked there, so
// hangmanState re-validates.
function buildGuessModal(customId: string): ModalBuilder {
	return new ModalBuilder()
		.setCustomId(customId)
		.setTitle(gamesCopy.hangman.modalTitle)
		.addComponents(
			new ActionRowBuilder<TextInputBuilder>().addComponents(
				new TextInputBuilder()
					.setCustomId(MODAL_FIELD)
					.setLabel(gamesCopy.hangman.modalInputLabel)
					.setPlaceholder(gamesCopy.hangman.modalPlaceholder)
					.setStyle(TextInputStyle.Short)
					.setRequired(true)
					.setMinLength(1)
					.setMaxLength(1)
			)
		);
}

async function onGuessClick(click: ButtonInteraction, channelId: string, board: Message): Promise<void> {
	const round = hangmanRounds.get(channelId);
	if (!round) {
		await click.reply({ content: gamesCopy.hangman.closed, flags: MessageFlags.Ephemeral }).catch(swallow("hangman closed reply"));
		return;
	}

	// ⚠️ showModal MUST be the first response to this click. A modal cannot be
	// deferred, so there is deliberately no deferUpdate or deferReply above it.
	// The customId carries click.id so several members opening the modal at the
	// same moment each await their OWN submission.
	const modalCustomId = `${HANGMAN_CUSTOM_ID_PREFIX}:${channelId}:${click.id}`;
	try {
		await click.showModal(buildGuessModal(modalCustomId));
	} catch (error) {
		console.warn("[mini-game] hangman could not open the guess modal", error);
		return;
	}

	// Rejects on timeout, and a member closing the modal is the common case, so a
	// null here is ordinary rather than an error. Costs the round nothing.
	const submit = await click
		.awaitModalSubmit({
			time: HANGMAN_MODAL_WINDOW_MS,
			filter: (i) => i.user.id === click.user.id && i.customId === modalCustomId,
		})
		.catch(() => null);
	if (!submit) return;

	// Re-read the round: the board could have been won, lost or expired while this
	// member sat in the modal.
	const live = hangmanRounds.get(channelId);
	if (!live) {
		await submit.reply({ content: gamesCopy.hangman.closed, flags: MessageFlags.Ephemeral }).catch(swallow("hangman stale submit"));
		return;
	}

	// Recorded BEFORE the guess is scored, and for every submit including repeats
	// and invalid characters: the set answers "who played this round", not "who
	// played it well". A member whose only guess was a repeat still took part.
	live.participants.add(submit.user.id);

	// ⚠️ SYNCHRONOUS. The board is public, so several members can submit in the
	// same tick. applyGuess does its whole check-then-write without yielding, so
	// two simultaneous guesses cannot both spend the last attempt or both win.
	const result = applyGuess(live.state, submit.fields.getTextInputValue(MODAL_FIELD));

	// Feedback is ephemeral to the guesser only. The BOARD is the public record,
	// and telling the whole channel that someone typed a digit would be noise.
	const c = gamesCopy.hangman;
	const feedback =
		result.status === "hit"
			? c.hit(result.letter)
			: result.status === "miss"
				? c.miss(result.letter, result.remaining)
				: result.status === "repeat"
					? c.repeat(result.letter)
					: result.status === "invalid"
						? c.invalid
						: c.closed;
	await submit.reply({ content: feedback, flags: MessageFlags.Ephemeral }).catch(swallow("hangman guess feedback"));

	// Only a real turn changes the board. A repeat, an invalid character, or a
	// late submit leaves it exactly as it was, which is the visible half of
	// "those do not cost an attempt".
	if (result.status === "hit" || result.status === "miss") {
		await renderBoard(board, live, channelId, submit.user.id);
	}
}

async function renderBoard(board: Message, round: HangmanRound, channelId: string, actorId: string): Promise<void> {
	const c = gamesCopy.hangman;

	if (round.state.status === "playing") {
		// The gallows frame IS the miss count, so the picture follows the state with no
		// bookkeeping. files is passed on every edit rather than only when the frame
		// changes: correctness over saving a re-upload a handful of times per round,
		// since an edit that drops its attachment renders an empty image slot.
		// `attachments: []` drops the previous frame, which an edit otherwise keeps,
		// so the board never stacks one picture per guess under its embed.
		const picture = await roundBoardPicture(round);
		await board
			.edit({ ...picture, components: [guessRow(channelId)], attachments: [] })
			.catch(swallow("hangman board update"));
		return;
	}

	const won = round.state.status === "won";
	const picture = await boardPicture(hangmanCardView(round.state, won ? "solved" : "lost"), resolveGameAsset(won ? "hangmanWin" : "hangmanLose"), (ref) =>
		buildHangmanEndEmbed(
			won ? c.wonTitle : c.lostTitle,
			won ? c.wonDescription(round.state.word, actorId) : c.lostDescription(round.state.word),
			ref
		)
	);
	await board
		.edit({
			...picture,
			// Drop the button so a late clicker gets a finished board rather than a
			// modal for a round that no longer exists.
			components: [],
			attachments: [],
			allowedMentions: { parse: [] },
		})
		.catch(swallow("hangman end board"));

	// ── leveling ──
	// After the end board, so the award can never delay the moment the channel
	// has been waiting for.
	//
	// ⚠️ GATE THE WIN ON `won`, NOT ON actorId. actorId is whoever made the FINAL
	// guess, which is the solver on a win and the member who hanged the round on a
	// loss. Passing it as the winner unconditionally would hand the win bonus to
	// the person who lost it.
	awardHangmanRound(board, round, won ? actorId : null);

	// Stopping the collector fires its end handler, which is what deletes the map
	// entry. One cleanup path, reached from every ending.
	round.stop();
}

async function finishRound(channelId: string, board: Message): Promise<void> {
	const round = hangmanRounds.get(channelId);
	// Unconditional and first: whatever else happens below, the channel is free.
	hangmanRounds.delete(channelId);
	if (!round) return;

	// A won or lost round already drew its own ending, and already awarded. Only
	// an expiry is left, so this is the one path that still owes an award.
	if (round.state.status !== "playing") return;

	const picture = await boardPicture(hangmanCardView(round.state, "expired"), resolveGameAsset("hangmanLose"), (ref) =>
		buildHangmanEndEmbed(gamesCopy.hangman.expiredTitle, gamesCopy.hangman.expiredDescription(round.state.word), ref)
	);
	await board.edit({ ...picture, components: [], attachments: [] }).catch(swallow("hangman expiry board"));

	// Nobody solved it, so nobody wins, but everyone who guessed still played and
	// showing up is the behavior being rewarded.
	awardHangmanRound(board, round, null);
}

// Resolve every participant to a display name and hand the round to the shared
// games award helper. Display names come from the member cache rather than a
// fetch: this runs after the round is over, and a cache miss degrades to the raw
// id in the standings rather than costing a round of Discord calls at the exact
// moment the channel is busiest.
function awardHangmanRound(board: Message, round: HangmanRound, winnerId: string | null): void {
	const guild = board.guild;
	awardMultiPlayerResult({
		client: board.client,
		guildId: guild?.id ?? null,
		channelId: board.channelId,
		game: "hangman",
		participants: [...round.participants].map((userId) => ({
			userId,
			username: guild?.members.cache.get(userId)?.displayName ?? userId,
		})),
		winnerId,
	});
}

// Board edits and feedback replies are fire and forget after the primary action:
// logged and swallowed, never thrown back out of a collector callback where no
// caller is left to catch them. The house convention.
function swallow(label: string): (error: unknown) => void {
	return (error: unknown) => console.warn(`[mini-game] ${label} failed`, error);
}
