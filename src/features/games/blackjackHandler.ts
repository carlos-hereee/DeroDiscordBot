import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ComponentType,
	TextChannel,
	type AttachmentBuilder,
	type ButtonInteraction,
	type Channel,
	type ChatInputCommandInteraction,
	type Client,
	type EmbedBuilder,
	type Message,
	type MessageEditOptions,
} from "discord.js";
import { errorEmbed, infoEmbed } from "@utils/embedBuilder.js";
import { COLORS } from "@base/copy/brand.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { CooldownManager } from "@utils/cooldownManager.js";
import { withRenderFallback, type RenderPayload } from "@features/renderer/index.js";
import { gamesCopy } from "./gamesCopy.js";
import { blackjackResultView, blackjackTableView, renderBlackjackResultCard, renderBlackjackTableCard } from "./blackjackRenderer.js";
import { buildBlackjackBettingEmbed, buildBlackjackResultEmbed, buildBlackjackSeatingEmbed, buildBlackjackTableEmbed, renderHand, renderTotal } from "./gamesEmbeds.js";
import {
	actionsShortOfChips,
	applyAction,
	applyLeave,
	bankrollWinnerOf,
	betChoices,
	bettingSeat,
	collectPayouts,
	createBankrollTable,
	handValue,
	createTable,
	isTableOver,
	legalActions,
	placeBet,
	playDealer,
	settle,
	settledHandsOf,
	startNextHand,
	type BlackjackAction,
	type BlackjackTable,
	type FinalStack,
	type SeatResult,
} from "./blackjackState.js";
import { awardBlackjackResult, awardBlackjackTableCoins } from "./gameXp.js";
import { recordHouseTableRatings } from "@features/ratings/recordMatchRatings.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { deroBrainCopy } from "@features/dero-brain/deroBrainCopy.js";
import { announceToMatch } from "@features/game-rooms/roomAnnouncer.js";
import { pickLine } from "@utils/pickLine.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { gameRoomsCopy } from "@features/game-rooms/gameRoomsCopy.js";
import { roomLifecycle } from "@features/game-rooms/roomLifecycle.js";
import { roomTrail, type RoomMoveInput } from "@features/game-rooms/roomTrail.js";
import { postTurnBoard } from "@features/game-rooms/turnBoard.js";
import { setTurnBlock, turnBlockLines } from "@features/game-rooms/turnLog.js";
import { drawingSettled, isClockExpired, pausedDeadline, withDrawingPause } from "@features/game-rooms/drawingPause.js";
import { cashOutBlackjackSeat, saveBlackjackStacks } from "@features/game-rooms/blackjackChips.js";
import { answerInChannel, beginChannelAnswer } from "@utils/answerInChannel.js";
import { acknowledgeConfirm, showConfirm, showCooldownNotice, showNotice, showPendingNotice, type ConfirmInteraction } from "@utils/textModal.js";
import { confirmCustomId } from "@features/game-rooms/gameRoomActions.js";
import { syncTurnPrompt, type TurnAdapter } from "@features/game-rooms/turnPrompt.js";
import { disarmTurnClock, syncTurnClocks, type TurnClockGame } from "@features/game-rooms/turnClock.js";

// ── /mini-game blackjack ───────────────────────────────────────────────────
// What:  two kinds of table on ONE engine. A ROOM's table (a solo room, or a multi seat
//        room the challenge card gathered) plays for a BANKROLL (2026-10 item 267, owner
//        decision 6): every seat sits with a stack of its buy in, each hand opens with a
//        betting turn per seat through the shared turn prompt, the hand pays the bets, and
//        the table deals hand after hand until every seat is broke or gone, then finishes
//        its room. The inline slash forms (`solo` and `table` typed where no room opens) keep
//        the one hand table they always had: seated, dealt, settled, done, for no chips.
// Who:   MINI_GAME_HANDLERS for the slash forms typed outside the challenge channels,
//        and soloRooms for a room's table, solo or multi seat.
// When:  an inline table lives until its hand settles or the board times out; a room's
//        table until nobody is left in it, or its room finishes another way (the idle
//        sweep, a deleted channel), which the next turn notices.
// Where: every board is a channel.send() message, NOT an interaction reply, and that is
//        load bearing for the same reason it is in hangman: an interaction token dies
//        after 15 minutes and a table can outlive that. A plain message edits forever.
// How:   ONE collector per table: an inline table watches its one board message; a room's
//        table watches its CHANNEL, because every hand posts a fresh board through the
//        shared turn board and a collector on one message would go deaf on the next. Each
//        board redraws behind the drawing pause after every bet and action.
//
// ⚠️ THE DEALER'S HOLE CARD IS SECRET FROM EVERYONE, which is why this game has
// no private per player view and therefore never meets the interaction token
// problem that shapes battleship and holdem. Do not "improve" this by showing a
// player their own hand ephemerally; there is nothing they can see that the
// board does not already show them. The turn modal a room table opens (blackjackTurnAdapter,
// 2026-10 item 257 Phase 4a) shows the same public hand beside the moves, or the bet choices.
//
// ⚠️ A ROOM'S TABLE STILL DIES ON RAILWAY SIGTERM, BUT ITS CHIPS DO NOT. The hand state
// lives in the module-scoped `games` Map below, so a redeploy mid hand loses the table while
// the room row says "playing". Every seat's stack is written to the row after each settle
// (blackjackChips, risk R5), so the boot recovery sweep (roomBootRecovery) finishes the room
// as abandoned and roomLifecycle.finish pays every stored stack back: the hand in play is
// called off and nothing settled is lost. A resumable table would mean persisting the whole
// hand the way battleship and hold em do, which is a rewrite of this file, not a patch.

// A seating window long enough to notice and short enough that a table does not
// hold a channel hostage waiting for a second player who is not coming.
export const SEATING_WINDOW_MS = 45_000;

// An inline table's whole lifetime. Generous, because a five seat hand with splits is
// genuinely slow, but finite so an abandoned table cleans itself up rather than sitting
// live until a redeploy. Held while the board draws (see armLifetime). A room's table has
// no lifetime (2026-10 item 267): its turn clock and the room idle sweep end a silent one.
export const TABLE_TIMEOUT_MS = 10 * 60_000;

// Seven is a real blackjack table. Five keeps the result embed inside a
// comfortable field count and keeps the slowest hand tolerable for seat one.
export const MAX_SEATS = 5;

// How far back the boot sweep looks for a dead board in a solo room. A solo room's
// scroll is the opener card, maybe an invite line, and the board, so this is generous.
const STALE_BOARD_FETCH_LIMIT = 20;

// Per starter, so one member cannot carpet a server with tables. Tables are
// already one per channel, so this only gates how fast someone opens new ones.
const BLACKJACK_COOLDOWN_MS = 15_000;
const cooldown = new CooldownManager(BLACKJACK_COOLDOWN_MS);

const PREFIX = "minigame:blackjack";
const customId = (channelId: string, action: string): string => `${PREFIX}:${channelId}:${action}`;
const actionOf = (id: string): string => id.split(":")[3] ?? "";

/** What a room's table plays for: the buy in every seat sat with, and whether it is wallet chips. */
export interface TableBankroll {
	buyIn: number;
	// False plays free with a pretend stack of the buy in, and no wallet ever moves.
	chips: boolean;
}

interface BlackjackGame {
	hostId: string;
	// Captured at creation so the settle path never has to guess it from whichever
	// message or interaction happens to be in scope at the time.
	guildId: string;
	// Join order IS seat order, so the member who sat first acts first. Kept as an
	// array rather than a Set because order carries meaning here.
	seated: Array<{ userId: string; username: string }>;
	// Null until the deal. Its presence is what distinguishes the seating phase
	// from the playing phase, so there is no separate phase field to fall out of
	// sync with it.
	table: BlackjackTable | null;
	// ⚠️ An inline table's settle claim. Set SYNCHRONOUSLY before any await in the settle
	// path, because the last action and the timeout can both reach settlement and paying a
	// table twice is the one bug here that costs real xp. A room's table claims each hand's
	// payout on the table itself (collectPayouts) and its end with `ended`.
	settled: boolean;
	// Set when this table plays inside a game room, solo or multi seat: its end closes the
	// room through roomLifecycle.finish (lock, result card, archive clock). Null for the
	// inline slash forms, which own no room.
	roomId: string | null;
	// A room's table only (2026-10 item 267); null at an inline table, which bets nothing.
	bankroll: TableBankroll | null;
	// True once a room's table has a turn line (promptTurn found a room that is no network table):
	// from then on every move and Leave are buttons on that line, and the board carries none of
	// them (owner decision of 2026-10-29: no button on both). False at an inline table.
	promptsTurns?: boolean;
	// The newest board, which the turn modal's Submit and the turn clock edit (a message edit,
	// unlike a click's token, never expires), and which a room table's next board replaces.
	board: Message | null;
	// A room table's last result board: the next hand's board is posted after it, through the
	// shared turn board, so the room reads hand, result, hand.
	resultBoardId: string | null;
	// A room table's hand so far, one line per bet and move, newest last: the hand is the table's
	// one turn, so its board carries these in its This turn block (2026-10 item 263 R3-29) and the
	// transcript records each once the board showing it was written. Empty for an inline table.
	turnLog: string[];
	seatingTimer: NodeJS.Timeout | null;
	// An inline table's lifetime clock: when the board was posted, and the timer that ends
	// the table TABLE_TIMEOUT_MS later plus any time the board spent drawing.
	openedAt: number;
	lifetimeTimer: NodeJS.Timeout | null;
	// A room table's turn clock (BLACKJACK_TURN_TIMEOUT_MS): the turn it counts and when that turn
	// started. The timer itself is the shared turn clock's (blackjackTurnClock below).
	clockTurn: string | null;
	clockStartedAt: number;
	// What each member who left walked away with, kept for the room's winner and its coins.
	cashedOut: Map<string, number>;
	// When a member last chose a bet, an action or a leave themselves; a timed out turn does not
	// count, so the idle sweep can still end a table nobody touches.
	actedAt: Date | null;
	// ⚠️ A room table's end claim, set synchronously before its finish, so a last settle and a
	// last leave in the same moment end the room once.
	ended: boolean;
	stop: () => void;
}

// One game per CHANNEL, matching hangman: the board is public and the channel
// plays it together. Process scoped, so a table open when Railway redeploys is
// lost; a room's table keeps its stacks on its row (see the header).
const games = new Map<string, BlackjackGame>();

// Test seams, matching hangmanHandler's convention.
export const _clearBlackjackGames = (): void => {
	for (const game of games.values()) clearGameTimers(game);
	games.clear();
};

function clearGameTimers(game: BlackjackGame): void {
	if (game.seatingTimer) clearTimeout(game.seatingTimer);
	if (game.lifetimeTimer) clearTimeout(game.lifetimeTimer);
	if (game.roomId) disarmTurnClock({ guildId: game.guildId, roomId: game.roomId }, "blackjack");
}
export const _activeBlackjackGameCount = (): number => games.size;
// The live table in a channel, so a test can stack the shoe before the deal it wants to see.
export const _blackjackTableOf = (channelId: string): BlackjackTable | null => games.get(channelId)?.table ?? null;

// True while this channel holds a live table in THIS process. The boot recovery sweep
// asks this for every blackjack room it finds: a room row that says "playing"
// while this answers false is a table Railway's SIGTERM already destroyed, and
// nothing inside this file will ever finish it.
export const hasLiveBlackjackTable = (channelId: string): boolean => games.has(channelId);

// Strip the buttons off a board whose table no longer exists, so a dead hand does not
// sit in the room looking playable. Best effort by design: a solo room records no
// board message id, so the board is found by its customId prefix in recent history,
// and a miss (deleted, or scrolled past the window) costs nothing worse than a
// button that answers "interaction failed".
export async function disarmStaleBlackjackBoard(channel: Channel): Promise<void> {
	if (!channel.isTextBased() || channel.isDMBased()) return;
	const recent = await channel.messages.fetch({ limit: STALE_BOARD_FETCH_LIMIT }).catch(() => null);
	if (!recent) return;
	const prefix = `${PREFIX}:${channel.id}:`;
	for (const message of recent.values()) {
		if (message.author.id !== channel.client.user?.id) continue;
		// Only action rows carry buttons; a components-v2 container is a different top
		// level shape and is skipped by the narrowing rather than walked.
		const armed = message.components
			.flatMap((row) => (row.type === ComponentType.ActionRow ? row.components : []))
			.some((component) => component.type === ComponentType.Button && component.customId?.startsWith(prefix) === true);
		if (!armed) continue;
		await message.edit({ components: [] }).catch(() => undefined);
	}
}

// ── button rows ─────────────────────────────────────────────────────────────

function seatingRow(channelId: string): ActionRowBuilder<ButtonBuilder> {
	const c = gamesCopy.blackjack;
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder().setCustomId(customId(channelId, "join")).setLabel(c.joinLabel).setStyle(ButtonStyle.Success),
		new ButtonBuilder().setCustomId(customId(channelId, "leave")).setLabel(c.leaveLabel).setStyle(ButtonStyle.Secondary),
		new ButtonBuilder().setCustomId(customId(channelId, "deal")).setLabel(c.dealLabel).setStyle(ButtonStyle.Primary)
	);
}

// Leave is any seat's, on the clock or not (2026-10 item 254, Arcade 12), so it is never
// disabled; the engine refuses a member with no seat.
const leaveButton = (channelId: string): ButtonBuilder =>
	new ButtonBuilder().setCustomId(customId(channelId, "leave")).setLabel(gamesCopy.blackjack.leaveHandLabel).setStyle(ButtonStyle.Danger);

// Whether this channel's table plays from a turn line, so its board keeps no buttons.
const playsFromTurnLine = (channelId: string): boolean => games.get(channelId)?.promptsTurns === true;

// A betting board's one button, Leave, unless the turn line carries it: the bets themselves are
// buttons on the turn line.
function bettingRows(channelId: string): ActionRowBuilder<ButtonBuilder>[] {
	return playsFromTurnLine(channelId) ? [] : [new ActionRowBuilder<ButtonBuilder>().addComponents(leaveButton(channelId))];
}

// The board's move row, unless the turn line carries the moves and Leave.
function actionRows(channelId: string, table: BlackjackTable): ActionRowBuilder<ButtonBuilder>[] {
	return playsFromTurnLine(channelId) ? [] : [actionRow(channelId, table)];
}

// Built FROM legalActions rather than from a hand written condition, so a button
// that appears is always one applyAction will accept. Convention 17: one helper
// per concept, and here the concept is "what may this seat do right now".
function actionRow(channelId: string, table: BlackjackTable): ActionRowBuilder<ButtonBuilder> {
	const c = gamesCopy.blackjack;
	const acting = table.seats[table.turn];
	const allowed = acting ? legalActions(table, acting.userId) : [];
	const labels: Record<BlackjackAction, string> = {
		hit: c.hitLabel,
		stand: c.standLabel,
		double: c.doubleLabel,
		split: c.splitLabel,
	};
	const styles: Record<BlackjackAction, ButtonStyle> = {
		hit: ButtonStyle.Primary,
		stand: ButtonStyle.Secondary,
		double: ButtonStyle.Success,
		split: ButtonStyle.Success,
	};

	const row = new ActionRowBuilder<ButtonBuilder>();
	for (const action of ["hit", "stand", "double", "split"] as BlackjackAction[]) {
		row.addComponents(
			new ButtonBuilder()
				.setCustomId(customId(channelId, action))
				.setLabel(labels[action])
				.setStyle(styles[action])
				// Disabled rather than absent, so the row does not reflow under the
				// player's cursor between turns and mis-click into a Stand. A double or a
				// split the stack cannot cover is disabled the same way (2026-10 item 267).
				.setDisabled(!allowed.includes(action))
		);
	}
	// The fifth and last button a row holds.
	row.addComponents(leaveButton(channelId));
	return row;
}

// ── the slash entry point ───────────────────────────────────────────────────

export async function runBlackjack(interaction: ChatInputCommandInteraction): Promise<void> {
	const c = gamesCopy.blackjack;

	// The cooldown is read before the acknowledgement, so the command itself opens the
	// cooldown notice (2026-10 item 263 R3-12): a notice can only be the FIRST answer, and the
	// check is an in memory read. Outside a server there is no key; the refusal below answers.
	if (interaction.guildId) {
		const gate = cooldown.check(`${interaction.guildId}:${interaction.user.id}`);
		if (gate.onCooldown) {
			await showCooldownNotice(interaction, { title: gamesCopy.notices.blackjack, message: c.cooldownMessage(Math.ceil(gate.remainingMs / 1000)) });
			return;
		}
	}

	// The refusals the command can read in memory are notices before the acknowledgement,
	// while a modal can still open (owner rule 1 of the Round 3 list, 2026-10 item 263).
	const channel = interaction.channel;
	if (!(channel instanceof TextChannel) || !interaction.guildId) {
		await showNotice(interaction, { title: gamesCopy.notices.blackjack, sections: [c.outsideGuild] });
		return;
	}
	if (games.has(channel.id)) {
		await showNotice(interaction, { title: gamesCopy.notices.blackjack, sections: [c.alreadyRunning] });
		return;
	}

	// The table itself posts where the command ran; the member's own answer (seated) posts
	// where it was pressed (2026-10 item 257 Phase 5), and a state met from here on is a private notice.
	const answer = await beginChannelAnswer(interaction, "here");

	const solo = interaction.options.getString("mode") !== "table";
	const host = { userId: interaction.user.id, username: interaction.user.globalName ?? interaction.user.username };
	const result = await startBlackjackTable(channel, interaction.guildId, host, solo);

	// A table opened since the press check: the race, answered as the same notice.
	if (result === "alreadyRunning") {
		await showPendingNotice(interaction, answer, { title: gamesCopy.notices.blackjack, sections: [c.alreadyRunning] });
		return;
	}
	if (result === "failed") {
		await answer.send({ embeds: [errorEmbed(c.noChannel)] });
		return;
	}

	cooldown.record(`${interaction.guildId}:${interaction.user.id}`);
	await answer.send({
		embeds: [infoEmbed(c.tableTitle, solo ? c.joined : c.seatingDescription(interaction.user.id), COLORS.GAME_BLACKJACK)],
	});
}

export type BlackjackStartResult = "started" | "alreadyRunning" | "failed";

// ── the shared core ─────────────────────────────────────────────────────────
// Split out from runBlackjack for the same two reasons startHangmanRound is:
// a second entry point (a dashboard button, say) must not drift from the slash
// path, and everything interesting here is reachable in a test without
// constructing a real ChatInputCommandInteraction. runBlackjack above is now
// only interaction plumbing: defer, guard, cooldown, delegate, reply.
export async function startBlackjackTable(
	channel: TextChannel,
	guildId: string,
	host: { userId: string; username: string },
	// True deals at once with whoever is seated: a solo hand, or a room's table whose
	// players are already known. False posts the seating board and its join window.
	dealNow: boolean,
	// The GameRoom this table plays inside (soloRooms). The inline forms pass nothing.
	roomId: string | null = null,
	// The room's other players, seated after the host in this order. Only a room's table
	// passes them; the engine refuses an action from anyone not seated, which is what
	// keeps a watcher in an open room from playing a hand.
	otherSeats: ReadonlyArray<{ userId: string; username: string }> = [],
	// What a room's table plays for (2026-10 item 267). A room's table with none named plays
	// free on the standard stack; an inline table never has one.
	bankroll: TableBankroll | null = null,
	// A network table posts no turn line (turnPrompt skips it), so its board keeps every button.
	network = false
): Promise<BlackjackStartResult> {
	// ① Claim the channel slot SYNCHRONOUSLY, the same discipline hangman uses:
	// the check and the write sit adjacent with no await between them, so two
	// members racing the command in one channel cannot both open a table.
	if (games.has(channel.id)) return "alreadyRunning";

	const game: BlackjackGame = {
		hostId: host.userId,
		guildId,
		seated: [host, ...otherSeats.slice(0, MAX_SEATS - 1)],
		table: null,
		settled: false,
		roomId,
		// Known from the first board, so even the opening deal keeps its moves and Leave on the
		// turn line rather than on the card.
		promptsTurns: roomId !== null && !network,
		bankroll: roomId ? (bankroll ?? { buyIn: BOT_CONSTANTS.HOLDEM_STARTING_STACK, chips: false }) : null,
		board: null,
		resultBoardId: null,
		seatingTimer: null,
		openedAt: Date.now(),
		lifetimeTimer: null,
		clockTurn: null,
		clockStartedAt: 0,
		cashedOut: new Map(),
		actedAt: null,
		ended: false,
		stop: () => undefined,
		turnLog: [],
	};
	games.set(channel.id, game);

	try {
		if (game.bankroll) {
			await openBankrollTable(game, channel, game.bankroll);
			return "started";
		}

		// ② A solo game deals straight away. A join window for one player is a
		// countdown to nothing, so solo never renders the seating board at all.
		let board: Message;
		let settledOnDeal = false;
		if (dealNow) {
			const { table, embed } = dealAndRender(game);

			// ⚠️ A NATURAL ENDS THE HAND BEFORE A SINGLE BUTTON EXISTS. createTable
			// marks it and advances the turn pointer straight past the seat, so the
			// table is already in the dealer phase here. Roughly one opening hand in
			// twenty is a natural, and without this the seat would get a board whose
			// every button is disabled, pay nothing, and sit dead until the collector
			// timed out ten minutes later. The table paths (dealInto, closeSeating)
			// each carry the same check for the same reason.
			const result = table.phase === "dealer" ? settleGame(game, channel.id, channel.client) : null;
			settledOnDeal = result !== null;

			// The opening deal draws before it posts: there is no board yet to put the
			// drawing status on, and the table's lifetime only starts once it is posted.
			board = await channel.send({
				...(result ? await resultParts(result) : await tableParts(table, embed)),
				components: result ? [] : actionRows(channel.id, table),
				allowedMentions: { parse: [] },
			});
		} else {
			board = await channel.send({
				embeds: [seatingEmbed(game)],
				components: [seatingRow(channel.id)],
				allowedMentions: { parse: [] },
			});
		}

		// ③ Nothing is clickable until the collector is wired, and the gap is one
		// tick, so a click cannot arrive early. Wired even for a hand that already
		// settled above, because its end handler is the ONE path that drops the map
		// entry; stopping it immediately runs that handler rather than leaving the
		// channel occupied by a finished game.
		wireBoardCollector(game, channel.id, board);
		if (settledOnDeal) game.stop();

		// ④ The window closes itself. Without this a table whose host never presses
		// Deal would sit in the seating phase until the collector's own timeout,
		// which is thirteen times longer.
		if (!dealNow) {
			game.seatingTimer = setTimeout(() => {
				void closeSeating(channel.id, board);
			}, SEATING_WINDOW_MS);
		}

		return "started";
	} catch (error) {
		// Release the slot so a failed send does not lock the channel out of
		// blackjack for the life of the process.
		clearGameTimers(game);
		games.delete(channel.id);
		console.warn(`[mini-game] blackjack could not post a board in channel ${channel.id}`, error);
		return "failed";
	}
}

// A room's table (2026-10 item 267): every seat sits with a stack of the buy in, the first
// board is the first hand's betting board, and the first seat is prompted for its bet.
async function openBankrollTable(game: BlackjackGame, channel: TextChannel, bankroll: TableBankroll): Promise<void> {
	const table = createBankrollTable({ players: game.seated, buyIn: bankroll.buyIn });
	game.table = table;
	const board = await channel.send({ embeds: [bettingEmbedOf(game, table)], components: bettingRows(channel.id), allowedMentions: { parse: [] } });
	wireChannelCollector(game, channel);
	game.board = board;
	// The idle sweep's clock starts at the open: nobody has acted yet, and a table nobody
	// ever bets at still ends 30 minutes on.
	noteMemberAction(game);
	await promptTurn(game, channel.client);
}

// ── the collectors, one per game ────────────────────────────────────────────

const isTableClick = (channelId: string, id: string): boolean => id.startsWith(`${PREFIX}:${channelId}:`);

// An inline table: its one board message.
function wireBoardCollector(game: BlackjackGame, channelId: string, board: Message): void {
	game.board = board;
	// No `time` option: the table's lifetime is armLifetime's timer below, which can
	// hold while the board draws. The collector's own limit cannot.
	const collector = board.createMessageComponentCollector({ componentType: ComponentType.Button, filter: (i) => isTableClick(channelId, i.customId) });
	listen(game, channelId, collector);
	game.openedAt = Date.now();
	armLifetime(game, channelId);
}

// A room's table: its whole channel, since every hand posts a fresh board (see the header).
function wireChannelCollector(game: BlackjackGame, channel: TextChannel): void {
	const collector = channel.createMessageComponentCollector({ componentType: ComponentType.Button, filter: (i) => isTableClick(channel.id, i.customId) });
	listen(game, channel.id, collector);
}

function listen(game: BlackjackGame, channelId: string, collector: { on: (event: "collect" | "end", listener: (arg: unknown) => void) => unknown; stop: () => void }): void {
	game.stop = () => collector.stop();
	collector.on("collect", (click) => {
		void onClick(click as ButtonInteraction, channelId);
	});
	// The single cleanup path, firing on stop() from a settle, a table's end and the lifetime
	// timer, so no exit leaves a map entry or a timer behind.
	collector.on("end", () => {
		const stale = games.get(channelId);
		if (stale) clearGameTimers(stale);
		games.delete(channelId);
	});
}

// ── an inline table's lifetime ──────────────────────────────────────────────
// TABLE_TIMEOUT_MS from the post, plus every millisecond the board spent drawing,
// so a render never ends a table early (the drawing pause). When the timer fires
// mid draw it waits for the draw to finish, then measures again: the held time
// has pushed the deadline on, so it re-arms rather than ending the table.
function armLifetime(game: BlackjackGame, channelId: string): void {
	const remaining = pausedDeadline(drawingKeyOf(channelId), game.openedAt, TABLE_TIMEOUT_MS) - Date.now();
	game.lifetimeTimer = setTimeout(() => {
		void endLifetimeIfDue(game, channelId);
	}, Math.max(0, remaining));
}

async function endLifetimeIfDue(game: BlackjackGame, channelId: string): Promise<void> {
	await drawingSettled(drawingKeyOf(channelId));
	// A table that settled while this waited is already gone; stopping it again
	// would run the cleanup on whatever table took the channel since.
	if (games.get(channelId) !== game) return;
	if (isClockExpired(drawingKeyOf(channelId), game.openedAt, TABLE_TIMEOUT_MS)) {
		game.stop();
		return;
	}
	armLifetime(game, channelId);
}

// ── a room table's turn clock (2026-10 item 267, owner decisions 7 and 15) ─────
// One clock per table, for whichever turn the table waits on, run by the shared turn clock
// (turnClock.ts): it warns the seat before the turn runs out and calls runOutTurnIfDue at the
// deadline, where a betting turn bets the seat's smallest choice and an action turn stands. The
// turn's start is kept here, since the table lives in this process: promptTurn notes it when a new
// turn begins, and the same turn keeps it. Held while the board draws, like every clock here.
// Neither timed out move counts as the member acting.

function noteTurnStart(game: BlackjackGame): void {
	const turn = game.table ? fingerprintOfTable(game.table) : null;
	if (turn === game.clockTurn) return;
	game.clockTurn = turn;
	game.clockStartedAt = Date.now();
}

// The turn ran out: bet the smallest choice or stand for the seat. Answers whether a timed out
// move was played; false for a turn played while this waited on a draw, or a table gone since.
async function runOutTurnIfDue(game: BlackjackGame, channelId: string): Promise<boolean> {
	await drawingSettled(drawingKeyOf(channelId));
	const table = game.table;
	const turn = game.clockTurn;
	if (games.get(channelId) !== game || !table || !game.board || !turn || fingerprintOfTable(table) !== turn) return false;
	if (!isClockExpired(drawingKeyOf(channelId), game.clockStartedAt, BOT_CONSTANTS.BLACKJACK_TURN_TIMEOUT_MS)) return false;
	game.clockTurn = null;
	// The room may have ended another way (the idle sweep, a deleted channel), which already
	// paid its stacks: this table then stops playing instead of dealing on in a closed room.
	if (!(await isRoomStillPlaying(game))) {
		retireTable(game);
		return false;
	}
	// The seat is read after the room read, but the move carries the turn this clock counted, so
	// a seat the turn moved to while it waited is never bet or stood for (2026-10 item 276).
	const client = game.board.client;
	const writer = messageWriter(game.board);
	const timedOut: MoveSource = { timedOut: true, turn };
	const betting = bettingSeat(table);
	if (betting) {
		const smallest = betChoices(table, betting.userId)[0];
		if (!smallest) return false;
		return (await placeBlackjackBet(game, channelId, betting.userId, smallest.amount, client, writer, timedOut)) === "played";
	}
	const acting = table.phase === "playing" ? table.seats[table.turn] : undefined;
	if (!acting) return false;
	return (await playBlackjackAction(game, channelId, acting.userId, "stand", client, writer, timedOut)) === "played";
}

// Takes no Message: every render on the click path goes through click.update(),
// which uses the click's own fresh token rather than the board reference. That
// is what keeps a table editable past the 15 minute interaction token life.
async function onClick(click: ButtonInteraction, channelId: string): Promise<void> {
	const game = games.get(channelId);
	if (!game) return;
	const c = gamesCopy.blackjack;
	const action = actionOf(click.customId);

	// ── seating phase ──
	if (!game.table) {
		if (action === "join") {
			if (game.seated.some((seat) => seat.userId === click.user.id)) {
				await showNotice(click, { title: gamesCopy.notices.blackjack, sections: [c.alreadySeated] });
				return;
			}
			if (game.seated.length >= MAX_SEATS) {
				await showNotice(click, { title: gamesCopy.notices.blackjack, sections: [c.tableFull] });
				return;
			}
			game.seated.push({ userId: click.user.id, username: click.user.globalName ?? click.user.username });
			await click.update({ embeds: [seatingEmbed(game)], components: [seatingRow(channelId)] });
			return;
		}

		if (action === "leave") {
			const before = game.seated.length;
			game.seated = game.seated.filter((seat) => seat.userId !== click.user.id);
			if (game.seated.length === before) {
				await showNotice(click, { title: gamesCopy.notices.blackjack, sections: [c.notSeated] });
				return;
			}
			await click.update({ embeds: [seatingEmbed(game)], components: [seatingRow(channelId)] });
			return;
		}

		if (action === "deal") {
			// Only the host may cut the window short. Any seated member could
			// otherwise deal the moment they sat, which defeats the window.
			if (click.user.id !== game.hostId) {
				await showNotice(click, { title: gamesCopy.notices.blackjack, sections: [c.hostOnlyDeal] });
				return;
			}
			if (game.seatingTimer) clearTimeout(game.seatingTimer);
			game.seatingTimer = null;
			await dealInto(game, channelId, click);
		}
		return;
	}

	// ── playing phase ──
	if (action === "leave") {
		// A chip table asks first, saying the stack is cashed out and the hand in play lost
		// (2026-10 item 276, owner decisions D6 and D9); its Submit is confirmBlackjackLeave.
		const cashOut = game.roomId && game.bankroll?.chips && game.table ? cashOutIfLeaving(game.table, click.user.id) : null;
		if (cashOut !== null && game.roomId) {
			await showConfirm(click, { title: gamesCopy.notices.blackjack, sections: [gameRoomsCopy.confirms.leaveBlackjackTable(cashOut)], confirmId: confirmCustomId("bleaveok", game.roomId) });
			return;
		}
		await leaveDuringHand(click, game, channelId);
		return;
	}
	if (!BLACKJACK_ACTIONS.includes(action)) return;

	const played = await playBlackjackAction(game, channelId, click.user.id, action as BlackjackAction, click.client, clickWriter(click));
	if (played === "not-your-turn") {
		const seated = game.table.seats.some((seat) => seat.userId === click.user.id);
		await showNotice(click, { title: gamesCopy.notices.blackjack, sections: [seated ? c.notYourTurn : c.notPlaying] });
		return;
	}
	if (played === "illegal") await showNotice(click, { title: gamesCopy.notices.blackjack, sections: [c.illegalAction] });
}

const BLACKJACK_ACTIONS: readonly string[] = ["hit", "stand", "double", "split"];

// "passed": the turn the move was for is no longer the table's (a double press, the clock).
type PlayResult = "played" | "not-your-turn" | "illegal" | "passed";

// How a move came to be played: by the member, or by the turn clock for them. `turn` is the
// table's fingerprint the move was decided on, from the turn line or the clock; a board button
// carries none and plays whatever turn the table is on.
interface MoveSource {
	timedOut: boolean;
	turn?: string;
}

// ⚠️ THE CLAIM ON A TURN (2026-10 item 276, audit P2-12). A turn line press checks the turn's
// fingerprint, then awaits the row, the played mark and the acknowledgement before the move
// applies, so a double press passed the check twice and played twice (two Hits). The table lives
// in this process, so checking the fingerprint in the same synchronous step that applies the move
// IS the claim: the first press moves the fingerprint on, and the second meets a passed turn.
// The turn clock claims the same way, so it never acts for a seat the turn moved to while it
// waited on the room read.
const turnHasPassed = (table: BlackjackTable, source: MoveSource): boolean => source.turn !== undefined && fingerprintOfTable(table) !== source.turn;

const BY_MEMBER: MoveSource = { timedOut: false };

/**
 * One seat's action against the table, from a board button, the turn modal or the turn clock:
 * the SAME path (2026-10 item 257 Phase 4a), so an action never has two implementations.
 * `writer` is how the board is rewritten, the click's own token or the board message itself.
 */
async function playBlackjackAction(
	game: BlackjackGame,
	channelId: string,
	userId: string,
	action: BlackjackAction,
	client: Message["client"],
	writer: BoardWriter,
	source: MoveSource = BY_MEMBER
): Promise<PlayResult> {
	if (!game.table) return "illegal";
	if (turnHasPassed(game.table, source)) return "passed";
	const handIndex = game.table.seats.find((seat) => seat.userId === userId)?.activeHand ?? 0;
	const outcome = applyAction(game.table, userId, action);
	if (outcome.status === "not-your-turn") return "not-your-turn";
	if (outcome.status === "illegal") return "illegal";
	if (!source.timedOut) noteMemberAction(game);
	const move = logHandMove(game, userId, action, handIndex, source);

	// The hand may have ended on this very action. Settling BEFORE the render
	// means the player sees one final board rather than a live board that is
	// replaced a moment later.
	if (game.table.phase === "dealer") {
		// The action that ended the hand is the hand's last line, on the hand's own board.
		const closing = move ? { block: turnBlockLines(game.turnLog), moves: [move] } : undefined;
		if (game.bankroll) {
			await finishHand(game, channelId, client, writer, closing);
			return "played";
		}
		const result = settleGame(game, channelId, client);
		if (result) {
			await redrawResult(channelId, result, writer);
			game.stop();
			return "played";
		}
	}

	await redrawTable(channelId, game.table, writer, tableEmbedOf(game, game.table), move ? [move] : []);
	await promptTurn(game, client);
	return "played";
}

/**
 * One seat's bet at a room's table (2026-10 item 267), from the turn modal or the turn clock:
 * the one path a bet has. The last seat's bet deals the hand, and a hand of naturals all round
 * settles at once.
 */
async function placeBlackjackBet(
	game: BlackjackGame,
	channelId: string,
	userId: string,
	amount: number,
	client: Message["client"],
	writer: BoardWriter,
	source: MoveSource = BY_MEMBER
): Promise<PlayResult> {
	const table = game.table;
	if (!table) return "illegal";
	if (turnHasPassed(table, source)) return "passed";
	const outcome = placeBet(table, userId, amount);
	if (outcome.status !== "ok") return outcome.status;
	if (!source.timedOut) noteMemberAction(game);
	const copy = gameRoomsCopy.turnBoard;
	const line = source.timedOut ? copy.blackjackTimedOutBet(userId, amount) : copy.blackjackBet(userId, amount);
	game.turnLog.push(line);
	const move: RoomMoveInput = { actorId: userId, kind: "guess", text: line };

	if (table.phase === "dealer") {
		await finishHand(game, channelId, client, writer, { block: turnBlockLines(game.turnLog), moves: [move] });
		return "played";
	}
	await redrawCurrent(game, channelId, writer, [move]);
	await promptTurn(game, client);
	return "played";
}

/**
 * A room table's line for one action, added to the hand's lines, or null for an inline table,
 * which keeps no transcript. Read after the action, off the hand it was played on: the hand it
 * left and its total, the way the block reads the hand back.
 */
function logHandMove(game: BlackjackGame, userId: string, action: BlackjackAction, handIndex: number, source: MoveSource): RoomMoveInput | null {
	const seat = game.table?.seats.find((candidate) => candidate.userId === userId);
	const hand = seat?.hands[handIndex];
	if (!game.roomId || !hand) return null;
	const copy = gameRoomsCopy.turnBoard;
	const cards = renderHand(hand.cards);
	const total = renderTotal(hand.cards);
	const lines: Record<BlackjackAction, string> = {
		hit: copy.blackjackHit(userId, cards, total),
		stand: source.timedOut ? copy.blackjackTimedOutStand(userId, total) : copy.blackjackStand(userId, total),
		double: copy.blackjackDouble(userId, cards, total),
		split: copy.blackjackSplit(userId, cards),
	};
	game.turnLog.push(lines[action]);
	return { actorId: userId, kind: "guess", text: lines[action] };
}

// The table embed with the hand's This turn block when it plays in a room.
function tableEmbedOf(game: BlackjackGame, table: BlackjackTable): EmbedBuilder {
	const embed = buildBlackjackTableEmbed(table, false);
	return game.roomId && game.turnLog.length > 0 ? setTurnBlock(embed, turnBlockLines(game.turnLog)) : embed;
}

// A room table's betting board, with the hand's This turn block once anybody bet.
function bettingEmbedOf(game: BlackjackGame, table: BlackjackTable): EmbedBuilder {
	const embed = buildBlackjackBettingEmbed(table, !(game.bankroll?.chips ?? false));
	return game.turnLog.length > 0 ? setTurnBlock(embed, turnBlockLines(game.turnLog)) : embed;
}

// A room table's board as its phase shows it: the bets being taken, or the hand in play.
function redrawCurrent(game: BlackjackGame, channelId: string, writer: BoardWriter, carried: readonly RoomMoveInput[] = []): Promise<void> {
	const table = game.table;
	if (!table) return Promise.resolve();
	if (table.phase === "betting") return redrawBoard(channelId, writer, async () => null, bettingEmbedOf(game, table), bettingRows(channelId), carried);
	return redrawTable(channelId, table, writer, tableEmbedOf(game, table), carried);
}

// ── leaving (2026-10 item 254, Arcade 12; the bankroll since item 267) ──
// The seat gives its hand up as a loss (applyLeave), then the table goes on exactly as
// after an action: settled if nobody is left to act, redrawn otherwise. At a room's table the
// seat takes its stack with it, at once: a chip table claims its ledger entry and credits the
// wallet, so a leave racing the table's end pays once. An inline table plays for no chips, so
// a loss there costs what any lost hand costs and refunds nothing.
async function leaveDuringHand(click: ButtonInteraction, game: BlackjackGame, channelId: string): Promise<void> {
	const c = gamesCopy.blackjack;
	if (!game.table) return;
	const outcome = applyLeave(game.table, click.user.id);
	if (outcome.status !== "left") {
		const refusal = outcome.status === "already-left" ? c.leftAlready : c.notPlaying;
		await showNotice(click, { title: gamesCopy.notices.blackjack, sections: [refusal] });
		return;
	}
	if (game.bankroll) {
		// The member chose to leave, so the idle sweep's clock starts again; a server leave does not.
		noteMemberAction(game);
		await leaveBankrollTable(game, channelId, click.user.id, outcome.cashOut, click.client, clickSurface(click));
		await answerInChannel(click, "here", { content: game.bankroll.chips ? c.leftWithChips(outcome.cashOut) : c.leftFreeTable });
		return;
	}

	const result = game.table.phase === "dealer" ? settleGame(game, channelId, click.client) : null;
	if (result) await redrawResult(channelId, result, clickWriter(click));
	else await redrawTable(channelId, game.table, clickWriter(click), tableEmbedOf(game, game.table));
	await answerInChannel(click, "here", { content: c.leftHand });
	if (result) game.stop();
}

// What a seat would walk away with if it left now, or null when it is not at the table: a bet
// placed in the betting turn comes back with it (applyLeave), a hand in play is lost.
function cashOutIfLeaving(table: BlackjackTable, userId: string): number | null {
	const seat = table.seats.find((candidate) => candidate.userId === userId);
	if (!seat || seat.out) return null;
	return table.phase === "betting" ? seat.stack + seat.bet : seat.stack;
}

/**
 * Leave's confirm at a chip table (2026-10 item 276, D6 and D9): its Submit, or the fallback
 * reply's button, routed through the game room confirms. The same leave the press made before it
 * asked, on the board message rather than the click, since a confirm is no board click.
 */
export async function confirmBlackjackLeave(interaction: ConfirmInteraction, channelId: string): Promise<void> {
	const c = gamesCopy.blackjack;
	const game = games.get(channelId);
	if (!game?.table || !game.bankroll || !game.board || game.ended) {
		await showNotice(interaction, { title: gamesCopy.notices.blackjack, sections: [c.notPlaying] });
		return;
	}
	const outcome = applyLeave(game.table, interaction.user.id);
	if (outcome.status !== "left") {
		await showNotice(interaction, { title: gamesCopy.notices.blackjack, sections: [outcome.status === "already-left" ? c.leftAlready : c.notPlaying] });
		return;
	}
	noteMemberAction(game);
	await acknowledgeConfirm(interaction);
	await leaveBankrollTable(game, channelId, interaction.user.id, outcome.cashOut, game.board.client, boardSurface(game.board));
	await answerInChannel(interaction, "here", { content: game.bankroll.chips ? c.leftWithChips(outcome.cashOut) : c.leftFreeTable });
}

/**
 * A member left the server while seated at a room's table (roomDeparture, 2026-10 item 276,
 * audit P1-4): the seat leaves exactly as their Leave would, its hand lost and its stack cashed
 * out, and the table plays on, or ends when nobody is left. Answers whether a seat left; false
 * when this process holds no live table for the channel or the member had already left it.
 */
export async function leaveBlackjackRoomSeat(channelId: string, userId: string): Promise<boolean> {
	const game = games.get(channelId);
	if (!game?.table || !game.bankroll || !game.board || game.ended) return false;
	const outcome = applyLeave(game.table, userId);
	if (outcome.status !== "left") return false;
	// The board message was fetched by this very process, so its client is the ready one.
	await leaveBankrollTable(game, channelId, userId, outcome.cashOut, game.board.client, boardSurface(game.board));
	return true;
}

// How a leave reaches the board: the Leave click answers through its own token, while a server
// leave has no click and edits the board message itself (the turn clock's way).
interface LeaveSurface {
	writer: BoardWriter;
	// Acknowledge without drawing, for a hand that is still posting its result.
	acknowledge: () => Promise<unknown>;
	// Take the board's buttons off, for a table nobody is left at.
	clearButtons: () => Promise<unknown>;
}

const clickSurface = (click: ButtonInteraction): LeaveSurface => ({
	writer: clickWriter(click),
	acknowledge: () => click.deferUpdate(),
	clearButtons: () => click.update({ components: [] }),
});

const boardSurface = (board: Message): LeaveSurface => ({
	writer: messageWriter(board),
	acknowledge: () => Promise.resolve(),
	clearButtons: () => board.edit({ components: [] }),
});

// The one seat leave at a room's table, after applyLeave took the seat out: Leave's press and a
// server leave both come here, so a seat has one way off the table.
async function leaveBankrollTable(game: BlackjackGame, channelId: string, userId: string, cashOut: number, client: Message["client"], surface: LeaveSurface): Promise<void> {
	const c = gamesCopy.blackjack;
	const table = game.table;
	const bankroll = game.bankroll;
	if (!table || !bankroll || !game.roomId) return;
	const room = { guildId: game.guildId, roomId: game.roomId, channelId };
	game.cashedOut.set(userId, cashOut);
	if (bankroll.chips) await cashOutBlackjackSeat(room, userId, cashOut);
	void roomTrail
		.postMove(client, room, { actorId: userId, kind: "forfeit", text: c.leftTableTrail(userId, cashOut, bankroll.chips) })
		.catch((error) => console.warn("[mini-game] the left the table line could not be posted", { roomId: room.roomId, error }));

	if (table.phase === "dealer") await finishHand(game, channelId, client, surface.writer);
	// A hand that just paid is still posting its result and the next board, which leave this
	// seat out (or end the table) on their own, so there is nothing to redraw here.
	else if (table.phase === "settled") await surface.acknowledge().catch(() => undefined);
	else if (isTableOver(table)) {
		// Nobody is left to bet or act, so the board loses its buttons and the room ends.
		await surface.clearButtons().catch(() => undefined);
		await endTable(game, client);
	} else {
		await redrawCurrent(game, channelId, surface.writer);
		await promptTurn(game, client);
	}
}

// ── phase transitions ───────────────────────────────────────────────────────

function seatingEmbed(game: BlackjackGame): EmbedBuilder {
	return buildBlackjackSeatingEmbed(
		game.hostId,
		game.seated.map((seat) => seat.userId),
		Math.round(SEATING_WINDOW_MS / 1000)
	);
}

// Deals and returns the first render. Split out because the solo path deals
// during the initial send and the table path deals from a click, and both must
// produce an identical table.
// Returns the table alongside the embed rather than leaving callers to read
// game.table back: after a `if (game.table) return` guard TypeScript has
// narrowed the field to null and cannot see this assignment, so every caller
// would otherwise need a cast that asserts away a genuinely useful check.
function dealAndRender(game: BlackjackGame): { table: BlackjackTable; embed: EmbedBuilder } {
	const table = createTable({ players: game.seated });
	game.table = table;
	return { table, embed: buildBlackjackTableEmbed(table, false) };
}

async function dealInto(game: BlackjackGame, channelId: string, click: ButtonInteraction): Promise<void> {
	const { table, embed } = dealAndRender(game);

	// Everyone may have been dealt a natural, in which case nobody acts and the
	// dealer is already up. createTable settles the turn pointer through the same
	// path an action would, so this is a real case rather than a defensive one.
	if (table.phase === "dealer") {
		const result = settleGame(game, channelId, click.client);
		if (result) {
			await redrawResult(channelId, result, clickWriter(click));
			game.stop();
			return;
		}
	}

	await redrawTable(channelId, table, clickWriter(click), embed);
}

async function closeSeating(channelId: string, board: Message): Promise<void> {
	const game = games.get(channelId);
	if (!game || game.table) return;
	const c = gamesCopy.blackjack;

	// The host is seated from creation, so an empty table is impossible unless the
	// host left. Handled rather than assumed away: createTable with zero seats
	// would deal to nobody and hand straight to a dealer with nothing to beat.
	if (game.seated.length === 0) {
		await board.edit({ embeds: [errorEmbed(c.nobodyCame)], components: [] }).catch(() => undefined);
		game.stop();
		return;
	}

	const { table, embed } = dealAndRender(game);
	if (table.phase === "dealer") {
		const result = settleGame(game, channelId, board.client);
		if (result) {
			await redrawResult(channelId, result, messageWriter(board));
			game.stop();
			return;
		}
	}
	await redrawTable(channelId, table, messageWriter(board), embed);
}

// ── settlement ──────────────────────────────────────────────────────────────

// What a settle hands its caller: the result embed, and the settled table and
// seat results the result card is drawn from.
interface SettledTable {
	embed: EmbedBuilder;
	table: BlackjackTable;
	results: SeatResult[];
}

// ── drawing the board ───────────────────────────────────────────────────────
// Every view is built INSIDE its render function, so a view that throws costs the
// picture and not the turn or the result: the text embed posts on its own.

// The board's key in the drawing pause. One table per channel, so the channel names it.
const drawingKeyOf = (channelId: string): string => `blackjack:${channelId}`;

const drawTableCard = (table: BlackjackTable): Promise<RenderPayload | null> => renderBlackjackTableCard(blackjackTableView(table));
const drawResultCard = (settled: SettledTable): Promise<RenderPayload | null> =>
	renderBlackjackResultCard(blackjackResultView(settled.table, settled.results));

/** What a board message carries: the card in the embed's image slot when it drew, the embed alone when it did not. */
interface BoardParts {
	embeds: EmbedBuilder[];
	files: AttachmentBuilder[];
}

function boardParts(embed: EmbedBuilder, drawn: RenderPayload | null): BoardParts {
	if (drawn) return { embeds: [embed.setImage(drawn.ref)], files: [drawn.attachment] };
	return { embeds: [embed], files: [] };
}

// The opening post's parts, drawn before it is sent (the deal and a dealt natural).
async function tableParts(table: BlackjackTable, embed: EmbedBuilder): Promise<BoardParts> {
	return boardParts(embed, await withRenderFallback(() => drawTableCard(table), () => null));
}

async function resultParts(settled: SettledTable): Promise<BoardParts> {
	return boardParts(settled.embed, await withRenderFallback(() => drawResultCard(settled), () => null));
}

/**
 * The two ways a board is rewritten. A click answers through its own fresh token:
 * the status as the click's update, the board as its edited reply, which is what
 * keeps a table editable past the 15 minute token life. The seating timer, the turn
 * modal and the turn clock have no click, so they edit the board message itself.
 */
interface BoardWriter {
	showStatus: (status: string) => Promise<unknown>;
	write: (payload: MessageEditOptions) => Promise<unknown>;
}

const clickWriter = (click: ButtonInteraction): BoardWriter => ({
	showStatus: (status) => click.update({ content: status }),
	write: (payload) => click.editReply(payload),
});

const messageWriter = (board: Message): BoardWriter => ({
	showStatus: (status) => board.edit({ content: status }),
	write: (payload) => board.edit(payload),
});

// A room table's RESULT posts as a fresh message through the shared turn board, so the dealer's
// revealed hand is the last thing in the room instead of an edit buried under the turn prompts
// (2026-10 item 257 Phase 4a), and the hand's board STAYS above it with its buttons off and its
// This turn block finished by `closing`, the move that ended the hand (item 263 R3-29). The
// base writer still takes the status line, which is what acknowledges a click. The result's id
// is kept, so the next hand's board posts after it.
function resultWriter(game: BlackjackGame, base: BoardWriter, closing?: { block: readonly string[]; moves: readonly RoomMoveInput[] }): BoardWriter {
	const board = game.board;
	const roomId = game.roomId;
	if (!roomId || !board) return base;
	return {
		showStatus: base.showStatus,
		write: async (payload) => {
			if (!board.channel.isSendable()) return;
			// A room table always plays in its room's guild text channel; the turn board only sends
			// in it and fetches the hand's board back. Claimed by nobody: the table lives in this
			// process with one writer, so the result is the table's board by being posted.
			const channel = board.channel as TextChannel;
			game.resultBoardId = await postTurnBoard(channel, { guildId: game.guildId, roomId }, board.id, { embeds: payload.embeds, files: payload.files, components: [] }, { boardField: null, ...(closing ? { closing } : {}) });
		},
	};
}

// Behind the drawing pause. `attachments: []` drops the previous turn's card, which
// an edit otherwise keeps, and `content: null` takes the drawing status back off.
// Cosmetic, so a failure is logged: the table in memory is the truth and the next
// action redraws it.
async function redrawBoard(
	channelId: string,
	writer: BoardWriter,
	render: () => Promise<RenderPayload | null>,
	embed: EmbedBuilder,
	components: ActionRowBuilder<ButtonBuilder>[],
	carried: readonly RoomMoveInput[] = []
): Promise<void> {
	await withDrawingPause({
		gameKey: drawingKeyOf(channelId),
		showStatus: writer.showStatus,
		render,
		fallback: () => null,
		swapIn: async (drawn) => {
			await writer.write({ ...boardParts(embed, drawn), components, content: null, attachments: [] });
			// After the write that shows them, the send first rule (roomTrail.recordCarriedMoves).
			const game = games.get(channelId);
			if (carried.length > 0 && game?.roomId) await roomTrail.recordCarriedMoves({ guildId: game.guildId, roomId: game.roomId }, carried);
		},
	}).catch((error) => console.warn(`[mini-game] blackjack could not redraw the board in channel ${channelId}`, error));
}

// The table in play, with its action row. `carried` is the move this redraw adds to the hand's block.
function redrawTable(
	channelId: string,
	table: BlackjackTable,
	writer: BoardWriter,
	embed: EmbedBuilder = buildBlackjackTableEmbed(table, false),
	carried: readonly RoomMoveInput[] = []
): Promise<void> {
	return redrawBoard(channelId, writer, () => drawTableCard(table), embed, actionRows(channelId, table), carried);
}

// The settled result, with nothing left to press.
function redrawResult(channelId: string, settled: SettledTable, writer: BoardWriter): Promise<void> {
	return redrawBoard(channelId, writer, () => drawResultCard(settled), settled.embed, []);
}

// An inline table's settle: plays the dealer, pays everyone, and returns the result embed with
// the table it settled. Returns null if this table has already settled, which is the guard that
// stops a double click or a timeout racing the last action from paying twice.
function settleGame(game: BlackjackGame, channelId: string, client: Message["client"]): SettledTable | null {
	if (!game.table || game.settled) return null;
	// ⚠️ Claimed synchronously, before anything awaits. Everything below is
	// in-process and pure until the award, which is itself fire and forget.
	game.settled = true;

	playDealer(game.table);
	const results = settle(game.table);

	// Fire and forget, per convention 7 and gameXp's own contract: a leveling
	// failure must never take down the message that shows the player their hand.
	// guildId is read off the game rather than off whichever message happens to be
	// in scope, because the settle callers reach here with different ones.
	awardBlackjackResult({
		client,
		guildId: game.guildId,
		channelId,
		seats: results,
		// Its channel and opening time key the coins, which no other table can share; its one
		// hand is the whole game, so the coins ride the hand.
		resultKey: `${channelId}:${game.openedAt}`,
		coinsPerHand: true,
	});

	return settledTableOf(game.table, results);
}

function settledTableOf(table: BlackjackTable, results: SeatResult[]): SettledTable {
	const anyDoubledLoss = results.some((seat) => seat.hands.some((outcome, index) => outcome === "lose" && seat.doubled[index]));
	return { embed: buildBlackjackResultEmbed(table, results, anyDoubledLoss), table, results };
}

// ── a room table's hand and its end (2026-10 item 267) ──────────────────────
// What:  the end of one hand: the dealer plays, the bets pay into the stacks (once, the
//        table's own claim), the stacks reach the row, the result posts, the broke are named,
//        and the next hand opens on its betting turns; or, with nobody left, the table ends.
// Why the stacks are written BEFORE the result posts: the result is a Discord write that can
//        stall or fail, and a restart in that gap must pay what the hand settled, not what the
//        table held before it.
async function finishHand(game: BlackjackGame, channelId: string, client: Message["client"], writer: BoardWriter, closing?: { block: readonly string[]; moves: readonly RoomMoveInput[] }): Promise<void> {
	const table = game.table;
	if (!table || !game.roomId) return;
	playDealer(table);
	const results = collectPayouts(table);
	if (!results) return;

	// Per hand XP stays (owner decision 7); the coins wait for the room's finish.
	awardBlackjackResult({ client, guildId: game.guildId, channelId, seats: results, resultKey: game.roomId, coinsPerHand: false });
	await persistStacks(game);
	await redrawResult(channelId, settledTableOf(table, results), resultWriter(game, writer, closing));
	callHandResults(game, client, table, results);
	await announceBroke(game, client, results);

	if (!startNextHand(table)) {
		await endTable(game, client);
		return;
	}
	game.turnLog = [];
	await postNextHandBoard(game, channelId);
	await promptTurn(game, client);
}

// Dero calls the hand in the match's call like a commentator (owner decision of 2026-10-29):
// the dealer's total or bust, then each seat's outcome, one clip. Fire and forget after the
// result board; announceToMatch speaks only when Dero is in this match's call and never throws.
function callHandResults(game: BlackjackGame, client: Message["client"], table: BlackjackTable, results: readonly SeatResult[]): void {
	const roomId = game.roomId;
	if (!roomId) return;
	const calls = deroBrainCopy.dealer.blackjackCalls;
	const dealerTotal = handValue(table.dealer.cards).total;
	const lines = [table.dealer.status === "bust" ? pickLine(calls.dealerBust)(dealerTotal) : pickLine(calls.dealerStands)(dealerTotal)];
	for (const result of results) for (const outcome of result.hands) lines.push(pickLine(calls[outcome])(result.username));
	void gameRoomStore
		.findByRoomId(game.guildId, roomId)
		.then((room) => (room ? announceToMatch(client, room, "commentary", lines.join(" ")) : undefined))
		.catch((error: unknown) => console.warn("[mini-game] the hand call could not be spoken", { roomId, error }));
}

// Every seat this hand left with no chips says so in the room, so the table knows why it stopped.
// A seat that went broke on an earlier hand was dealt nothing this one, so only the newly broke
// are among `results`.
async function announceBroke(game: BlackjackGame, client: Message["client"], results: readonly SeatResult[]): Promise<void> {
	const table = game.table;
	if (!table || !game.roomId) return;
	const dealt = new Set(results.map((result) => result.userId));
	for (const seat of table.seats) {
		if (seat.out !== "broke" || !dealt.has(seat.userId)) continue;
		await roomTrail
			.postMove(client, { guildId: game.guildId, roomId: game.roomId, channelId: game.board?.channelId ?? null }, { actorId: seat.userId, kind: "system", text: gamesCopy.blackjack.brokeTrail(seat.userId) })
			.catch((error) => console.warn("[mini-game] the out of chips line could not be posted", { roomId: game.roomId, error }));
	}
}

// The next hand's betting board, posted after the result through the shared turn board, so
// every hand keeps its own board in the room. The posted board becomes the one the modal and
// the clock edit; the channel collector already hears its buttons.
async function postNextHandBoard(game: BlackjackGame, channelId: string): Promise<void> {
	const table = game.table;
	const previous = game.board;
	if (!table || !game.roomId || !previous || !previous.channel.isSendable()) return;
	const channel = previous.channel as TextChannel;
	const postedId = await postTurnBoard(
		channel,
		{ guildId: game.guildId, roomId: game.roomId },
		game.resultBoardId ?? previous.id,
		{ embeds: [bettingEmbedOf(game, table)], components: bettingRows(channelId) },
		{ boardField: null }
	).catch((error) => {
		console.warn(`[mini-game] blackjack could not post the next hand's board in channel ${channelId}`, error);
		return null;
	});
	const posted = postedId ? await channel.messages.fetch(postedId).catch(() => null) : null;
	if (posted) game.board = posted;
	game.resultBoardId = null;
}

/**
 * The table is over: every seat is broke or gone. Its room finishes through roomLifecycle.finish
 * (the one writer of a date into archiveAt), which pays every stack still on the ledger; this
 * table's winner is the member who ended with the largest stack above their buy in, and the
 * room's coins pay once, only when this finish was the one that ended the room. A ranked table
 * is rated here too, on the same claim (rateBlackjackTable).
 */
async function endTable(game: BlackjackGame, client: Message["client"]): Promise<void> {
	const table = game.table;
	if (!table || !game.roomId || !game.bankroll || game.ended) return;
	// ⚠️ Claimed synchronously, before anything awaits (see `ended`).
	game.ended = true;
	disarmTurnClock({ guildId: game.guildId, roomId: game.roomId }, "blackjack");

	const finalStacks: FinalStack[] = table.seats.map((seat) => ({ userId: seat.userId, buyIn: game.bankroll?.buyIn ?? 0, stack: game.cashedOut.get(seat.userId) ?? seat.stack }));
	const roomId = game.roomId;
	try {
		const room = await gameRoomStore.findByRoomId(game.guildId, roomId);
		if (room) {
			const ended = await roomLifecycle.finish(client, room, { winnerId: bankrollWinnerOf(finalStacks) });
			const coinGame = room.game === "solo-blackjack" ? "solo-blackjack" : "blackjack";
			if (ended) {
				awardBlackjackTableCoins({ guildId: game.guildId, game: coinGame, roomId, stacks: finalStacks });
				rateBlackjackTable(room, table, finalStacks);
			}
		}
	} catch (error) {
		console.error("[mini-game] blackjack room finish failed", { roomId, error });
	}
	await promptTurn(game, client);
	game.stop();
}

/**
 * Rate a finished Blackjack table (2026-10 item 276, owner decision D8): one OpenSkill update
 * placing every seat by its final stack against its own buy in, a Leave counting at the stack
 * it cashed out (finalStacks reads cashedOut first), with the house as a fixed entrant. Called
 * only by the call that won finish's claim, so a table is rated once. recordHouseTableRatings
 * refuses what is not rated: a casual table, and a solo table against Dero (solo-blackjack is no
 * rated game). A table that settled fewer than BLACKJACK_MIN_RATED_HANDS hands writes its result
 * unrated, so opening a ranked table and leaving it at once moves no rating.
 */
function rateBlackjackTable(room: IGameRoom, table: BlackjackTable, finalStacks: readonly FinalStack[]): void {
	const results = finalStacks.map((entry) => ({ userId: entry.userId, net: entry.stack - entry.buyIn }));
	const rated = settledHandsOf(table) >= BOT_CONSTANTS.RATINGS.BLACKJACK_MIN_RATED_HANDS;
	void recordHouseTableRatings(room, results, room.kickedIds ?? [], { rated });
}

// The stacks after a settle (chip tables only) and when a member last acted, on the row.
async function persistStacks(game: BlackjackGame): Promise<void> {
	const table = game.table;
	if (!table || !game.roomId) return;
	const stacks = game.bankroll?.chips ? table.seats.filter((seat) => seat.out !== "left").map((seat) => ({ userId: seat.userId, stack: seat.stack })) : [];
	await saveBlackjackStacks({ guildId: game.guildId, roomId: game.roomId }, stacks, game.actedAt);
}

// A member chose a bet, an action or a leave: the idle sweep's clock starts again. Written at
// once and fire and forget, because a long hand of several seats can outlast the idle window
// between two settles.
function noteMemberAction(game: BlackjackGame): void {
	if (!game.roomId) return;
	game.actedAt = new Date();
	void saveBlackjackStacks({ guildId: game.guildId, roomId: game.roomId }, [], game.actedAt);
}

// Whether the room this table plays in is still playing. A read that fails answers yes, so a
// database blip never stops a live table; the next turn asks again.
async function isRoomStillPlaying(game: BlackjackGame): Promise<boolean> {
	if (!game.roomId) return true;
	const room = await gameRoomStore.findByRoomId(game.guildId, game.roomId).catch(() => undefined);
	if (room === undefined) return true;
	return room?.status === "playing";
}

// The room ended without this table: take the buttons off its board and drop it. Its stacks
// were paid by whatever finished the room.
function retireTable(game: BlackjackGame): void {
	game.ended = true;
	void game.board?.edit({ components: [] }).catch(() => undefined);
	game.stop();
}

// ── the turn prompt (turnPrompt.ts, 2026-10 item 257 Phase 4a) ────────
// What:  Blackjack's side of the shared turn piece, for a room's table, solo or multi seat. The
//        table lives in this file's process Map, so the adapter reads the game by the room's
//        channel. Every hand here is public, so the modal shows nothing the board does not: on a
//        betting turn the seat's stack and its bet choices (2026-10 item 267), on an action turn
//        the player's own cards, the dealer's up card and the moves that are legal, with any the
//        stack cannot cover named and why.
// How:   a bet plays through placeBlackjackBet and a move through playBlackjackAction, the
//        functions the turn clock and the board's buttons call, and the board is rewritten by
//        editing its message.

const MOVE_FIELD = "move";
const BET_FIELD = "bet";

const gameOf = (room: { channelId: string | null }): BlackjackGame | undefined => (room.channelId ? games.get(room.channelId) : undefined);

const actingSeat = (game: BlackjackGame | undefined) => (game?.table?.phase === "playing" ? game.table.seats[game.table.turn] : undefined);

// The turn the table waits on, as the prompt's fingerprint (no colons): the hand number keeps a
// turn of one hand from reading as the same turn of the next.
function fingerprintOfTable(table: BlackjackTable): string | null {
	if (table.phase === "betting") return table.seats[table.turn] ? `b${table.handNumber}.${table.turn}` : null;
	if (table.phase !== "playing") return null;
	const cardsDealt = table.seats.reduce((total, seat) => total + seat.hands.reduce((sum, hand) => sum + hand.cards.length, 0), 0);
	return `j${table.handNumber}.${table.turn}.${table.seats[table.turn]?.activeHand ?? 0}.${cardsDealt}`;
}

// Post (or retire) the prompt for whoever the table is waiting on, and arm the turn clock for
// that turn. Fire and forget after the board was drawn: a failed prompt never holds a hand up.
// Rooms only; the inline forms have no row. A room that finished another way retires the table.
async function promptTurn(game: BlackjackGame, client: Client): Promise<void> {
	if (!game.roomId) return;
	if (!game.ended) noteTurnStart(game);
	const room = await gameRoomStore.findByRoomId(game.guildId, game.roomId).catch(() => null);
	if (!room) return;
	if (room.status !== "playing" && !game.ended) retireTable(game);
	// A network table posts no turn line (syncTurnPrompt skips it), so its board keeps its buttons.
	game.promptsTurns = !room.network && (room.satellites?.length ?? 0) === 0;
	await syncTurnPrompt(client, room, blackjackTurnAdapter);
	// A network table too, which gets no prompt line but still runs out of time.
	await syncTurnClocks(client, room, [blackjackTurnClock]);
}

export const blackjackTurnAdapter: TurnAdapter = {
	game: "blackjack",
	whoseTurn(room) {
		const game = gameOf(room);
		const table = game?.table;
		if (!table) return null;
		return (bettingSeat(table) ?? actingSeat(game))?.userId ?? null;
	},
	fingerprintOf(room) {
		const table = gameOf(room)?.table;
		return table ? fingerprintOfTable(table) : null;
	},
	view(room, userId) {
		const game = gameOf(room);
		const table = game?.table;
		if (!game || !table) return null;
		const copy = gamesCopy.blackjack;
		const betting = bettingSeat(table);
		if (betting) {
			if (betting.userId !== userId) return null;
			const choices = betChoices(table, userId);
			if (choices.length === 0) return null;
			return {
				title: copy.betModalTitle,
				text: [copy.betStackText(betting.stack, table.buyIn)],
				fields: [{ kind: "select", id: BET_FIELD, label: copy.betFieldLabel, options: choices.map((choice) => ({ label: copy.betChoice(choice.percent, choice.amount), value: String(choice.amount) })) }],
			};
		}
		const seat = actingSeat(game);
		if (!seat || seat.userId !== userId) return null;
		const legal = legalActions(table, userId);
		if (legal.length === 0) return null;
		const hand = seat.hands[seat.activeHand];
		const labels: Record<BlackjackAction, string> = { hit: copy.hitLabel, stand: copy.standLabel, double: copy.doubleLabel, split: copy.splitLabel };
		// A double or a split the stack cannot cover is left out of the moves and named here with
		// its reason (owner decision 3 of the bankroll spell), since a select cannot disable one option.
		const short = actionsShortOfChips(table, userId).map((action) => copy.shortOfChips(labels[action], hand.bet, seat.stack));
		return {
			title: copy.turnModalTitle,
			text: [copy.turnHandText(renderHand(hand.cards), renderTotal(hand.cards), table.dealer.cards[0] ? renderHand([table.dealer.cards[0]]) : ""), ...short],
			fields: [{ kind: "select", id: MOVE_FIELD, label: gameRoomsCopy.turnPrompt.moveLabel, options: legal.map((action) => ({ label: labels[action], value: action })) }],
		};
	},
	async apply(client, room, userId, answers, acknowledge, fingerprint) {
		const game = gameOf(room);
		if (!game?.table || !game.board) return { ok: false, reason: gameRoomsCopy.turnPrompt.turnPassed };
		const writer = messageWriter(game.board);
		const byMember: MoveSource = { timedOut: false, turn: fingerprint };
		// The board message was fetched by this very process, so its client is the ready one.
		const boardClient = game.board.client;
		const bet = answers[BET_FIELD];
		if (bet !== undefined) {
			const amount = Number(bet);
			if (!Number.isSafeInteger(amount)) return { ok: false, reason: gamesCopy.blackjack.illegalAction };
			await acknowledge();
			return answerOf(await placeBlackjackBet(game, room.channelId ?? "", userId, amount, boardClient, writer, byMember));
		}
		const action = answers[MOVE_FIELD] ?? "";
		if (!BLACKJACK_ACTIONS.includes(action)) return { ok: false, reason: gamesCopy.blackjack.illegalAction };
		await acknowledge();
		return answerOf(await playBlackjackAction(game, room.channelId ?? "", userId, action as BlackjackAction, boardClient, writer, byMember));
	},
	// Leave rides the turn line, any seat's at any time; the channel collector hears it there.
	extraButtons(room) {
		return room.channelId ? [leaveButton(room.channelId)] : [];
	},
};

/**
 * A room table's turn clock (2026-10 item 267, decision 15), solo or multi seat: the seat the
 * table waits on, from the turn's start promptTurn noted plus BLACKJACK_TURN_TIMEOUT_MS and every
 * drawing hold. Its end is runOutTurnIfDue, the timeout this table always had. A restart loses the
 * table itself (roomBootRecovery closes the room), so there is never a clock to rebuild.
 */
export const blackjackTurnClock: TurnClockGame = {
	kind: "blackjack",
	current(room, now) {
		const game = gameOf(room);
		const table = game?.table;
		if (!game || !table || !room.channelId || game.ended) return null;
		const fingerprint = fingerprintOfTable(table);
		const memberId = (bettingSeat(table) ?? actingSeat(game))?.userId;
		if (!fingerprint || !memberId || fingerprint !== game.clockTurn) return null;
		return { memberId, fingerprint, deadline: pausedDeadline(drawingKeyOf(room.channelId), game.clockStartedAt, BOT_CONSTANTS.BLACKJACK_TURN_TIMEOUT_MS, now) };
	},
	async expire(_client, room) {
		const game = gameOf(room);
		return game && room.channelId ? runOutTurnIfDue(game, room.channelId) : false;
	},
	// The room ended another way (the idle sweep, a deleted channel), which already paid its
	// stacks: the table stops playing instead of dealing on in a closed room.
	roomEnded(room) {
		const game = gameOf(room);
		if (game && !game.ended) retireTable(game);
	},
};

// A bet's or a move's result, worded for the turn modal's Submit.
function answerOf(played: PlayResult): { ok: true } | { ok: false; reason: string } {
	if (played === "passed") return { ok: false, reason: gameRoomsCopy.turnPrompt.turnPassed };
	if (played === "not-your-turn") return { ok: false, reason: gamesCopy.blackjack.notYourTurn };
	return played === "illegal" ? { ok: false, reason: gamesCopy.blackjack.illegalAction } : { ok: true };
}
