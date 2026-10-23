import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	LabelBuilder,
	MessageFlags,
	ModalBuilder,
	StringSelectMenuBuilder,
	TextInputBuilder,
	TextInputStyle,
	type AttachmentBuilder,
	type ButtonInteraction,
	type ColorResolvable,
	type EmbedBuilder,
	type ModalSubmitFields,
	type ModalSubmitInteraction,
	type StringSelectMenuInteraction,
} from "discord.js";
import { errorEmbed, infoEmbed } from "@utils/embedBuilder.js";
import { COLORS } from "@base/copy/brand.js";
import { monopolyTradeView, renderTradeCard } from "@features/games/monopolyRenderer.js";
import { isRenderPayload, withRenderFallback } from "@features/renderer/index.js";
import type { OwnableTile } from "@features/games/monopolyBoard.js";
import {
	acceptTrade,
	describeTradeSide,
	openTrade,
	rejectTrade,
	tradableLots,
	type MonopolyResult,
	type MonopolyState,
	type TradeProposal,
} from "@features/games/monopolyState.js";
import { GAME_ROOM_MODAL_PREFIX, GAME_ROOM_PREFIX, GAME_ROOM_SELECT_PREFIX } from "./gameRoomActions.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import {
	commitMonopolyMove,
	loadSeatedRoom,
	monopolyStateOf,
	parseWholeCount,
	resolveParticipants,
	type MonopolyMove,
} from "./roomMonopolyHandlers.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── roomMonopolyTrade ────────────────────────────────────────────────
// What:  trading in Discord: the Trade button, the partner picker, the offer modal,
//        the private review of an open offer, and its Accept, Decline and Withdraw.
// Who:   gameRoomHandlers routes the `mtrade`, `mtradeAccept` and `mtradeReject`
//        buttons, the `mtradeWith` select and the `mtrade` modal here.
// When:  any time in a live match, by any seat still in it, on or off its turn
//        (the standard rule). One offer may be open at a time.
// Where: the engine (monopolyTrade) owns every rule and moves everything at once
//        on accept; this file gathers the terms and keeps them private.
// How:   ① Trade, with no offer open, replies with a picker of the other seats.
//        ② The pick opens the offer modal. Discord allows five fields in a modal,
//        so the plan's seven become five: the two lot lists are multi selects of
//        exactly the lots each side may trade, chips are one field each way, and
//        the two jail card counts share one field (shown only when a card exists).
//        ③ The submit opens the trade. ④ While it is open, the same Trade button
//        shows the terms to the two players in it, privately, with the answers.
//
// ⚠️ THE TERMS NEVER REACH THE CHANNEL BEFORE AN ACCEPT (risk M6). Every surface
// here that shows them is ephemeral and only reachable by the two players in the
// trade; the public trail carries the engine's lines, which name who offered whom
// and, only once accepted, what moved.

const PRIVATE = { flags: MessageFlags.Ephemeral } as const;

// The modal's field ids, read back on submit.
const FIELD = {
	giveLots: "give_lots",
	wantLots: "want_lots",
	giveChips: "give_chips",
	wantChips: "want_chips",
	jailCards: "jail_cards",
} as const;

// Discord's ceiling on options in one select. A seat holding more than 25 tradable
// lots (the board has 28) offers the rest in a second trade; the slice keeps the
// select from throwing in that corner.
const MAX_SELECT_OPTIONS = 25;
// Nine digits, the ceiling parseWholeCount accepts.
const COUNT_MAX_LENGTH = 9;
// "give, want": two counts and a separator, with room for spaces.
const JAIL_CARDS_MAX_LENGTH = 10;
// The jail card field holds exactly two counts, separated by a comma or spaces.
const JAIL_CARDS_SEPARATOR = /[\s,]+/;

// ── ① the Trade button ────────────────────────────────────────────────
/** Trade: the partner picker when no offer is open, or the open offer for the two players in it. */
export async function handleMtrade(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	const state = monopolyStateOf(room);
	if (!state || state.phase === "finished") {
		await interaction.reply({ content: state ? gameRoomsCopy.monopoly.matchOver : gameRoomsCopy.monopoly.noBoard, ...PRIVATE });
		return;
	}
	const actorId = interaction.user.id;
	if (!isStillPlaying(state, actorId)) {
		await interaction.reply({ content: gameRoomsCopy.monopoly.inventoryOut, ...PRIVATE });
		return;
	}
	if (state.pendingTrade) {
		await interaction.reply({ ...(await openOfferReply(room.roomId, state.pendingTrade, actorId)), ...PRIVATE });
		return;
	}

	const partners = state.seats.filter((seat) => !seat.bankrupt && seat.userId !== actorId);
	if (partners.length === 0) {
		await interaction.reply({ content: gameRoomsCopy.monopoly.noTradePartners, ...PRIVATE });
		return;
	}
	// Names take a member fetch, which can outrun Discord's three second window.
	await interaction.deferReply(PRIVATE);
	const named = await resolveParticipants(interaction.client, room.guildId, partners.map((seat) => seat.userId));
	const picker = new StringSelectMenuBuilder()
		.setCustomId(`${GAME_ROOM_SELECT_PREFIX}:mtradeWith:${room.roomId}`)
		.setPlaceholder(gameRoomsCopy.monopoly.tradePartnerPlaceholder)
		.addOptions(
			named.map(({ userId, username }) => ({
				// A member who left the server has no name, and the seat number is the
				// one thing the board shows for every seat.
				label: username ?? `Seat ${state.seats.findIndex((seat) => seat.userId === userId) + 1}`,
				value: userId,
			}))
		);
	await interaction.editReply({
		content: gameRoomsCopy.monopoly.tradePartnerPrompt,
		components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(picker)],
	});
}

// ── ② the partner pick opens the offer modal ──────────────────────────
/** The partner picker: opens the offer modal for that partner. */
export async function handleTradePartnerSelect(interaction: StringSelectMenuInteraction): Promise<void> {
	const [, , roomId] = interaction.customId.split(":");
	const room = await loadSeatedRoom(interaction, roomId);
	if (!room) return;

	const state = monopolyStateOf(room);
	const initiatorId = interaction.user.id;
	const partnerId = interaction.values[0] ?? "";
	if (!state || state.phase === "finished") {
		await interaction.reply({ content: gameRoomsCopy.monopoly.matchOver, ...PRIVATE });
		return;
	}
	if (state.pendingTrade) {
		await interaction.reply({ ...(await openOfferReply(room.roomId, state.pendingTrade, initiatorId)), ...PRIVATE });
		return;
	}
	if (!isStillPlaying(state, initiatorId) || !isStillPlaying(state, partnerId) || partnerId === initiatorId) {
		await interaction.reply({ content: gameRoomsCopy.monopoly.noTradePartners, ...PRIVATE });
		return;
	}
	// The modal must be the first response to the pick, so nothing above defers.
	await interaction.showModal(offerModal(room.roomId, state, initiatorId, partnerId));
}

function offerModal(roomId: string, state: MonopolyState, initiatorId: string, partnerId: string): ModalBuilder {
	const labels: LabelBuilder[] = [];
	// A select needs at least one option, so a side with nothing tradable gets no
	// lot field at all rather than an empty one.
	const giveLots = tradableLots(state, initiatorId);
	if (giveLots.length > 0) labels.push(lotsField(FIELD.giveLots, gameRoomsCopy.monopoly.giveLotsLabel, giveLots));
	const wantLots = tradableLots(state, partnerId);
	if (wantLots.length > 0) labels.push(lotsField(FIELD.wantLots, gameRoomsCopy.monopoly.wantLotsLabel, wantLots));
	labels.push(countField(FIELD.giveChips, gameRoomsCopy.monopoly.giveChipsLabel, gameRoomsCopy.monopoly.chipsPlaceholder, COUNT_MAX_LENGTH));
	labels.push(countField(FIELD.wantChips, gameRoomsCopy.monopoly.wantChipsLabel, gameRoomsCopy.monopoly.chipsPlaceholder, COUNT_MAX_LENGTH));
	if (holdsJailCard(state, initiatorId) || holdsJailCard(state, partnerId)) {
		labels.push(
			countField(FIELD.jailCards, gameRoomsCopy.monopoly.jailCardsLabel, gameRoomsCopy.monopoly.jailCardsPlaceholder, JAIL_CARDS_MAX_LENGTH)
		);
	}

	return new ModalBuilder()
		.setCustomId(`${GAME_ROOM_MODAL_PREFIX}:mtrade:${roomId}:${partnerId}`)
		.setTitle(gameRoomsCopy.monopoly.tradeModalTitle)
		.addLabelComponents(...labels);
}

function lotsField(customId: string, label: string, lots: OwnableTile[]): LabelBuilder {
	const options = lots.slice(0, MAX_SELECT_OPTIONS);
	const select = new StringSelectMenuBuilder()
		.setCustomId(customId)
		.setPlaceholder(gameRoomsCopy.monopoly.lotsPlaceholder)
		.setRequired(false)
		.setMinValues(0)
		.setMaxValues(options.length)
		.addOptions(options.map((tile) => ({ label: tile.name, value: tile.id })));
	return new LabelBuilder().setLabel(label).setStringSelectMenuComponent(select);
}

function countField(customId: string, label: string, placeholder: string, maxLength: number): LabelBuilder {
	const input = new TextInputBuilder()
		.setCustomId(customId)
		.setStyle(TextInputStyle.Short)
		.setRequired(false)
		.setMaxLength(maxLength)
		.setPlaceholder(placeholder);
	return new LabelBuilder().setLabel(label).setTextInputComponent(input);
}

// ── ③ the offer modal's submit ────────────────────────────────────────
/** The offer modal: open the trade, and confirm privately to the player who made it. */
export async function handleTradeModal(interaction: ModalSubmitInteraction): Promise<void> {
	const [, , roomId, partnerId] = interaction.customId.split(":");
	const room = await loadSeatedRoom(interaction, roomId);
	if (!room || !partnerId) return;

	await interaction.deferReply(PRIVATE);
	const terms = readOfferTerms(interaction.fields);
	if (!terms) {
		await interaction.editReply({ embeds: [errorEmbed(gameRoomsCopy.monopoly.tradeNotANumber)] });
		return;
	}

	const proposal: TradeProposal = {
		initiatorId: interaction.user.id,
		counterpartyId: partnerId,
		offer: terms.offer,
		request: terms.request,
		openedAt: Date.now(),
	};
	// Every rule (seats still playing, owned and tradable lots, enough chips and
	// cards, something moving at all) is the engine's, and its refusal is worded
	// for the player already.
	const outcome = await commitMonopolyMove(interaction.client, room, interaction.user.id, (state) => openTrade(state, proposal), {
		onTurnOnly: false,
	});
	if (!outcome.ok) {
		await interaction.editReply({ embeds: [errorEmbed(outcome.reason)] });
		return;
	}
	await interaction.editReply({ content: gameRoomsCopy.monopoly.tradeSent(partnerId) });
}

type OfferTerms = Pick<TradeProposal, "offer" | "request">;

// The modal's fields as the two sides of a proposal, or null when a count is not
// a plain whole number. The lot values are whatever Discord sent back, which the
// engine re-validates; only the typed counts need parsing here.
function readOfferTerms(fields: ModalSubmitFields): OfferTerms | null {
	const giveChips = parseWholeCount(textValue(fields, FIELD.giveChips));
	const wantChips = parseWholeCount(textValue(fields, FIELD.wantChips));
	const jailCards = parseJailCards(textValue(fields, FIELD.jailCards));
	if (giveChips === null || wantChips === null || jailCards === null) return null;
	return {
		offer: { properties: selectValues(fields, FIELD.giveLots), chips: giveChips, gojf: jailCards.give },
		request: { properties: selectValues(fields, FIELD.wantLots), chips: wantChips, gojf: jailCards.want },
	};
}

// "give, want", blank for none. Exactly two counts, because one would leave the
// player guessing which side it meant.
function parseJailCards(text: string): { give: number; want: number } | null {
	const parts = text.trim().split(JAIL_CARDS_SEPARATOR).filter((part) => part !== "");
	if (parts.length === 0) return { give: 0, want: 0 };
	if (parts.length !== 2) return null;
	const [give, want] = parts.map(parseWholeCount);
	return give === null || want === null ? null : { give, want };
}

// A field the modal left out (no tradable lots, no jail cards) reads as empty
// rather than throwing, which is what discord.js does for a missing id.
const textValue = (fields: ModalSubmitFields, customId: string): string =>
	fields.fields.has(customId) ? fields.getTextInputValue(customId) : "";

const selectValues = (fields: ModalSubmitFields, customId: string): string[] =>
	fields.fields.has(customId) ? [...fields.getStringSelectValues(customId)] : [];

// ── ④ the open offer, and its answers ─────────────────────────────────
// What the Trade button shows while an offer is open: the terms and the answers to
// the counterparty, the terms and Withdraw to the initiator, and to anyone else
// only that an offer is waiting, never its terms.
async function openOfferReply(
	roomId: string,
	trade: TradeProposal,
	viewerId: string
): Promise<{ content?: string; embeds?: EmbedBuilder[]; files?: AttachmentBuilder[]; components?: ActionRowBuilder<ButtonBuilder>[] }> {
	if (viewerId === trade.counterpartyId) {
		return {
			...(await offerMessage(gameRoomsCopy.monopoly.tradeOfferToYou(trade.initiatorId), trade.offer, trade.request)),
			components: [
				answerRow(
					answerButton(roomId, "mtradeAccept", trade, gameRoomsCopy.monopoly.acceptTradeLabel, ButtonStyle.Success),
					answerButton(roomId, "mtradeReject", trade, gameRoomsCopy.monopoly.declineTradeLabel, ButtonStyle.Danger)
				),
			],
		};
	}
	if (viewerId === trade.initiatorId) {
		return {
			...(await offerMessage(gameRoomsCopy.monopoly.tradeOfferFromYou(trade.counterpartyId), trade.request, trade.offer)),
			components: [answerRow(answerButton(roomId, "mtradeReject", trade, gameRoomsCopy.monopoly.withdrawTradeLabel, ButtonStyle.Secondary))],
		};
	}
	return { content: gameRoomsCopy.monopoly.tradeBetweenOthers(trade.initiatorId, trade.counterpartyId) };
}

// The offer as a message: the trade card in the embed's image slot when it draws
// (2026-10 item 243 Phase 3), the text terms alone when it does not. Both replies
// that use it are ephemeral, which is what keeps the terms off the channel (M6),
// and the card itself is never cached.
async function offerMessage(
	headline: string,
	youGet: TradeProposal["offer"],
	youGive: TradeProposal["offer"]
): Promise<{ embeds: EmbedBuilder[]; files?: AttachmentBuilder[] }> {
	const card = await withRenderFallback(
		() => renderTradeCard(monopolyTradeView(youGet, youGive)),
		() => offerEmbed(headline, youGet, youGive)
	);
	if (isRenderPayload(card)) return { embeds: [offerEmbed(headline, youGet, youGive).setImage(card.ref)], files: [card.attachment] };
	return { embeds: [card] };
}

// The terms from the viewer's side: what they would receive, then what they would hand over.
function offerEmbed(headline: string, youGet: TradeProposal["offer"], youGive: TradeProposal["offer"]): EmbedBuilder {
	const description = [
		headline,
		"",
		gameRoomsCopy.monopoly.tradeYouGet(describeTradeSide(youGet)),
		gameRoomsCopy.monopoly.tradeYouGive(describeTradeSide(youGive)),
	].join("\n");
	return infoEmbed(gameRoomsCopy.monopoly.tradeOfferTitle, description, COLORS.ARCADE as ColorResolvable);
}

// The trade's openedAt rides the arg so this answer can only ever settle THIS offer.
function answerButton(roomId: string, action: "mtradeAccept" | "mtradeReject", trade: TradeProposal, label: string, style: ButtonStyle): ButtonBuilder {
	return new ButtonBuilder().setCustomId(`${GAME_ROOM_PREFIX}:${action}:${roomId}:${trade.openedAt}`).setLabel(label).setStyle(style);
}

const answerRow = (...buttons: ButtonBuilder[]): ActionRowBuilder<ButtonBuilder> => new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);

/** Accept, from the counterparty's private review. */
export async function handleMtradeAccept(interaction: ButtonInteraction, room: IGameRoom, openedAtArg: string): Promise<void> {
	await answerOffer(interaction, room, openedAtArg, (state, actorId) => acceptTrade(state, actorId), () => gameRoomsCopy.monopoly.tradeAccepted);
}

/** Decline (the counterparty) or Withdraw (the initiator), from either one's private review. */
export async function handleMtradeReject(interaction: ButtonInteraction, room: IGameRoom, openedAtArg: string): Promise<void> {
	// Who answered decides the reply, and the trade is gone once the answer lands, so
	// the move notes it from the state it reads.
	let withdrew = false;
	await answerOffer(
		interaction,
		room,
		openedAtArg,
		(state, actorId) => {
			withdrew = state.pendingTrade?.initiatorId === actorId;
			return rejectTrade(state, actorId);
		},
		() => (withdrew ? gameRoomsCopy.monopoly.tradeWithdrawn : gameRoomsCopy.monopoly.tradeDeclined)
	);
}

async function answerOffer(
	interaction: ButtonInteraction,
	room: IGameRoom,
	openedAtArg: string,
	answer: MonopolyMove,
	doneText: () => string
): Promise<void> {
	// deferUpdate rather than a reply: the press is on the private review message,
	// which the editReply below turns into the outcome.
	await interaction.deferUpdate();
	const outcome = await commitMonopolyMove(interaction.client, room, interaction.user.id, (state, actorId) => answerIfSameOffer(state, actorId, openedAtArg, answer), {
		onTurnOnly: false,
	});
	if (!outcome.ok) {
		await interaction.followUp({ embeds: [errorEmbed(outcome.reason)], ...PRIVATE });
		return;
	}
	await interaction.editReply({ content: doneText(), embeds: [], components: [] });
}

// An answer button from an offer that was withdrawn and replaced must not settle the
// replacement, so the open offer has to be the one the button was drawn for.
function answerIfSameOffer(state: MonopolyState, actorId: string, openedAtArg: string, answer: MonopolyMove): MonopolyResult {
	if (!state.pendingTrade || String(state.pendingTrade.openedAt) !== openedAtArg) {
		return { ok: false, reason: gameRoomsCopy.monopoly.tradeGone };
	}
	return answer(state, actorId);
}

// ── small reads ───────────────────────────────────────────────────────
const isStillPlaying = (state: MonopolyState, userId: string): boolean =>
	state.seats.some((seat) => seat.userId === userId && !seat.bankrupt);

const holdsJailCard = (state: MonopolyState, userId: string): boolean =>
	state.seats.some((seat) => seat.userId === userId && seat.gojfCards > 0);

export const roomMonopolyTrade = {
	handleMtrade,
	handleTradePartnerSelect,
	handleTradeModal,
	handleMtradeAccept,
	handleMtradeReject,
};
