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
	liveTrade,
	openTrade,
	rejectTrade,
	tradableLots,
	type MonopolyResult,
	type MonopolyState,
	type TradeProposal,
} from "@features/games/monopolyState.js";
import { GAME_ROOM_MODAL_PREFIX, GAME_ROOM_PREFIX } from "./gameRoomActions.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import {
	commitMonopolyMove,
	loadSeatedRoom,
	monopolyStateOf,
	parseWholeCount,
	type MonopolyMove,
} from "./roomMonopolyHandlers.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { showNotice } from "@utils/textModal.js";

// ── roomMonopolyTrade ────────────────────────────────────────────────
// What:  trading in Discord: the Trade button, the partner picker, the offer modal,
//        the private review of an open offer, and its Accept, Decline and Withdraw.
// Who:   gameRoomHandlers routes the `mtrade`, `mtradeAccept` and `mtradeReject`
//        buttons, the `mtradeWith` select and the `mtrade` modal here.
// When:  any time in a live match, by any seat still in it, on or off its turn
//        (the standard rule). One offer may be open at a time.
// Where: the engine (monopolyTrade) owns every rule and moves everything at once
//        on accept; this file gathers the terms and keeps them private.
// How:   ① Trade, with no offer open, opens the offer modal at once (the owner's call:
//        a partner picker posted first was too slow). Discord allows five fields: who
//        you trade with (only when there is more than one other seat), the lots you
//        give, the lots you want (every other seat's, each named by its owner), and
//        chips each way. A Get out of jail free card rides the lot lists as one more
//        option, so it needs no field of its own. ② The old partner picker, kept for a
//        picker posted before, opens the same modal. ③ The submit opens the trade. ④ While it is open, the same Trade button
//        shows the terms to the two players in it, privately, with the answers.
//
// ⚠️ THE TERMS NEVER REACH THE CHANNEL BEFORE AN ACCEPT (risk M6). Every surface
// here that shows them is ephemeral and only reachable by the two players in the
// trade; the public trail carries the engine's lines, which name who offered whom
// and, only once accepted, what moved.

const PRIVATE = { flags: MessageFlags.Ephemeral } as const;

// The modal's field ids, read back on submit.
const FIELD = {
	partner: "partner",
	giveLots: "give_lots",
	wantLots: "want_lots",
	giveChips: "give_chips",
	wantChips: "want_chips",
} as const;

// The lot list value a Get out of jail free card rides as. No tile id is this word.
const JAIL_CARD_VALUE = "gojf";

// Discord's ceiling on options in one select. A seat holding more than 25 tradable
// lots (the board has 28) offers the rest in a second trade; the slice keeps the
// select from throwing in that corner.
const MAX_SELECT_OPTIONS = 25;
// Nine digits, the ceiling parseWholeCount accepts.
const COUNT_MAX_LENGTH = 9;

// ── ① the Trade button ────────────────────────────────────────────────
/** Trade: the offer modal when no offer is open, or the open offer for the two players in it. */
export async function handleMtrade(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	const state = monopolyStateOf(room);
	if (!state || state.phase === "finished") {
		await showNotice(interaction, { title: gameRoomsCopy.notices.monopoly, sections: [state ? gameRoomsCopy.monopoly.matchOver : gameRoomsCopy.monopoly.noBoard] });
		return;
	}
	const actorId = interaction.user.id;
	if (!isStillPlaying(state, actorId)) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.monopoly, sections: [gameRoomsCopy.monopoly.inventoryOut] });
		return;
	}
	// A lapsed offer blocks nothing (2026-10 item 276, audit P3): the press opens a new one over it.
	const openOffer = liveTrade(state);
	if (openOffer) {
		await interaction.reply({ ...(await openOfferReply(room.roomId, openOffer, actorId)), ...PRIVATE });
		return;
	}

	const partners = state.seats.filter((seat) => !seat.bankrupt && seat.userId !== actorId);
	if (partners.length === 0) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.monopoly, sections: [gameRoomsCopy.monopoly.noTradePartners] });
		return;
	}
	// The modal must be the first answer to the press, so names come from the member cache
	// only (a fetch cannot fit Discord's three seconds); a seat number stands in for a miss.
	const nameOf = seatNamer(state, (userId) => interaction.guild?.members.cache.get(userId)?.displayName ?? null);
	await interaction.showModal(offerModal(room.roomId, state, actorId, partners.map((seat) => seat.userId), nameOf));
}

// A seat's name for the modal: the member's display name, else "Seat N", the one thing the
// board shows for every seat.
function seatNamer(state: MonopolyState, cachedName: (userId: string) => string | null): (userId: string) => string {
	return (userId) => cachedName(userId) ?? `Seat ${state.seats.findIndex((seat) => seat.userId === userId) + 1}`;
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
		await showNotice(interaction, { title: gameRoomsCopy.notices.monopoly, sections: [gameRoomsCopy.monopoly.matchOver] });
		return;
	}
	const openOffer = liveTrade(state);
	if (openOffer) {
		await interaction.reply({ ...(await openOfferReply(room.roomId, openOffer, initiatorId)), ...PRIVATE });
		return;
	}
	if (!isStillPlaying(state, initiatorId) || !isStillPlaying(state, partnerId) || partnerId === initiatorId) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.monopoly, sections: [gameRoomsCopy.monopoly.noTradePartners] });
		return;
	}
	// The modal must be the first response to the pick, so nothing above defers.
	const nameOf = seatNamer(state, (userId) => interaction.guild?.members.cache.get(userId)?.displayName ?? null);
	await interaction.showModal(offerModal(room.roomId, state, initiatorId, [partnerId], nameOf));
}

/** One option of a lot list: a lot, or a Get out of jail free card. */
interface LotOption {
	label: string;
	value: string;
}

/**
 * The offer modal. With one possible partner the partner rides the customId and the modal has
 * no partner field; with more, the first field picks them and the wanted lots list every other
 * seat's lots, each named by its owner (the engine refuses a lot the chosen partner does not
 * own, in words the player reads). Exported for the test.
 */
export function offerModal(roomId: string, state: MonopolyState, initiatorId: string, partnerIds: readonly string[], nameOf: (userId: string) => string): ModalBuilder {
	const copy = gameRoomsCopy.monopoly;
	const labels: LabelBuilder[] = [];
	const onlyPartner = partnerIds.length === 1 ? partnerIds[0] : null;
	if (!onlyPartner) labels.push(partnerField(partnerIds, nameOf));

	// A select needs at least one option, so a side with nothing tradable gets no lot field
	// at all rather than an empty one.
	const giveOptions = lotOptions(state, [initiatorId], () => null);
	if (giveOptions.length > 0) labels.push(lotsField(FIELD.giveLots, copy.giveLotsLabel, giveOptions));
	const wantOptions = lotOptions(state, partnerIds, onlyPartner ? () => null : nameOf);
	if (wantOptions.length > 0) labels.push(lotsField(FIELD.wantLots, copy.wantLotsLabel, wantOptions));
	labels.push(countField(FIELD.giveChips, copy.giveChipsLabel, copy.chipsPlaceholder, COUNT_MAX_LENGTH));
	labels.push(countField(FIELD.wantChips, copy.wantChipsLabel, copy.chipsPlaceholder, COUNT_MAX_LENGTH));

	const partnerArg = onlyPartner ? `:${onlyPartner}` : "";
	return new ModalBuilder()
		.setCustomId(`${GAME_ROOM_MODAL_PREFIX}:mtrade:${roomId}${partnerArg}`)
		.setTitle(copy.tradeModalTitle)
		.addLabelComponents(...labels);
}

function partnerField(partnerIds: readonly string[], nameOf: (userId: string) => string): LabelBuilder {
	const select = new StringSelectMenuBuilder()
		.setCustomId(FIELD.partner)
		.setPlaceholder(gameRoomsCopy.monopoly.tradePartnerPlaceholder)
		.setMinValues(1)
		.setMaxValues(1)
		.addOptions(partnerIds.slice(0, MAX_SELECT_OPTIONS).map((userId) => ({ label: nameOf(userId), value: userId })));
	return new LabelBuilder().setLabel(gameRoomsCopy.monopoly.tradePartnerPrompt).setStringSelectMenuComponent(select);
}

// The lots these seats may trade, led by one jail card option when any of them holds a card,
// so a seat with 25 lots still offers it. `ownerName` labels each lot with its owner when the
// list spans several seats.
function lotOptions(state: MonopolyState, ownerIds: readonly string[], ownerName: (userId: string) => string | null): LotOption[] {
	const lots = ownerIds.flatMap((ownerId) => {
		const owner = ownerName(ownerId);
		return tradableLots(state, ownerId).map((tile: OwnableTile) => ({ label: owner ? `${tile.name} (${owner})` : tile.name, value: tile.id }));
	});
	const holdsCard = ownerIds.some((ownerId) => holdsJailCard(state, ownerId));
	const jailCard = holdsCard ? [{ label: gameRoomsCopy.monopoly.jailCardOption, value: JAIL_CARD_VALUE }] : [];
	return [...jailCard, ...lots].slice(0, MAX_SELECT_OPTIONS);
}

function lotsField(customId: string, label: string, options: LotOption[]): LabelBuilder {
	const select = new StringSelectMenuBuilder()
		.setCustomId(customId)
		.setPlaceholder(gameRoomsCopy.monopoly.lotsPlaceholder)
		.setRequired(false)
		.setMinValues(0)
		.setMaxValues(options.length)
		.addOptions(options);
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
	const [, , roomId, partnerArg] = interaction.customId.split(":");
	const room = await loadSeatedRoom(interaction, roomId);
	// One possible partner rides the customId; with more, the modal's partner field names them.
	const partnerId = partnerArg ?? selectValues(interaction.fields, FIELD.partner)[0];
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
// engine re-validates; only the typed counts need parsing here. A jail card picked
// in a lot list is one card on that side.
function readOfferTerms(fields: ModalSubmitFields): OfferTerms | null {
	const giveChips = parseWholeCount(textValue(fields, FIELD.giveChips));
	const wantChips = parseWholeCount(textValue(fields, FIELD.wantChips));
	if (giveChips === null || wantChips === null) return null;
	return { offer: tradeSide(selectValues(fields, FIELD.giveLots), giveChips), request: tradeSide(selectValues(fields, FIELD.wantLots), wantChips) };
}

function tradeSide(picked: readonly string[], chips: number): TradeProposal["offer"] {
	return { properties: picked.filter((value) => value !== JAIL_CARD_VALUE), chips, gojf: picked.includes(JAIL_CARD_VALUE) ? 1 : 0 };
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
