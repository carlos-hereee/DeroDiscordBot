import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { networkConsentStore } from "@db/stores/networkConsentStore.js";
import type { INetworkConsent } from "@db/models/NetworkConsent.js";

// ── networkConsent ───────────────────────────────────────────────────
// What:  the one answer to "may this member be shown in another server?" (2026-10 item
//        244 Phase 5b): they accepted the network notice at the current version.
// Who:   every door into a network table (joinGate, networkJoin, the host's network
//        choice), the network board's host line, the network scope boards and the server
//        ratings. ONE rule, so no surface can count an old or missing consent as consent.
// Does NOT: show the notice or store an acceptance (networkRules.consentPrompt and the
//        notice's buttons in networkJoin). Knows no discord.js, so the rating boards,
//        which keep discord.js out, can read it.
//
// ⚠️ NO ROW, OR A ROW BELOW BOT_CONSTANTS.NETWORK.CONSENT_VERSION, IS NO CONSENT.

/** True when a consent row covers the current notice. */
export function isConsentCurrent(row: Pick<INetworkConsent, "version"> | null | undefined): boolean {
	return row !== null && row !== undefined && row.version >= BOT_CONSTANTS.NETWORK.CONSENT_VERSION;
}

/** Whether a member accepted the current network notice. */
export async function hasNetworkConsent(userId: string): Promise<boolean> {
	return isConsentCurrent(await networkConsentStore.findByUserId(userId));
}

/** Which of these members accepted the current network notice, in one query. */
export function consentingAmong(userIds: readonly string[]): Promise<Set<string>> {
	return networkConsentStore.findConsentingUserIds(userIds, BOT_CONSTANTS.NETWORK.CONSENT_VERSION);
}
