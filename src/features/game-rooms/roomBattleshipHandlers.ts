import { TextChannel, type ButtonInteraction, type Client } from "discord.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { COLUMNS, FLEET, GRID_SIZE, expireTurn, markReady, rerollFleet, shipsRemaining, startBattle, type BattleshipState, type SetupRefusal } from "@features/games/battleshipState.js";
import { awardTwoPlayerResult } from "@features/games/gameXp.js";
import { awardXp } from "@features/leveling/awardXp.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { recordMatchRatings, twoPlayerFinishingOrder } from "@features/ratings/recordMatchRatings.js";
import { roomTrail, type RoomMoveInput } from "./roomTrail.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { isClockExpired, pausedDeadline, roomDrawingKey, withDrawingPause } from "./drawingPause.js";
import { lastActivityAt } from "./roomActivity.js";
import { syncTurnClocks, type TurnClockGame } from "./turnClock.js";
import {
	fire,
	deserializeMatch,
	serializeMatch,
	battleshipBoardCard,
	battleshipBoardMessageWith,
	privateBoardReply,
	privateBoardView,
	ownFleetText,
	targetGridText,
	fleetFingerprint,
	SETUP_PRESS_FINGERPRINT,
	PRIVATE,
	type BattleshipSinking,
	type FireOutcome,
	type StoredBattleship,
} from "./roomBattleship.js";
import { showPrivateView } from "./privateView.js";
import { battleshipOutcome, wasBehindOnShips, type OutcomeBucket } from "./matchOutcome.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { showNotice } from "@utils/textModal.js";
import { postTurnBoard } from "./turnBoard.js";
import { handleTurnPress, showTurnModal, syncTurnPrompt, type TurnAdapter, type TurnView } from "./turnPrompt.js";

// ── roomBattleshipHandlers ───────────────────────────────────────────
// What:  the interaction half of battleship: aiming, firing, looking at your own
//        board, and re-laying your fleet.
// Who:   routed from gameRoomHandlers, which has already proven the clicker is one
//        of the room's players.
// When:  many times per match, unlike every other game in this feature.
// Where: a shot is a turn (2026-10 item 263 R3-29): each shot posts the battle's board
//        afresh through the shared turn board with that shot in its This turn block, and
//        the board before it stays in the room with its buttons off, so the room reads as
//        the battle's log. Setup edits its one board in place; the fleet's ready lines and
//        the battle's opening line still post as their own lines, since they are no shot.
// How:   every write goes back through the room row, so a deploy mid-match costs
//        nothing.

const storedMatch = (room: IGameRoom): StoredBattleship | null => (room.secret as StoredBattleship | null) ?? null;

async function persist(room: IGameRoom, stored: StoredBattleship) {
	return gameRoomStore.update(room.guildId, room.roomId, { secret: stored as never });
}

/**
 * Draw the battle's board behind the drawing pause, so the turn clock holds while the card
 * renders. Shared by a shot, the turn sweep's expiry and the battle's start. `turn` is the
 * turn's own moves (the shot, or the expired turn), which the board's This turn block shows
 * and the transcript records once that board is posted. Cosmetic, so a failure is logged and
 * swallowed: the row is the truth and the next turn will catch up.
 */
export async function redrawBattleshipBoard(
	client: Client,
	room: IGameRoom,
	stored: StoredBattleship,
	sinking: BattleshipSinking | null = null,
	turn: readonly RoomMoveInput[] = []
): Promise<void> {
	if (!stored.boardMessageId || !room.channelId) return;
	const channel = await client.channels.fetch(room.channelId).catch(() => null);
	if (!(channel instanceof TextChannel)) return;
	// Null when an admin deleted it: a running battle still posts its next board, so the turn's
	// moves are never lost with it; only setup, which edits in place, needs it.
	const message = await channel.messages.fetch(stored.boardMessageId).catch(() => null);

	const state = deserializeMatch(stored);
	await withDrawingPause({
		gameKey: roomDrawingKey(room),
		showStatus: async (status) => {
			await message?.edit({ content: status });
		},
		render: () => battleshipBoardCard(state, sinking),
		fallback: () => null,
		swapIn: async (card) => {
			const board = battleshipBoardMessageWith(state, room.roomId, card, turn.map((move) => move.text));
			// Once the battle runs, every redraw is a new turn: the start, each shot, the winning
			// shot and an expired turn each post their board through the shared turn board, and the
			// board before keeps its picture and loses its buttons (2026-10 item 263 R3-29). The
			// claim is keyed on the id the caller read, which the shot's own persist just wrote.
			if (state.status !== "setup") {
				await postTurnBoard(channel, room, stored.boardMessageId ?? null, board, { carried: turn });
				return;
			}
			// `attachments: []` drops the last turn's picture, which an edit otherwise
			// keeps, and `content: null` takes the drawing status back off.
			await message?.edit({ ...board, content: null, attachments: [] });
		},
	}).catch((error) => console.warn("[game-rooms] failed to redraw the battleship board", error));
	// The line that pings the captain whose turn it now is, below the board that was just drawn,
	// and that captain's turn clock (2026-10 item 267), counted from the move the board shows.
	await syncTurnPrompt(client, room, battleshipTurnAdapter);
	await syncTurnClocks(client, room, [battleshipTurnClock]);
}

// ── the turn's end (the sweep's and the turn clock's) ─────────────────
/** What one look at a battleship match's clock did. */
export type BattleshipExpiry = "expired" | "forfeited" | "setupTimedOut" | null;

// The setup clock ran out (post-launch plan item 17): start the battle with both
// fleets as they are. A compare and swap on the status, so a second Ready landing in
// the same moment and this sweep cannot both start it. True when this call started it.
async function startBattleOnSetupTimeout(client: Client, room: IGameRoom, stored: StoredBattleship): Promise<boolean> {
	const state = deserializeMatch(stored);
	if (!startBattle(state)) return false;
	const next = serializeMatch(state, { boardMessageId: stored.boardMessageId });
	const started = await gameRoomStore.updateSecretIf(room.guildId, room.roomId, { "secret.status": "setup" }, next);
	if (!started) return false;
	await roomTrail.postMove(client, room, { actorId: room.hostId, kind: "system", text: gameRoomsCopy.battleship.setupTimedOut, meta: { expired: true } });
	await roomTrail.postMove(client, room, { actorId: room.hostId, kind: "system", text: gameRoomsCopy.battleship.battleBegins(state.players[state.turn].userId) });
	await redrawBattleshipBoard(client, room, next);
	return true;
}

// The turn this expiry was decided on, as a filter: the same captain to fire, the same missed
// turn count and not one shot since. Two paths can end a turn now (the turn clock at the deadline
// and the 5 minute sweep), and each would otherwise count a second missed turn for one silence,
// which forfeits the match; whichever writes first wins and the other writes nothing.
const sameTurnFilter = (stored: StoredBattleship): Record<string, unknown> => ({
	"secret.status": "playing",
	"secret.turn": stored.turn,
	"secret.missedTurns": stored.missedTurns,
	"secret.players.0.shots": stored.players[0].shots,
	"secret.players.1.shots": stored.players[1].shots,
});

/**
 * Forfeit the captain's turn when it has sat past GAME_ROOM_TURN_TIMEOUT_MS (the match after two
 * in a row), or start a battle whose setup clock ran out. THE one timeout function: the 5 minute
 * sweep (roomTurnSweep) calls it for every match and the turn clock calls it at the deadline
 * (2026-10 item 267). Answers what it did, or null when nothing was due or another path won.
 */
export async function expireBattleshipTurnIfDue(client: Client, room: IGameRoom, now: Date): Promise<BattleshipExpiry> {
	const stored = storedMatch(room);
	// A room whose match never started, or whose secret is some other game's shape, is not this clock's business.
	if (!stored?.players) return null;

	// Never while the board is drawing, and every held millisecond is added back,
	// so a slow render never costs a player their turn (the drawing pause).
	if (!isClockExpired(roomDrawingKey(room), lastActivityAt(room), BOT_CONSTANTS.GAME_ROOM_TURN_TIMEOUT_MS, now.getTime())) return null;

	const state = deserializeMatch(stored);
	// A captain who never pressed Ready costs nobody the match (post-launch plan
	// item 17): when the setup clock runs out the fleets sail as Dero laid them.
	if (state.status === "setup") return (await startBattleOnSetupTimeout(client, room, stored)) ? "setupTimedOut" : null;
	if (state.status !== "playing") return null;

	// Whose turn is being forfeited, captured BEFORE expireTurn mutates the
	// state, because it passes the turn to the other player.
	const loserId = state.players[state.turn].userId;
	const result = expireTurn(state);
	const next = serializeMatch(state, { boardMessageId: stored.boardMessageId });
	const written = await gameRoomStore.updateSecretIf(room.guildId, room.roomId, sameTurnFilter(stored), next);
	if (!written) return null;

	// The expiry is a MOVE: it belongs in the transcript that is the product, and it is
	// the only record of why the match ended the way it did. It is the turn the captain
	// let pass, so it rides that turn's board as its This turn block (2026-10 item 263
	// R3-29), recorded once the board is posted rather than posted as a line of its own.
	const expired: RoomMoveInput = {
		actorId: loserId,
		kind: "system",
		text: result.forfeited ? gameRoomsCopy.battleship.forfeitedMatch(loserId) : gameRoomsCopy.battleship.forfeitedTurn(loserId),
		meta: { expired: true },
	};
	await redrawBattleshipBoard(client, room, next, null, [expired]);
	if (!result.forfeited) return "expired";

	const claimed = await roomLifecycle.finish(client, room, { winnerId: result.winnerId, outcome: { bucket: "timeout" } });
	// A turn timeout forfeit IS rated, by owner decision (2026-10 item 244): the
	// player who stopped taking turns lost a match they started. Once, by the call
	// that won finish's claim; fire and forget.
	if (claimed && result.winnerId) void recordMatchRatings(room, [result.winnerId, loserId]);

	// The win still pays, because the opponent turning up and the other player
	// not is exactly the behaviour being rewarded. No sink bonus is involved:
	// nothing was sunk by walking away.
	// The captains off the match, not the row: against a Dero bot the row holds the
	// host alone (2026-10 item 250 Phase 5), and awardXp pays the bot nothing.
	const [a, b] = state.players.map((player) => player.userId);
	awardTwoPlayerResult({
		client,
		guildId: room.guildId,
		channelId: room.channelId,
		game: "battleship",
		challenger: { id: a } as never,
		opponent: { id: b } as never,
		winner: result.winnerId === a ? "challenger" : "opponent",
		resultKey: room.roomId,
	});
	return "forfeited";
}

/**
 * Battleship's turn clock (2026-10 item 267): the captain to fire, from the last move the trail
 * holds plus GAME_ROOM_TURN_TIMEOUT_MS and every drawing hold, the same stamp the sweep reads.
 * Setup is no one captain's turn, so it is left to the sweep, which still sails the fleets.
 */
export const battleshipTurnClock: TurnClockGame = {
	kind: "battleship",
	current(room, now) {
		const stored = storedMatch(room);
		const fingerprint = battleshipTurnAdapter.fingerprintOf(room);
		if (stored?.status !== "playing" || !fingerprint) return null;
		return {
			memberId: stored.players[stored.turn].userId,
			fingerprint,
			deadline: pausedDeadline(roomDrawingKey(room), lastActivityAt(room), BOT_CONSTANTS.GAME_ROOM_TURN_TIMEOUT_MS, now),
		};
	},
	async expire(client, room, now) {
		const ended = await expireBattleshipTurnIfDue(client, room, now);
		return ended === "expired" || ended === "forfeited";
	},
};

// ── firing ────────────────────────────────────────────────────────────
// Take your turn opens one modal: the target grid and two selects, a file A to J and a rank 1 to
// 10, so one Submit fires (2026-10 item 257 Phase 4a, owner items 18 and 19). The board has no
// Fire button since 2026-10 item 263 R3-3; this answers one left on a board posted before then.
export async function handleFire(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	await handleTurnPress(interaction, room, battleshipTurnAdapter.fingerprintOf(room) ?? "", () => battleshipTurnAdapter);
}

/**
 * Fire at one coordinate for `shooterId`, whoever opened the modal: the engine's refusals come
 * back as a worded reason, and a landed shot goes through commitShot, the function every shot
 * (a member's, a Dero bot's) ends in.
 */
async function fireAt(client: Client, room: IGameRoom, shooterId: string, aim: { x: number; y: number }, acknowledge: () => Promise<unknown>): Promise<string | null> {
	const stored = storedMatch(room);
	if (!stored) return gameRoomsCopy.battleship.matchOver;
	const outcome = fire(stored, shooterId, aim);
	if (!outcome.ok || !outcome.state) return outcome.message;
	const shooterName = stored.players.find((board) => board.userId === shooterId)?.username ?? shooterId;
	// A silent acknowledgement, not a reply: the trail line already tells the shooter
	// and everyone watching what the shot did, so a private copy of the same sentence
	// only doubled it. Without some acknowledgement Discord shows the shooter
	// "interaction failed" after three seconds.
	await commitShot(client, room, stored, { ...outcome, state: outcome.state }, { userId: shooterId, name: shooterName }, acknowledge);
	return null;
}

/**
 * Everything after a shot the engine accepted, whoever fired it: persist, narrate,
 * redraw, the sink bonus, and the finish when it won. The Fire button and a Dero bot's
 * turn (botTurns, 2026-10 item 250 Phase 5) both land here, so a bot's shot reads exactly
 * like a member's. `acknowledge` runs right after the persist, where the button's
 * deferUpdate always ran.
 */
export async function commitShot(
	client: Client,
	room: IGameRoom,
	stored: StoredBattleship,
	outcome: FireOutcome & { state: BattleshipState },
	shooter: { userId: string; name: string },
	acknowledge: () => Promise<unknown> = async () => undefined
): Promise<void> {
	const next = serializeMatch(outcome.state, { boardMessageId: stored.boardMessageId });
	await persist(room, next);
	await acknowledge();

	// The narration is a MOVE: it belongs in the transcript that is the product, and it
	// names only a coordinate that has now been fired on, never an unfired one. It rides the
	// shot's own board as its This turn block and is recorded once that board is posted, never
	// also posted as a line of its own (2026-10 item 263 R3-29, risk R6).
	const shot: RoomMoveInput = { actorId: shooter.userId, kind: "guess", text: outcome.message, meta: { sunk: outcome.sunk ?? null } };

	// A shot that sank a ship redraws with the sinking reveal on the card.
	const sinking = outcome.sunk ? { shooterId: shooter.userId, ship: outcome.sunk } : null;
	await redrawBattleshipBoard(client, room, next, sinking, [shot]);

	// ── the per sink bonus ──
	// ⚠️ AWARDED WITHOUT `game`, DELIBERATELY. awardXp increments
	// `games.<slug>.played` for ANY call that names a game, so passing
	// game: "battleship" here would record a fifth and sixth "played" for a match
	// the member played once, and /account renders that line. The match record is
	// written exactly once, by awardTwoPlayerResult on the winning shot; this call
	// is xp only.
	//
	// Fire and forget after the primary action (house rule 7): the shot has already
	// landed and been narrated, and awardXp never throws by contract.
	if (outcome.sunk) {
		void awardXp({
			client,
			guildId: room.guildId,
			userId: shooter.userId,
			username: shooter.name,
			amount: BOT_CONSTANTS.LEVELING.GAME_SINK_XP,
			source: "game",
			channelId: room.channelId,
		});
	}

	if (!outcome.won) return;

	// The captains off the match, not the row: against a Dero bot the row holds the host
	// alone (2026-10 item 250 Phase 5). recordMatchRatings leaves a bot match unrated, and
	// awardXp pays a bot nothing.
	const captains = outcome.state.players.map((player) => player.userId);

	// The result card shows the final board with the last sinking on it, when it draws.
	const finalBoard = await battleshipBoardCard(outcome.state, sinking);
	const claimed = await roomLifecycle.finish(client, room, {
		winnerId: shooter.userId,
		...(finalBoard ? { art: finalBoard } : {}),
		outcome: { bucket: battleshipWinOutcome(captains, room, outcome.state, shooter.userId) },
	});
	// Rated once, by the shot that won finish's claim: the shooter first, the other
	// player second (2026-10 item 244). Fire and forget, never awaited.
	if (claimed) void recordMatchRatings(room, twoPlayerFinishingOrder(captains, shooter.userId));

	const [a, b] = captains;
	awardTwoPlayerResult({
		client,
		guildId: room.guildId,
		channelId: room.channelId,
		game: "battleship",
		challenger: { id: a } as never,
		opponent: { id: b } as never,
		winner: shooter.userId === a ? "challenger" : "opponent",
		resultKey: room.roomId,
	});
}

// How the winning shot's match was won (post-launch plan item 21): ships still afloat,
// and whether the winner was ever behind, replayed from the sinkings in the trail. The
// winning shot itself is not in `room.moves` yet, and it cannot put the winner behind.
function battleshipWinOutcome(captains: readonly string[], room: IGameRoom, state: BattleshipState, winnerId: string): OutcomeBucket {
	const loserId = captains.find((id) => id !== winnerId) ?? "";
	const sinkings = (room.moves ?? []).filter((move) => move.kind === "guess" && Boolean(move.meta?.sunk)).map((move) => move.actorId);
	return battleshipOutcome({
		cause: "played",
		winnerShipsAfloat: shipsRemaining(state, winnerId),
		winnerWasBehind: wasBehindOnShips(sinkings, winnerId, loserId, FLEET.length),
	});
}

// ── the private board (Q8: pull based, never pushed) ──────────────────
// ⚠️ ONLY EVER THE CLICKER'S OWN FLEET. This is the one surface that renders a
// player's unfired ships, so it must never reach the channel. It opens as a modal
// (post-launch plan item 16), which only the presser sees, and falls back to the
// ephemeral reply it used to be. No private channels and no DMs either: a channel per
// player costs two channels per match against a 500 channel server cap.
async function showOwnBoard(interaction: ButtonInteraction, room: IGameRoom, state: BattleshipState): Promise<void> {
	await showPrivateView(interaction, room.roomId, privateBoardView(state, interaction.user.id), async () => ({
		...(await privateBoardReply(state, interaction.user.id)),
		...PRIVATE,
	}));
}

export async function handleViewBoard(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	const stored = storedMatch(room);
	if (!stored) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.battleship, sections: [gameRoomsCopy.battleship.matchOver] });
		return;
	}
	await showOwnBoard(interaction, room, deserializeMatch(stored));
}

// ── setup: Randomize and Ready (post-launch plan item 17) ─────────────
// The refusals the setup controls share, worded for the member who pressed.
const SETUP_REFUSALS: Record<SetupRefusal, string> = {
	"not-in-setup": gameRoomsCopy.battleship.setupOver,
	"not-a-player": gameRoomsCopy.errors.notYours,
	"already-ready": gameRoomsCopy.battleship.alreadyReady,
};

/**
 * Randomize (2026-10 item 263 R3-1): lay this captain's fleet again IN MEMORY, open the setup
 * modal showing it at once, then write it. The modal must be the press's first answer inside
 * Discord's three seconds, so nothing renders or fetches before it (risk R5), and it carries the
 * new fleet's fingerprint, so a Submit locks in this fleet and no other (risk R14). Pressed as
 * often as the captain likes; each press supersedes the modal before it. A Randomize on a board
 * posted before Phase 4a of item 257 (action `reroll`) lands here too.
 */
export async function handleRandomize(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	const userId = interaction.user.id;
	const relaid = relayFleet(room, userId);
	if (!relaid.ok) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.battleship, sections: [relaid.reason] });
		return;
	}
	await showTurnModal(interaction, room.roomId, fleetFingerprint(relaid.board), setupView(relaid.state, userId));
	// One player's fleet slot, by index: writing the whole secret back would revert whatever
	// the opponent did between this handler's read and its write. The opponent's own Randomize
	// is a DIFFERENT index. Written after the modal opened; if it fails, the modal's Submit
	// meets the old fleet's fingerprint and locks nothing.
	await gameRoomStore.setSecretField(room.guildId, room.roomId, `players.${relaid.index}`, relaid.board);
}

type RelaidFleet = { ok: true; state: BattleshipState; index: 0 | 1; board: StoredBattleship["players"][number] } | { ok: false; reason: string };

/** Lay one captain's fleet again without writing it. Answers the new fleet and its slot, or the refusal worded for the member. */
function relayFleet(room: IGameRoom, userId: string): RelaidFleet {
	const stored = storedMatch(room);
	if (!stored) return { ok: false, reason: gameRoomsCopy.battleship.matchOver };

	const state = deserializeMatch(stored);
	const result = rerollFleet(state, userId);
	if (!result.ok) {
		// A board posted before setup existed is past its first shot or at it; its old
		// Reroll button answers in the words it always did.
		return { ok: false, reason: result.reason === "not-in-setup" && stored.ready === undefined ? gameRoomsCopy.battleship.rerollTooLate : SETUP_REFUSALS[result.reason] };
	}
	return { ok: true, state, index: result.index, board: serializeMatch(state).players[result.index] };
}

/** The setup modal: the captain's fleet and no field, so its Submit is I am ready and closing it is not yet. */
function setupView(state: BattleshipState, userId: string): TurnView {
	return { title: gameRoomsCopy.battleship.setupModalTitle, text: [ownFleetText(state, userId)], fields: [] };
}

// Ready: lock this player's fleet. The first Ready is narrated and redrawn; the second
// starts the battle, exactly once, however close together the two presses land.
export async function handleReady(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	const refusal = await lockFleetIn(interaction.client, room, interaction.user.id, () => interaction.deferUpdate());
	if (refusal) await showNotice(interaction, { title: gameRoomsCopy.notices.battleship, sections: [refusal] });
}

/** Lock one captain's fleet in, the function the old Ready button and the setup modal's Submit both call. Answers a refusal or null. */
async function lockFleetIn(client: Client, room: IGameRoom, userId: string, acknowledge: () => Promise<unknown>): Promise<string | null> {
	const stored = storedMatch(room);
	if (!stored) return gameRoomsCopy.battleship.matchOver;

	const result = markReady(deserializeMatch(stored), userId);
	if (!result.ok) return SETUP_REFUSALS[result.reason];
	await commitReady(client, room, userId, result.index, acknowledge);
	return null;
}

/**
 * Lock one captain's fleet in, after markReady accepted it, and start the battle on the
 * second Ready. The Ready button and a Dero bot captain (botTurns, 2026-10 item 250 Phase
 * 5) both land here. `acknowledge` runs where the button's deferUpdate always ran.
 */
export async function commitReady(
	client: Client,
	room: IGameRoom,
	userId: string,
	index: 0 | 1,
	acknowledge: () => Promise<unknown> = async () => undefined
): Promise<void> {
	// ① This player's own slot only, so a Ready landing beside the opponent's cannot
	// write theirs back to false. ② The start is a compare and swap on the status, so
	// when both Readies land together and each sees both flags, one of them starts it.
	// Writing the whole blob there is safe: with both captains ready nothing else in
	// setup writes the secret (no aim exists yet and Randomize refuses a ready player).
	const afterReady = await gameRoomStore.setSecretField(room.guildId, room.roomId, `ready.${index}`, true);
	const readied = (afterReady?.secret as StoredBattleship | null) ?? null;
	const bothReady = readied?.ready?.[0] === true && readied?.ready?.[1] === true;
	const started =
		readied && bothReady
			? await gameRoomStore.updateSecretIf(room.guildId, room.roomId, { "secret.status": "setup" }, { ...readied, status: "playing" })
			: null;

	await acknowledge();
	await roomTrail.postMove(client, room, { actorId: userId, kind: "system", text: gameRoomsCopy.battleship.readyLine(userId) });

	const latest = (started ?? afterReady)?.secret as StoredBattleship | null;
	if (!latest) return;
	if (started) {
		await roomTrail.postMove(client, room, {
			actorId: userId,
			kind: "system",
			text: gameRoomsCopy.battleship.battleBegins(latest.players[latest.turn].userId),
		});
	}
	await redrawBattleshipBoard(client, room, latest);
}

// ── the turn prompt (turnPrompt.ts, 2026-10 item 257 Phase 4a) ────────
// What:  Battleship's side of the shared turn piece. While the fleets are laid there is no one
//        on the clock: the board's Set up your fleet button opens one modal with your fleet's
//        emoji grid and nothing to choose, and its Submit locks that fleet in (2026-10 item 263
//        R3-1); the board's Randomize opens the same modal on a new fleet. Once the battle
//        runs, Take your turn opens one modal with the target grid and a file and a rank
//        select, and one Submit fires.
// How:   the setup Submit plays through lockFleetIn, the function the old Ready button calls; a
//        shot plays through fireAt and commitShot, the path every shot ends in. The grid stays
//        emoji text (owner decision 14): a modal shows no image.
// ⚠️ A SETUP MODAL CARRIES ITS FLEET'S FINGERPRINT (risk R14). The press is the same "setup" for
// both captains, but each modal carries fleetFingerprint of the fleet it showed and the Submit is
// checked against the fleet stored now, so a modal opened before a Randomize locks nothing and
// answers the way a passed turn does.

const FILE_FIELD = "file";
const RANK_FIELD = "rank";

const shotsFired = (state: BattleshipState): number => state.players[0].shots.size + state.players[1].shots.size;

export const battleshipTurnAdapter: TurnAdapter = {
	game: "battleship",
	whoseTurn(room) {
		const stored = storedMatch(room);
		return stored?.status === "playing" ? stored.players[stored.turn].userId : null;
	},
	canAct(room, userId) {
		const stored = storedMatch(room);
		if (!stored) return false;
		if (stored.status === "setup") return stored.players.some((board) => board.userId === userId);
		return stored.status === "playing" && stored.players[stored.turn].userId === userId;
	},
	fingerprintOf(room) {
		const stored = storedMatch(room);
		if (!stored) return null;
		if (stored.status === "setup") return SETUP_PRESS_FINGERPRINT;
		return stored.status === "playing" ? `b${shotsFired(deserializeMatch(stored))}` : null;
	},
	memberFingerprintOf(room, userId) {
		const stored = storedMatch(room);
		if (stored?.status !== "setup") return battleshipTurnAdapter.fingerprintOf(room);
		const board = stored.players.find((player) => player.userId === userId);
		return board ? fleetFingerprint(board) : null;
	},
	view(room, userId) {
		const stored = storedMatch(room);
		if (!stored) return null;
		const copy = gameRoomsCopy.battleship;
		const state = deserializeMatch(stored);
		if (stored.status === "setup") {
			const index = state.players.findIndex((player) => player.userId === userId);
			if (index < 0 || state.ready[index]) return null;
			return setupView(state, userId);
		}
		if (stored.status !== "playing" || state.players[state.turn].userId !== userId) return null;
		return {
			title: copy.fireModalTitle,
			text: [targetGridText(state, userId)],
			fields: [
				{ kind: "select", id: FILE_FIELD, label: copy.columnPlaceholder, options: COLUMNS.map((label, index) => ({ label, value: String(index) })) },
				{ kind: "select", id: RANK_FIELD, label: copy.rowPlaceholder, options: Array.from({ length: GRID_SIZE }, (_, index) => ({ label: String(index + 1), value: String(index) })) },
			],
		};
	},
	async apply(client, room, userId, answers, acknowledge) {
		const stored = storedMatch(room);
		if (stored?.status === "setup") {
			const refusal = await lockFleetIn(client, room, userId, acknowledge);
			return refusal ? { ok: false, reason: refusal } : { ok: true };
		}
		const x = Number.parseInt(answers[FILE_FIELD] ?? "", 10);
		const y = Number.parseInt(answers[RANK_FIELD] ?? "", 10);
		if (!Number.isInteger(x) || !Number.isInteger(y)) return { ok: false, reason: gameRoomsCopy.battleship.offGrid };
		const refusal = await fireAt(client, room, userId, { x, y }, acknowledge);
		return refusal ? { ok: false, reason: refusal } : { ok: true };
	},
};

export const roomBattleshipHandlers = { handleFire, handleViewBoard, handleRandomize, handleReady, commitShot, commitReady };
