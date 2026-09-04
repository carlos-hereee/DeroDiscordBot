import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ComponentType,
	MessageFlags,
	TextChannel,
	type ButtonInteraction,
	type Channel,
	type ChatInputCommandInteraction,
	type EmbedBuilder,
	type Message,
} from "discord.js";
import { errorEmbed, infoEmbed } from "@utils/embedBuilder.js";
import { COLORS } from "@base/copy/brand.js";
import { CooldownManager } from "@utils/cooldownManager.js";
import { gamesCopy } from "./gamesCopy.js";
import { buildBlackjackResultEmbed, buildBlackjackSeatingEmbed, buildBlackjackTableEmbed } from "./gamesEmbeds.js";
import { applyAction, createTable, legalActions, playDealer, settle, type BlackjackAction, type BlackjackTable } from "./blackjackState.js";
import { awardBlackjackResult } from "./gameXp.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { roomLifecycle } from "@features/game-rooms/roomLifecycle.js";

// ── /mini-game blackjack ───────────────────────────────────────────────────
// What:  three surfaces on ONE engine, exactly as the owner asked. `solo` deals
//        a one seat hand immediately. `table` posts a seating board others join.
//        Joining is a BUTTON on that board rather than a subcommand, because
//        "join the table I can see" is a click, not a command someone has to
//        learn.
// Who:   MINI_GAME_HANDLERS is the only caller.
// When:  a table lives until the hand settles or the board times out.
// Where: the board is a channel.send() message, NOT an interaction reply, and
//        that is load bearing for the same reason it is in hangman: an
//        interaction token dies after 15 minutes and a seating window plus a
//        multi seat hand can outlive that. A plain message edits forever.
// How:   ONE message and ONE collector for the whole game, re-rendered three
//        times: seating, table, result. Two messages would mean two collectors
//        and a second cleanup path to forget.
//
// ⚠️ THE DEALER'S HOLE CARD IS SECRET FROM EVERYONE, which is why this game has
// no private per player view and therefore never meets the interaction token
// problem that shapes battleship and holdem. Do not "improve" this by showing a
// player their own hand ephemerally; there is nothing they can see that the
// board does not already show them.
//
// ⚠️ A SOLO ROOM'S TABLE STILL DIES ON RAILWAY SIGTERM, AND THAT IS CLOSED OUT
// HONESTLY RATHER THAN RECOVERED. Solo blackjack opens through RoomProvisioner (a
// GameRoom row, a channel, the tier quota), but the HAND state stays in the
// module-scoped `games` Map below, so a redeploy mid-hand loses the table while
// the room row says "playing". The boot recovery sweep (roomBootRecovery) asks
// hasLiveBlackjackTable for every solo blackjack room it finds and, for a room this
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
// sitting live until a redeploy.
const TABLE_TIMEOUT_MS = 10 * 60_000;

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
	// Set when this table was opened as a SOLO game room: the settle path then closes
	// the room through roomLifecycle.finish (lock, result card, archive clock). Null
	// for the inline table form, which lives in ⚔️challenges and owns no room.
	roomId: string | null;
	seatingTimer: NodeJS.Timeout | null;
	stop: () => void;
}

// One game per CHANNEL, matching hangman: the board is public and the channel
// plays it together. Process scoped, so a table open when Railway redeploys is
// lost, which is the same accepted v1 tradeoff every other game here makes.
const games = new Map<string, BlackjackGame>();

// Test seams, matching hangmanHandler's convention.
export const _clearBlackjackGames = (): void => {
	for (const game of games.values()) if (game.seatingTimer) clearTimeout(game.seatingTimer);
	games.clear();
};
export const _activeBlackjackGameCount = (): number => games.size;

// True while this channel holds a live table in THIS process. The boot recovery sweep
// asks this for every solo blackjack room it finds: a room row that says "playing"
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
	return row;
}

// ── the slash entry point ───────────────────────────────────────────────────

export async function runBlackjack(interaction: ChatInputCommandInteraction): Promise<void> {
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });
	const c = gamesCopy.blackjack;

	const channel = interaction.channel;
	if (!(channel instanceof TextChannel) || !interaction.guildId) {
		await interaction.editReply({ embeds: [errorEmbed(c.outsideGuild)] });
		return;
	}

	const gate = cooldown.check(`${interaction.guildId}:${interaction.user.id}`);
	if (gate.onCooldown) {
		await interaction.editReply({ embeds: [errorEmbed(c.cooldownMessage(Math.ceil(gate.remainingMs / 1000)))] });
		return;
	}

	const solo = interaction.options.getString("mode") !== "table";
	const host = { userId: interaction.user.id, username: interaction.user.globalName ?? interaction.user.username };
	const result = await startBlackjackTable(channel, interaction.guildId, host, solo);

	if (result === "alreadyRunning") {
		await interaction.editReply({ embeds: [errorEmbed(c.alreadyRunning)] });
		return;
	}
	if (result === "failed") {
		await interaction.editReply({ embeds: [errorEmbed(c.noChannel)] });
		return;
	}

	cooldown.record(`${interaction.guildId}:${interaction.user.id}`);
	await interaction.editReply({
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
	solo: boolean,
	// The GameRoom this table plays inside, when it was opened as a solo room via
	// soloRooms.openSoloRoom. The inline forms pass nothing.
	roomId: string | null = null
): Promise<BlackjackStartResult> {
	// ① Claim the channel slot SYNCHRONOUSLY, the same discipline hangman uses:
	// the check and the write sit adjacent with no await between them, so two
	// members racing the command in one channel cannot both open a table.
	if (games.has(channel.id)) return "alreadyRunning";

	const game: BlackjackGame = {
		hostId: host.userId,
		guildId,
		seated: [host],
		table: null,
		settled: false,
		roomId,
		seatingTimer: null,
		stop: () => undefined,
	};
	games.set(channel.id, game);

	try {
		// ② A solo game deals straight away. A join window for one player is a
		// countdown to nothing, so solo never renders the seating board at all.
		let board: Message;
		let settledOnDeal = false;
		if (solo) {
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

			board = await channel.send({
				embeds: [result ?? embed],
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

		// ④ The window closes itself. Without this a table whose host never presses
		// Deal would sit in the seating phase until the collector's own timeout,
		// which is thirteen times longer.
		if (!solo) {
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
	const collector = board.createMessageComponentCollector({
		componentType: ComponentType.Button,
		filter: (i) => i.customId.startsWith(`${PREFIX}:${channelId}:`),
		time: TABLE_TIMEOUT_MS,
	});
	game.stop = () => collector.stop();

	collector.on("collect", (click) => {
		void onClick(click as ButtonInteraction, channelId);
	});

	// The single cleanup path, firing on stop() AND on the time limit, so no exit
	// leaves a map entry behind.
	collector.on("end", () => {
		const stale = games.get(channelId);
		if (stale?.seatingTimer) clearTimeout(stale.seatingTimer);
		games.delete(channelId);
	});
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
				await click.reply({ embeds: [errorEmbed(c.alreadySeated)], flags: MessageFlags.Ephemeral });
				return;
			}
			if (game.seated.length >= MAX_SEATS) {
				await click.reply({ embeds: [errorEmbed(c.tableFull)], flags: MessageFlags.Ephemeral });
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
				await click.reply({ embeds: [errorEmbed(c.notSeated)], flags: MessageFlags.Ephemeral });
				return;
			}
			await click.update({ embeds: [seatingEmbed(game)], components: [seatingRow(channelId)] });
			return;
		}

		if (action === "deal") {
			// Only the host may cut the window short. Any seated member could
			// otherwise deal the moment they sat, which defeats the window.
			if (click.user.id !== game.hostId) {
				await click.reply({ embeds: [errorEmbed(c.hostOnlyDeal)], flags: MessageFlags.Ephemeral });
				return;
			}
			if (game.seatingTimer) clearTimeout(game.seatingTimer);
			game.seatingTimer = null;
			await dealInto(game, channelId, click);
		}
		return;
	}

	// ── playing phase ──
	if (!(["hit", "stand", "double", "split"] as string[]).includes(action)) return;

	const outcome = applyAction(game.table, click.user.id, action as BlackjackAction);
	if (outcome.status === "not-your-turn") {
		const seated = game.table.seats.some((seat) => seat.userId === click.user.id);
		await click.reply({ embeds: [errorEmbed(seated ? c.notYourTurn : c.notPlaying)], flags: MessageFlags.Ephemeral });
		return;
	}
	if (outcome.status === "illegal") {
		await click.reply({ embeds: [errorEmbed(c.illegalAction)], flags: MessageFlags.Ephemeral });
		return;
	}

	// The hand may have ended on this very action. Settling BEFORE the render
	// means the player sees one final board rather than a live board that is
	// replaced a moment later.
	if (game.table.phase === "dealer") {
		const result = settleGame(game, channelId, click.client);
		if (result) {
			await click.update({ embeds: [result], components: [] });
			game.stop();
			return;
		}
	}

	await click.update({ embeds: [buildBlackjackTableEmbed(game.table, false)], components: [actionRow(channelId, game.table)] });
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
			await click.update({ embeds: [result], components: [] });
			game.stop();
			return;
		}
	}

	await click.update({ embeds: [embed], components: [actionRow(channelId, table)] });
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
			await board.edit({ embeds: [result], components: [] }).catch(() => undefined);
			game.stop();
			return;
		}
	}
	await board.edit({ embeds: [embed], components: [actionRow(channelId, table)] }).catch(() => undefined);
}

// ── settlement ──────────────────────────────────────────────────────────────

// Plays the dealer, pays everyone, and returns the result embed. Returns null if
// this table has already settled, which is the guard that stops a double click
// or a timeout racing the last action from paying twice.
function settleGame(game: BlackjackGame, channelId: string, client: Message["client"]): EmbedBuilder | null {
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
	});

	// A table that plays inside a SOLO ROOM closes its room here: finish stamps the
	// row, locks the channel, posts the result card and starts the archive clock.
	// Fire and forget after the settle (convention 7), and NO extra xp is paid by
	// this call site: awardBlackjackResult above already paid the game's own award,
	// and finish's room-rate top up adds only the room delta on top, the same
	// convention every other room hosted game follows.
	if (game.roomId) {
		const roomId = game.roomId;
		const seat = results.find((entry) => entry.userId === game.hostId);
		// The room's winner is the solo seat when ANY of its hands beat the dealer
		// (a split seat reports both halves); a push-only or losing hand ends the
		// room with no winner, which finish renders honestly.
		const winnerId = seat?.hands.some((outcome) => outcome === "win" || outcome === "blackjack") ? game.hostId : null;
		void (async () => {
			const room = await gameRoomStore.findByRoomId(game.guildId, roomId);
			if (!room) return;
			await roomLifecycle.finish(client, room, { winnerId });
		})().catch((error) => console.error("[mini-game] solo blackjack room finish failed", { roomId, error }));
	}

	const anyDoubledLoss = results.some((seat) => seat.hands.some((outcome, index) => outcome === "lose" && seat.doubled[index]));
	return buildBlackjackResultEmbed(game.table, results, anyDoubledLoss);
}
