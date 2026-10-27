import type { Client } from "discord.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { secureRandom } from "@utils/secureRng.js";
import { applyForfeit, type MonopolyState } from "@features/games/monopolyState.js";
import { applyMonopolyBotAction, decideMonopolyMove, type MonopolyBotAction } from "@features/games/monopolyBot.js";
import { decideBattleshipShot } from "@features/games/battleshipBot.js";
import { markReady } from "@features/games/battleshipState.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { botSeatName, isBotSeatId } from "./botSeat.js";
import { playHoldemBotTurn } from "./roomHoldemHandlers.js";
import { commitMonopolyMove, monopolyStateOf, withAuctionNotice } from "./roomMonopolyHandlers.js";
import { commitReady, commitShot } from "./roomBattleshipHandlers.js";
import { deserializeMatch, fire, type StoredBattleship } from "./roomBattleship.js";

// ── botTurns ─────────────────────────────────────────────────────────
// What:  the driver that moves every Dero bot seat (2026-10 item 250 Phase 5): each tick
//        it finds the playing rooms with a bot, and moves at most one bot one step in each.
// Who:   main.ts, on an interval of BOT_CONSTANTS.BOT_TURNS.TICK_MS. Nothing a member
//        presses reaches here, and no bot ever reaches a member's handler.
// Where: every bot move goes through the SAME claim and announce path a member's press
//        takes (hold'em's applySeatMove, Monopoly's commitMonopolyMove, Battleship's
//        commitShot and commitReady), so a bot's move is persisted by compare and swap,
//        narrated, redrawn and finished exactly like a member's, and a press racing a bot
//        loses or wins the same way two presses do.
// How:   one step per room per tick reads at a human pace and keeps a room's Discord
//        writes far from its rate limit. A tick that is still running when the next fires
//        is skipped, so a slow Discord never stacks two drives of one room.
//
// ⚠️ A ROOM OF BOTS ALONE ALWAYS ENDS. Bots always have a move, so the idle sweeps that
// close an abandoned room never fire on them, and bot only Monopoly can run for ever (the
// pure bot's own simulations stall on about half of all seeds). So the moment no member is
// left in a match, the driver ends it: hold'em closes the table on its standings, Monopoly
// forfeits the bots one by one, poorest first, until the richest stands alone.

export interface BotTurnSummary {
	moved: number;
}

let tickInFlight = false;

/** One tick over every playing room with a bot. Never throws; a room that fails is logged and the rest still move. */
export async function sweepBotTurns(client: Client, now: Date = new Date()): Promise<BotTurnSummary> {
	if (tickInFlight) return { moved: 0 };
	tickInFlight = true;
	try {
		const rooms = await gameRoomStore.findPlayingWithBots();
		let moved = 0;
		for (const room of rooms) if (await driveRoom(client, room, now)) moved++;
		return { moved };
	} catch (error) {
		console.error("[game-rooms] the bot turn sweep failed to read its rooms", error);
		return { moved: 0 };
	} finally {
		tickInFlight = false;
	}
}

// Per room, so one room's failure never stalls another's bots.
async function driveRoom(client: Client, room: IGameRoom, now: Date): Promise<boolean> {
	try {
		if (room.game === "holdem") return await playHoldemBotTurn(client, room, now);
		if (room.game === "monopoly") return await playMonopolyBotTurn(client, room);
		if (room.game === "battleship") return await playBattleshipBotTurn(client, room);
		return false;
	} catch (error) {
		console.error("[game-rooms] a bot turn failed for one room", { guildId: room.guildId, roomId: room.roomId, error });
		return false;
	}
}

// ── Monopoly ──────────────────────────────────────────────────────────
// The first bot with something to do takes one step: a turn on the clock, or an answer
// off it (a trade offered to it, a bid in an open auction, a debt it owes). The engine
// decides who may do what; the bot's choice is checked by it again on the claim.
export async function playMonopolyBotTurn(client: Client, room: IGameRoom): Promise<boolean> {
	const state = monopolyStateOf(room);
	if (!state || state.phase === "finished") return false;
	if (!hasSolventMember(state)) return forfeitPoorestBot(client, room, state);

	for (const seat of state.seats) {
		if (seat.bankrupt || !isBotSeatId(seat.userId)) continue;
		const action = decideMonopolyMove(state, seat.userId);
		if (action.kind === "wait") continue;
		const outcome = await commitMonopolyMove(client, room, seat.userId, (current, actorId) => applyBotAction(current, actorId, action), { onTurnOnly: false });
		return outcome.ok;
	}
	return false;
}

// A bot's skip opens an auction the same way a member's does, with the same notice.
function applyBotAction(state: MonopolyState, botId: string, action: MonopolyBotAction) {
	const result = applyMonopolyBotAction(state, botId, action, secureRandom, Date.now());
	return action.kind === "skip" ? withAuctionNotice(result) : result;
}

const hasSolventMember = (state: MonopolyState): boolean => state.seats.some((seat) => !seat.bankrupt && !isBotSeatId(seat.userId));

// One forfeit per tick: the poorest bot leaves through the engine's own forfeit, so its
// lots go back to the bank and the last seat standing wins as in any match.
async function forfeitPoorestBot(client: Client, room: IGameRoom, state: MonopolyState): Promise<boolean> {
	const bots = state.seats.filter((seat) => !seat.bankrupt && isBotSeatId(seat.userId)).sort((first, second) => first.chips - second.chips);
	const poorest = bots[0];
	if (!poorest || bots.length < 2) return false;
	const outcome = await commitMonopolyMove(client, room, poorest.userId, (current) => applyForfeit(current, poorest.userId), { onTurnOnly: false });
	return outcome.ok;
}

// ── Battleship ────────────────────────────────────────────────────────
// Setup: the bot keeps the fleet Dero laid and presses Ready. Battle: on its turn it aims
// and fires in one step. Both through the button's own cores.
export async function playBattleshipBotTurn(client: Client, room: IGameRoom): Promise<boolean> {
	const stored = (room.secret as StoredBattleship | null) ?? null;
	if (!stored) return false;
	const state = deserializeMatch(stored);
	const botId = state.players.map((player) => player.userId).find(isBotSeatId);
	if (!botId) return false;

	if (state.status === "setup") {
		const ready = markReady(state, botId);
		if (!ready.ok) return false;
		await commitReady(client, room, botId, ready.index);
		return true;
	}
	if (state.status !== "playing" || state.players[state.turn].userId !== botId) return false;

	const target = decideBattleshipShot(state, botId);
	if (!target) return false;
	const outcome = fire(stored, botId, target);
	if (!outcome.ok || !outcome.state) return false;
	await commitShot(client, room, stored, { ...outcome, state: outcome.state }, { userId: botId, name: botSeatName(botId) });
	return true;
}
