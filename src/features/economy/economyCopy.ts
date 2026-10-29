// ── economyCopy ──────────────────────────────────────────────────────
// Every line the chip economy shows (2026-10 item 250 Phase 5): the member's /claim
// replies, the admin's /arcade chips replies and settings panel,
// and the 🗒️admin-log lines a grant and the monthly award write. Kept beside the
// feature like gameRoomsCopy and ratingsCopy rather than in the copy packs, because
// both packs would carry it word for word. The /account chips line is leveling's
// (levelingCopy.labels), beside the luck line it sits under.
//
// Never a dash in any of it (house rule 1). Amounts always go through `chips`, so one
// place decides how a number of chips reads.
//
// A member's chips and coins are ONE global wallet each (2026-10 item 267 Session 1a):
// no line here may say chips belong to a server. A server's chip switch decides only
// whether its Hold'em tables play for chips.

import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";

const CLAIM_COINS = BOT_CONSTANTS.DERO_COINS.CLAIM;
const VAULT_DAILY_RECEIVE_CAP = BOT_CONSTANTS.ECONOMY.VAULT_DAILY_RECEIVE_CAP;
const MARKET = BOT_CONSTANTS.ECONOMY.MARKET;

/** A number of chips as members read it: "25,000 chips", "1 chip". */
export function chips(amount: number): string {
	return `${amount.toLocaleString("en-US")} ${amount === 1 ? "chip" : "chips"}`;
}

/** A number of Dero coins as members read it: "20 Dero coins", "1 Dero coin". */
export function coins(amount: number): string {
	return `${amount.toLocaleString("en-US")} ${amount === 1 ? "Dero coin" : "Dero coins"}`;
}

const relative = (at: Date): string => `<t:${Math.floor(at.getTime() / 1000)}:R>`;

export const economyCopy = {
	// ── /claim ──
	claim: {
		title: "🪙 Chips",
		cooldown: (balance: number, nextClaimAt: Date): string =>
			`You already claimed today. Your next claim opens ${relative(nextClaimAt)}.\nYour balance: **${chips(balance)}**.`,
		notInGuild: "`/claim` works inside a server Dero is in. Your chips are yours in every one of them.",
		failed: "Dero could not reach the chip ledger just now. Try `/claim` again in a moment.",
	},

	// ── the daily claim round (2026-10 item 257, Phase 3a) ──
	// Claim daily rewards and /claim are a round of rock paper scissors against Dero, paid
	// on both currencies: a win doubles the chips, a draw pays them one and a half times, a
	// loss pays them as they always were, and the coins follow DERO_COINS.CLAIM. One claim
	// a day across every server.
	round: {
		commandDescription: "Throw rock paper scissors against Dero for your daily chips and Dero coins",
		modalTitle: "🪨 📄 ✂️ Daily claim",
		prompt: `Throw against Dero, once a day across every server. A win pays your daily chips twice over and ${coins(CLAIM_COINS.won)}, a draw one and a half times and ${coins(CLAIM_COINS.tie)}, and a loss the usual chips and ${coins(CLAIM_COINS.lost)}.`,
		selectLabel: "Your throw",
		// The payout under the drawn reveal, in 💬dero-commands. The member is mentioned
		// without a ping. The multiplier is the chips' alone; the coins are their own table.
		payout: (input: { userId: string; chipsPaid: number; coinsPaid: number; multiplier: number }): string => {
			const pay = [`**${chips(input.chipsPaid)}** (x${input.multiplier})`, input.coinsPaid > 0 ? `**${coins(input.coinsPaid)}**` : null].filter(Boolean).join(" and ");
			const head = `Dero pays <@${input.userId}> ${pay}. Your chips and coins are yours in every server.`;
			return input.coinsPaid > 0 ? head : `${head}\nToday's Dero coins were paid already.`;
		},
		// No 💬dero-commands yet (setup not rerun since it was added): the result answers
		// the member privately instead, with the reason.
		noCommandsChannel: "This server has no Dero commands channel yet, so your round shows only to you.",
	},

	// ── 🏪dero-market (2026-10 item 267 Session 2a, owner decision 5) ──
	// The Buy coins and Sell coins buttons under the channel's intro, their modals, the
	// states a press or a Submit can meet, and the answer a finished trade posts in the
	// channel. Every price and the cap read ECONOMY.MARKET, never a typed number.
	market: {
		buyLabel: "Buy coins",
		sellLabel: "Sell coins",
		buyModalTitle: "🪙 Buy Dero coins",
		sellModalTitle: "💰 Sell Dero coins",
		buyRate: `1 Dero coin costs ${chips(MARKET.COIN_BUY_PRICE_CHIPS)}. You may buy up to ${coins(MARKET.DAILY_COIN_BUY_CAP)} a day across every server.`,
		sellRate: `1 Dero coin sells for ${chips(MARKET.COIN_SELL_PRICE_CHIPS)}, as many as you like.`,
		balances: (view: { chips: number; coins: number; buyLeftToday: number }): string =>
			`You hold **${chips(view.chips)}** and **${coins(view.coins)}**. Coins you may still buy today: **${view.buyLeftToday}**.`,
		amountLabel: "How many coins",
		amountPlaceholder: (most: number): string => (most === 1 ? "1" : `1 to ${most.toLocaleString("en-US")}`),
		// A press on a server with chips off, and the line the closed intro also gives.
		closed: "Chips are switched off in this server, so the market is closed here. Your chips and coins are yours in every server, and the market is open wherever chips are on.",
		capSpent: (nextDay: Date): string =>
			`You bought your ${coins(MARKET.DAILY_COIN_BUY_CAP)} for today. Buying opens again at midnight UTC, ${relative(nextDay)}. Selling is open any time.`,
		capLeft: (leftToday: number): string =>
			leftToday > 0
				? `You may buy only **${coins(leftToday)}** more today, across every server. Nothing moved.`
				: `You already bought your ${coins(MARKET.DAILY_COIN_BUY_CAP)} for today. Nothing moved.`,
		cannotAfford: (balance: number): string =>
			`One Dero coin costs ${chips(MARKET.COIN_BUY_PRICE_CHIPS)}, and you hold ${chips(balance)}. Claim your daily chips or win a table first.`,
		shortChips: (balance: number, price: number): string => `That buy costs ${chips(price)}, and you hold ${chips(balance)}. Nothing moved.`,
		nothingToSell: "You hold no Dero coins to sell. Games and the daily claim pay them.",
		shortCoins: (balance: number): string => `You hold only ${coins(balance)}. Nothing moved.`,
		invalidAmount: "Type a whole number of coins, like 2. Nothing moved.",
		bought: (input: { coins: number; chipsPaid: number; chips: number; coinBalance: number; buyLeftToday: number }): string =>
			`bought **${coins(input.coins)}** for **${chips(input.chipsPaid)}**. You now hold ${chips(input.chips)} and ${coins(input.coinBalance)}, and may buy ${input.buyLeftToday} more today.`,
		sold: (input: { coins: number; chipsPaid: number; chips: number; coinBalance: number }): string =>
			`sold **${coins(input.coins)}** for **${chips(input.chipsPaid)}**. You now hold ${chips(input.chips)} and ${coins(input.coinBalance)}.`,
		// No 🏪dero-market stored yet (the boot that builds it has not run): the trade
		// answers the member privately instead, with the reason.
		noMarketChannel: "This server has no market channel yet, so your trade shows only to you.",
		modalRefused: "Discord did not open the market's form just now. Press the button again in a moment.",
		notInGuild: "The market works inside a server Dero is in.",
		failed: "Dero could not finish that trade just now. Check your balances on `/account` before you try again.",
	},

	// ── /arcade chips (admin facing, plain and practical) ──
	admin: {
		commandDescription: "Chip economy: switch it on or off, see the server vault, and grant chips from it",
		statusDescription: "Show the server vault, recent grants, and whether chips are on",
		toggleDescription: "Turn the chip economy on or off for this server",
		toggleOption: "On: Hold'em here buys in with chips. Off: free stacks. Members keep their chips either way",
		grantDescription: "Grant chips from the server vault to a member",
		grantUserOption: "The member who receives the chips",
		grantAmountOption: "How many chips to grant",
		title: "🪙 Chip economy",
		statusBody: (input: { on: boolean; vaultBalance: number; lastAwardMonth: string | null; grants: readonly { userId: string; amount: number; at: Date; byAdminId: string }[] }): string => {
			const lines = [
				`Chips: **${input.on ? "ON" : "OFF"}**`,
				`Server vault: **${chips(input.vaultBalance)}**`,
				`Last network award: ${input.lastAwardMonth ?? "none yet"}`,
				"",
				"**Recent grants**",
			];
			if (input.grants.length === 0) lines.push("No grants yet.");
			for (const grant of input.grants) lines.push(`${relative(grant.at)} <@${grant.byAdminId}> granted ${chips(grant.amount)} to <@${grant.userId}>`);
			return lines.join("\n");
		},
		toggled: (on: boolean): string =>
			on
				? "Chip economy: **ON**. New Hold'em tables in this server ask for a buy in from members' chips."
				: "Chip economy: **OFF**. New Hold'em tables in this server deal free stacks. Members keep their chips and their daily `/claim`, which are theirs in every server, and the vault is kept for when it comes back on. Tables already open keep their chips.",
		unchanged: (on: boolean): string => `The chip economy is already **${on ? "ON" : "OFF"}**. Nothing changed.`,
		granted: (input: { userId: string; amount: number; walletBalance: number; vaultBalance: number }): string =>
			`Granted **${chips(input.amount)}** to <@${input.userId}>. Their balance: ${chips(input.walletBalance)}. Vault left: ${chips(input.vaultBalance)}.`,
		vaultShort: (vaultBalance: number): string => `The vault holds only **${chips(vaultBalance)}**, not enough for that grant.`,
		// The daily vault cap (2026-10 item 267, risk R3): a member's chips are global, so
		// every server's grants to them share one cap a UTC day.
		dailyCapReached: (userId: string, leftToday: number): string =>
			`<@${userId}> can receive only **${chips(leftToday)}** more from server vaults today. Vault grants are capped at ${chips(VAULT_DAILY_RECEIVE_CAP)} per member a day across every server, since their chips are theirs everywhere. Nothing moved.`,
		invalidAmount: (max: number): string => `A grant is a whole number of chips from 1 to ${max.toLocaleString("en-US")}.`,
		botTarget: "Bots do not hold chips. Pick a member.",
		economyOff: "Chips are switched off in this server. Turn them on with `/arcade chips toggle` before granting.",
		grantFailed: "The grant did not land and the vault was refunded. Try again in a moment.",
		failed: "Dero could not reach the chip ledger just now. Nothing changed; try again in a moment.",
		notInGuild: "This only works inside a server.",
		setupRequired: "Run `/setup` first, so Dero knows this server's admin role.",
	},

	// ── the /arcade chips settings panel ──
	// The chip switch on the /arcade settings panel.
	panel: {
		economy: "Chips",
		economyHint: "Hold'em tables here buy in with members' chips",
	},

	// ── 🗒️admin-log lines ──
	adminLog: {
		grantSubject: "Chip grant",
		grantDetail: (userId: string, amount: number, vaultBalance: number): string => `${chips(amount)} to <@${userId}>, vault now ${chips(vaultBalance)}`,
		topUpSubject: "Server vault",
		topUpDetail: (rank: number, amount: number, vaultBalance: number, month: string): string =>
			`network award for ${month}, rank ${rank}: ${chips(amount)} added, vault now ${chips(vaultBalance)}`,
		economySubject: "Chip economy",
	},
};
