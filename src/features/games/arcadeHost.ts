import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	StringSelectMenuBuilder,
	type ButtonInteraction,
	type ChatInputCommandInteraction,
	type ModalSubmitInteraction,
	type StringSelectMenuInteraction,
} from "discord.js";
import { registerButton, registerModal, registerSelectMenu } from "@handlers/interactionRegistry.js";
import { beginChannelAnswer } from "@utils/answerInChannel.js";
import { describeSoloOpenFailure, openSoloRoom, readPrivateQuotaStatus, readSoloRefusalAtPress, type SoloGameSlug } from "@features/game-rooms/soloRooms.js";
import { showNotice } from "@utils/textModal.js";
import { answerSoloRefusal, closeHeldDraft, offerChallengeDraft, offerToFreeSlot } from "@features/game-rooms/challengeBoard.js";
import { SOLO_LUCK_GAMES } from "@features/game-rooms/roomTypes.js";
import { chargeSoloTable } from "@features/game-rooms/holdemDraftBuyIn.js";
import { gameRoomsCopy } from "@features/game-rooms/gameRoomsCopy.js";
import { HANGMAN_CATEGORIES, isHangmanCategory, type HangmanCategory } from "./hangmanWords.js";

// ── arcadeHost ─────────────────────────────────────────────────────────────
// What:  the "Host a game" controls and the hangman category start, both riding the
//        🕹️games intro (2026-10 item 245 Phase 4a moved them off 📋arcade-rules), so a
//        member can start a game by pressing a button rather than by learning
//        `/mini-game` first.
// Who:   GuildSetupManager.resolveIntroComponents attaches both rows to the games
//        intro; main.ts registers the handlers once at boot.
// When:  on a button press or a category pick, any time.
// Where: the solo forms open a room of their own; "Open a Blackjack table" posts a
//        challenge card in ⚔️challenges with Join, like every room game, and its hands
//        play in the room the card opens (2026-10 item 254, Arcade 1): nothing is played
//        in ⚔️challenges, and nothing is posted into 🕹️games, whose messages are the
//        controls themselves.
// How:   the SOLO forms (Host Hangman, Play Blackjack, the hangman category start) open
//        a solo GameRoom via soloRooms.openSoloRoom, so a one-player game holds the
//        host's one-room slot, counts against the guild cap and counts as a PRIVATE
//        room for the tier quota, exactly like every other room. "Open a Blackjack
//        table" goes through challengeBoard.offerChallengeDraft, the same door every
//        board button uses, so the table gets a card, a pool and a room the same way.
//
// ⚠️ ONLY GAMES THAT NEED NO NAMED OPPONENT ARE HOSTABLE HERE, and the omission
// is honest rather than an oversight. Head-to-head games start from the
// challenge board, which owns opponent selection.

const PREFIX = "arcade_host";
// The category start's action, on the select registry under the same prefix (the
// button and select registries are separate maps, so the two cannot collide).
const HANGMAN_CATEGORY_ACTION = "hcategory";
// The held draft confirm's action (2026-10 item 263 R3-9), on the modal registry for its
// Submit and the button registry for the fallback button a refused modal leaves.
const REPLACE_ACTION = "replace";

// Every solo room a press here (or a /mini-game typed in a challenge channel) can open, which
// the replace confirm's customId is checked against: it is user input like any customId.
const SOLO_START_GAMES: readonly SoloGameSlug[] = ["solo-hangman", "solo-blackjack", ...SOLO_LUCK_GAMES];
const isSoloStartGame = (game: string | undefined): game is SoloGameSlug => (SOLO_START_GAMES as readonly (string | undefined)[]).includes(game);

// value → how to start it. Adding a game is one entry here plus one line of copy;
// there is deliberately no switch statement anywhere else in this file.
const HOSTABLE = [
	{ id: "hangman", label: "Host Hangman", emoji: "🪢", style: ButtonStyle.Success },
	{ id: "blackjack", label: "Play Blackjack", emoji: "🃏", style: ButtonStyle.Primary },
	{ id: "blackjack-table", label: "Open a Blackjack table", emoji: "🪑", style: ButtonStyle.Primary },
] as const;

type HostableId = (typeof HOSTABLE)[number]["id"];

export function buildArcadeHostButtons(): ButtonBuilder[] {
	return HOSTABLE.map((game) =>
		new ButtonBuilder().setCustomId(`${PREFIX}:${game.id}`).setLabel(game.label).setEmoji(game.emoji).setStyle(game.style)
	);
}

export function buildArcadeHostRow(): ActionRowBuilder<ButtonBuilder> {
	return new ActionRowBuilder<ButtonBuilder>().addComponents(...buildArcadeHostButtons());
}

/**
 * The hangman category start: a select of the word bank's ten shelves that opens a
 * solo hangman room with a word Dero draws from the shelf picked. Its own row, because
 * Discord gives a select menu a whole action row. The placeholder comes from the
 * guild's copy pack, the labels from the same table the in room category select reads.
 */
export function buildHangmanCategoryStartRow(placeholder: string): ActionRowBuilder<StringSelectMenuBuilder> {
	const labels = gameRoomsCopy.hangman.categoryLabels;
	return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
		new StringSelectMenuBuilder()
			.setCustomId(`${PREFIX}:${HANGMAN_CATEGORY_ACTION}`)
			.setPlaceholder(placeholder)
			.setMinValues(1)
			.setMaxValues(1)
			.addOptions(HANGMAN_CATEGORIES.map((category) => ({ label: labels[category], value: category, emoji: "🪢" })))
	);
}

async function handleArcadeHost(interaction: ButtonInteraction): Promise<void> {
	if (interaction.customId.split(":")[1] === REPLACE_ACTION) {
		await handleSoloReplace(interaction);
		return;
	}
	const choice = interaction.customId.split(":")[1] as HostableId;
	if (!HOSTABLE.some((game) => game.id === choice)) return;

	// ── the multi seat table: a challenge card, like every room game ──
	// Before the defer below, because the creation modal answers the press itself; the card
	// is posted only on its Submit (2026-10 item 263 Phase 2a).
	if (choice === "blackjack-table") {
		await offerChallengeDraft(interaction, "blackjack");
		return;
	}

	if (!interaction.guild) return;

	// ── the solo forms: a private one-player room ──
	await openSoloRoomForMember(interaction, choice === "hangman" ? "solo-hangman" : "solo-blackjack");
}

// The category start's submit. The value is re-checked against the bank, because a
// select's values are user input whoever built the menu.
async function handleHangmanCategoryStart(interaction: StringSelectMenuInteraction): Promise<void> {
	const [, action] = interaction.customId.split(":");
	if (action !== HANGMAN_CATEGORY_ACTION) return;
	const category = interaction.values[0] ?? "";
	if (!isHangmanCategory(category)) return;

	// Answered apart from the select rather than as an update: the select lives on the
	// shared games intro, and updating it would edit that public message for everyone.
	if (!interaction.guild) return;
	await openSoloRoomForMember(interaction, "solo-hangman", { hangmanCategory: category });
}

// The shared tail of every solo form: open the room, or, on a refusal, tell the member
// what to do about it. Acknowledged quietly first, because opening a room is a channel
// create plus its opener, past Discord's three second window. A room that opens posts
// nothing in 💬dero-commands (2026-10 item 263 R3-24): the room's own opener pings its
// player there, so a line pointing at it would be a second ping in another channel.
// Exported for miniGameInChallenges (2026-10 item 254, Arcade 1), whose slash commands
// typed in ⚔️challenges open the same solo rooms and answer the same way.
//
// ⚠️ THE HELD SLOT IS ANSWERED AT THE PRESS (2026-10 item 263 R3-9), while a modal can still
// open: a held draft is offered to close in one Submit (handleSoloReplace), and a held match
// is named where it plays. The replace confirm's own Submit skips the check, having just closed
// the draft; whatever still holds the slot then is a race, answered by answerSoloRefusal.
export async function openSoloRoomForMember(
	interaction: ButtonInteraction | StringSelectMenuInteraction | ChatInputCommandInteraction | ModalSubmitInteraction,
	game: SoloGameSlug,
	options: { hangmanCategory?: HangmanCategory } = {}
): Promise<void> {
	const guild = interaction.guild!;
	// Started beside the held slot reads rather than after them, so the press spends one round
	// of reads inside Discord's three seconds; a held slot answers first and the check is dropped.
	const refusalAtPress = readSoloRefusalAtPress(guild, interaction.user.id);
	if (!interaction.isModalSubmit() && (await offerToFreeSlot(interaction, (roomId) => replaceConfirmId(game, roomId, options.hangmanCategory)))) return;
	const refusal = await refusalAtPress;
	if (refusal) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.room, sections: [describeSoloOpenFailure(refusal)] });
		return;
	}
	// A solo Blackjack table's seats, asked here through the one chip rule (chargeSoloTable), LAST
	// before the acknowledgement. A solo table is never ranked, so since 2026-10 item 276 (owner
	// decision D1) the rule answers free seats on the standard stack and takes nothing; kept on
	// the rule so a refusal would still be a notice at the press, and openSoloRoom would own any
	// chips it took and give them back if the room does not open.
	const blackjackCharge = game === "solo-blackjack" ? await chargeSoloTable(guild.id, interaction.user.id) : null;
	if (blackjackCharge && !blackjackCharge.ok) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.room, sections: [blackjackCharge.reason] });
		return;
	}
	const answer = await beginChannelAnswer(interaction, "here");
	const member = guild.members.cache.get(interaction.user.id);
	const result = await openSoloRoom(
		guild,
		game,
		{
			userId: interaction.user.id,
			displayName: member?.displayName ?? interaction.user.globalName ?? interaction.user.username,
			user: interaction.user,
		},
		{ ...options, ...(blackjackCharge?.ok ? { blackjackSeats: blackjackCharge.seats } : {}) }
	);
	if (result.ok) {
		// The quota status line rides the confirmation when the tier surface is
		// enforcing, so a solo host sees the ceiling the same way an invite host
		// does on the visibility chooser. Null (and skipped) in production today.
		const status = await readPrivateQuotaStatus(guild.id, interaction.user.id).catch(() => null);
		// With no channel the answer is a private defer still waiting, so it names the room
		// rather than hang; in a channel the quiet acknowledgement already closed the press.
		if (answer.channelId === null) {
			const started = gameRoomsCopy.board.cardStarted(result.channel.id);
			await answer.send({ content: status ? `${started} ${status}` : started });
			return;
		}
		if (status) await answer.send({ content: status });
		return;
	}
	// Only a race reaches here (a slot taken or the server filled since the press), or a real failure;
	// a state is a private notice and a failure the error embed (answerSoloRefusal).
	await answerSoloRefusal(interaction, answer, result);
}

// The replace confirm's id: the solo room it opens, the held draft it closes first, and the
// hangman shelf picked, when there was one.
function replaceConfirmId(game: SoloGameSlug, roomId: string, category?: HangmanCategory): string {
	return [PREFIX, REPLACE_ACTION, game, roomId, ...(category ? [category] : [])].join(":");
}

// The held draft confirm's Submit, or its fallback button: close the draft it named (only
// while it is still this member's draft), then open the solo room the press asked for.
async function handleSoloReplace(interaction: ButtonInteraction | ModalSubmitInteraction): Promise<void> {
	const [, , game, roomId, category] = interaction.customId.split(":");
	if (!interaction.guild || !isSoloStartGame(game) || !roomId) return;
	await closeHeldDraft(interaction.guild, roomId, interaction.user.id);
	await openSoloRoomForMember(interaction, game, { hangmanCategory: category && isHangmanCategory(category) ? category : undefined });
}

/**
 * Register the arcade host buttons and the hangman category start. Called once at
 * boot from main.ts, before the InteractionCreate listener installs, exactly like the
 * suggestion box and self-destruct handlers.
 */
export function registerArcadeHostHandlers(): void {
	registerButton(PREFIX, handleArcadeHost);
	registerSelectMenu(PREFIX, handleHangmanCategoryStart);
	registerModal(PREFIX, handleSoloReplace);
}
