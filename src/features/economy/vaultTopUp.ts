import type { Client } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { matchResultStore } from "@db/stores/matchResultStore.js";
import { serverVaultStore } from "@db/stores/serverVaultStore.js";
import { serverBoard, type ServerRatingRow } from "@features/ratings/serverRatings.js";
import { adminLog } from "@features/setup/adminLog.js";
import { previousUtcMonth, type UtcMonth } from "@utils/utcMonthKey.js";
import { isChipEconomyOn } from "./chipWallet.js";
import { readVault } from "./serverVault.js";
import { economyCopy } from "./economyCopy.js";

// ── vaultTopUp ───────────────────────────────────────────────────────
// What:  the monthly network award (2026-10 item 250 Phase 5): on the 1st, the servers
//        the network ranks highest add chips to their vaults, 100,000 for the top
//        server, 50,000 for ranks 2 to 5 and 25,000 for ranks 6 to 10.
// Who:   ReminderScheduler.startScheduler's monthly cron (ECONOMY.VAULT_TOP_UP_CRON).
// When:  once a month, paying the month that just ended.
// Where: the ranking is the network server board /rating servers shows
//        (serverRatings.serverBoard across every game), so the award and the board
//        members read can never disagree about who is first.
//
// Two gates before a server is ranked for the award, in this order: chips are on in it
// (an admin who switched chips off sees no award lines), and it finished at least one
// rated match in the month being paid (the plan's risk R2: a dormant server that still
// wears a high rating earns nothing). Servers that fail a gate drop out and the ones
// below them move up, so the ten awards always go to ten active servers when ten exist.
//
// ⚠️ NEVER PAYS A MONTH TWICE. Each vault's lastAwardMonth is the claim, matched and set
// in the same write (serverVaultStore.awardMonth), so a deploy that runs two processes,
// or a cron that fires twice, pays once.

const ECONOMY = BOT_CONSTANTS.ECONOMY;

/** One server's place in the award: its rank among the eligible servers, and what it is paid. */
export interface TopUpAward {
	guildId: string;
	rank: number;
	amount: number;
}

export type TopUpStatus = "paid" | "already-paid" | "failed";

export interface TopUpOutcome extends TopUpAward {
	status: TopUpStatus;
}

/** The awards for servers already ranked best first and already gated: rank 1 takes the first amount, and so on. */
export function topUpAwards(ranked: readonly Pick<ServerRatingRow, "guildId">[], amounts: readonly number[] = ECONOMY.VAULT_TOP_UP_AWARDS): TopUpAward[] {
	return ranked.slice(0, amounts.length).map((server, index) => ({ guildId: server.guildId, rank: index + 1, amount: amounts[index] }));
}

// The gates, in board order. Sequential rather than parallel: a handful of reads per
// server on a cron with nobody waiting, and it stops reading once ten have passed.
async function eligibleServers(board: readonly ServerRatingRow[], month: UtcMonth, needed: number): Promise<ServerRatingRow[]> {
	const eligible: ServerRatingRow[] = [];
	for (const server of board) {
		if (eligible.length >= needed) break;
		const config = await guildConfigStore.findByGuildId(server.guildId);
		if (!config || !isChipEconomyOn(config)) continue;
		if (!(await matchResultStore.hasRatedMatchInGuild(server.guildId, month))) continue;
		eligible.push(server);
	}
	return eligible;
}

/** Pay one server's award once, and log it to that server's 🗒️admin-log. */
async function payAward(client: Client, award: TopUpAward, month: UtcMonth): Promise<TopUpOutcome> {
	try {
		await readVault(award.guildId);
		const paid = await serverVaultStore.awardMonth(award.guildId, month.key, award.amount);
		if (!paid) return { ...award, status: "already-paid" };
		adminLog.emit({
			guild: { id: award.guildId, client },
			kind: "vault.topup",
			actor: { source: "dero" },
			payload: {
				subject: economyCopy.adminLog.topUpSubject,
				detail: economyCopy.adminLog.topUpDetail(award.rank, award.amount, paid.balance, month.key),
				tier: award.rank,
				amount: award.amount,
				newVaultBalance: paid.balance,
				networkRatingPeriod: month.key,
			},
		});
		return { ...award, status: "paid" };
	} catch (error) {
		console.error(`[economy] paying the ${month.key} vault award to guild ${award.guildId} failed`, error);
		return { ...award, status: "failed" };
	}
}

/** Rank, gate and pay the month before `now`. Never throws; a failed board read pays nobody and says so. */
export async function runVaultTopUp(client: Client, now: Date = new Date()): Promise<TopUpOutcome[]> {
	const month = previousUtcMonth(now);
	try {
		const board = await serverBoard(client, null);
		const eligible = await eligibleServers(board, month, ECONOMY.VAULT_TOP_UP_AWARDS.length);
		const outcomes: TopUpOutcome[] = [];
		for (const award of topUpAwards(eligible)) outcomes.push(await payAward(client, award, month));
		console.log(`[economy] vault awards for ${month.key}: ${outcomes.filter((outcome) => outcome.status === "paid").length} paid of ${outcomes.length}`);
		return outcomes;
	} catch (error) {
		console.error(`[economy] the ${month.key} vault awards failed before any was paid`, error);
		return [];
	}
}
