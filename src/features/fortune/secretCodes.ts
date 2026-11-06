// ── secret codes (FUTURE_PLANS item 88, v1) ────────────────────────────────
// The intentionally tiny v1: three hardcoded codes mapping to the permanent
// ultra-reading weight each grants. All three weights are prime (19 / 43 / 83
// percent), sitting above the prime 0.03 base (rollFortune.ULTRA_WEIGHT). The
// generic create-code / configure-code builder and the dashboard toggle are
// deferred (see item 88); nothing here assumes a reward beyond the weight, so the
// same shape generalizes later.
//   • minor      GILDED-BY-SILENT       0.19  announced to everyone at launch
//   • major      THE-GOLDEN-NOD         0.43  surfaced to PRO/BUSINESS subscribers
//   • exclusive  SILENT-COULD-BE-MIDAS  0.83  hand-delivered by the owner
import { fortuneBuffStore } from "@db/stores/fortuneBuffStore.js";
import { canonicalPhrase } from "@utils/canonicalPhrase.js";

const CODES: ReadonlyArray<{ code: string; weight: number }> = [
	{ code: "GILDED-BY-SILENT", weight: 0.19 },
	{ code: "THE-GOLDEN-NOD", weight: 0.43 },
	{ code: "SILENT-COULD-BE-MIDAS", weight: 0.83 },
];

// The matching code entry for a phrase, or null if it matches nothing. Exported
// so a unit test can assert the map without touching the DB.
export function matchCode(raw: string): { code: string; weight: number } | null {
	const key = canonicalPhrase(raw);
	return CODES.find((c) => canonicalPhrase(c.code) === key) ?? null;
}

export type RedeemOutcome =
	| { status: "invalid" }
	| { status: "granted"; percent: number }
	| { status: "unchanged"; percent: number };

// Validate a phrase and, if real, grant its buff to the user (keeping the higher
// of any existing buff). "unchanged" means the code is valid but the user already
// held an equal or stronger blessing. `percent` is the resulting effective ultra
// chance, ready for display.
export async function redeemCode(userId: string, raw: string): Promise<RedeemOutcome> {
	const hit = matchCode(raw);
	if (!hit) return { status: "invalid" };

	const result = await fortuneBuffStore.grantIfHigher(userId, hit.weight, hit.code);
	const percent = Math.round(result.weight * 100);
	return result.raised ? { status: "granted", percent } : { status: "unchanged", percent };
}
