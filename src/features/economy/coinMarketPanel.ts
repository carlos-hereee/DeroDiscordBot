import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, type ButtonInteraction, type ModalSubmitInteraction } from "discord.js";
import { getPluginCopy } from "@base/copy/getCopy.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { registerButton, registerModal } from "@handlers/interactionRegistry.js";
import { buildFieldsModal, readFieldAnswers, type ModalField } from "@features/game-rooms/pickerModal.js";
import { answerChannelId, answerInChannel } from "@utils/answerInChannel.js";
import { acknowledgeTextModal, showErrorNotice, showModalOrReply, showNotice } from "@utils/textModal.js";
import { utcDayStart } from "@utils/utcMonthKey.js";
import { isChipEconomyOn } from "./chipWallet.js";
import { buyCoins, buyPriceOf, parseCoinAmount, readMarketView, sellCoins, type MarketView } from "./coinMarket.js";
import { economyCopy } from "./economyCopy.js";

// ── coinMarketPanel ──────────────────────────────────────────────────
// What:  🏪dero-market's two buttons, Buy coins and Sell coins, under the channel's intro
//        (2026-10 item 267 Session 2a, owner decision 5). A press reads everything it can
//        know first (chips off here, today's buys spent, nothing to sell, not enough chips
//        for one coin) and answers a state as a notice titled for the market; otherwise it
//        opens a modal with the rate, both balances and today's buys left over one amount
//        field. The Submit trades through coinMarket.ts and posts the finished trade in
//        🏪dero-market, pinging the trader alone.
// Who:   GuildSetupManager puts buildMarketRow under the intro; main.ts calls
//        registerCoinMarketHandlers once at boot.
// Does NOT: move money or decide a price or a cap: coinMarket.ts and ECONOMY.MARKET do.
//
// The Submit reads every balance again, because another trade (in this server or another,
// since both wallets are global) may have spent the cap, the chips or the coins since the
// press. Those states only a Submit can meet are kind race in utils/noticeSites.test.ts.

/** The market's interactionRegistry prefix: its buttons and its modals share it. */
export const MARKET_PREFIX = "market";

const MARKET_SIDES = ["buy", "sell"] as const;
type MarketSide = (typeof MARKET_SIDES)[number];

const AMOUNT_FIELD = "coins";
const DAY_MS = 24 * 60 * 60 * 1000;
// The amount field's length: the most coins a member could type is a whole balance, and
// seven digits is far past any balance the drip of game awards builds.
const AMOUNT_MAX_LENGTH = 7;

const copy = economyCopy.market;

type GuildConfigRow = Awaited<ReturnType<typeof guildConfigStore.findByGuildId>>;

const sideOf = (customId: string): MarketSide | null => {
	const side = customId.split(":")[1];
	return (MARKET_SIDES as readonly string[]).includes(side) ? (side as MarketSide) : null;
};

const noticeTitle = (config: GuildConfigRow): string => getPluginCopy(config).notice.market;

/** The intro's one row: Buy coins and Sell coins. */
export function buildMarketRow(): ActionRowBuilder<ButtonBuilder> {
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder().setCustomId(`${MARKET_PREFIX}:buy`).setLabel(copy.buyLabel).setEmoji("🪙").setStyle(ButtonStyle.Success),
		new ButtonBuilder().setCustomId(`${MARKET_PREFIX}:sell`).setLabel(copy.sellLabel).setEmoji("💰").setStyle(ButtonStyle.Primary)
	);
}

// ── the press ──

/** A Buy coins or Sell coins press: a state notice, or the trade modal. Never throws. */
export async function handleMarketPress(interaction: ButtonInteraction): Promise<void> {
	const side = sideOf(interaction.customId);
	if (!side) return;
	const guildId = interaction.guildId;
	if (!guildId) {
		await showNotice(interaction, { title: noticeTitle(null), sections: [copy.notInGuild] });
		return;
	}

	let config: GuildConfigRow = null;
	let view: MarketView;
	const now = new Date();
	try {
		config = await guildConfigStore.findByGuildId(guildId);
		if (!isChipEconomyOn(config)) {
			await showNotice(interaction, { title: noticeTitle(config), sections: [copy.closed] });
			return;
		}
		view = await readMarketView(interaction.user.id, now);
	} catch (error) {
		console.error(`[economy] opening the ${side} market for ${interaction.user.id} in guild ${guildId} failed`, error);
		await showErrorNotice(interaction, copy.failed, config);
		return;
	}

	const state = pressState(side, view, now);
	if (state) {
		await showNotice(interaction, { title: noticeTitle(config), sections: [state] });
		return;
	}
	await showModalOrReply(interaction, buildMarketModal(side, view), () => ({ content: copy.modalRefused, flags: MessageFlags.Ephemeral }));
}

// What a press already knows refuses it, so the modal never opens on a trade that cannot
// happen. Null when the trade can.
function pressState(side: MarketSide, view: MarketView, now: Date): string | null {
	if (side === "sell") return view.coins > 0 ? null : copy.nothingToSell;
	if (view.buyLeftToday <= 0) return copy.capSpent(new Date(utcDayStart(now).getTime() + DAY_MS));
	if (view.chips < buyPriceOf(1)) return copy.cannotAfford(view.chips);
	return null;
}

// The most coins a member could trade right now, for the field's hint: a buy is held by
// both the day's cap and the chips, a sale by the coins held.
function mostTradable(side: MarketSide, view: MarketView): number {
	if (side === "sell") return view.coins;
	return Math.min(view.buyLeftToday, Math.floor(view.chips / buyPriceOf(1)));
}

const amountField = (side: MarketSide, view: MarketView): ModalField => ({
	kind: "text",
	id: AMOUNT_FIELD,
	label: copy.amountLabel,
	placeholder: copy.amountPlaceholder(mostTradable(side, view)),
	maxLength: AMOUNT_MAX_LENGTH,
});

/** The trade modal: the rate, both balances and today's buys left, over one amount field. Exported for the tests. */
export function buildMarketModal(side: MarketSide, view: MarketView) {
	return buildFieldsModal({
		customId: `${MARKET_PREFIX}:${side}`,
		title: side === "buy" ? copy.buyModalTitle : copy.sellModalTitle,
		text: [side === "buy" ? copy.buyRate : copy.sellRate, copy.balances(view)],
		fields: [amountField(side, view)],
	});
}

// ── the Submit ──

/**
 * The trade modal's Submit: read the amount and the switch again, trade, then post the
 * finished trade in 🏪dero-market. A refusal answers privately and moves nothing. Never throws.
 */
export async function handleMarketSubmit(interaction: ModalSubmitInteraction): Promise<void> {
	const side = sideOf(interaction.customId);
	if (!side) return;
	const guildId = interaction.guildId;
	if (!guildId) {
		await showNotice(interaction, { title: noticeTitle(null), sections: [copy.notInGuild] });
		return;
	}
	// The field is read by the id the modal was built with; the placeholder plays no part.
	const amount = parseCoinAmount(readFieldAnswers(interaction, [{ kind: "text", id: AMOUNT_FIELD, label: "", placeholder: "", maxLength: AMOUNT_MAX_LENGTH }])[AMOUNT_FIELD] ?? "");

	let config: GuildConfigRow = null;
	try {
		config = await guildConfigStore.findByGuildId(guildId);
		if (amount === null) {
			await showNotice(interaction, { title: noticeTitle(config), sections: [copy.invalidAmount] });
			return;
		}
		if (!isChipEconomyOn(config)) {
			await showNotice(interaction, { title: noticeTitle(config), sections: [copy.closed] });
			return;
		}
		// Acknowledged before the trade's writes, so they never miss Discord's three second
		// window; every answer after this is a private follow up or the channel post.
		await acknowledgeTextModal(interaction);
		const now = new Date();
		const userId = interaction.user.id;
		const refusal = side === "buy" ? await tradeBuy(interaction, config, { userId, guildId, coins: amount, now }) : await tradeSell(interaction, config, { userId, guildId, coins: amount, now });
		if (refusal) await showNotice(interaction, { title: noticeTitle(config), sections: [refusal] });
	} catch (error) {
		console.error(`[economy] the ${side} trade of ${amount} coins for ${interaction.user.id} in guild ${guildId} failed`, error);
		await showErrorNotice(interaction, copy.failed, config);
	}
}

interface Trade {
	userId: string;
	guildId: string;
	coins: number;
	now: Date;
}

// A buy, answered in the channel when it lands. Answers the refusal's words when it did not.
async function tradeBuy(interaction: ModalSubmitInteraction, config: GuildConfigRow, trade: Trade): Promise<string | null> {
	const result = await buyCoins(trade);
	if (result.kind === "cap") return copy.capLeft(result.leftToday);
	if (result.kind === "chips") return copy.shortChips(result.balance, result.price);
	const view = await readMarketView(trade.userId, trade.now);
	await postTrade(interaction, config, copy.bought({ coins: result.coins, chipsPaid: result.chipsPaid, chips: view.chips, coinBalance: view.coins, buyLeftToday: view.buyLeftToday }));
	return null;
}

// A sale, answered in the channel when it lands. Answers the refusal's words when it did not.
async function tradeSell(interaction: ModalSubmitInteraction, config: GuildConfigRow, trade: Trade): Promise<string | null> {
	const result = await sellCoins(trade);
	if (result.kind === "coins") return copy.shortCoins(result.balance);
	const view = await readMarketView(trade.userId, trade.now);
	await postTrade(interaction, config, copy.sold({ coins: result.coins, chipsPaid: result.chipsPaid, chips: view.chips, coinBalance: view.coins }));
	return null;
}

// The finished trade in 🏪dero-market, pinging the trader only (answerInChannel's
// "market" audience), where the mention leads the line. A server whose market channel is
// not built yet gets the same line privately, led by "You" and followed by the reason.
async function postTrade(interaction: ModalSubmitInteraction, config: GuildConfigRow, line: string): Promise<void> {
	const content = answerChannelId(config, "market") ? line : `You ${line}\n${copy.noMarketChannel}`;
	await answerInChannel(interaction, "market", { content }, { config });
}

/** Register the market's buttons and modals. Called once at boot from main.ts. */
export function registerCoinMarketHandlers(): void {
	registerButton(MARKET_PREFIX, handleMarketPress);
	registerModal(MARKET_PREFIX, handleMarketSubmit);
}
