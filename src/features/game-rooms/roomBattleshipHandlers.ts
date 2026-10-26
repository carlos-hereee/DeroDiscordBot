import { MessageFlags, TextChannel, type ButtonInteraction, type Client, type StringSelectMenuInteraction } from "discord.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { FLEET, markReady, rerollFleet, shipsRemaining, type BattleshipState, type SetupRefusal } from "@features/games/battleshipState.js";
import { awardTwoPlayerResult } from "@features/games/gameXp.js";
import { awardXp } from "@features/leveling/awardXp.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { recordMatchRatings, twoPlayerFinishingOrder } from "@features/ratings/recordMatchRatings.js";
import { roomTrail } from "./roomTrail.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { roomDrawingKey, withDrawingPause } from "./drawingPause.js";
import {
	fire,
	deserializeMatch,
	serializeMatch,
	battleshipBoardCard,
	battleshipBoardMessageWith,
	privateBoardReply,
	privateBoardView,
	PRIVATE,
	type BattleshipSinking,
	type FireOutcome,
	type StoredBattleship,
} from "./roomBattleship.js";
import { showPrivateView } from "./privateView.js";
import { battleshipOutcome, wasBehindOnShips, type OutcomeBucket } from "./matchOutcome.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── roomBattleshipHandlers ───────────────────────────────────────────
// What:  the interaction half of battleship: aiming, firing, looking at your own
//        board, and re-laying your fleet.
// Who:   routed from gameRoomHandlers, which has already proven the clicker is one
//        of the room's players.
// When:  many times per match, unlike every other game in this feature.
// Where: the public board is ONE message, EDITED every turn. That deliberately
//        differs from hangman's append-only trail: a 10x10 grid reposted per shot
//        would be thirty unreadable walls, so the board carries the STATE and the
//        trail carries the NARRATION. Both exist; neither is redundant.
// How:   every write goes back through the room row, so a deploy mid-match costs
//        nothing.

const storedMatch = (room: IGameRoom): StoredBattleship | null => (room.secret as StoredBattleship | null) ?? null;

async function persist(room: IGameRoom, stored: StoredBattleship) {
	return gameRoomStore.update(room.guildId, room.roomId, { secret: stored as never });
}

/**
 * Redraw the one public board message behind the drawing pause, so the turn clock
 * holds while the card renders. Shared by a shot and the turn sweep's expiry.
 * Cosmetic, so a failure is logged and swallowed: the row is the truth and the
 * next turn will catch up.
 */
export async function redrawBattleshipBoard(
	client: Client,
	room: IGameRoom,
	stored: StoredBattleship,
	sinking: BattleshipSinking | null = null
): Promise<void> {
	if (!stored.boardMessageId || !room.channelId) return;
	const channel = await client.channels.fetch(room.channelId).catch(() => null);
	if (!(channel instanceof TextChannel)) return;
	const message = await channel.messages.fetch(stored.boardMessageId).catch(() => null);
	if (!message) return;

	const state = deserializeMatch(stored);
	await withDrawingPause({
		gameKey: roomDrawingKey(room),
		showStatus: (status) => message.edit({ content: status }),
		render: () => battleshipBoardCard(state, sinking),
		fallback: () => null,
		// `attachments: []` drops the last turn's picture, which an edit otherwise
		// keeps, and `content: null` takes the drawing status back off.
		swapIn: (card) => message.edit({ ...battleshipBoardMessageWith(state, room.roomId, card), content: null, attachments: [] }),
	}).catch((error) => console.warn("[game-rooms] failed to redraw the battleship board", error));
}

// ── aiming ────────────────────────────────────────────────────────────
// The two selects each store HALF a coordinate on the row. Keeping it on the row
// rather than in a Map means a deploy mid-aim costs a re-click at worst, and two
// players aiming at once cannot collide on one shared slot.
//
// ⚠️ THAT LAST CLAUSE IS TRUE OF THE SLOT AND WAS FALSE OF THE WRITE. Each player owns
// `pending.<their id>`, but this handler used to persist `{ ...stored, pending }`, the WHOLE
// secret rebuilt from a snapshot read at handler entry. So an aim landing just after the
// opponent's shot wrote their shot, the turn and their sunk-ship progress straight back to
// what they were before it. A dotted setSecretField on this player's own slot touches
// nothing else, which is what makes the original comment true.
export async function handleAimSelect(interaction: StringSelectMenuInteraction): Promise<void> {
	const [, action, roomId] = interaction.customId.split(":");
	const guildId = interaction.guildId;
	if (!guildId || !roomId) return;

	const room = await gameRoomStore.findByRoomId(guildId, roomId);
	if (!room || room.status !== "playing") {
		await interaction.reply({ content: gameRoomsCopy.battleship.matchOver, ...PRIVATE });
		return;
	}
	// Re-gated: a select's customId is user input and this is reachable directly.
	if (!room.playerIds.includes(interaction.user.id)) {
		await interaction.reply({ content: gameRoomsCopy.errors.notYours, ...PRIVATE });
		return;
	}

	const stored = storedMatch(room);
	if (!stored) {
		await interaction.reply({ content: gameRoomsCopy.battleship.matchOver, ...PRIVATE });
		return;
	}

	const value = Number.parseInt(interaction.values[0] ?? "", 10);
	if (!Number.isInteger(value)) return;

	const mine = { ...(stored.pending?.[interaction.user.id] ?? {}) };
	if (action === "bscol") mine.x = value;
	else mine.y = value;

	// setSecretField, not claimSecretField: the second select must land ON TOP of the first,
	// so this is a revision, not a once-only claim.
	await gameRoomStore.setSecretField(guildId, roomId, `pending.${interaction.user.id}`, mine);

	// Ephemeral, always: announcing an aim publicly would tell the opponent where
	// the next shot is going before it is fired.
	const ready = mine.x !== undefined && mine.y !== undefined;
	await interaction.reply({
		content: ready
			? gameRoomsCopy.battleship.aimed(`${["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"][mine.x!]}${mine.y! + 1}`)
			: gameRoomsCopy.battleship.aimedPartial,
		...PRIVATE,
	});
}

// ── firing ────────────────────────────────────────────────────────────
export async function handleFire(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	const stored = storedMatch(room);
	if (!stored) {
		await interaction.reply({ content: gameRoomsCopy.battleship.matchOver, ...PRIVATE });
		return;
	}

	const outcome = fire(stored, interaction.user.id);
	if (!outcome.ok || !outcome.state) {
		await interaction.reply({ content: outcome.message, ...PRIVATE });
		return;
	}

	const shooterName =
		interaction.guild?.members.cache.get(interaction.user.id)?.displayName ?? interaction.user.globalName ?? interaction.user.username;
	// A silent acknowledgement, not a reply: the trail line already tells the shooter
	// and everyone watching what the shot did, so a private copy of the same sentence
	// only doubled it. Without some acknowledgement Discord shows the shooter
	// "interaction failed" after three seconds.
	await commitShot(interaction.client, room, stored, { ...outcome, state: outcome.state }, { userId: interaction.user.id, name: shooterName }, () => interaction.deferUpdate());
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
	// Clear the shooter's aim so the next turn starts from nothing rather than
	// re-firing the previous coordinate on a stray press.
	const pending = { ...(stored.pending ?? {}) };
	delete pending[shooter.userId];
	const next = serializeMatch(outcome.state, { pending, boardMessageId: stored.boardMessageId });
	await persist(room, next);
	await acknowledge();

	// The narration is a MOVE: it belongs in the transcript that is the product, and
	// it names only a coordinate that has now been fired on, never an unfired one.
	await roomTrail.postMove(client, room, {
		actorId: shooter.userId,
		kind: "guess",
		text: outcome.message,
		meta: { sunk: outcome.sunk ?? null },
	});

	// A shot that sank a ship redraws with the sinking reveal on the card.
	const sinking = outcome.sunk ? { shooterId: shooter.userId, ship: outcome.sunk } : null;
	await redrawBattleshipBoard(client, room, next, sinking);

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
		await interaction.reply({ content: gameRoomsCopy.battleship.matchOver, ...PRIVATE });
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

// Randomize: lay this player's fleet again, then show them the new layout in the
// private view, so the press answers with the thing it changed and nothing lands in
// the channel. Only during setup and only before this player pressed Ready.
export async function handleReroll(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	const stored = storedMatch(room);
	if (!stored) {
		await interaction.reply({ content: gameRoomsCopy.battleship.matchOver, ...PRIVATE });
		return;
	}

	const state = deserializeMatch(stored);
	const result = rerollFleet(state, interaction.user.id);
	if (!result.ok) {
		// A board posted before setup existed is past its first shot or at it; its old
		// Reroll button answers in the words it always did.
		const refusal = result.reason === "not-in-setup" && stored.ready === undefined ? gameRoomsCopy.battleship.rerollTooLate : SETUP_REFUSALS[result.reason];
		await interaction.reply({ content: refusal, ...PRIVATE });
		return;
	}

	// One player's fleet slot, by index, for the same reason as the aim above: writing the whole
	// secret back would revert whatever the opponent did between this handler's read and its
	// write. The opponent's own reroll is a DIFFERENT index.
	const relaid = serializeMatch(state).players[result.index];
	await gameRoomStore.setSecretField(room.guildId, room.roomId, `players.${result.index}`, relaid);
	await showOwnBoard(interaction, room, state);
}

// Ready: lock this player's fleet. The first Ready is narrated and redrawn; the second
// starts the battle, exactly once, however close together the two presses land.
export async function handleReady(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	const stored = storedMatch(room);
	if (!stored) {
		await interaction.reply({ content: gameRoomsCopy.battleship.matchOver, ...PRIVATE });
		return;
	}

	const result = markReady(deserializeMatch(stored), interaction.user.id);
	if (!result.ok) {
		await interaction.reply({ content: SETUP_REFUSALS[result.reason], ...PRIVATE });
		return;
	}
	await commitReady(interaction.client, room, interaction.user.id, result.index, () => interaction.deferUpdate());
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

export const roomBattleshipHandlers = { handleAimSelect, handleFire, handleViewBoard, handleReroll, handleReady, commitShot, commitReady };

// Re-exported so the router's flag reads identically to every other ephemeral
// surface in the feature.
export const BATTLESHIP_PRIVATE_FLAGS = MessageFlags.Ephemeral;
