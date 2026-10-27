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
		notInGuild: "Chips belong to a server, so `/claim` only works inside one.",
		failed: "Dero could not reach the chip ledger just now. Try `/claim` again in a moment.",
	},

	// ── the daily claim round (2026-10 item 257, Phase 3a) ──
	// Claim daily rewards and /claim are a round of rock paper scissors against Dero, paid
	// on both currencies: a win doubles the claim, a draw pays it one and a half times, a
	// loss pays it as it always was.
	round: {
		commandDescription: "Throw rock paper scissors against Dero for your daily chips and Dero coins",
		modalTitle: "🪨 📄 ✂️ Daily claim",
		prompt: "Throw against Dero. A win pays your daily claim twice over, a draw one and a half times, and a loss pays it as usual.",
		selectLabel: "Your throw",
		// The payout under the drawn reveal, in 💬dero-commands. The member is mentioned
		// without a ping.
		payout: (input: { userId: string; chipsPaid: number | null; coinsPaid: number; multiplier: number }): string => {
			const pay = [input.chipsPaid === null ? null : `**${chips(input.chipsPaid)}**`, input.coinsPaid > 0 ? `**${coins(input.coinsPaid)}**` : null].filter(Boolean).join(" and ");
			const head = pay ? `Dero pays <@${input.userId}> ${pay} (x${input.multiplier}).` : `<@${input.userId}> played today's round.`;
			return input.coinsPaid > 0 ? head : `${head}\nToday's Dero coins from this server were paid already.`;
		},
		// Chips off: the round still pays coins, and the card says so with the command a
		// member sends an admin (the same words Phase 1b gave the chips off notice).
		chipsOff: "Chips are switched off on this server, so this round paid Dero coins only.\nSend this command to an admin and ask them to switch chips on:\n`/arcade chips toggle enabled:True`",
		// The cooldown with chips off: only the coins' UTC day decides it.
		coinsCooldown: (nextClaimAt: Date): string => `You already claimed today. Your next claim opens ${relative(nextClaimAt)}.`,
		// No 💬dero-commands yet (setup not rerun since it was added): the result answers
		// the member privately instead, with the reason.
		noCommandsChannel: "This server has no Dero commands channel yet, so your round shows only to you.",
	},

	// ── /arcade chips (admin facing, plain and practical) ──
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
