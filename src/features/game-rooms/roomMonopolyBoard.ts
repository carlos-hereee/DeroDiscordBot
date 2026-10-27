import { TextChannel, type Client, type Guild, type Message } from "discord.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import type { MonopolyState } from "@features/games/monopolyState.js";
import { renderBoard } from "@features/games/monopolyRenderer.js";
import type { ResolvedGameAsset } from "@features/games/gamesAssets.js";
import { monopolyBoardEmbedWith, monopolyControlsRow } from "./roomMonopoly.js";
import { roomTrail, type RoomMoveInput } from "./roomTrail.js";
import { roomDrawingKey, withDrawingPause } from "./drawingPause.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { labelForRoom } from "./satelliteRooms.js";
import { botSeatName, isBotSeatId, memberIdsOnly } from "./botSeat.js";
import type { RoomMoveKind } from "./roomTypes.js";

// ── roomMonopolyBoard ────────────────────────────────────────────────
// What:  where a Monopoly match's board message sits, and what it carries: the board
//        is always the LAST message in the room (2026-10 item 254, Arcade 8). During a
//        turn the board carries that turn's lines, edited in place with each move; when
//        the turn passes, the finished turn's lines post as one log message, the new
//        board posts below it with the buttons, and the old board is deleted.
// Who:   roomMonopolyHandlers.applyMonopolyOutcome, the tail every move reaches (a
//        press, a modal, a bot's turn, the idle and auction sweeps), plus the referee's
//        notice and the Bring Dero into the call button, which post above the board and
//        so move it down (roomMonopolyRefereeNotice).
// When:  once per landed move, after the move was persisted.
// Where: the board's message id lives on the match (`secret.boardMessageId`). Every
//        move's compare and swap includes it (turnFingerprint), and the repost moves it
//        with one conditional dotted write, so a move read before the board moved can
//        never write the old id back.
// How:   ① every placement queues behind the room's drawing pause, so two moves' boards
//        land in the order they were persisted; ② inside the queue the CURRENT board id
//        is read from the row, never from the move's own copy, which an earlier
//        placement may already have replaced; ③ a line reaches the transcript only after
//        the message carrying it was sent or edited (roomTrail's rule).
//
// ⚠️ THE NEW BOARD IS PERSISTED BEFORE THE OLD ONE IS DELETED. A crash between the two
// leaves two boards, both of whose buttons still work (a control carries the room id,
// not the message id) and the newer of which the row points at; the reverse order would
// leave a room with no board at all.

/**
 * The match stored on a room row, or null for a row with no board yet. Through
 * `unknown` because IGameRoom types `secret` as hangman's RoomSecret, the shape the
 * Mixed field was first written for; the `seats` check is what tells a Monopoly
 * state apart from a row whose secret was never seeded. Here rather than in the
 * handlers so this module can read the row without importing them back.
 */
export function monopolyStateOf(room: IGameRoom | null): MonopolyState | null {
	const stored = room?.secret as unknown as Partial<MonopolyState> | null | undefined;
	return Array.isArray(stored?.seats) ? (stored as MonopolyState) : null;
}

// ── the engine's lines ────────────────────────────────────────────────
// A player's mention in an engine line. Hyphens too: a Dero bot seat's mention is
// `<@dero-bot-red>` (2026-10 item 250 Phase 5). The voice referee builds its spoken
// allowlist from the same pattern.
export const PLAYER_MENTION_PATTERN = String.raw`<@!?[\w-]+>`;

const TURN_HANDOFF = new RegExp(String.raw`^It is now ${PLAYER_MENTION_PATTERN}'s turn\.$`);

/** True for the engine's "It is now X's turn." line, which opens a turn: the board's log and the voice referee both split on it. */
export const isTurnHandoffLine = (line: string): boolean => TURN_HANDOFF.test(line);

// ── the turn's lines ──────────────────────────────────────────────────
/** How one move's lines split between the turn that just ended and the turn now on the clock. */
export interface TurnSplit {
	// Every line of the turn that just ended, for its log message, or null while the turn runs on.
	finishedShown: string[] | null;
	// The lines of this move that belong to the finished turn, which no message carried yet.
	finishedNew: string[];
	// The turn on the clock's lines so far, which the board carries (and the state stores).
	current: string[];
	// The lines of this move that belong to the turn on the clock.
	currentNew: string[];
}

const turnsTaken = (state: MonopolyState): number => state.stats?.turnsTaken ?? 0;

/**
 * Split one move's lines at the turn handoff. The turn passed when the engine counted
 * one more turn taken, or the match ended (its last turn is over and no new one starts).
 * The engine's "It is now X's turn." line opens the new turn, so it and everything after
 * it ride the new board; everything before it closes the old one. A move that passed the
 * turn without a handoff line (the match ending) closes the old turn with all its lines.
 */
export function splitTurnLines(read: MonopolyState, next: MonopolyState, lines: readonly string[]): TurnSplit {
	const earlier = read.turnLog ?? [];
	const passed = next.phase === "finished" || turnsTaken(next) !== turnsTaken(read);
	if (!passed) return { finishedShown: null, finishedNew: [], current: [...earlier, ...lines], currentNew: [...lines] };

	const cut = next.phase === "finished" ? lines.length : lastHandoffIndex(lines);
	const finishedNew = lines.slice(0, cut);
	const currentNew = lines.slice(cut);
	return { finishedShown: [...earlier, ...finishedNew], finishedNew, current: currentNew, currentNew };
}

// Where the last turn handoff line sits, or the end of the lines when there is none.
// The last one, because a move that passes the turn twice (a forfeit on the clock right
// after a handoff) has only the final turn still running. A loop rather than
// findLastIndex, which the compiler's library target does not carry.
function lastHandoffIndex(lines: readonly string[]): number {
	for (let index = lines.length - 1; index >= 0; index--) if (isTurnHandoffLine(lines[index])) return index;
	return lines.length;
}

/** `next` with the turn log the board will carry, stamped before the move is persisted. */
export function withTurnLog(read: MonopolyState, next: MonopolyState, lines: readonly string[]): MonopolyState {
	return { ...next, turnLog: splitTurnLines(read, next, lines).current };
}

// ── the names on the tokens ───────────────────────────────────────────
/**
 * Display names for seats, the cache first, then ONE fetch for whoever it lacks,
 * rather than resolveParticipants' fetch of everyone: the board redraws and the voice
 * referee speaks on every move, and a fetch of a user list is a gateway request each
 * time, while seated players are almost always cached already. A Dero bot is named and
 * never fetched (its id is no member's, and one bad id would fail the fetch for every
 * member in it); a member who left reads as "a player".
 */
export async function displayNamesIn(guild: Guild, userIds: readonly string[]): Promise<Map<string, string>> {
	const missing = memberIdsOnly(userIds).filter((userId) => !guild.members.cache.has(userId));
	if (missing.length > 0) await guild.members.fetch({ user: missing }).catch(() => null);
	const fallback = gameRoomsCopy.monopoly.refereeUnknownPlayer;
	const nameOf = (userId: string): string => (isBotSeatId(userId) ? botSeatName(userId) : (guild.members.cache.get(userId)?.displayName ?? fallback));
	return new Map(userIds.map((userId) => [userId, nameOf(userId)]));
}

/**
 * Each seat still in the match named for its tag on the board picture: a member by
 * display name (cache first), a Dero bot through labelForRoom, the one path every line
 * naming a bot takes. Best effort: a guild that cannot be read leaves the tags off.
 */
export async function seatNamesForBoard(client: Client, room: Pick<IGameRoom, "guildId" | "network">, state: MonopolyState): Promise<Map<string, string>> {
	const seatIds = state.seats.filter((seat) => !seat.bankrupt).map((seat) => seat.userId);
	const names = new Map<string, string>();
	try {
		for (const botId of seatIds.filter(isBotSeatId)) names.set(botId, await labelForRoom(client, { network: room.network ?? false }, `<@${botId}>`));
		const guild = client.guilds.cache.get(room.guildId) ?? (await client.guilds.fetch(room.guildId).catch(() => null));
		if (!guild) return names;
		const members = await displayNamesIn(guild, seatIds.filter((userId) => !isBotSeatId(userId)));
		for (const [userId, name] of members) names.set(userId, name);
	} catch (error) {
		// Swallowed on purpose: a tag is a convenience, and the board must post without one.
		console.warn("[game-rooms] the monopoly name tags could not be read", { guildId: room.guildId, error });
	}
	return names;
}

// ── placing the board ─────────────────────────────────────────────────
/** One move's lines, split, and who made them, for the board to carry and the transcript to record. */
export interface BoardPlacement {
	split: TurnSplit;
	actorId: string;
	kind: RoomMoveKind;
}

/**
 * Put the board for `state` where it belongs after a move: edited in place while the
 * turn runs, reposted below the turn's log message when it passed. Cosmetic past the
 * persist, so a failure is logged and swallowed: the row is the truth, and the next
 * move places the board from it.
 */
export async function placeMonopolyBoard(client: Client, room: IGameRoom, state: MonopolyState, placement: BoardPlacement): Promise<void> {
	const { split, actorId, kind } = placement;
	const asMoves = (lines: readonly string[]): RoomMoveInput[] => lines.map((text) => ({ actorId, kind, text }));
	let channel: TextChannel | null = null;
	let boardId: string | null = null;

	await withDrawingPause({
		gameKey: roomDrawingKey(room),
		showStatus: async (status) => {
			channel = await boardChannel(client, room.channelId);
			const board = channel ? await fetchBoard(channel, state.boardMessageId) : null;
			await board?.edit({ content: status });
		},
		render: async () => {
			// ② Read here, after the queue let this placement through, so it sees the board
			// every earlier placement left.
			boardId = await currentBoardId(room, state);
			return renderBoard(state, Date.now(), await seatNamesForBoard(client, room, state));
		},
		fallback: () => null,
		swapIn: async (picture) => {
			channel ??= await boardChannel(client, room.channelId);
			if (!channel) return;
			if (!split.finishedShown) {
				const board = await fetchBoard(channel, boardId);
				if (board) {
					await board.edit({ ...boardPayload(room, state, picture), content: null, attachments: [] });
					await roomTrail.recordCarriedMoves(room, asMoves(split.currentNew));
					return;
				}
				// The board was deleted from under the match: post a fresh one rather than
				// leave the room with no buttons.
			} else {
				await roomTrail.postMoveLog(client, room, { shown: split.finishedShown, moves: asMoves(split.finishedNew) });
			}
			await repostBoard(channel, room, boardId, boardPayload(room, state, picture), asMoves(split.currentNew));
		},
	}).catch((error) => console.warn("[game-rooms] failed to place the monopoly board", { roomId: room.roomId, error }));
}

/**
 * Move the board below whatever was just posted above it: the referee's notice, or the
 * join notice Bring Dero into the call leaves in the room. `above` posts first, inside
 * the same queue, so nothing lands between it and the new board. With nothing to post,
 * a board that is already the last message stays where it is. Reads the match fresh,
 * because the move that prompted this may no longer be the latest. Never throws.
 */
export async function moveMonopolyBoardToBottom(client: Client, room: IGameRoom, above?: (channel: TextChannel) => Promise<unknown>): Promise<void> {
	let latest: { row: IGameRoom; state: MonopolyState } | null = null;
	await withDrawingPause({
		gameKey: roomDrawingKey(room),
		// No status line: the board is not changing, only moving.
		showStatus: async () => undefined,
		render: async () => {
			latest = await readMatch(room);
			if (!latest) return null;
			return renderBoard(latest.state, Date.now(), await seatNamesForBoard(client, latest.row, latest.state));
		},
		fallback: () => null,
		swapIn: async (picture) => {
			const match: { row: IGameRoom; state: MonopolyState } | null = latest;
			const channel = await boardChannel(client, room.channelId);
			if (!match || !channel) return;
			const boardId = match.state.boardMessageId;
			if (above) await above(channel);
			else if (boardId && channel.lastMessageId === boardId) return;
			await repostBoard(channel, match.row, boardId, boardPayload(match.row, match.state, picture), []);
		},
	}).catch((error) => console.warn("[game-rooms] failed to move the monopoly board down", { roomId: room.roomId, error }));
}

// ── helpers ───────────────────────────────────────────────────────────
type BoardPayload = ReturnType<typeof boardPayload>;

// Rendered for the seat on the clock, because the board is one shared message and that
// seat is the only one whose turn buttons do anything. A finished match gets no rows.
function boardPayload(room: Pick<IGameRoom, "roomId">, state: MonopolyState, picture: ResolvedGameAsset | null) {
	const { embed, attachment } = monopolyBoardEmbedWith(state, picture);
	const activeId = state.seats[state.activeSeatIndex].userId;
	return { embeds: [embed], components: monopolyControlsRow(state, activeId, room.roomId), files: attachment ? [attachment] : [] };
}

// ① send, ② claim the id (null when another placement moved it first, in which case the
// newcomer is withdrawn and nothing is recorded), ③ record what it carries, ④ delete the
// old board. Pings nobody: the board names players in its embed, which never pings.
async function repostBoard(channel: TextChannel, room: Pick<IGameRoom, "guildId" | "roomId">, fromId: string | null, payload: BoardPayload, carried: readonly RoomMoveInput[]): Promise<void> {
	const posted = await channel.send({ ...payload, allowedMentions: { parse: [] } });
	const claimed = await gameRoomStore.moveMonopolyBoard(room.guildId, room.roomId, fromId, posted.id);
	if (!claimed) {
		await posted.delete().catch(() => undefined);
		return;
	}
	await roomTrail.recordCarriedMoves(room, carried);
	if (!fromId) return;
	const old = await fetchBoard(channel, fromId);
	// Logged rather than thrown: a leftover board still works, and the row points past it.
	await old?.delete().catch((error: unknown) => console.warn("[game-rooms] the old monopoly board could not be deleted", { roomId: room.roomId, error }));
}

// The room's text channel, or null once it is gone (an admin can delete it at any time,
// and the row outlives it by design).
async function boardChannel(client: Client, channelId: string | null): Promise<TextChannel | null> {
	if (!channelId) return null;
	const channel = await client.channels.fetch(channelId).catch(() => null);
	return channel instanceof TextChannel ? channel : null;
}

async function fetchBoard(channel: TextChannel, messageId: string | null): Promise<Message | null> {
	if (!messageId) return null;
	return channel.messages.fetch(messageId).catch(() => null);
}

async function readMatch(room: Pick<IGameRoom, "guildId" | "roomId">): Promise<{ row: IGameRoom; state: MonopolyState } | null> {
	const row = await gameRoomStore.findByRoomId(room.guildId, room.roomId).catch(() => null);
	const state = monopolyStateOf(row);
	return row && state ? { row, state } : null;
}

// The board the row points at now, or the move's own copy when the row cannot be read.
async function currentBoardId(room: Pick<IGameRoom, "guildId" | "roomId">, state: MonopolyState): Promise<string | null> {
	const match = await readMatch(room);
	return match ? match.state.boardMessageId : state.boardMessageId;
}
