// ── economyCopy ──────────────────────────────────────────────────────
// Every line the chip economy shows (2026-10 item 250 Phase 5): the member's /claim
// replies, the admin's /economy replies and settings panel,
// and the 🗒️admin-log lines a grant and the monthly award write. Kept beside the
// feature like gameRoomsCopy and ratingsCopy rather than in the copy packs, because
// both packs would carry it word for word. The /account chips line is leveling's
// (levelingCopy.labels), beside the luck line it sits under.
//
// Never a dash in any of it (house rule 1). Amounts always go through `chips`, so one
// place decides how a number of chips reads.

/** A number of chips as members read it: "25,000 chips", "1 chip". */
export function chips(amount: number): string {
	return `${amount.toLocaleString("en-US")} ${amount === 1 ? "chip" : "chips"}`;
}

const relative = (at: Date): string => `<t:${Math.floor(at.getTime() / 1000)}:R>`;

export const economyCopy = {
	// ── /claim ──
	claim: {
		commandDescription: "Claim your chips: a big first claim, then a daily one",
		title: "🪙 Chips",
		firstClaim: (amount: number, balance: number): string =>
			`Welcome to the table. Dero slides **${chips(amount)}** across to you.\nYour balance: **${chips(balance)}**. Come back tomorrow for more.`,
		dailyClaim: (amount: number, balance: number): string => `Dero counts out your daily **${chips(amount)}**.\nYour balance: **${chips(balance)}**.`,
		cooldown: (balance: number, nextClaimAt: Date): string =>
			`You already claimed today. Your next claim opens ${relative(nextClaimAt)}.\nYour balance: **${chips(balance)}**.`,
		economyOff: "Chips are switched off in this server. An admin can turn them back on with `/economy toggle`.",
		notInGuild: "Chips belong to a server, so `/claim` only works inside one.",
		failed: "Dero could not reach the chip ledger just now. Try `/claim` again in a moment.",
	},

	// ── /economy (admin facing, plain and practical) ──
	admin: {
		commandDescription: "Chip economy: switch it on or off, see the server vault, and grant chips from it",
		statusDescription: "Show the server vault, recent grants, and whether chips are on",
		toggleDescription: "Turn the chip economy on or off for this server",
		toggleOption: "On: members claim chips and buy into Hold'em with them. Off: tables deal free stacks",
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
				? "Chip economy: **ON**. Members can `/claim` chips, and new Hold'em tables in this server ask for a buy in from them."
				: "Chip economy: **OFF**. `/claim` is closed and new Hold'em tables deal free stacks. Balances and the vault are kept for when it comes back on. Tables already open keep their chips.",
		unchanged: (on: boolean): string => `The chip economy is already **${on ? "ON" : "OFF"}**. Nothing changed.`,
		granted: (input: { userId: string; amount: number; walletBalance: number; vaultBalance: number }): string =>
			`Granted **${chips(input.amount)}** to <@${input.userId}>. Their balance: ${chips(input.walletBalance)}. Vault left: ${chips(input.vaultBalance)}.`,
		vaultShort: (vaultBalance: number): string => `The vault holds only **${chips(vaultBalance)}**, not enough for that grant.`,
		invalidAmount: (max: number): string => `A grant is a whole number of chips from 1 to ${max.toLocaleString("en-US")}.`,
		botTarget: "Bots do not hold chips. Pick a member.",
		economyOff: "Chips are switched off in this server. Turn them on with `/economy toggle` before granting.",
		grantFailed: "The grant did not land and the vault was refunded. Try again in a moment.",
		failed: "Dero could not reach the chip ledger just now. Nothing changed; try again in a moment.",
		notInGuild: "This only works inside a server.",
		setupRequired: "Run `/setup` first, so Dero knows this server's admin role.",
	},

	// ── the /economy settings panel ──
	panel: {
		title: "Chip economy",
		economy: "Chips",
		economyHint: "Members claim chips and buy into Hold'em with them",
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
