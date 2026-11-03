import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { deroCoinStore } from "@db/stores/deroCoinStore.js";
import { utcDayKey } from "@utils/utcMonthKey.js";
import { readWallet, returnChips, takeChips } from "./chipWallet.js";
import { readCoinBalance } from "./deroCoins.js";

// ── coinMarket ───────────────────────────────────────────────────────
// What:  🏪dero-market's trades (2026-10 item 267 Session 2a, owner decision 5): a member
//        buys Dero coins with chips at ECONOMY.MARKET's price, at most its daily cap per
//        UTC day across every server, and sells coins back for chips, uncapped. Both
//        wallets are global, so a trade in any server moves the same two balances.
// Who:   coinMarketPanel.ts, the Buy coins and Sell coins buttons and their modals.
// Does NOT: show anything, read a server's chip switch, or decide whether a member may
//        press. The panel does all three; this module only moves money and says how a
//        trade ended.
//
// ⚠️ MONEY SAFETY (risk R4). Every guard is a conditional write, never a read then a
// write: the day's buy count is reserved in ONE update that matches only while the cap
// has room, chips are taken only while they cover the price, and coins only while the
// balance covers the sale. So two trades racing on one member can neither pass the cap
// nor spend chips or coins that exist once. Each step after the first gives back what
// the steps before it took when it fails, so a refused trade moves nothing.

const MARKET = BOT_CONSTANTS.ECONOMY.MARKET;

/** How a buy ended. `cap` and `chips` are refusals that moved nothing. */
export type BuyResult = { kind: "bought"; coins: number; chipsPaid: number } | { kind: "cap"; leftToday: number } | { kind: "chips"; balance: number; price: number };

/** How a sell ended. `coins` is a refusal that moved nothing. */
export type SellResult = { kind: "sold"; coins: number; chipsPaid: number } | { kind: "coins"; balance: number };

/** What the market's modal shows a member: both balances and the coins they may still buy today. */
export interface MarketView {
	chips: number;
	coins: number;
	buyLeftToday: number;
}

/** The chips `coins` cost to buy. */
export const buyPriceOf = (coins: number): number => coins * MARKET.COIN_BUY_PRICE_CHIPS;

/** The chips `coins` pay when sold. */
export const sellPriceOf = (coins: number): number => coins * MARKET.COIN_SELL_PRICE_CHIPS;

/** A positive whole number of coins: the only amount the market trades. */
export function isWholeCoinAmount(amount: number): boolean {
	return Number.isSafeInteger(amount) && amount > 0;
}

/** Read an amount a member typed, or null when it is not a whole number of coins. */
export function parseCoinAmount(raw: string): number | null {
	const trimmed = raw.trim();
	if (!/^\d+$/.test(trimmed)) return null;
	const amount = Number(trimmed);
	return isWholeCoinAmount(amount) ? amount : null;
}

/**
 * The coins a member may still buy today. A stored day other than today's is a count from
 * a day already past, so the whole cap is open again.
 */
export async function buyLeftToday(userId: string, now: Date): Promise<number> {
	const wallet = await deroCoinStore.findWallet(userId);
	const boughtToday = wallet?.marketDayKey === utcDayKey(now) ? (wallet.marketBoughtToday ?? 0) : 0;
	return Math.max(0, MARKET.DAILY_COIN_BUY_CAP - boughtToday);
}

/** Both balances and today's buys left, for the modal and for a press's state checks. */
export async function readMarketView(userId: string, now: Date): Promise<MarketView> {
	const [wallet, coins, left] = await Promise.all([readWallet({ userId }), readCoinBalance(userId), buyLeftToday(userId, now)]);
	return { chips: wallet.balance, coins, buyLeftToday: left };
}

/**
 * Buy `coins` Dero coins. ① Reserve them against today's cap; ② take their price in chips;
 * ③ write the trade's ledger row and credit the coins. A failed ② gives the reservation
 * back, and a failed ③ row gives the chips and the reservation back. Throws only when the
 * database does; `guildId` only names where the trade was made on its row.
 */
export async function buyCoins(trade: { userId: string; guildId: string; coins: number; now: Date }): Promise<BuyResult> {
	const { userId, coins, now } = trade;
	if (!isWholeCoinAmount(coins)) throw new Error(`a market buy of ${coins} coins for ${userId} is not a whole number of coins`);
	const dayKey = utcDayKey(now);
	const price = buyPriceOf(coins);

	// ① The reservation is the cap's claim: a second buy racing this one meets the count
	// this one already wrote and is refused there, before any chip moves. A buy larger than
	// the whole cap could still pass the store's filter on a fresh day (the filter only
	// guards a day already counted), so it is refused here first, as serverVault.ts refuses
	// an oversized grant (2026-10 item 280).
	const reserved = coins <= MARKET.DAILY_COIN_BUY_CAP && (await deroCoinStore.reserveMarketBuy(userId, coins, dayKey, MARKET.DAILY_COIN_BUY_CAP));
	if (!reserved) return { kind: "cap", leftToday: await buyLeftToday(userId, now) };

	// ② The chips. Short of them, the reservation goes back, so a refused buy costs none of
	// the day's cap.
	if (!(await takeChips({ userId }, price))) {
		await deroCoinStore.releaseMarketBuy(userId, coins, dayKey);
		return { kind: "chips", balance: (await readWallet({ userId })).balance, price };
	}

	// ③ The row first, then the coins, the order every award keeps, so the ledger never
	// lacks a coin the wallet holds. A row that fails returns the chips and the reservation
	// and throws; a credit that fails after its row leaves the coins on the ledger, from
	// which the wallet is rebuilt, and throws so the member is told it failed.
	try {
		await deroCoinStore.insertTrade({ userId, guildId: trade.guildId, amount: coins, source: "market", marketSide: "buy", chips: price, at: now });
	} catch (error) {
		await returnChips({ userId }, price);
		await deroCoinStore.releaseMarketBuy(userId, coins, dayKey);
		throw error;
	}
	await deroCoinStore.creditBalance(userId, coins);
	return { kind: "bought", coins, chipsPaid: price };
}

/**
 * Sell `coins` Dero coins. ① Take them with a conditional debit; ② write the trade's ledger
 * row; ③ pay their price in chips. A failed ② gives the coins back. Throws only when the
 * database does.
 */
export async function sellCoins(trade: { userId: string; guildId: string; coins: number; now: Date }): Promise<SellResult> {
	const { userId, coins, now } = trade;
	if (!isWholeCoinAmount(coins)) throw new Error(`a market sale of ${coins} coins for ${userId} is not a whole number of coins`);
	const price = sellPriceOf(coins);

	// ① The debit is the sale's claim: it matches only while the balance covers it, so two
	// sales racing on one wallet cannot both sell the same coins.
	if (!(await deroCoinStore.debit(userId, coins))) return { kind: "coins", balance: await readCoinBalance(userId) };

	// ② The row right after its debit, so the ledger rebuilds the wallet; a row that fails
	// puts the coins back and pays no chips.
	try {
		await deroCoinStore.insertTrade({ userId, guildId: trade.guildId, amount: coins, source: "market", marketSide: "sell", chips: price, at: now });
	} catch (error) {
		await deroCoinStore.creditBalance(userId, coins);
		throw error;
	}

	// ③ The chips, new to the wallet: the coins already left it, so this credit pays the
	// sale once and needs no claim of its own.
	await returnChips({ userId }, price);
	return { kind: "sold", coins, chipsPaid: price };
}
