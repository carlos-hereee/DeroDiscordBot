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
import { CooldownManager } from "@utils/cooldownManager.js";
import { withRenderFallback, type RenderPayload } from "@features/renderer/index.js";
import { gamesCopy } from "./gamesCopy.js";
import { blackjackResultView, blackjackTableView, renderBlackjackResultCard, renderBlackjackTableCard } from "./blackjackRenderer.js";
import { buildBlackjackResultEmbed, buildBlackjackSeatingEmbed, buildBlackjackTableEmbed, renderHand, renderTotal } from "./gamesEmbeds.js";
import { applyAction, applyLeave, createTable, legalActions, playDealer, settle, type BlackjackAction, type BlackjackTable, type SeatResult } from "./blackjackState.js";
import { awardBlackjackResult } from "./gameXp.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { gameRoomsCopy } from "@features/game-rooms/gameRoomsCopy.js";
import { roomLifecycle } from "@features/game-rooms/roomLifecycle.js";
import { roomTrail } from "@features/game-rooms/roomTrail.js";
import { drawingSettled, isClockExpired, pausedDeadline, withDrawingPause } from "@features/game-rooms/drawingPause.js";
import { answerInChannel, beginChannelAnswer } from "@utils/answerInChannel.js";
import { showErrorNotice } from "@utils/textModal.js";
import { syncTurnPrompt, type TurnAdapter } from "@features/game-rooms/turnPrompt.js";

// ── /mini-game blackjack ───────────────────────────────────────────────────
// What:  three surfaces on ONE engine, exactly as the owner asked. `solo` deals
//        a one seat hand immediately. `table` posts a seating board others join.
//        Joining is a BUTTON on that board rather than a subcommand, because
//        "join the table I can see" is a click, not a command someone has to
//        learn. A table in a ROOM (2026-10 item 254, Arcade 1) is the third shape:
//        its players gathered on the challenge card, so it seats them all and deals
//        at once, the way solo does, and only they can act.
// Who:   MINI_GAME_HANDLERS for the slash forms typed outside the challenge channels,
//        and soloRooms for a room's table, solo or multi seat.
// When:  a table lives until the hand settles or the board times out.
// Where: the board is a channel.send() message, NOT an interaction reply, and
//        that is load bearing for the same reason it is in hangman: an
//        interaction token dies after 15 minutes and a seating window plus a
//        multi seat hand can outlive that. A plain message edits forever.
// How:   ONE message and ONE collector for the whole game, re-rendered three
//        ways: seating, table, result. Two messages would mean two collectors
//        and a second cleanup path to forget. The table and the result each carry
//        their card (blackjackRenderer) and redraw behind the drawing pause after
//        every deal and action, so players see the table every turn.
//
// ⚠️ THE DEALER'S HOLE CARD IS SECRET FROM EVERYONE, which is why this game has
// no private per player view and therefore never meets the interaction token
// problem that shapes battleship and holdem. Do not "improve" this by showing a
// player their own hand ephemerally; there is nothing they can see that the
// board does not already show them. The turn modal a room table opens (blackjackTurnAdapter,
// 2026-10 item 257 Phase 4a) shows the same public hand beside the moves, nothing more.
//
// ⚠️ A ROOM'S TABLE STILL DIES ON RAILWAY SIGTERM, AND THAT IS CLOSED OUT
// HONESTLY RATHER THAN RECOVERED. A blackjack room, solo or multi seat, opens through
// RoomProvisioner (a GameRoom row, a channel, the tier quota), but the HAND state stays
// in the module-scoped `games` Map below, so a redeploy mid-hand loses the table while
// the room row says "playing". The boot recovery sweep (roomBootRecovery) asks
// hasLiveBlackjackTable for every blackjack room it finds and, for a room this
// process holds no table for, says so in the room, disarms the dead board and
// finishes the room as abandoned: nothing was settled, so nothing is paid, and the
// host's room slot is released. A resumable table means persisting the hand into
// the room's `secret` the way battleship and hold em do, which is a rewrite of the
// collector flow, not a patch. Do not bolt a partial recovery onto this Map.

// A seating window long enough to notice and short enough that a table does not
// hold a channel hostage waiting for a second player who is not coming.
export const SEATING_WINDOW_MS = 45_000;

// The whole board's lifetime. Generous, because a five seat hand with splits is
// genuinely slow, but finite so an abandoned table cleans itself up rather than
// sitting live until a redeploy. Held while the board draws (see armLifetime).
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
	// ⚠️ The settle claim. Set SYNCHRONOUSLY before any await in the settle path,
	// because the last action and the timeout can both reach settlement and paying
	// a table twice is the one bug here that costs real xp.
	settled: boolean;
	// Set when this table plays inside a game room, solo or multi seat: the settle path
	// then closes the room through roomLifecycle.finish (lock, result card, archive
	// clock). Null for the inline slash forms, which own no room.
	roomId: string | null;
	// The board message the collector watches, set once it is wired. The turn modal's Submit has
	// no click on the board to answer through, so it edits this message instead (a message edit,
	// unlike a click's token, never expires); a room table's result also reposts from it.
	board: Message | null;
	seatingTimer: NodeJS.Timeout | null;
	// The table's lifetime clock: when the board was posted, and the timer that ends
	// the table TABLE_TIMEOUT_MS later plus any time the board spent drawing.
	openedAt: number;
	lifetimeTimer: NodeJS.Timeout | null;
	stop: () => void;
}

// One game per CHANNEL, matching hangman: the board is public and the channel
// plays it together. Process scoped, so a table open when Railway redeploys is
// lost, which is the same accepted v1 tradeoff every other game here makes.
const games = new Map<string, BlackjackGame>();

// Test seams, matching hangmanHandler's convention.
export const _clearBlackjackGames = (): void => {
	for (const game of games.values()) clearGameTimers(game);
	games.clear();
};

function clearGameTimers(game: BlackjackGame): void {
	if (game.seatingTimer) clearTimeout(game.seatingTimer);
	if (game.lifetimeTimer) clearTimeout(game.lifetimeTimer);
}
export const _activeBlackjackGameCount = (): number => games.size;

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
				// player's cursor between turns and mis-click into a Stand.
				.setDisabled(!allowed.includes(action))
		);
	}
	// Leave is any seat's, on the clock or not (2026-10 item 254, Arcade 12), so it is never
	// disabled; the engine refuses a member with no seat. The fifth and last button a row holds.
	row.addComponents(new ButtonBuilder().setCustomId(customId(channelId, "leave")).setLabel(c.leaveHandLabel).setStyle(ButtonStyle.Danger));
	return row;
}

// ── the slash entry point ───────────────────────────────────────────────────

export async function runBlackjack(interaction: ChatInputCommandInteraction): Promise<void> {
	// The table itself posts where the command ran; the member's own answer (seated, or
	// why not) posts in 💬dero-commands (2026-10 item 257 Phase 5).
	const answer = await beginChannelAnswer(interaction, "member");
	const c = gamesCopy.blackjack;

	const channel = interaction.channel;
	if (!(channel instanceof TextChannel) || !interaction.guildId) {
		await answer.send({ embeds: [errorEmbed(c.outsideGuild)] });
		return;
	}

	const gate = cooldown.check(`${interaction.guildId}:${interaction.user.id}`);
	if (gate.onCooldown) {
		await answer.send({ embeds: [errorEmbed(c.cooldownMessage(Math.ceil(gate.remainingMs / 1000)))] });
		return;
	}

	const solo = interaction.options.getString("mode") !== "table";
	const host = { userId: interaction.user.id, username: interaction.user.globalName ?? interaction.user.username };
	const result = await startBlackjackTable(channel, interaction.guildId, host, solo);

	if (result === "alreadyRunning") {
		await answer.send({ embeds: [errorEmbed(c.alreadyRunning)] });
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
	otherSeats: ReadonlyArray<{ userId: string; username: string }> = []
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
		board: null,
		seatingTimer: null,
		openedAt: Date.now(),
		lifetimeTimer: null,
		stop: () => undefined,
	};
	games.set(channel.id, game);

	try {
		// ② A solo game deals straight away. A join window for one player is a
		// countdown to nothing, so solo never renders the seating board at all, and
		// neither does a room's table, whose seats were taken on the challenge card.
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
				components: result ? [] : [actionRow(channel.id, table)],
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
		wireCollector(game, channel.id, board);
		if (settledOnDeal) game.stop();
		// A room table deals at once, so its first seat is prompted here (item 257 Phase 4a).
		else if (dealNow) await promptTurn(game, channel.client);

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
		games.delete(channel.id);
		console.warn(`[mini-game] blackjack could not post a board in channel ${channel.id}`, error);
		return "failed";
	}
}

// ── the collector, one per game ─────────────────────────────────────────────

function wireCollector(game: BlackjackGame, channelId: string, board: Message): void {
	game.board = board;
	// No `time` option: the table's lifetime is armLifetime's timer below, which can
	// hold while the board draws. The collector's own limit cannot.
	const collector = board.createMessageComponentCollector({
		componentType: ComponentType.Button,
		filter: (i) => i.customId.startsWith(`${PREFIX}:${channelId}:`),
	});
	game.stop = () => collector.stop();

	collector.on("collect", (click) => {
		void onClick(click as ButtonInteraction, channelId);
	});

	// The single cleanup path, firing on stop() from a settle AND from the lifetime
	// timer, so no exit leaves a map entry or a timer behind.
	collector.on("end", () => {
		const stale = games.get(channelId);
		if (stale) clearGameTimers(stale);
		games.delete(channelId);
	});

	game.openedAt = Date.now();
	armLifetime(game, channelId);
}

// ── the table's lifetime ────────────────────────────────────────────────────
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
				await showErrorNotice(click, c.alreadySeated);
				return;
			}
			if (game.seated.length >= MAX_SEATS) {
				await showErrorNotice(click, c.tableFull);
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
				await showErrorNotice(click, c.notSeated);
				return;
			}
			await click.update({ embeds: [seatingEmbed(game)], components: [seatingRow(channelId)] });
			return;
		}

		if (action === "deal") {
			// Only the host may cut the window short. Any seated member could
			// otherwise deal the moment they sat, which defeats the window.
			if (click.user.id !== game.hostId) {
				await showErrorNotice(click, c.hostOnlyDeal);
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
		await leaveDuringHand(click, game, channelId);
		return;
	}
	if (!BLACKJACK_ACTIONS.includes(action)) return;

	const played = await playBlackjackAction(game, channelId, click.user.id, action as BlackjackAction, click.client, clickWriter(click));
	if (played === "not-your-turn") {
		const seated = game.table.seats.some((seat) => seat.userId === click.user.id);
		await showErrorNotice(click, seated ? c.notYourTurn : c.notPlaying);
		return;
	}
	if (played === "illegal") await showErrorNotice(click, c.illegalAction);
}

const BLACKJACK_ACTIONS: readonly string[] = ["hit", "stand", "double", "split"];

/**
 * One seat's action against the table, from a board button or the turn modal: the SAME path
 * (2026-10 item 257 Phase 4a), so an action never has two implementations. `writer` is how the
 * board is rewritten, the click's own token or the board message itself.
 */
async function playBlackjackAction(
	game: BlackjackGame,
	channelId: string,
	userId: string,
	action: BlackjackAction,
	client: Message["client"],
	writer: BoardWriter
): Promise<"played" | "not-your-turn" | "illegal"> {
	if (!game.table) return "illegal";
	const outcome = applyAction(game.table, userId, action);
	if (outcome.status === "not-your-turn") return "not-your-turn";
	if (outcome.status === "illegal") return "illegal";

	// The hand may have ended on this very action. Settling BEFORE the render
	// means the player sees one final board rather than a live board that is
	// replaced a moment later.
	if (game.table.phase === "dealer") {
		const result = settleGame(game, channelId, client);
		if (result) {
			await redrawResult(channelId, result, resultWriter(game, writer));
			await promptTurn(game, client);
			game.stop();
			return "played";
		}
	}

	await redrawTable(channelId, game.table, writer);
	await promptTurn(game, client);
	return "played";
}

// ── leaving during a hand (2026-10 item 254, Arcade 12) ──
// The seat gives its hand up as a loss (applyLeave), then the table goes on exactly as
// after an action: settled if nobody is left to act, redrawn otherwise. In a room the
// trail gets one line saying who left; the inline forms keep no trail. Blackjack plays
// for no chips, so a loss here costs what any lost hand costs and refunds nothing.
async function leaveDuringHand(click: ButtonInteraction, game: BlackjackGame, channelId: string): Promise<void> {
	const c = gamesCopy.blackjack;
	if (!game.table) return;
	const outcome = applyLeave(game.table, click.user.id);
	if (outcome.status !== "left") {
		const refusal = outcome.status === "already-left" ? c.leftAlready : c.notPlaying;
		await showErrorNotice(click, refusal);
		return;
	}
	if (game.roomId) {
		void roomTrail.postMove(click.client, { guildId: game.guildId, roomId: game.roomId, channelId }, { actorId: click.user.id, kind: "forfeit", text: c.leftTrail(click.user.id) });
	}

	const result = game.table.phase === "dealer" ? settleGame(game, channelId, click.client) : null;
	if (result) await redrawResult(channelId, result, resultWriter(game, clickWriter(click)));
	else await redrawTable(channelId, game.table, clickWriter(click));
	await promptTurn(game, click.client);
	await answerInChannel(click, "member", { content: c.leftHand });
	if (result) game.stop();
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
			await redrawResult(channelId, result, resultWriter(game, clickWriter(click)));
			game.stop();
			return;
		}
	}

	await redrawTable(channelId, table, clickWriter(click), embed);
	await promptTurn(game, click.client);
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
			await redrawResult(channelId, result, resultWriter(game, messageWriter(board)));
			game.stop();
			return;
		}
	}
	await redrawTable(channelId, table, messageWriter(board), embed);
	await promptTurn(game, board.client);
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
 * keeps a table editable past the 15 minute token life. The seating timer has no
 * click, so it edits the board message itself.
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

// A room table's RESULT posts as a fresh message and retires the board, so the dealer's revealed
// hand is the last thing in the room instead of an edit buried under the turn prompts and the
// room's own result card (2026-10 item 257 Phase 4a). The base writer still takes the status
// line, which is what acknowledges a click. The inline slash forms own no room and keep the edit.
function resultWriter(game: BlackjackGame, base: BoardWriter): BoardWriter {
	const board = game.board;
	if (!game.roomId || !board) return base;
	return {
		showStatus: base.showStatus,
		write: async (payload) => {
			if (board.channel.isSendable()) await board.channel.send({ embeds: payload.embeds, files: payload.files, components: [], allowedMentions: { parse: [] } });
			await board.delete().catch((error: unknown) => console.warn("[mini-game] the old blackjack board could not be deleted", error));
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
	components: ActionRowBuilder<ButtonBuilder>[]
): Promise<void> {
	await withDrawingPause({
		gameKey: drawingKeyOf(channelId),
		showStatus: writer.showStatus,
		render,
		fallback: () => null,
		swapIn: (drawn) => writer.write({ ...boardParts(embed, drawn), components, content: null, attachments: [] }),
	}).catch((error) => console.warn(`[mini-game] blackjack could not redraw the board in channel ${channelId}`, error));
}

// The table in play, with its action row.
function redrawTable(channelId: string, table: BlackjackTable, writer: BoardWriter, embed: EmbedBuilder = buildBlackjackTableEmbed(table, false)): Promise<void> {
	return redrawBoard(channelId, writer, () => drawTableCard(table), embed, [actionRow(channelId, table)]);
}

// The settled result, with nothing left to press.
function redrawResult(channelId: string, settled: SettledTable, writer: BoardWriter): Promise<void> {
	return redrawBoard(channelId, writer, () => drawResultCard(settled), settled.embed, []);
}

// Plays the dealer, pays everyone, and returns the result embed with the table it
// settled. Returns null if this table has already settled, which is the guard that
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
	// in scope, because the three settle callers reach here with different ones.
	awardBlackjackResult({
		client,
		guildId: game.guildId,
		channelId,
		seats: results,
		// The room when the table plays in one; an inline slash table owns no room, so its
		// channel and opening time key the coins, which no other table can share.
		resultKey: game.roomId ?? `${channelId}:${game.openedAt}`,
	});

	// A table that plays inside a ROOM closes its room here: finish stamps the
	// row, locks the channel, posts the result card and starts the archive clock.
	// Fire and forget after the settle (convention 7), and NO extra xp is paid by
	// this call site: awardBlackjackResult above already paid the game's own award,
	// and finish's room-rate top up adds only the room delta on top, the same
	// convention every other room hosted game follows.
	if (game.roomId) {
		const roomId = game.roomId;
		const winnerId = roomWinnerOf(results);
		void (async () => {
			const room = await gameRoomStore.findByRoomId(game.guildId, roomId);
			if (!room) return;
			await roomLifecycle.finish(client, room, { winnerId });
		})().catch((error) => console.error("[mini-game] solo blackjack room finish failed", { roomId, error }));
	}

	const anyDoubledLoss = results.some((seat) => seat.hands.some((outcome, index) => outcome === "lose" && seat.doubled[index]));
	return { embed: buildBlackjackResultEmbed(game.table, results, anyDoubledLoss), table: game.table, results };
}

// ── the turn prompt (turnPrompt.ts, 2026-10 item 257 Phase 4a) ────────
// What:  Blackjack's side of the shared turn piece, for a room's multi seat table. The table
//        lives in this file's process Map, so the adapter reads the game by the room's channel.
//        Every hand here is public, so the modal shows nothing the board does not: it is the
//        player's own cards, the dealer's up card and the moves that are legal.
// How:   a move plays through playBlackjackAction, the function the board's buttons call, and
//        the board is rewritten by editing its message. A one seat Play Dero table
//        (solo-blackjack) is not prompted: its player is alone with the buttons.

const MOVE_FIELD = "move";

const gameOf = (room: { channelId: string | null }): BlackjackGame | undefined => (room.channelId ? games.get(room.channelId) : undefined);

const actingSeat = (game: BlackjackGame | undefined) => (game?.table?.phase === "playing" ? game.table.seats[game.table.turn] : undefined);

// Post (or retire) the prompt for whoever the table is waiting on. Fire and forget after the
// board was drawn: a failed prompt never holds a hand up. Rooms only; the inline forms have no row.
async function promptTurn(game: BlackjackGame, client: Client): Promise<void> {
	if (!game.roomId) return;
	const room = await gameRoomStore.findByRoomId(game.guildId, game.roomId).catch(() => null);
	if (room) await syncTurnPrompt(client, room, blackjackTurnAdapter);
}

export const blackjackTurnAdapter: TurnAdapter = {
	game: "blackjack",
	whoseTurn(room) {
		return actingSeat(gameOf(room))?.userId ?? null;
	},
	fingerprintOf(room) {
		const table = gameOf(room)?.table;
		if (!table || table.phase !== "playing") return null;
		const cardsDealt = table.seats.reduce((total, seat) => total + seat.hands.reduce((sum, hand) => sum + hand.cards.length, 0), 0);
		return `j${table.turn}.${table.seats[table.turn]?.activeHand ?? 0}.${cardsDealt}`;
	},
	view(room, userId) {
		const game = gameOf(room);
		const seat = actingSeat(game);
		const table = game?.table;
		if (!game || !table || !seat || seat.userId !== userId) return null;
		const legal = legalActions(table, userId);
		if (legal.length === 0) return null;
		const copy = gamesCopy.blackjack;
		const hand = seat.hands[seat.activeHand];
		const labels: Record<BlackjackAction, string> = { hit: copy.hitLabel, stand: copy.standLabel, double: copy.doubleLabel, split: copy.splitLabel };
		return {
			title: copy.turnModalTitle,
			text: [copy.turnHandText(renderHand(hand.cards), renderTotal(hand.cards), table.dealer.cards[0] ? renderHand([table.dealer.cards[0]]) : "")],
			fields: [{ kind: "select", id: MOVE_FIELD, label: gameRoomsCopy.turnPrompt.moveLabel, options: legal.map((action) => ({ label: labels[action], value: action })) }],
		};
	},
	async apply(client, room, userId, answers, acknowledge) {
		const game = gameOf(room);
		const action = answers[MOVE_FIELD] ?? "";
		if (!game?.table || !game.board) return { ok: false, reason: gameRoomsCopy.turnPrompt.turnPassed };
		if (!BLACKJACK_ACTIONS.includes(action)) return { ok: false, reason: gamesCopy.blackjack.illegalAction };
		await acknowledge();
		// The board message was fetched by this very process, so its client is the ready one.
		const played = await playBlackjackAction(game, room.channelId ?? "", userId, action as BlackjackAction, game.board.client, messageWriter(game.board));
		if (played === "not-your-turn") return { ok: false, reason: gamesCopy.blackjack.notYourTurn };
		return played === "illegal" ? { ok: false, reason: gamesCopy.blackjack.illegalAction } : { ok: true };
	},
};

/**
 * The one winner a room's result card can name: the only seat with a hand that beat the
 * dealer (a split seat reports both halves). A table where several seats won, or none, ends
 * with no single winner, which finish renders honestly; a solo seat is simply the only seat.
 */
export function roomWinnerOf(results: readonly SeatResult[]): string | null {
	const winners = results.filter((seat) => seat.hands.some((outcome) => outcome === "win" || outcome === "blackjack"));
	return winners.length === 1 ? winners[0].userId : null;
}
