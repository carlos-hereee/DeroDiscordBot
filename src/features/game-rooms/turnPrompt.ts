import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, type ButtonInteraction, type Client, type ModalSubmitInteraction } from "discord.js";
import { showModalOrReply, showNotice } from "@utils/textModal.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import type { IGameRoom, TurnPromptRecord } from "@db/models/GameRoom.js";
import type { GameSlug } from "./roomTypes.js";
import { GAME_ROOM_MODAL_PREFIX, GAME_ROOM_PREFIX } from "./gameRoomActions.js";
import { buildFieldsModal, readFieldAnswers, type ModalField } from "./pickerModal.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { isBotSeatId } from "./botSeat.js";
import { resolveRoomChannel, roomTrail } from "./roomTrail.js";
import { pickLine } from "@utils/pickLine.js";

// ── turnPrompt ───────────────────────────────────────────────────────
// What:  the one piece every turn based game shares (2026-10 item 257 Phase 4a): when a
//        turn starts, one line in the room pings the member on the clock with their moves
//        as buttons, each played in one press (quickMovesOf: a lone Roll is one press, no
//        modal), and a Take your turn button only when a move needs typing or a second
//        pick (Hold'em's raise amount, Battleship's column and row); that button opens a
//        modal that IS their hand and their moves, and its Submit plays the move. The
//        line is edited to say it was played or passed. The room
//        channel stays the event log and the table, the modal stays the private hand.
// Who:   Hold'em, Monopoly, Battleship and Blackjack, each through a small TurnAdapter that
//        answers whose turn it is, what the hand and the legal moves are, and how a move is
//        applied. The games call syncTurnPrompt after they redraw; gameRoomHandlers routes
//        the Take your turn press and the modal Submit to handleTurnPress and handleTurnSubmit.
// Does NOT: decide a rule, hold a game's state, or play a move of its own. Applying a move
//        is the adapter's job and it goes through the SAME function the game's own button
//        press calls, so there is never a second move path. A Dero bot seat on the clock
//        gets no prompt: nobody can press for it, and its tick plays it.
//
// ⚠️ A STALE SUBMIT IS REFUSED (risk R4). The button and the modal both carry the turn's
// fingerprint, and the Submit re-reads the row and compares it again, so a modal opened for a
// turn that has since passed answers "That turn has passed" instead of playing the new one.
// ⚠️ THE MODAL IS BUILT FROM THE ROW ALREADY IN HAND (risk R5): a modal must be the first
// answer to a press, inside Discord's three seconds, so nothing renders or fetches before it.
// ⚠️ A MODAL CANNOT OPEN FROM A SUBMIT (risk R6), so anything that needs a second modal
// (Monopoly's trade and bid) stays a button on the prompt line beside Take your turn.

/** The action word of the Take your turn button and of its modal. */
export const TURN_ACTION = "turn";

/** What a game answers when asked to prompt a turn; see the file header. */
export interface TurnAdapter {
	readonly game: GameSlug;
	/** The member (or Dero bot seat) on the clock, or null when nobody is. */
	whoseTurn(room: IGameRoom): string | null;
	/** Whether this member may open the turn modal now. Defaults to being the one on the clock. */
	canAct?(room: IGameRoom, userId: string): boolean;
	/** A token that is the same for the whole turn and different for the next one; no colons. */
	fingerprintOf(room: IGameRoom): string | null;
	/**
	 * The fingerprint one member's modal carries and its Submit is checked against, when it is
	 * narrower than the turn's. Battleship's setup has no turn, so each captain's modal carries
	 * their own fleet's layout instead, and a Submit after a Randomize locks nothing (2026-10 item
	 * 263, risk R14). Defaults to fingerprintOf.
	 */
	memberFingerprintOf?(room: IGameRoom, userId: string): string | null;
	/** The modal's title, text and fields for this member, or null when there is nothing to play. */
	view(room: IGameRoom, userId: string): TurnView | null;
	/**
	 * Play the move through the game's own move function. `acknowledge` is called once the move
	 * is claimed, where the game's button path always acknowledged. Answers a refusal worded for
	 * the member.
	 */
	apply(client: Client, room: IGameRoom, userId: string, answers: Readonly<Record<string, string>>, acknowledge: () => Promise<unknown>): Promise<TurnApplyResult>;
	/** Buttons that ride the prompt line beside Take your turn (Monopoly's Trade and Bid). */
	extraButtons?(room: IGameRoom): ButtonBuilder[];
}

/** What a turn modal shows. */
export interface TurnView {
	title: string;
	text: readonly string[];
	fields: readonly ModalField[];
}

/** A move applied, or why it was refused. */
export type TurnApplyResult = { ok: true } | { ok: false; reason: string };

/** The game's adapter, or undefined for a game that does not prompt. */
export type TurnAdapterLookup = (game: GameSlug) => TurnAdapter | undefined;

const EMPTY_PROMPT: TurnPromptRecord = { fingerprint: null, messageId: null, playerId: null, layout: null, played: false };

/** The Take your turn button for a turn. Exported so a game can offer the same press from its own board. */
export const turnButtonId = (roomId: string, fingerprint: string): string => `${GAME_ROOM_PREFIX}:${TURN_ACTION}:${roomId}:${fingerprint}`;

const turnModalId = (roomId: string, fingerprint: string): string => `${GAME_ROOM_MODAL_PREFIX}:${TURN_ACTION}:${roomId}:${fingerprint}`;

/** The action word of a move button: one legal move played in one press, with no modal. */
export const TURN_MOVE_ACTION = "tmove";

const turnMoveButtonId = (roomId: string, fingerprint: string, value: string): string => `${GAME_ROOM_PREFIX}:${TURN_MOVE_ACTION}:${roomId}:${fingerprint}:${value}`;

// Discord's limits: a custom id of 100 characters, a button label of 80, five buttons a row and
// five rows a message. Moves past MOVE_BUTTONS_MAX keep the modal, so the extras always fit.
const CUSTOM_ID_MAX = 100;
const BUTTON_LABEL_MAX = 80;
const BUTTONS_PER_ROW = 5;
const MOVE_BUTTONS_MAX = 15;

/** The moves a turn plays from buttons, and whether the modal is still needed for the rest. */
interface QuickMoves {
	fieldId: string;
	options: readonly { label: string; value: string }[];
	/** True when the view asks for more than the move (Hold'em's typed raise), so Take your turn stays. */
	keepsModal: boolean;
}

/**
 * The one-press moves of a turn (the owner's call: a modal for a lone Roll was too slow). A view
 * whose FIRST field is a single choice select, and whose other fields are only optional typed
 * text, plays every option of that select as its own button; a view with a second select
 * (Battleship's column and row) or too many options keeps the modal. Built from the view the
 * modal would show, so a button and the modal can never offer different moves.
 */
export function quickMovesOf(adapter: TurnAdapter, room: IGameRoom, playerId: string): QuickMoves | null {
	const view = adapter.view(room, playerId);
	if (!view) return null;
	const [first, ...rest] = view.fields;
	if (first?.kind !== "select" || rest.some((field) => field.kind !== "text")) return null;
	if (first.options.length === 0 || first.options.length > MOVE_BUTTONS_MAX) return null;
	return { fieldId: first.id, options: first.options, keepsModal: rest.length > 0 };
}

function promptRows(adapter: TurnAdapter, room: IGameRoom, fingerprint: string): ActionRowBuilder<ButtonBuilder>[] {
	const take = new ButtonBuilder().setCustomId(turnButtonId(room.roomId, fingerprint)).setLabel(gameRoomsCopy.turnPrompt.takeLabel).setEmoji("🎯").setStyle(ButtonStyle.Primary);
	const extras = adapter.extraButtons?.(room) ?? [];
	const playerId = adapter.whoseTurn(room);
	const quick = playerId ? quickMovesOf(adapter, room, playerId) : null;
	const moveButtons = quick ? moveButtonsOf(room.roomId, fingerprint, quick) : null;
	if (!quick || !moveButtons) return chunkRows([take, ...extras]);
	return [...chunkRows(moveButtons), ...chunkRows(quick.keepsModal ? [take, ...extras] : extras)];
}

// One button per move, or null when any custom id would pass Discord's limit (a long value),
// in which case the turn keeps the modal rather than losing a move.
function moveButtonsOf(roomId: string, fingerprint: string, quick: QuickMoves): ButtonBuilder[] | null {
	const buttons: ButtonBuilder[] = [];
	for (const [index, option] of quick.options.entries()) {
		const customId = turnMoveButtonId(roomId, fingerprint, option.value);
		if (customId.length > CUSTOM_ID_MAX) return null;
		const style = index === 0 ? ButtonStyle.Primary : ButtonStyle.Secondary;
		buttons.push(new ButtonBuilder().setCustomId(customId).setLabel(option.label.slice(0, BUTTON_LABEL_MAX)).setStyle(style));
	}
	return buttons;
}

function chunkRows(buttons: readonly ButtonBuilder[]): ActionRowBuilder<ButtonBuilder>[] {
	const rows: ActionRowBuilder<ButtonBuilder>[] = [];
	for (let start = 0; start < buttons.length; start += BUTTONS_PER_ROW) rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons.slice(start, start + BUTTONS_PER_ROW)));
	return rows;
}

// What the prompt's buttons are, as a string, so a change to the extras (an auction opening
// mid turn) is noticed without being a new turn. The Take your turn button is the same for the
// whole turn, so only the extras can differ.
const layoutOf = (rows: readonly ActionRowBuilder<ButtonBuilder>[]): string =>
	rows
		.flatMap((row) => row.components)
		.map((component) => (component.toJSON() as { custom_id?: string }).custom_id ?? "")
		.join("|");

// ── keeping the prompt in step with the game ──────────────────────────
/**
 * Put the prompt where the game's turn is: post a new line when a new member's turn (or a new
 * turn of the same member) has started, edit the previous line to say how it ended, and take
 * the line down when nobody is on the clock. Idempotent: called after every redraw, it does
 * nothing when the prompt already matches. Fire and forget after the primary action (rulebook
 * convention 7), so it never throws into the move that called it.
 *
 * A network table is skipped: a satellite's members are in other servers, a press from one
 * reaches the host room only through the satellite actions, and a pinged line in the host
 * channel would name members of no one's server.
 */
export async function syncTurnPrompt(client: Client, room: IGameRoom, adapter: TurnAdapter): Promise<void> {
	try {
		if (room.network || room.satellites?.length) return;
		// Re-read: the room the caller holds may be a press old, and the prompt record is on the row.
		const fresh = await gameRoomStore.findByRoomId(room.guildId, room.roomId);
		if (!fresh) return;
		const current = fresh.turnPrompt ?? EMPTY_PROMPT;
		const onClock = fresh.status === "playing" ? adapter.whoseTurn(fresh) : null;
		const playerId = onClock && !isBotSeatId(onClock) ? onClock : null;
		const fingerprint = playerId ? adapter.fingerprintOf(fresh) : null;
		if (!playerId || !fingerprint) {
			await takePromptDown(client, fresh, current);
			return;
		}

		const rows = promptRows(adapter, fresh, fingerprint);
		const layout = layoutOf(rows);
		if (current.fingerprint === fingerprint) {
			if (current.layout !== layout) await refreshLayout(client, fresh, current, fingerprint, layout, rows);
			return;
		}
		await postNewPrompt(client, fresh, current, { playerId, fingerprint, layout, rows });
	} catch (error) {
		console.warn("[game-rooms] the turn prompt could not be synced", { roomId: room.roomId, error });
	}
}

interface NewPrompt {
	playerId: string;
	fingerprint: string;
	layout: string;
	rows: ActionRowBuilder<ButtonBuilder>[];
}

// ① send the line, ② claim it on the row against the prompt that was read (the loser deletes
// its own line, so two syncs for one turn leave one), ③ edit the line it replaced.
async function postNewPrompt(client: Client, room: IGameRoom, current: TurnPromptRecord, next: NewPrompt): Promise<void> {
	const posted = await roomTrail.postTurnPrompt(client, room, { playerId: next.playerId, text: pickLine(gameRoomsCopy.turnPrompt.line)(next.playerId), components: next.rows });
	if (!posted) return;
	const previous = await gameRoomStore.claimTurnPrompt(room.guildId, room.roomId, current.fingerprint, {
		fingerprint: next.fingerprint,
		messageId: posted.id,
		playerId: next.playerId,
		layout: next.layout,
	});
	if (!previous) {
		await posted.delete().catch(() => undefined);
		return;
	}
	await retireLine(client, room, previous.turnPrompt ?? EMPTY_PROMPT);
}

async function takePromptDown(client: Client, room: IGameRoom, current: TurnPromptRecord): Promise<void> {
	if (!current.fingerprint) return;
	const previous = await gameRoomStore.claimTurnPrompt(room.guildId, room.roomId, current.fingerprint, { fingerprint: null, messageId: null, playerId: null, layout: null });
	if (previous) await retireLine(client, room, previous.turnPrompt ?? EMPTY_PROMPT);
}

async function refreshLayout(client: Client, room: IGameRoom, current: TurnPromptRecord, fingerprint: string, layout: string, rows: ActionRowBuilder<ButtonBuilder>[]): Promise<void> {
	const message = await fetchPromptLine(client, room, current);
	if (!message) return;
	await message.edit({ components: rows, allowedMentions: { parse: [] } });
	await gameRoomStore.setTurnPromptLayout(room.guildId, room.roomId, fingerprint, layout);
}

// The line a turn left behind says whether it was played through its modal or passed (the
// clock, or a move made from the board's own buttons), and loses its button: a Take your turn
// that no longer does anything must not look live.
async function retireLine(client: Client, room: IGameRoom, record: TurnPromptRecord): Promise<void> {
	const message = await fetchPromptLine(client, room, record);
	if (!message || !record.playerId) return;
	const copy = gameRoomsCopy.turnPrompt;
	const content = record.played ? copy.playedLine(record.playerId) : copy.passedLine(record.playerId);
	await message.edit({ content, components: [], allowedMentions: { parse: [] } }).catch((error: unknown) => console.warn("[game-rooms] a spent turn prompt could not be edited", { roomId: room.roomId, error }));
}

async function fetchPromptLine(client: Client, room: IGameRoom, record: TurnPromptRecord) {
	if (!record.messageId) return null;
	const channel = await resolveRoomChannel(client, room.channelId);
	return channel ? channel.messages.fetch(record.messageId).catch(() => null) : null;
}

// ── the press and the Submit ──────────────────────────────────────────
const canActNow = (adapter: TurnAdapter, room: IGameRoom, userId: string): boolean =>
	adapter.canAct ? adapter.canAct(room, userId) : adapter.whoseTurn(room) === userId;

const memberFingerprint = (adapter: TurnAdapter, room: IGameRoom, userId: string): string | null =>
	adapter.memberFingerprintOf ? adapter.memberFingerprintOf(room, userId) : adapter.fingerprintOf(room);

/**
 * Open a turn modal whose Submit lands in handleTurnSubmit, checked against `fingerprint`. The
 * press below opens it, and so does a game control that must answer with the modal at once
 * (Battleship's Randomize, which shows the fleet it just laid before writing it).
 */
export async function showTurnModal(interaction: ButtonInteraction, roomId: string, fingerprint: string, view: TurnView): Promise<void> {
	await showModalOrReply(interaction, buildFieldsModal({ customId: turnModalId(roomId, fingerprint), title: view.title, text: view.text, fields: view.fields }), () => ({
		content: view.text.join("\n\n"),
		flags: MessageFlags.Ephemeral,
	}));
}

/**
 * Take your turn: open the modal with the member's hand and moves. Refused, in a notice, for
 * anybody who is not on the clock and for a button whose turn has passed. Built from `room`,
 * the row the router just loaded, with no render and no fetch (risk R5).
 */
export async function handleTurnPress(interaction: ButtonInteraction, room: IGameRoom, fingerprint: string, adapterFor: TurnAdapterLookup): Promise<void> {
	const copy = gameRoomsCopy.turnPrompt;
	const notice = (text: string) => showNotice(interaction, { title: gameRoomsCopy.notices.room, sections: [text] });
	const adapter = adapterFor(room.game);
	if (!adapter || room.status !== "playing") return notice(copy.turnPassed);
	if (!canActNow(adapter, room, interaction.user.id)) return notice(copy.notYourTurn);
	if (adapter.fingerprintOf(room) !== fingerprint) return notice(copy.turnPassed);
	const view = adapter.view(room, interaction.user.id);
	if (!view) return notice(copy.nothingToPlay);
	await showTurnModal(interaction, room.roomId, memberFingerprint(adapter, room, interaction.user.id) ?? fingerprint, view);
}

/**
 * The modal's Submit. Re-reads the row and re-checks the actor and the fingerprint (risk R4),
 * then plays the move through the adapter and acknowledges with deferUpdate once the move is
 * claimed. A refusal answers privately: a Submit cannot open a modal.
 */
export async function handleTurnSubmit(interaction: ModalSubmitInteraction, adapterFor: TurnAdapterLookup): Promise<void> {
	const [, , roomId, fingerprint] = interaction.customId.split(":");
	const guildId = interaction.guildId;
	if (!guildId || !roomId || !fingerprint) return;
	const copy = gameRoomsCopy.turnPrompt;
	const notice = (text: string) => showNotice(interaction, { title: gameRoomsCopy.notices.room, sections: [text] });

	const room = await gameRoomStore.findByRoomId(guildId, roomId);
	const adapter = room ? adapterFor(room.game) : undefined;
	if (!room || !adapter || room.status !== "playing") return notice(copy.turnPassed);
	if (!room.playerIds.includes(interaction.user.id)) return notice(gameRoomsCopy.errors.notYours);
	if (!canActNow(adapter, room, interaction.user.id)) return notice(copy.notYourTurn);
	if (memberFingerprint(adapter, room, interaction.user.id) !== fingerprint) return notice(copy.turnPassed);
	const view = adapter.view(room, interaction.user.id);
	if (!view) return notice(copy.turnPassed);

	await playTurnMove(interaction, room, adapter, fingerprint, readFieldAnswers(interaction, view.fields));
}

/**
 * A move button's press: the same checks as the modal's Submit (risk R4), then the one move it
 * names, through the adapter's apply like every other way of playing a turn. The value must
 * still be one of the moves the view offers now, so a button drawn for an earlier step of a
 * Monopoly turn (Roll after the roll) plays nothing.
 */
export async function handleTurnMovePress(interaction: ButtonInteraction, adapterFor: TurnAdapterLookup): Promise<void> {
	// The value may hold a colon of its own (Monopoly's buy:<lot>), so it is everything after the fourth.
	const [, , roomId, fingerprint, ...valueParts] = interaction.customId.split(":");
	const value = valueParts.join(":");
	const guildId = interaction.guildId;
	if (!guildId || !roomId || !fingerprint || !value) return;
	const copy = gameRoomsCopy.turnPrompt;
	const notice = (text: string) => showNotice(interaction, { title: gameRoomsCopy.notices.room, sections: [text] });

	const room = await gameRoomStore.findByRoomId(guildId, roomId);
	const adapter = room ? adapterFor(room.game) : undefined;
	if (!room || !adapter || room.status !== "playing") return notice(copy.turnPassed);
	if (!room.playerIds.includes(interaction.user.id)) return notice(gameRoomsCopy.errors.notYours);
	if (!canActNow(adapter, room, interaction.user.id)) return notice(copy.notYourTurn);
	if (memberFingerprint(adapter, room, interaction.user.id) !== fingerprint) return notice(copy.turnPassed);
	const quick = quickMovesOf(adapter, room, interaction.user.id);
	if (!quick || !quick.options.some((option) => option.value === value)) return notice(copy.turnPassed);
	await playTurnMove(interaction, room, adapter, fingerprint, { [quick.fieldId]: value });
}

// Play one move for the member on the clock, from the modal's Submit or a move button.
async function playTurnMove(
	interaction: ModalSubmitInteraction | ButtonInteraction,
	room: IGameRoom,
	adapter: TurnAdapter,
	fingerprint: string,
	answers: Readonly<Record<string, string>>
): Promise<void> {
	const notice = (text: string) => showNotice(interaction, { title: gameRoomsCopy.notices.room, sections: [text] });
	// Marked BEFORE the move, so the redraw the move triggers retires the old line as played;
	// taken back below if the game refuses the move.
	await markPlayed(room, fingerprint, true);
	let acknowledged = false;
	const acknowledge = async (): Promise<void> => {
		acknowledged = true;
		await interaction.deferUpdate().catch(() => undefined);
	};
	const result = await adapter.apply(interaction.client, room, interaction.user.id, answers, acknowledge);
	if (result.ok) {
		if (!acknowledged) await acknowledge();
		return;
	}
	await markPlayed(room, fingerprint, false);
	await notice(result.reason);
}

// Best effort: the mark only picks the words a spent line is edited to.
async function markPlayed(room: IGameRoom, fingerprint: string, played: boolean): Promise<void> {
	await gameRoomStore.setTurnPromptPlayed(room.guildId, room.roomId, fingerprint, played).catch((error: unknown) => console.warn("[game-rooms] the turn prompt mark could not be written", { roomId: room.roomId, error }));
}
