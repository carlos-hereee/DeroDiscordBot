import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { IMeetingConsent } from "@db/models/MeetingConsent.js";
import { meetingConsentStore } from "@db/stores/meetingConsentStore.js";
import { meetingStore } from "@db/stores/meetingStore.js";
import { meetingSummaryJobStore } from "@db/stores/meetingSummaryJobStore.js";
import { meetingTranscriptStore } from "@db/stores/meetingTranscriptStore.js";
import { consentingAmong, isConsentCurrent } from "@utils/consentVersion.js";
import { shortId } from "@utils/shortId.js";

// ── meetingConsent ──────────────────────────────────────────────────────────
// What:  the one rule for whether a member may be recorded in a meeting (2026-11 item 388,
//        owner decision D6 and grade note R7): a MeetingConsent row whose revokedAt is null
//        AND whose version is at least MEETINGS.CONSENT_VERSION. The generic
//        utils/consentVersion.ts checks the version only, so the revoke rule lives here.
//        Also the writes behind I agree and Stop recording me, and the short trust cache the
//        recorder reads on every speaking start.
// Who:   meetingRecorder (before every subscribe and every segment write), consentNotice
//        (the mcon buttons), meetingLifecycle and meetingPresence (who in the hall agreed).
// Does NOT: subscribe, drop a recorder buffer or post anything. consentNotice drops the
//        member's live buffer first, then calls revokeMeetingConsent and removeWordsFromOpenMeetings.

interface TrustEntry {
	current: boolean;
	until: number;
}

// Memory only, keyed guild then member. A miss reads the row; a revoke clears its entry at
// once, so a member who presses Stop recording me is never trusted on a stale yes.
const trust = new Map<string, TrustEntry>();

const trustKey = (guildId: string, userId: string): string => `${guildId}:${userId}`;

/** True when this row lets its member be recorded now. */
export function isMeetingConsentCurrent(row: Pick<IMeetingConsent, "version" | "revokedAt"> | null | undefined): boolean {
	if (!row || row.revokedAt) return false;
	return isConsentCurrent(row, BOT_CONSTANTS.MEETINGS.CONSENT_VERSION);
}

/**
 * Whether this member may be recorded in this server, trusted for CONSENT_TRUST_MS so a
 * speaker's every speaking start does not read the database. `now` is injectable for tests.
 */
export async function hasMeetingConsent(guildId: string, userId: string, now: number = Date.now()): Promise<boolean> {
	const cached = trust.get(trustKey(guildId, userId));
	if (cached && now < cached.until) return cached.current;
	const current = isMeetingConsentCurrent(await meetingConsentStore.findByMember(guildId, userId));
	trust.set(trustKey(guildId, userId), { current, until: now + BOT_CONSTANTS.MEETINGS.CONSENT_TRUST_MS });
	return current;
}

/** Which of these members may be recorded, in one read. The store already leaves revoked rows out. */
export async function consentingMembers(guildId: string, userIds: readonly string[]): Promise<Set<string>> {
	return consentingAmong(
		userIds,
		async (ids) => (await meetingConsentStore.findActiveRows(guildId, ids)).filter((row) => isMeetingConsentCurrent(row)),
		BOT_CONSTANTS.MEETINGS.CONSENT_VERSION
	);
}

/** I agree: the current version, accepted now, any earlier revoke cleared. */
export async function agreeToRecording(guildId: string, userId: string, now: Date = new Date()): Promise<void> {
	await meetingConsentStore.accept(guildId, userId, BOT_CONSTANTS.MEETINGS.CONSENT_VERSION, now);
	trust.set(trustKey(guildId, userId), { current: true, until: now.getTime() + BOT_CONSTANTS.MEETINGS.CONSENT_TRUST_MS });
}

/**
 * Stop recording me: the cache forgets the member before the row is written, so no speaking
 * start between the two can trust an old yes. True when there was a consent to revoke.
 */
export async function revokeMeetingConsent(guildId: string, userId: string, now: Date = new Date()): Promise<boolean> {
	trust.delete(trustKey(guildId, userId));
	return meetingConsentStore.revoke(guildId, userId, now);
}

/**
 * The owner's "delete her words" rule (D1 sub answer): every segment of this member in a
 * meeting of this server still recording or waiting for its summary is deleted, they leave
 * that meeting's speakerIds, and its summary job goes back to pending under a fresh leaseId
 * without counting an attempt, so a launcher holding the old lease has its result refused and
 * the next claim reads the transcript without them. A meeting already summarized keeps its
 * notes. Spend already metered is not refunded. Returns how many segments went.
 */
export async function removeWordsFromOpenMeetings(guildId: string, userId: string): Promise<number> {
	const meetingIds = await meetingStore.findOpenIds(guildId);
	if (meetingIds.length === 0) return 0;
	const removed = await meetingTranscriptStore.deleteForSpeaker(guildId, meetingIds, userId);
	for (const meetingId of meetingIds) {
		await meetingStore.removeSpeaker(guildId, meetingId, userId);
		await meetingSummaryJobStore.resetLease(guildId, meetingId, shortId());
	}
	return removed;
}

/** Forget every trusted answer. Tests only. */
export function _resetMeetingConsentCache(): void {
	trust.clear();
}
