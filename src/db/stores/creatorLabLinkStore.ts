// src/db/stores/creatorLabLinkStore.ts
import { CreatorLabLinkCode, type ICreatorLabLinkCode } from "@db/models/CreatorLabLinkCode.js";
import { generateCode, PAIRING_CODE_TTL_MS } from "@db/stores/pendingPairingStore.js";

// ── Creator Lab link code store (2026-11 item 283 Phase 4) ──
// Issues and redeems the one time codes modeled by CreatorLabLinkCode. It reuses the pairing code
// generator and lifetime on purpose: same unambiguous alphabet, same 15 minutes to alt tab from
// Discord to the dashboard, and the server's code pattern matches that alphabet. One live code per
// Discord user (delete then create); single use and expiry live in redeem's atomic findOneAndUpdate.

export const CREATOR_LAB_LINK_CODE_TTL_MS = PAIRING_CODE_TTL_MS;
const MAX_ISSUE_ATTEMPTS = 5;
const MONGO_DUPLICATE_KEY = 11000;

export const creatorLabLinkStore = {
	// A fresh code for this Discord user; any unredeemed earlier code goes dead at once.
	async issue(discordUserId: string, discordUsername: string): Promise<string> {
		await CreatorLabLinkCode.deleteMany({ discordUserId, consumedAt: null });
		// Retried on the astronomically rare collision with a consumed row the TTL has not reaped yet.
		for (let attempt = 0; attempt < MAX_ISSUE_ATTEMPTS; attempt++) {
			const code = generateCode();
			try {
				await CreatorLabLinkCode.create({ code, discordUserId, discordUsername, expiresAt: new Date(Date.now() + CREATOR_LAB_LINK_CODE_TTL_MS) });
				return code;
			} catch (err) {
				if ((err as { code?: number })?.code === MONGO_DUPLICATE_KEY) continue;
				throw err;
			}
		}
		throw new Error("creatorLabLinkStore.issue: exhausted code generation retries");
	},

	// Consumes a code atomically. Null for invalid, expired or already used alike, so the route is not
	// an oracle for probing live codes (the pairing redeem posture).
	async redeem(code: string): Promise<ICreatorLabLinkCode | null> {
		const normalized = code.trim().toUpperCase();
		const doc = await CreatorLabLinkCode.findOneAndUpdate(
			{ code: normalized, consumedAt: null, expiresAt: { $gt: new Date() } },
			{ $set: { consumedAt: new Date() } },
			{ new: true }
		).lean();
		return (doc ?? null) as ICreatorLabLinkCode | null;
	},
};
