// src/db/stores/creatorLabChannelCodeStore.ts
import { CreatorLabChannelCode, type ICreatorLabChannelCode } from "@db/models/CreatorLabChannelCode.js";
import { generateCode, PAIRING_CODE_TTL_MS } from "@db/stores/pendingPairingStore.js";

// ── Creator Lab live channel code store (2026-11 item 284 Phase 3) ──
// Issues and redeems the codes modeled by CreatorLabChannelCode, with the pairing code generator and
// lifetime (the same alphabet the server's code pattern matches, the same 15 minutes to reach the
// dashboard), as creatorLabLinkStore does for a person. One live code per channel (delete then create);
// single use and expiry live in redeem's atomic findOneAndUpdate.

export const CREATOR_LAB_CHANNEL_CODE_TTL_MS = PAIRING_CODE_TTL_MS;
const MAX_ISSUE_ATTEMPTS = 5;
const MONGO_DUPLICATE_KEY = 11000;

export interface ChannelCodeIssue {
	guildId: string;
	channelId: string;
	guildName: string;
	channelName: string;
	discordUserId: string;
}

export const creatorLabChannelCodeStore = {
	// A fresh code for this channel; any unredeemed earlier code for it goes dead at once.
	async issue(issue: ChannelCodeIssue): Promise<string> {
		await CreatorLabChannelCode.deleteMany({ channelId: issue.channelId, consumedAt: null });
		// Retried on the astronomically rare collision with a consumed row the TTL has not reaped yet.
		for (let attempt = 0; attempt < MAX_ISSUE_ATTEMPTS; attempt++) {
			const code = generateCode();
			try {
				await CreatorLabChannelCode.create({ ...issue, code, expiresAt: new Date(Date.now() + CREATOR_LAB_CHANNEL_CODE_TTL_MS) });
				return code;
			} catch (err) {
				if ((err as { code?: number })?.code === MONGO_DUPLICATE_KEY) continue;
				throw err;
			}
		}
		throw new Error("creatorLabChannelCodeStore.issue: exhausted code generation retries");
	},

	// Consumes a code atomically. Null for invalid, expired or already used alike, so the route is not
	// an oracle for probing live codes (the pairing redeem posture).
	async redeem(code: string): Promise<ICreatorLabChannelCode | null> {
		const normalized = code.trim().toUpperCase();
		const doc = await CreatorLabChannelCode.findOneAndUpdate(
			{ code: normalized, consumedAt: null, expiresAt: { $gt: new Date() } },
			{ $set: { consumedAt: new Date() } },
			{ new: true }
		).lean();
		return (doc ?? null) as ICreatorLabChannelCode | null;
	},
};
