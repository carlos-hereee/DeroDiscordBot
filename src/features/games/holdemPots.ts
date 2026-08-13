// ── holdemPots ──────────────────────────────────────────────────────────────
// What:  turns per player commitments into a main pot and however many side pots
//        the all ins require, then pays them out.
// Who:   the showdown, after holdemHand has ranked everyone still in.
// When:  once per hand.
// Where: PURE. Chips in, chips out, no Discord and no store.
// How:   LAYERS. Every distinct commitment level opens a layer; each layer holds
//        (level - previous level) chips from every player who reached that level,
//        and is winnable only by the players who reached it AND did not fold.
//
// ⚠️ THE PLAN SAYS TO ASSUME NOTHING HERE, and it is right: no surveyed Discord
// poker implementation documents side pots at all, so every case below was written
// out by hand rather than ported. The property that makes the layer model correct
// is that a player can only ever win chips they could have LOST: a short stack who
// is all in for 20 cannot win the 80 that two other players bet on top.
//
// ⚠️ AND FOLDED CHIPS STAY IN. A player who bets 50 and folds has bought nothing;
// their chips remain in the layers they reached and are won by somebody else. They
// are a CONTRIBUTOR to those layers and never eligible for them.

export interface PlayerCommitment {
	userId: string;
	// Total chips this player put in across the whole hand, not this street.
	committed: number;
	folded: boolean;
}

export interface Pot {
	amount: number;
	// Who may win it, in the order they were passed in. Never includes a folded
	// player, even though a folded player's chips may be sitting in it.
	eligible: string[];
}

/**
 * Build the layered pots for a finished hand.
 *
 * Returns the main pot first, then each side pot in the order its layer opened,
 * which is also ascending by the all in that created it.
 */
export function buildPots(commitments: PlayerCommitment[]): Pot[] {
	const levels = [...new Set(commitments.map((player) => player.committed))]
		.filter((level) => level > 0)
		.sort((a, b) => a - b);

	const pots: Pot[] = [];
	let previous = 0;
	// Chips from a layer nobody can win, held until a layer that somebody can.
	let carry = 0;

	for (const level of levels) {
		const contributors = commitments.filter((player) => player.committed >= level);
		const amount = (level - previous) * contributors.length;
		previous = level;
		if (amount <= 0) continue;

		const eligible = contributors.filter((player) => !player.folded).map((player) => player.userId);

		// ⚠️ A LAYER WITH NO ELIGIBLE WINNER STILL HOLDS REAL CHIPS. Every contributor
		// at this level folded, so there is nobody to award it to, and emitting it
		// meant `awardPots` skipped it and the chips left the table for good. The
		// ordinary cause is an uncalled bet, which `settleHand` now strips before
		// calling here; the carry is the backstop for what stripping cannot reach, two
		// folded players tied at the top level. Rolling the chips into a pot somebody
		// CAN win keeps the table's total exact, which is the property that matters.
		if (eligible.length === 0) {
			carry += amount;
			continue;
		}

		const total = amount + carry;
		carry = 0;

		// Two adjacent layers with the SAME eligible set are one pot to a player, and
		// splitting them would show "main pot 30, side pot 20" for what is plainly a
		// single 50 chip pot. Merge on the way in rather than post-processing.
		const last = pots[pots.length - 1];
		if (last && sameMembers(last.eligible, eligible)) last.amount += total;
		else pots.push({ amount: total, eligible });
	}

	// A carry left over means the TOP layers were the unwinnable ones, so there was
	// no later pot to roll into. The last pot that does have a winner takes them.
	if (carry > 0 && pots.length > 0) pots[pots.length - 1].amount += carry;

	return pots;
}

function sameMembers(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	const set = new Set(a);
	return b.every((id) => set.has(id));
}

/**
 * The chips a player put in that nobody ever called, which are returned rather
 * than won.
 *
 * ⚠️ THIS IS A REAL RULE, NOT A ROUNDING DETAIL. If one player bets 200 into a
 * table whose next largest commitment is 50, the top 150 was never contested: it
 * cannot be lost, so it is handed straight back. The layered build above would
 * otherwise create a final pot that player is the sole eligible winner of, which
 * pays out identically but READS as though they won 150 they never risked, and a
 * hand history that says so is a hand history players argue about.
 */
export function uncalledPortion(commitments: PlayerCommitment[]): { userId: string; amount: number } | null {
	const sorted = [...commitments].sort((a, b) => b.committed - a.committed);
	const [top, second] = sorted;
	if (!top || top.committed <= 0) return null;
	const secondCommitted = second?.committed ?? 0;
	if (top.committed <= secondCommitted) return null;
	return { userId: top.userId, amount: top.committed - secondCommitted };
}

export interface PotAward {
	userId: string;
	amount: number;
}

/**
 * Pay out the pots.
 *
 * `rankOf` returns a comparable strength for a player, higher is better, and is
 * expected to come from compareHands. `seatOrder` breaks an odd chip.
 *
 * ⚠️ ODD CHIPS ARE NOT DISCARDED. A 25 chip pot split two ways is 12 and 12 with
 * one left over, and a payout that floors both shares quietly destroys a chip per
 * split pot. Over a tournament that is a real drift in the total, which is exactly
 * the kind of thing nobody notices until the numbers stop adding up. The odd chip
 * goes to the earliest eligible player in `seatOrder`, which is the house rule
 * closest to "first left of the button".
 */
export function awardPots(
	pots: Pot[],
	rankOf: (userId: string) => number,
	seatOrder: string[] = []
): PotAward[] {
	const totals = new Map<string, number>();
	const add = (userId: string, amount: number) => totals.set(userId, (totals.get(userId) ?? 0) + amount);

	for (const pot of pots) {
		// buildPots no longer emits an unwinnable pot (it rolls those chips into one
		// that has a winner), so this is a guard against a hand-built Pot rather than
		// a live path. It must never become the way chips leave the table again.
		if (pot.eligible.length === 0) continue;

		const best = Math.max(...pot.eligible.map(rankOf));
		const winners = pot.eligible.filter((userId) => rankOf(userId) === best);

		const share = Math.floor(pot.amount / winners.length);
		let remainder = pot.amount - share * winners.length;
		for (const winner of winners) add(winner, share);

		// Hand the leftover out one chip at a time, in seat order, so a three way
		// split of 26 pays 9/9/8 rather than losing two chips.
		const ordered = [...winners].sort(
			(a, b) => (seatOrder.indexOf(a) + 1 || Infinity) - (seatOrder.indexOf(b) + 1 || Infinity)
		);
		let index = 0;
		while (remainder > 0) {
			add(ordered[index % ordered.length], 1);
			remainder--;
			index++;
		}
	}

	return [...totals.entries()].map(([userId, amount]) => ({ userId, amount }));
}

// The total sitting in every pot, for the table headline.
export const potTotal = (pots: Pot[]): number => pots.reduce((sum, pot) => sum + pot.amount, 0);
