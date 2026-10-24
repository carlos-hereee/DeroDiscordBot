// src/db/stores/pendingPairingStore.ts
import { randomInt } from "crypto";
import { PendingPairing, type IPendingPairing } from "@db/models/PendingPairing.js";

// ── pairing code store (FUTURE_PLANS item 63) ──────────────────────────
// Issues and redeems the one-time guild claim codes modeled by PendingPairing.
// generateCode is exported on its own so it can be unit tested as a pure
// function; issue and redeem own the DB side. Atomicity and single-use live in
// redeem's findOneAndUpdate; one-live-code-per-guild lives in issue's
// delete-then-create.

// Unambiguous alphabet: 0/O/1/I/L removed because a human reads this code out
// of a DM and retypes it into the dashboard, and confusable glyphs are the top
// source of "the code doesn't work" tickets. 31 symbols to the 6th power is
// about 887 million combinations, which with the 15 minute TTL and the
// redeem-side attempt limiter makes guessing a live code infeasible.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH = 6;

// 15 minutes. Long enough to alt-tab from Discord to the dashboard and paste,
// short enough that a leaked DM screenshot is worthless soon after. Mongo's TTL
// monitor reaps the row once this passes.
const TTL_MS = 15 * 60 * 1000;

export function generateCode(): string {
	let code = "";
	for (let i = 0; i < CODE_LENGTH; i++) {
		// crypto.randomInt is uniform and unbiased over [0, len). Math.random is
		// predictable and is never acceptable for a claim token.
		code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
	}
	return code;
}

export const pendingPairingStore = {
	// Issue a fresh code for a guild. Any unconsumed code for the same guild is
	// deleted first so there is exactly one live code per guild: a re-invite
	// regenerates and the previous DM's code goes dead at once. Consumed rows are
	// left for the TTL to reap so a redeemed code cannot be re-issued by a racing
	// invite.
	async issue(guildId: string, ownerUserId: string): Promise<string> {
		await PendingPairing.deleteMany({ guildId, consumedAt: null });

		// Retry on the astronomically unlikely unique-index collision against a
		// consumed but not yet reaped row. Bounded so a real index problem
		// surfaces as a thrown error instead of an infinite loop.
		for (let attempt = 0; attempt < 5; attempt++) {
			const code = generateCode();
			try {
				await PendingPairing.create({
					code,
					guildId,
					ownerUserId,
					expiresAt: new Date(Date.now() + TTL_MS),
				});
				return code;
			} catch (err) {
				// 11000 is Mongo's duplicate-key error. Anything else is a real
				// failure and must propagate.
				if ((err as { code?: number })?.code === 11000) continue;
				throw err;
			}
		}
		throw new Error("pendingPairingStore.issue: exhausted code generation retries");
	},

	// Atomically consume a code. The guarded filter plus $set in one
	// findOneAndUpdate is the whole concurrency story: two racing redeems cannot
	// both match because the first flips consumedAt and the second no longer
	// satisfies consumedAt:null. expiresAt is re-checked here, not just left to
	// the TTL monitor (which can lag up to ~60s), so a technically expired row
	// never redeems. Returns the row on success, null for invalid, expired, or
	// already-consumed. The caller deliberately cannot tell which, so the
	// endpoint is not an oracle for probing valid codes.
	async redeem(code: string): Promise<IPendingPairing | null> {
		const normalized = code.trim().toUpperCase();
		const doc = await PendingPairing.findOneAndUpdate(
			{ code: normalized, consumedAt: null, expiresAt: { $gt: new Date() } },
			{ $set: { consumedAt: new Date() } },
			{ new: true }
		).lean();
		return (doc ?? null) as IPendingPairing | null;
	},

	// Self destruct's server data delete (post-launch plan item 10): only codes nobody
	// redeemed, since a redeemed row is the record that pairs the server to its app.
	async deleteUnclaimedForGuild(guildId: string) {
		return PendingPairing.deleteMany({ guildId, consumedAt: null });
	},
};
