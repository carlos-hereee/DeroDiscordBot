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

// ── turnPrompt ───────────────────────────────────────────────────────
// What:  the one piece every turn based game shares (2026-10 item 257 Phase 4a): when a
//        turn starts, one line in the room pings the member on the clock with a Take your
//        turn button; the button opens a modal that IS their hand and their moves; its
//        Submit plays the move; the line is edited to say it was played or passed. The room
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

function promptRows(adapter: TurnAdapter, room: IGameRoom, fingerprint: string): ActionRowBuilder<ButtonBuilder>[] {
	const take = new ButtonBuilder().setCustomId(turnButtonId(room.roomId, fingerprint)).setLabel(gameRoomsCopy.turnPrompt.takeLabel).setEmoji("🎯").setStyle(ButtonStyle.Primary);
	return [new ActionRowBuilder<ButtonBuilder>().addComponents(take, ...(adapter.extraButtons?.(room) ?? []))];
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
	const posted = await roomTrail.postTurnPrompt(client, room, { playerId: next.playerId, text: gameRoomsCopy.turnPrompt.line(next.playerId), components: next.rows });
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

	await showModalOrReply(interaction, buildFieldsModal({ customId: turnModalId(room.roomId, fingerprint), title: view.title, text: view.text, fields: view.fields }), () => ({
		content: view.text.join("\n\n"),
		flags: MessageFlags.Ephemeral,
	}));
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
	if (adapter.fingerprintOf(room) !== fingerprint) return notice(copy.turnPassed);
	const view = adapter.view(room, interaction.user.id);
	if (!view) return notice(copy.turnPassed);

	const answers = readFieldAnswers(interaction, view.fields);
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
