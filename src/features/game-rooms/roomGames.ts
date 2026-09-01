import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	MessageFlags,
	StringSelectMenuBuilder,
	type ButtonInteraction,
	type StringSelectMenuInteraction,
} from "discord.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { resolveVersus, type VersusFlip } from "@features/games/versusResolve.js";
import { resolveGameAsset, type GameAssetKey } from "@features/games/gamesAssets.js";
import { scoreRps, RPS_CHOICES, type RpsChoice } from "@features/games/rpsWinner.js";
import { awardTwoPlayerResult } from "@features/games/gameXp.js";
import { roomTrail } from "./roomTrail.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { GAME_ROOM_PREFIX, GAME_ROOM_SELECT_PREFIX } from "./gameRoomActions.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── roomGames ────────────────────────────────────────────────────────
// What:  the in-room half of every two-player game: the control that appears in a
//        room, and what happens when a player presses it.
// Who:   the `gameroom:move:<roomId>` button, routed by gameRoomHandlers.
// When:  once for coin flip and dice roll (one press decides it), twice for rps
//        (each player picks in secret).
// Where: the room row is the ONLY state. The old handlers kept rounds in a
//        module-scoped Map that Railway's SIGTERM destroyed on every deploy, so a
//        match open at that moment simply died. A room survives the deploy.
// How:   every visible state change goes through roomTrail.postMove, so the Discord
//        scroll and the transcript cannot disagree, and the match ends through
//        roomLifecycle.finish, so the lock, the result card and the archive clock
//        are the same ones every other ending uses.

// The control that rides the room's opener card.
export function roomMoveRow(room: Pick<IGameRoom, "roomId" | "game">): ActionRowBuilder<ButtonBuilder> {
	const label =
		room.game === "coinflip" ? "Flip the coin" : room.game === "diceroll" ? "Roll the dice" : "Make your pick";
	const emoji = room.game === "coinflip" ? "🪙" : room.game === "diceroll" ? "🎲" : "✊";

	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder().setCustomId(`${GAME_ROOM_PREFIX}:move:${room.roomId}`).setLabel(label).setEmoji(emoji).setStyle(ButtonStyle.Primary),
		new ButtonBuilder()
			.setCustomId(`${GAME_ROOM_PREFIX}:forfeit:${room.roomId}`)
			.setLabel("Forfeit")
			.setStyle(ButtonStyle.Secondary)
	);
}

// Route a move to its game. Reached only after gameRoomHandlers has proven the
// clicker is one of the room's players (`move` is playersOnly), which is what stops
// a spectator resolving somebody else's match.
export async function runRoomMove(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	if (room.status !== "playing") {
		await interaction.reply({ content: gameRoomsCopy.errors.notFound, flags: MessageFlags.Ephemeral });
		return;
	}

	if (room.game === "coinflip" || room.game === "diceroll") {
		await runVersusMove(interaction, room);
		return;
	}
	if (room.game === "rps") {
		await promptRpsChoice(interaction, room);
		return;
	}

	// hangman lands here once Phase 5 moves it into rooms. Honest until then.
	await interaction.reply({ content: "This game has no room controls yet.", flags: MessageFlags.Ephemeral });
}

// ── coin flip and dice roll ───────────────────────────────────────────
// One press resolves the whole match, so there is no secret half and nothing to
// coordinate. Either player may press it: both agreed to the match by being in the
// room, and making it host-only would strand a match whose host walked away.
async function runVersusMove(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	const flip: VersusFlip = room.game === "coinflip" ? "coin" : "dice";
	const [challengerId, opponentId] = room.playerIds;

	await interaction.deferUpdate();

	// ① Re-read the row before resolving anything. The `room` this handler was given was
	// loaded at button-press time, so when both players press in the same tick, both arrive
	// here holding a "playing" snapshot. A fresh read turns most of those second presses into
	// a silent no-op BEFORE a flip line is composed or posted (the first press's outcome is
	// already on screen, so there is nothing to tell this presser). This only NARROWS the
	// window; the finish claim below plus the superseded line at ③ close what remains.
	const fresh = await gameRoomStore.findByRoomId(room.guildId, room.roomId);
	if (!fresh || fresh.status !== "playing") return;

	const result = resolveVersus(flip);
	const winnerId =
		result.winner === "tie" ? null : result.winner === "challenger" ? challengerId : opponentId;

	const detail =
		result.flip === "coin"
			? gameRoomsCopy.games.coinLine(result.face)
			: gameRoomsCopy.games.diceLine(challengerId, result.challengerRoll, opponentId, result.opponentRoll);

	await roomTrail.postMove(interaction.client, room, {
		actorId: interaction.user.id,
		kind: "system",
		text: detail,
		meta: { result },
	});

	// The payoff frame. A dice TIE gets its own image so the flattest outcome still
	// reads as an outcome rather than a missing winner; a coin cannot tie, which the
	// VersusResult union already guarantees.
	const artKey: GameAssetKey = result.flip === "coin" ? "coinFlip" : result.winner === "tie" ? "diceTie" : "diceRoll";
	const ended = await roomLifecycle.finish(interaction.client, room, { winnerId, art: resolveGameAsset(artKey) });

	// ⚠️ ONLY THE PRESS THAT ENDED THE MATCH PAYS. This function takes no claim of its own,
	// so two players pressing in the same tick both reach here having each resolved their own
	// flip. finish is conditional on a non-terminal status and reports which press won, and the
	// award sits OUTSIDE that write, so without this guard the loser's press would pay the base
	// game XP a second time and record `games.<slug>.played` twice on both members. The room's
	// own rate top up is already inside the claim.
	//
	// ③ The losing press already POSTED its flip at ②, because posting first is the
	// send-first-then-append invariant and moving it after the claim would trade a cosmetic
	// wart for an unrecoverable one. So when the claim reports this press lost the race, say
	// so where both contradictory lines are standing: an append-only correction through the
	// same trail, never an edit of the posted row. The channel and the transcript then both
	// record which result was real.
	if (!ended) {
		await roomTrail.postMove(interaction.client, room, {
			actorId: interaction.user.id,
			kind: "system",
			text: gameRoomsCopy.games.flipSuperseded,
			meta: { superseded: true, result },
		});
		return;
	}

	// Fire and forget after the primary action, per house rule 7. Both players have
	// already seen the outcome, so nothing the award does can change what the match
	// looked like, and awardXp never throws by contract.
	awardTwoPlayerResult({
		client: interaction.client,
		guildId: room.guildId,
		channelId: room.channelId ?? "",
		game: room.game,
		challenger: { id: challengerId } as never,
		opponent: { id: opponentId } as never,
		winner: result.winner,
	});
}

// ── rock paper scissors ───────────────────────────────────────────────
// ⚠️ THE SECRECY PROPERTY IS THE ONE REGRESSION THE PLAN CALLS UNFORGIVABLE. A
// spectator must not learn either throw before the reveal. Two things enforce it and
// both are needed: ① a pick is submitted through an EPHEMERAL select, so it is never
// a message in the channel, and ② the only thing posted to the trail before both
// picks are in is a "locked in" line that names the player and NOT the choice. The
// choice itself lives on room.secret, which the model documents as never reaching an
// embed, a customId or a log line before the room is terminal.
interface RpsSecret {
	picks?: Record<string, RpsChoice>;
}

async function promptRpsChoice(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	const picks = ((room.secret as RpsSecret | null)?.picks ?? {}) as Record<string, RpsChoice>;
	if (picks[interaction.user.id]) {
		await interaction.reply({ content: gameRoomsCopy.games.rpsAlreadyPicked, flags: MessageFlags.Ephemeral });
		return;
	}

	const select = new StringSelectMenuBuilder()
		.setCustomId(`${GAME_ROOM_SELECT_PREFIX}:rps:${room.roomId}`)
		.setPlaceholder(gameRoomsCopy.games.rpsPlaceholder)
		.setMinValues(1)
		.setMaxValues(1)
		.addOptions(RPS_CHOICES.map((choice) => ({ label: gameRoomsCopy.games.rpsLabel(choice), value: choice })));

	// Ephemeral, so the prompt itself gives nothing away to the channel either.
	await interaction.reply({
		content: gameRoomsCopy.games.rpsPrompt,
		components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
		flags: MessageFlags.Ephemeral,
	});
}

// The secret pick's submission.
export async function handleRpsSelect(interaction: StringSelectMenuInteraction): Promise<void> {
	const [prefix, action, roomId] = interaction.customId.split(":");
	if (prefix !== GAME_ROOM_SELECT_PREFIX || action !== "rps" || !roomId) return;

	const guildId = interaction.guildId;
	if (!guildId) return;

	const room = await gameRoomStore.findByRoomId(guildId, roomId);
	if (!room || room.status !== "playing") {
		await interaction.reply({ content: gameRoomsCopy.errors.notFound, flags: MessageFlags.Ephemeral });
		return;
	}
	// Re-gate here rather than trusting that the button was gated: a select's customId
	// is user input and this handler is reachable directly.
	if (!room.playerIds.includes(interaction.user.id)) {
		await interaction.reply({ content: gameRoomsCopy.errors.notYours, flags: MessageFlags.Ephemeral });
		return;
	}

	const choice = interaction.values[0] as RpsChoice;
	if (!RPS_CHOICES.includes(choice)) return;

	// ⚠️ CLAIM THE SLOT, DO NOT READ-MODIFY-WRITE THE BLOB. `secret` is a single Mixed
	// field, so writing back `{ picks }` built from this handler's own read replaced it
	// wholesale: both players picking in the same tick left only the second pick, `bothIn`
	// was false for BOTH of them, and the room sat at "playing" forever holding its host's
	// one-room slot with nothing to sweep it. A dotted claim on this player's own slot
	// cannot touch the other player's, and a null return means this player had already
	// picked. That null REPLACES the read-then-check this handler used to do: the check and
	// the write are now one server-side operation, so a double submit cannot slip between
	// them. promptRpsChoice still refuses early on the button, but a select's customId is
	// user input and this handler is reachable without it.
	const claimed = await gameRoomStore.claimSecretField(guildId, roomId, `picks.${interaction.user.id}`, choice);
	if (!claimed) {
		await interaction.reply({ content: gameRoomsCopy.games.rpsAlreadyPicked, flags: MessageFlags.Ephemeral });
		return;
	}
	// Ephemeral confirmation. Naming the choice back to the player who made it is
	// safe; it is their own screen.
	await interaction.reply({ content: gameRoomsCopy.games.rpsLocked(choice), flags: MessageFlags.Ephemeral });

	// Off the RETURNED row, never off `room`. The row this handler read predates the other
	// player's claim, so deciding `bothIn` from it is exactly how both players ended up
	// waiting on each other.
	const picks = ((claimed.secret as RpsSecret | null)?.picks ?? {}) as Record<string, RpsChoice>;
	const [challengerId, opponentId] = room.playerIds;
	const bothIn = Boolean(picks[challengerId] && picks[opponentId]);

	if (!bothIn) {
		// ⚠️ NAMES THE PLAYER, NEVER THE CHOICE. This line is public, and it exists so
		// the other player knows to go, which needs no information about the throw.
		await roomTrail.postMove(interaction.client, room, {
			actorId: interaction.user.id,
			kind: "system",
			text: gameRoomsCopy.games.rpsLockedPublic(interaction.user.id),
		});
		return;
	}

	// Both are in: reveal, and only now does either choice become public.
	const outcome = scoreRps(picks[challengerId], picks[opponentId]);
	const winnerId = outcome === "tie" ? null : outcome === "challenger" ? challengerId : opponentId;

	await roomTrail.postMove(interaction.client, room, {
		actorId: interaction.user.id,
		kind: "system",
		text: gameRoomsCopy.games.rpsReveal(challengerId, picks[challengerId], opponentId, picks[opponentId]),
		meta: { picks, outcome },
	});

	// The WINNING throw, so the image says something the text does not already say
	// twice. A tie has its own frame.
	const rpsArt: GameAssetKey =
		outcome === "tie"
			? "rpsTie"
			: (`rps${(outcome === "challenger" ? picks[challengerId] : picks[opponentId]).replace(/^./, (c) => c.toUpperCase())}` as GameAssetKey);
	await roomLifecycle.finish(interaction.client, room, { winnerId, art: resolveGameAsset(rpsArt) });

	awardTwoPlayerResult({
		client: interaction.client,
		guildId: room.guildId,
		channelId: room.channelId ?? "",
		game: "rps",
		challenger: { id: challengerId } as never,
		opponent: { id: opponentId } as never,
		winner: outcome,
	});
}
