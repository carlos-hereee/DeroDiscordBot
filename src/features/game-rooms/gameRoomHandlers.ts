import { type ButtonInteraction, type ModalSubmitInteraction } from "discord.js";
import { registerButton, registerSelectMenu, registerModal } from "@handlers/interactionRegistry.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { gateOwnerOrAdmin } from "@utils/permissions.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import {
	GAME_ROOM_PREFIX,
	GAME_ROOM_SELECT_PREFIX,
	GAME_ROOM_MODAL_PREFIX,
	GAME_ROOM_ACTIONS,
	HOST_STRICT_ACTIONS,
	SATELLITE_ACTIONS,
	CONFIRM_ACTIONS,
	confirmCustomId,
	parseGameRoomCustomId,
	type GameRoomAction,
	type ParsedGameRoomCustomId,
} from "./gameRoomActions.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { roomTrail } from "./roomTrail.js";
import { challengeBoard } from "./challengeBoard.js";
import { CHALLENGE_GAMES } from "./challengeBoardEmbeds.js";
import { SETTINGS_GAMES } from "./challengeSettings.js";
import { runRoomMove, handleRpsSelect } from "./roomGames.js";
import {
	openAuthoringModal,
	openGuessModal,
	handleAuthoringModal,
	handleGuessModal,
	handleCategorySelect,
} from "./roomHangman.js";
import { roomBattleshipHandlers } from "./roomBattleshipHandlers.js";
import { roomHoldemHandlers } from "./roomHoldemHandlers.js";
import { roomMonopolyHandlers } from "./roomMonopolyHandlers.js";
import { roomMonopolyBuild } from "./roomMonopolyBuild.js";
import { roomMonopolyMortgage } from "./roomMonopolyMortgage.js";
import { roomMonopolyTrade } from "./roomMonopolyTrade.js";
import { roomMonopolyAuction } from "./roomMonopolyAuction.js";
import { roomMonopolySurrender } from "./roomMonopolySurrender.js";
import { roomMonopolyRefereeNotice } from "./roomMonopolyRefereeNotice.js";
import { hostControls } from "./hostControls.js";
import { PRIVATE_VIEW_ACTION, closePrivateView } from "./privateView.js";
import { satelliteAt } from "./satelliteRooms.js";
import { handleTurnPress, handleTurnSubmit } from "./turnPrompt.js";
import { turnAdapterFor } from "./turnAdapters.js";
import { registerNetworkHandlers } from "./networkJoin.js";
import type { GameSlug, SatelliteRoom } from "./roomTypes.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { archiveSaveSelect, canSaveMatch, saveMatchIfChosen } from "./savedMatches.js";
import { acknowledgeConfirm, showConfirm, showNotice, type ConfirmInteraction } from "@utils/textModal.js";

const satelliteWords = rokCommanderCopy.arcadeSatellites;

// The games a creation modal may post a card for: the board's own, plus the Blackjack table
// the arcade host's button opens, one list with the settings table (challengeSettings). Wider
// than CHALLENGE_GAMES, which is only the board's buttons.
const DRAFT_CONFIRM_GAMES: readonly string[] = SETTINGS_GAMES;

// The actions that only make sense while a draft is still a draft. Listed once so
// the status refusal below cannot drift from the routing switch. `requests` and `kick`
// are host controls too but are NOT here: they also work in a live room, and each
// refuses by the room's status itself.
const BOARD_ACTIONS = new Set<GameRoomAction>(["vis", "invite", "join", "start", "startok", "dero", "cancel", "auctions", "referee", "approval", "bots", "casual", "hbuyin", "haccept", "edit", "editok"]);

// ── gameRoomHandlers ─────────────────────────────────────────────────
// What:  routes every `gameroom:` button to its action, after proving the clicker is
//        allowed to press it.
// Who:   registered once at boot from main.ts, beside the suggestion box and arcade
//        host handlers.
// When:  on every click, including clicks on buttons from rooms that were archived
//        weeks ago. A customId lives as long as the message it rides.
// Where: ⚠️ main.ts DOES NOT GATE BUTTONS. Its permission checks live inside
//        `if (interaction.isChatInputCommand())` and it returns from the button branch
//        long before reaching them, so a button-driven feature MUST gate itself. This
//        file is that gate, exactly as PowerUps.handlePowerUpButton re-verifies admin
//        on every click rather than trusting the button's existence.
// How:   parse, load the room SCOPED TO THE GUILD (or, for a press in a network table's
//        satellite, to the guild and channel it came from), apply the satellite's own
//        gate and then the action's declared gate, then act.

/** A press, a confirm's Submit included, that passed every gate the router applies. */
type GatedPress =
	| { kind: "new"; parsed: ParsedGameRoomCustomId; game: GameSlug }
	| { kind: "room"; parsed: ParsedGameRoomCustomId; room: IGameRoom; isAdmin: boolean };

/** What reaches the router: a button press, or the Submit of a confirm it opened. */
type GameRoomPress = ButtonInteraction | ModalSubmitInteraction;

// Every gate a press passes before it acts, shared by a button and a confirm's Submit
// (2026-10 item 257), because a modal Submit is reachable without the press that opened
// it: the room is looked up again, scoped to the guild, and the action's own gate is run
// again. Answers the refusal itself and returns null, so a caller only has to stop.
async function gatePress(interaction: GameRoomPress, parsed: ParsedGameRoomCustomId): Promise<GatedPress | null> {
	const guildId = interaction.guildId;
	if (!guildId || !interaction.guild) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.room, sections: [gameRoomsCopy.errors.outsideGuild] });
		return null;
	}

	// `new` and its confirm `newok` are the actions that run before a room exists, so
	// their tail is a game slug rather than a roomId and there is nothing to look up or
	// gate against: anyone may start a challenge.
	if (parsed.action === "new" || parsed.action === "newok") {
		const games: readonly string[] = parsed.action === "new" ? CHALLENGE_GAMES : DRAFT_CONFIRM_GAMES;
		if (!games.includes(parsed.tail)) {
			await showNotice(interaction, { title: gameRoomsCopy.notices.room, sections: ["This control is no longer available."] });
			return null;
		}
		return { kind: "new", parsed, game: parsed.tail as GameSlug };
	}

	// ⚠️ GUILD SCOPING IS A SECURITY BOUNDARY (invariant 2). The roomId rides the
	// customId, which anyone can read and replay, so the lookup is scoped to the guild
	// the click came from. A room in ANOTHER guild therefore reads as not found rather
	// than as forbidden, which is what stops a caller probing whether a room exists
	// somewhere else. The one way to reach a room hosted elsewhere is from inside one of
	// its satellite channels (resolvePressedRoom).
	const pressed = await resolvePressedRoom(interaction, guildId, parsed.tail);
	if (!pressed) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.room, sections: [gameRoomsCopy.errors.notFound] });
		return null;
	}
	const { room, satellite } = pressed;
	const actorId = interaction.user.id;

	// ⚠️ A PRESS FROM A SATELLITE (2026-10 item 244 Phase 5a) IS GATED BEFORE ANYTHING
	// ELSE, and by two rules of its own. ① Only a seated player's own controls are taken
	// there (SATELLITE_ACTIONS): every host control, and the admin override that comes
	// with it, belongs to the host room, because the override reads the CLICKER's
	// permissions and here the clicker is an admin of a different server. ② Only the
	// members that satellite seats may press anything in it; a remote admin reading
	// along may watch, not play. The playersOnly gate below still applies on top.
	if (satellite) {
		if (!SATELLITE_ACTIONS.has(parsed.action)) {
			await showNotice(interaction, { title: gameRoomsCopy.notices.room, sections: [satelliteWords.hostRoomOnly] });
			return null;
		}
		if (!satellite.userIds.includes(actorId)) {
			await showNotice(interaction, { title: gameRoomsCopy.notices.room, sections: [satelliteWords.notSeatedHere] });
			return null;
		}
	}

	// A draft that was cancelled, or a room that already finished, still has clickable
	// board controls in the channel's history. Refuse them by STATUS rather than by
	// hiding the buttons, because a hidden button is a suggestion and the message
	// stays scrollable forever.
	if (BOARD_ACTIONS.has(parsed.action) && room.status !== "draft") {
		await showNotice(interaction, { title: gameRoomsCopy.notices.room, sections: [gameRoomsCopy.board.draftGone] });
		return null;
	}

	const action = GAME_ROOM_ACTIONS[parsed.action];

	// playersOnly first: it is the cheaper check and needs no config read.
	if (action.playersOnly && !room.playerIds.includes(actorId)) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.room, sections: [gameRoomsCopy.errors.notYours] });
		return null;
	}

	// hostOnly is host OR admin. The admin override is deliberate and is why this is not
	// a bare `actorId === room.hostId`: clearing an abandoned room is moderation, and a
	// moderator is not one of the room's players.
	let isAdmin = false;
	if (action.hostOnly && actorId !== room.hostId) {
		// Starting the match is the host's alone (post-launch plan item 18), so no
		// config read and no override: an admin is refused like any other member.
		if (HOST_STRICT_ACTIONS.has(parsed.action)) {
			await showNotice(interaction, { title: gameRoomsCopy.notices.room, sections: [gameRoomsCopy.board.onlyHostStarts] });
			return null;
		}
		const config = await guildConfigStore.findByGuildId(guildId);
		isAdmin = await gateOwnerOrAdmin(interaction, config);
		if (!isAdmin) {
			await showNotice(interaction, { title: gameRoomsCopy.notices.room, sections: [gameRoomsCopy.errors.notYours] });
			return null;
		}
	}

	return { kind: "room", parsed, room, isAdmin };
}

async function handleGameRoomButton(interaction: ButtonInteraction): Promise<void> {
	const parsed = parseGameRoomCustomId(interaction.customId);

	// A retired or malformed control. The ordinary cause is a member scrolling back to
	// a room from two deploys ago, not an attack, so the reply is an honest note rather
	// than a refusal.
	if (!parsed) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.room, sections: ["This control is no longer available."] });
		return;
	}

	const gated = await gatePress(interaction, parsed);
	if (!gated) return;
	// A confirm's own button, from the private reply a confirm falls back to when Discord
	// will not show its modal: it acts exactly as the modal's Submit would.
	if (CONFIRM_ACTIONS.has(parsed.action)) {
		await runConfirmed(interaction, gated);
		return;
	}
	if (gated.kind === "new") {
		await challengeBoard.offerChallengeDraft(interaction, gated.game);
		return;
	}
	const { room } = gated;

	switch (parsed.action) {
		// ── the board ──
		case "vis":
			await challengeBoard.chooseVisibility(interaction, room, parsed.arg ?? "invite");
			return;
		case "invite":
			await challengeBoard.openInvitePicker(interaction, room);
			return;
		case "join":
			await challengeBoard.joinChallenge(interaction, room);
			return;
		case "haccept":
			await challengeBoard.acceptBuyIn(interaction, room);
			return;
		case "start":
			await challengeBoard.startMatch(interaction, room);
			return;
		case "dero":
			await challengeBoard.playDero(interaction, room);
			return;
		case "bots":
			await challengeBoard.openBotPicker(interaction, room);
			return;
		case "casual":
			await challengeBoard.chooseCasual(interaction, room, parsed.arg ?? "");
			return;
		case "cancel":
			await challengeBoard.cancelDraft(interaction, room);
			return;
		case "auctions":
		case "referee":
			await challengeBoard.chooseDraftSetting(interaction, room, parsed.action, parsed.arg ?? "");
			return;
		case "edit":
			await challengeBoard.openSettingsEditor(interaction, room);
			return;
		case "rematch":
			// On the result card of a finished room. rematchFromRoom refuses by status
			// and enforces the one-rematch-per-room rule itself.
			await challengeBoard.rematchFromRoom(interaction, room);
			return;

		// ── the host controls (2026-10 item 244 Phase 4) ──
		case "approval":
			await hostControls.toggleApproval(interaction, room, parsed.arg ?? "");
			return;
		case "requests":
			await hostControls.openJoinRequests(interaction, room);
			return;
		case "kick":
			await hostControls.openRemovePicker(interaction, room);
			return;
		case "hseats":
			await roomHoldemHandlers.handleSeatsToggle(interaction, room, parsed.arg ?? "");
			return;

		// ── in the room ──
		// Take your turn (item 257 Phase 4a): the arg is the turn's fingerprint, and the press
		// re-checks the presser is on the clock and the turn is still the one it was posted for.
		case "turn":
			await handleTurnPress(interaction, room, parsed.arg ?? "", turnAdapterFor);
			return;
		case "author":
			await openAuthoringModal(interaction, room);
			return;
		case "hjoin":
			await roomHoldemHandlers.handleBuyIn(interaction, room);
			return;
		// The host's Set the buy in is on the challenge card now (item 257 Phase 4a).
		case "hbuyin":
			await challengeBoard.openBuyIn(interaction, room);
			return;
		case "hstart":
			await roomHoldemHandlers.handleDeal(interaction, room);
			return;
		case "hmove":
			await roomHoldemHandlers.handleMove(interaction, room, parsed.arg ?? "");
			return;
		case "hcards":
			await roomHoldemHandlers.handleShowCards(interaction, room);
			return;
		// Leave and End ask first (item 12); their confirms act in runConfirmed.
		// A state the press can already read is refused here, so the confirm's Submit meets it
		// only when the table moved while the confirm stood open (2026-10 item 263 R3-6).
		case "hleave": {
			const refusal = roomHoldemHandlers.leaveRefusal(room, interaction.user.id);
			if (refusal) {
				await showNotice(interaction, { title: gameRoomsCopy.notices.holdem, sections: [refusal] });
				return;
			}
			await showConfirm(interaction, { title: gameRoomsCopy.notices.holdem, sections: [gameRoomsCopy.confirms.leaveTable], confirmId: confirmCustomId("hleaveok", room.roomId) });
			return;
		}
		case "hend": {
			const refusal = roomHoldemHandlers.endRefusal(room);
			if (refusal) {
				await showNotice(interaction, { title: gameRoomsCopy.notices.holdem, sections: [refusal] });
				return;
			}
			await showConfirm(interaction, { title: gameRoomsCopy.notices.holdem, sections: [gameRoomsCopy.confirms.endTable], confirmId: confirmCustomId("hendok", room.roomId) });
			return;
		}
		case "hback":
			await roomHoldemHandlers.handleImBack(interaction, room);
			return;
		// ── monopoly ──
		// Each handler re-checks that the clicker is the seat on the clock; the
		// playersOnly gate above only proved they are at the table.
		case "mroll":
			await roomMonopolyHandlers.handleMroll(interaction, room);
			return;
		case "mbuy":
			await roomMonopolyHandlers.handleMbuy(interaction, room, parsed.arg ?? "");
			return;
		case "mskip":
			await roomMonopolyHandlers.handleMskip(interaction, room);
			return;
		case "mend":
			await roomMonopolyHandlers.handleMend(interaction, room);
			return;
		case "mjail":
			await roomMonopolyHandlers.handleMjail(interaction, room, parsed.arg ?? "");
			return;
		case "minventory":
			await roomMonopolyHandlers.handleMinventory(interaction, room);
			return;
		case "mbuild":
			await roomMonopolyBuild.handleMbuild(interaction, room);
			return;
		// Trades and bids come from ANY seat still in the match, so these handlers
		// check that, not the turn.
		case "mtrade":
			await roomMonopolyTrade.handleMtrade(interaction, room);
			return;
		case "mtradeAccept":
			await roomMonopolyTrade.handleMtradeAccept(interaction, room, parsed.arg ?? "");
			return;
		case "mtradeReject":
			await roomMonopolyTrade.handleMtradeReject(interaction, room, parsed.arg ?? "");
			return;
		case "mauction":
			await roomMonopolyAuction.handleMauction(interaction, room, parsed.arg ?? "");
			return;
		case "msurrender":
			await roomMonopolySurrender.handleMsurrender(interaction, room);
			return;
		case "mrefvoice":
			await roomMonopolyRefereeNotice.handleEnableVoice(interaction);
			return;
		case "mrefcall":
			await roomMonopolyRefereeNotice.handleBringIntoCall(interaction);
			return;
		case "mpaydebt":
			await roomMonopolyHandlers.handleMpaydebt(interaction, room);
			return;
		case "board":
			await roomBattleshipHandlers.handleViewBoard(interaction, room);
			return;
		case "reroll":
			await roomBattleshipHandlers.handleReroll(interaction, room);
			return;
		case "bready":
			await roomBattleshipHandlers.handleReady(interaction, room);
			return;
		case "move":
			// Each game answers `move` its own way and the fork has to happen HERE
			// rather than inside runRoomMove: hangman shows a modal, which must be the
			// FIRST response to an interaction, and battleship replies ephemerally,
			// while the one-press games defer an update. By the time runRoomMove knew
			// which game it was, the wrong response would already have been sent.
			// The solo form shares hangman's guess flow wholesale: the gate that stops
			// an author guessing keys on secret.authoredBy, which a bank-seeded solo
			// word leaves null, so the host guesses their own room legally.
			if (room.game === "hangman" || room.game === "solo-hangman") {
				await openGuessModal(interaction, room);
				return;
			}
			if (room.game === "battleship") {
				await roomBattleshipHandlers.handleFire(interaction, room);
				return;
			}
			await runRoomMove(interaction, room);
			return;
		// Both ask first (2026-10 item 257, owner item 12): the press opens a confirm and
		// only its Submit archives or forfeits, in runConfirmed below.
		case "archive":
			await showConfirm(interaction, {
				title: gameRoomsCopy.notices.room,
				sections: [gameRoomsCopy.confirms.archive],
				confirmId: confirmCustomId("archiveok", room.roomId),
				// Offered only to a player of a finished match (item 257 Phase 3b): an admin clearing
				// someone else's room has no match of their own to keep.
				select: canSaveMatch(room, interaction.user.id) ? archiveSaveSelect() : undefined,
			});
			return;
		case "forfeit":
			// A match already over is refused at the press, so confirmForfeit meets it only when
			// the match ended while the confirm stood open (R3-6).
			if (isMatchOver(room)) {
				await showNotice(interaction, { title: gameRoomsCopy.notices.room, sections: [gameRoomsCopy.confirms.matchOver] });
				return;
			}
			await showConfirm(interaction, { title: gameRoomsCopy.notices.room, sections: [gameRoomsCopy.confirms.forfeit], confirmId: confirmCustomId("forfeitok", room.roomId) });
			return;
	}
}

// ── the confirms (2026-10 item 257, owner item 12) ──
// What:  the one place a confirmed action happens: a confirm modal's Submit, or the
//        button of the private reply a confirm falls back to. Closing the modal never
//        reaches here, so nothing happens without Submit.
// Who:   handleGameRoomButton for the fallback button, handleGameRoomConfirm for Submit,
//        each after gatePress ran the confirmed press's own gate again.
async function runConfirmed(interaction: ConfirmInteraction, gated: GatedPress): Promise<void> {
	if (gated.kind === "new") {
		// The arg is the open draft the one room per host confirm offered to close (item 15).
		await challengeBoard.confirmChallengeDraft(interaction, gated.game, gated.parsed.arg ?? null);
		return;
	}
	const { parsed, room, isAdmin } = gated;
	switch (parsed.action) {
		case "startok":
			await challengeBoard.confirmStartMatch(interaction, room);
			return;
		case "editok":
			await challengeBoard.confirmSettingsEdit(interaction, room);
			return;
		case "archiveok":
			// The save lands BEFORE the archive (item 257 Phase 3b): the row survives the
			// archive either way, but a save is a write the member chose and must not race
			// the delete. It never blocks the archive.
			await saveMatchIfChosen(interaction, room);
			// Acknowledged BEFORE the delete: the channel the confirm was pressed in is about
			// to stop existing, and an answer sent after it is gone throws.
			await acknowledgeConfirm(interaction);
			await roomLifecycle.archiveNow(interaction.client, room, interaction.user.id, isAdmin);
			return;
		case "forfeitok":
			await confirmForfeit(interaction, room);
			return;
		case "hleaveok":
			await roomHoldemHandlers.handleLeaveTable(interaction, room);
			return;
		case "hendok":
			await roomHoldemHandlers.handleEndTable(interaction, room);
			return;
		case "msurrenderok":
			await roomMonopolySurrender.handleMsurrenderConfirm(interaction, room);
			return;
		default:
			await showNotice(interaction, { title: gameRoomsCopy.notices.room, sections: [gameRoomsCopy.errors.controlRetired] });
	}
}

const isMatchOver = (room: IGameRoom): boolean => room.status === "finished" || room.status === "archived";

// A confirmed forfeit. The row was read again by gatePress, and a match that ended while
// the confirm stood open is refused rather than given a forfeit line after its result.
async function confirmForfeit(interaction: ConfirmInteraction, room: IGameRoom): Promise<void> {
	if (isMatchOver(room)) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.room, sections: [gameRoomsCopy.confirms.matchOver] });
		return;
	}
	const actorId = interaction.user.id;
	// The result card in the room is the answer, so the confirm closes with no message.
	await acknowledgeConfirm(interaction);
	// The forfeit is a MOVE first: it belongs in the transcript that is the
	// product, not only in the result card. postMove sends, then appends (law).
	await roomTrail.postMove(interaction.client, room, {
		actorId,
		kind: "forfeit",
		text: gameRoomsCopy.trail.forfeited(actorId),
	});
	// The winner is whoever did not forfeit, and only when exactly one player
	// remains. A three seat room losing one player has no winner yet, so it
	// resolves to null rather than to an arbitrary survivor.
	const remaining = room.playerIds.filter((id) => id !== actorId);
	await roomLifecycle.finish(interaction.client, room, {
		winnerId: remaining.length === 1 ? remaining[0] : null,
		outcome: { bucket: "forfeit" },
	});
}

// A confirm's Submit. Only the actions in CONFIRM_ACTIONS come this way; any other id
// under this prefix arriving as a modal is forged or retired, and acts on nothing.
async function handleGameRoomConfirm(interaction: ModalSubmitInteraction): Promise<void> {
	const parsed = parseGameRoomCustomId(interaction.customId);
	if (!parsed || !CONFIRM_ACTIONS.has(parsed.action)) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.room, sections: [gameRoomsCopy.errors.controlRetired] });
		return;
	}
	const gated = await gatePress(interaction, parsed);
	if (gated) await runConfirmed(interaction, gated);
}

/** A pressed room, and the satellite the press came from when it was not the room's own channel. */
interface PressedRoom {
	room: IGameRoom;
	satellite: SatelliteRoom | null;
}

// The room a press belongs to: the clicking guild's own room by its roomId, or, for a
// press inside a network table's satellite channel, the host row that keeps that
// satellite (2026-10 item 244 Phase 5a).
//
// ⚠️ THE SATELLITE LOOKUP IS SCOPED TO THE GUILD AND CHANNEL THE PRESS CAME FROM, never to
// the clicking guild's rooms and never to the roomId alone. Discord sets both, so a roomId
// replayed from any other channel still reads as not found; and the roomId must match the
// row the channel belongs to, so a control from one table cannot act on another.
async function resolvePressedRoom(interaction: GameRoomPress, guildId: string, roomId: string): Promise<PressedRoom | null> {
	const room = await gameRoomStore.findByRoomId(guildId, roomId);
	if (room) return { room, satellite: null };

	const channelId = interaction.channelId;
	if (!channelId) return null;
	const host = await gameRoomStore.findBySatelliteChannel(guildId, channelId);
	if (!host || host.roomId !== roomId) return null;
	const satellite = satelliteAt(host, guildId, channelId);
	return satellite ? { room: host, satellite } : null;
}

/**
 * Register the game room controls. Called once at boot from main.ts, before the
 * InteractionCreate listener installs, exactly like the suggestion box, self destruct
 * and arcade host handlers.
 */
export function registerGameRoomHandlers(): void {
	registerButton(GAME_ROOM_PREFIX, handleGameRoomButton);
	// A confirm's modal carries the same customId as its fallback button (showConfirm), so
	// its Submit arrives under the button prefix in the registry's modal map.
	registerModal(GAME_ROOM_PREFIX, handleGameRoomConfirm);
	// One select prefix, sub-routed on the same `<action>` position the buttons use.
	// Each sub-handler re-checks its own action name and re-gates the actor, because a
	// select's customId and its values are user input whoever built the menu.
	registerSelectMenu(GAME_ROOM_SELECT_PREFIX, async (interaction) => {
		const action = interaction.customId.split(":")[1];
		if (action === "invite") return challengeBoard.handleInviteSelect(interaction);
		if (action === "opponent") return challengeBoard.handleOpponentSelect(interaction);
		if (action === "bots") return challengeBoard.handleBotSelect(interaction);
		// The host controls: the card's band and spectator setting, the Requests panel's
		// answers, and the Remove a player picker. Each re-gates the host (or an admin) itself.
		if (action === "band") return hostControls.handleBandSelect(interaction);
		if (action === "spectators") return hostControls.handleSpectatorSelect(interaction);
		if (action === "accept" || action === "decline") return hostControls.handleJoinRequestSelect(interaction);
		if (action === "kick") return hostControls.handleRemoveSelect(interaction);
		if (action === "rps") return handleRpsSelect(interaction);
		// Hangman: the host lets Dero draw the word from a category.
		if (action === "hcategory") return handleCategorySelect(interaction);
		if (action === "mtradeWith") return roomMonopolyTrade.handleTradePartnerSelect(interaction);
		if (action === "mbuild") return roomMonopolyBuild.handleBuildSelect(interaction);
		if (action === "mmortgage") return roomMonopolyMortgage.handleMortgageSelect(interaction);
		if (action === "munmortgage") return roomMonopolyMortgage.handleUnmortgageSelect(interaction);
		if (action === "msell") return roomMonopolyMortgage.handleSellSelect(interaction);
		await showNotice(interaction, { title: gameRoomsCopy.notices.room, sections: ["This control is no longer available."] });
	});
	// Hangman's two modals and Monopoly's two. Same sub-routing shape, and each
	// sub-handler re-gates the actor: a modal submit is reachable without the button
	// that opened it.
	registerModal(GAME_ROOM_MODAL_PREFIX, async (interaction) => {
		const action = interaction.customId.split(":")[1];
		if (action === "word") return handleAuthoringModal(interaction);
		if (action === "guess") return handleGuessModal(interaction);
		// A turn's modal: the hand and the moves of whichever game prompted it.
		if (action === "turn") return handleTurnSubmit(interaction, turnAdapterFor);
		if (action === "mtrade") return roomMonopolyTrade.handleTradeModal(interaction);
		if (action === "mbid") return roomMonopolyAuction.handleBidModal(interaction);
		// The single choice pickers shown as modals (2026-10 item 254 Phase 5b): the same
		// action names and handlers as their select messages, which remain the fallback.
		if (action === "opponent") return challengeBoard.handleOpponentSelect(interaction);
		if (action === "bots") return challengeBoard.handleBotSelect(interaction);
		if (action === "kick") return hostControls.handleRemoveSelect(interaction);
		if (action === "rps") return handleRpsSelect(interaction);
		// A chip table's buy in (2026-10 item 250 Phase 5).
		if (action === "hbuyin") return challengeBoard.handleBuyInModal(interaction);
		// The private view modals (battleship's board, hold em's hand) have nothing to
		// submit; closing one is acknowledged and nothing else.
		if (action === PRIVATE_VIEW_ACTION) return closePrivateView(interaction);
		await showNotice(interaction, { title: gameRoomsCopy.notices.room, sections: ["This control is no longer available."] });
	});
	// The network board's select and the network notice's buttons (2026-10 item 244 Phase
	// 5b): their own prefixes, registered here so the network rides the same boot step as
	// the rooms it seats players at.
	registerNetworkHandlers();
}

// Exported for the handler tests, which drive the routing without a live client.
export const _handleGameRoomButton = handleGameRoomButton;
export const _handleGameRoomConfirm = handleGameRoomConfirm;
