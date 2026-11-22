// ── consentVersion ──────────────────────────────────────────────────────────
// What:  the one versioned consent check (2026-11 item 388, owner decision D25): a consent
//        row counts only when it covers the notice the member is being asked about now.
// Who:   features/game-rooms/networkConsent.ts (the network notice) and, from Phase 3,
//        features/meetings/meetingConsent.ts (the meeting recording notice). Each passes its
//        own version constant and its own reader, so one rule serves both and neither can
//        count an old or missing row as consent.
// Does NOT: know any model, store or constant, or any rule beyond the version. A notice with
//        a revoke (meeting consent) filters revoked rows out in the reader it passes.
//
// ⚠️ NO ROW, OR A ROW BELOW THE VERSION, IS NO CONSENT.

/** The part of a consent row this check reads. */
export interface VersionedConsentRow {
	userId: string;
	version: number;
}

/** True when a consent row covers notice `version` or a later one. */
export function isConsentCurrent(row: Pick<VersionedConsentRow, "version"> | null | undefined, version: number): boolean {
	return row !== null && row !== undefined && row.version >= version;
}

/**
 * Which of these members hold a current consent, read through `readConsents` in one call.
 * The reader returns the rows it has for those ids; a member with none is not consenting.
 */
export async function consentingAmong(
	userIds: readonly string[],
	readConsents: (userIds: readonly string[]) => Promise<readonly VersionedConsentRow[]>,
	version: number
): Promise<Set<string>> {
	if (userIds.length === 0) return new Set();
	const rows = await readConsents(userIds);
	return new Set(rows.filter((row) => isConsentCurrent(row, version)).map((row) => row.userId));
}
