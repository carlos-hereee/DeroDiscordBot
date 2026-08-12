import { MessageFlags, type ButtonInteraction } from "discord.js";
import { registerButton, registerSelectMenu } from "@handlers/interactionRegistry.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { gateOwnerOrAdmin } from "@utils/permissions.js";
import { errorEmbed } from "@utils/embedBuilder.js";
import {
	GAME_ROOM_PREFIX,
	GAME_ROOM_SELECT_PREFIX,
	GAME_ROOM_ACTIONS,
	parseGameRoomCustomId,
	type GameRoomAction,
} from "./gameRoomActions.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { roomTrail } from "./roomTrail.js";
import { challengeBoard } from "./challengeBoard.js";
import { CHALLENGE_GAMES } from "./challengeBoardEmbeds.js";
import { runRoomMove, handleRpsSelect } from "./roomGames.js";
import type { GameSlug } from "./roomTypes.js";

// The actions that only make sense while a draft is still a draft. Listed once so
// the status refusal below cannot drift from the routing switch.
const BOARD_ACTIONS = new Set<GameRoomAction>(["vis", "invite", "join", "start", "cancel"]);

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
// How:   parse, load the room SCOPED TO THE GUILD, apply the action's declared gate,
//        then act.

async function handleGameRoomButton(interaction: ButtonInteraction): Promise<void> {
	const parsed = parseGameRoomCustomId(interaction.customId);

	// A retired or malformed control. The ordinary cause is a member scrolling back to
	// a room from two deploys ago, not an attack, so the reply is an honest note rather
	// than a refusal.
	if (!parsed) {
		await interaction.reply({ content: "This control is no longer available.", flags: MessageFlags.Ephemeral });
		return;
	}

	const guildId = interaction.guildId;
	if (!guildId || !interaction.guild) {
		await interaction.reply({ embeds: [errorEmbed("This button only works inside a server.")], flags: MessageFlags.Ephemeral });
		return;
	}

	// `new` is the one action that runs before a room exists, so its tail is a game
	// slug rather than a roomId and there is nothing to look up or gate against.
	if (parsed.action === "new") {
		if (!(CHALLENGE_GAMES as readonly string[]).includes(parsed.tail)) {
			await interaction.reply({ content: "This control is no longer available.", flags: MessageFlags.Ephemeral });
			return;
		}
		await challengeBoard.startChallengeDraft(interaction, parsed.tail as GameSlug);
		return;
	}

	// ⚠️ GUILD SCOPING IS A SECURITY BOUNDARY (invariant 2). The roomId rides the
	// customId, which anyone can read and replay, so the lookup is scoped to the guild
	// the click came from. A room in ANOTHER guild therefore reads as not found rather
	// than as forbidden, which is what stops a caller probing whether a room exists
	// somewhere else.
	const room = await gameRoomStore.findByRoomId(guildId, parsed.tail);
	if (!room) {
		await interaction.reply({ content: gameRoomsCopy.errors.notFound, flags: MessageFlags.Ephemeral });
		return;
	}

	// A draft that was cancelled, or a room that already finished, still has clickable
	// board controls in the channel's history. Refuse them by STATUS rather than by
	// hiding the buttons, because a hidden button is a suggestion and the message
	// stays scrollable forever.
	if (BOARD_ACTIONS.has(parsed.action) && room.status !== "draft") {
		await interaction.reply({ content: gameRoomsCopy.board.draftGone, flags: MessageFlags.Ephemeral });
		return;
	}

	const action = GAME_ROOM_ACTIONS[parsed.action];
	const actorId = interaction.user.id;

	// playersOnly first: it is the cheaper check and needs no config read.
	if (action.playersOnly && !room.playerIds.includes(actorId)) {
		await interaction.reply({ content: gameRoomsCopy.errors.notYours, flags: MessageFlags.Ephemeral });
		return;
	}

	// hostOnly is host OR admin. The admin override is deliberate and is why this is not
	// a bare `actorId === room.hostId`: clearing an abandoned room is moderation, and a
	// moderator is not one of the room's players.
	let isAdmin = false;
	if (action.hostOnly && actorId !== room.hostId) {
		const config = await guildConfigStore.findByGuildId(guildId);
		isAdmin = await gateOwnerOrAdmin(interaction, config);
		if (!isAdmin) {
			await interaction.reply({ content: gameRoomsCopy.errors.notYours, flags: MessageFlags.Ephemeral });
			return;
		}
	}

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
		case "start":
			await challengeBoard.startMatch(interaction, room);
			return;
		case "cancel":
			await challengeBoard.cancelDraft(interaction, room);
			return;

		// ── in the room ──
		case "move":
			await runRoomMove(interaction, room);
			return;
		case "archive": {
			// Acknowledge BEFORE the delete. The channel this button lives in is about to
			// stop existing, and an editReply against a deleted channel throws; deferring
			// ephemerally means the ack is already delivered when the floor disappears.
			await interaction.reply({ content: "Archiving this room.", flags: MessageFlags.Ephemeral });
			await roomLifecycle.archiveNow(interaction.client, room, actorId, isAdmin);
			return;
		}
		case "forfeit": {
			await interaction.reply({ content: "Forfeit recorded.", flags: MessageFlags.Ephemeral });
			// The forfeit is a MOVE first: it belongs in the transcript that is the
			// product, not only in the result card.
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
			});
			return;
		}
	}
}

/**
 * Register the game room controls. Called once at boot from main.ts, before the
 * InteractionCreate listener installs, exactly like the suggestion box, self destruct
 * and arcade host handlers.
 */
export function registerGameRoomHandlers(): void {
	registerButton(GAME_ROOM_PREFIX, handleGameRoomButton);
	// One select prefix, sub-routed on the same `<action>` position the buttons use.
	// Each sub-handler re-checks its own action name and re-gates the actor, because a
	// select's customId and its values are user input whoever built the menu.
	registerSelectMenu(GAME_ROOM_SELECT_PREFIX, async (interaction) => {
		const action = interaction.customId.split(":")[1];
		if (action === "invite") return challengeBoard.handleInviteSelect(interaction);
		if (action === "opponent") return challengeBoard.handleOpponentSelect(interaction);
		if (action === "rps") return handleRpsSelect(interaction);
		await interaction.reply({ content: "This control is no longer available.", flags: MessageFlags.Ephemeral });
	});
}

// Exported for the handler tests, which drive the routing without a live client.
export const _handleGameRoomButton = handleGameRoomButton;
