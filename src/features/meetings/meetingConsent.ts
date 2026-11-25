import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { IMeetingConsent } from "@db/models/MeetingConsent.js";
import { meetingConsentStore } from "@db/stores/meetingConsentStore.js";
import { meetingStore } from "@db/stores/meetingStore.js";
import { meetingSummaryJobStore } from "@db/stores/meetingSummaryJobStore.js";
import { meetingTranscriptStore } from "@db/stores/meetingTranscriptStore.js";
import { consentingAmong, isConsentCurrent } from "@utils/consentVersion.js";
import { createGuildQueue } from "@utils/guildQueue.js";
import { shortId } from "@utils/shortId.js";

// ── meetingConsent ──────────────────────────────────────────────────────────
// What:  the one rule for whether a member may be recorded in a meeting (2026-11 item 388,
//        owner decision D6 and grade note R7): a MeetingConsent row whose revokedAt is null
//        AND whose version is at least MEETINGS.CONSENT_VERSION. The generic
//        utils/consentVersion.ts checks the version only, so the revoke rule lives here.
//        Also the writes behind I agree, No thanks and Stop recording me, and the short trust
//        cache the recorder reads on every speaking start.
// Who:   meetingRecorder (before every subscribe and every segment write), consentNotice
//        (the mcon buttons), meetingLifecycle and meetingPresence (who in the hall agreed), and
//        meetingBootRecovery (retryOwedWithdrawals).
// How a withdrawal always wins (2026-11 item 420): one member's accepts and revokes run through
//        one queue, so press order decides the row; a withdrawal raises the member's generation
//        before its first await, so a read or an agree in flight cannot store a yes over it; and
//        a withdrawal not finished yet (its row or its removal still to write) reads as a no
//        everywhere, whatever the row still says.
// Does NOT: subscribe, drop a recorder buffer or post anything. consentNotice drops the
//        member's live buffer first, then calls revokeMeetingConsent and its finish.

interface TrustEntry {
	current: boolean;
	until: number;
}

/** What a withdrawal came to: it ended a yes, there was none left to end, or there never was one. */
export type WithdrawalOutcome = "withdrawn" | "alreadyWithdrawn" | "neverAgreed";
/** Whether an I agree stood: it did, a later withdrawal beat it, or a removal still owed could not run. */
export type AgreeOutcome = "agreed" | "overtaken" | "removalFailed";

/** One withdrawal press. `outcome` rejects when its write failed, which the repair pass then retries. */
export interface Withdrawal {
	outcome: Promise<WithdrawalOutcome>;
	/** Remove the member's words from every open meeting. Never throws: what fails stays owed. */
	finish(): Promise<void>;
}

// A withdrawal whose row or removal is not done yet. `live` while its own press is still at work,
// so the repair pass never runs beside it.
interface OwedWithdrawal {
	guildId: string;
	userId: string;
	rowWritten: boolean;
	live: boolean;
}

// Memory only, keyed guild then member. A miss reads the row; a withdrawal clears its entry at
// once, so a member who presses No thanks or Stop recording me is never trusted on a stale yes.
const trust = new Map<string, TrustEntry>();
// How many times each member withdrew in this process. Anything that waited compares it, so a
// yes read or written before a withdrawal is never stored after it.
const withdrawals = new Map<string, number>();
// Memory only: after a restart the revoked row itself, with the member still in a meeting's
// speakerIds, is the durable mark of a removal still owed (meetingBootRecovery).
const owed = new Map<string, OwedWithdrawal>();
// Its own queue, keyed by member rather than guild, so one member's presses run in press order
// and nobody else waits for them.
const consentQueue = createGuildQueue();

const memberKey = (guildId: string, userId: string): string => `${guildId}:${userId}`;
const withdrawalsOf = (key: string): number => withdrawals.get(key) ?? 0;

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
	const key = memberKey(guildId, userId);
	if (owed.has(key)) return false;
	const cached = trust.get(key);
	if (cached && now < cached.until) return cached.current;
	return readConsent(guildId, userId, now);
}

// The row's answer, cached. A withdrawal that landed while it was read makes the read worthless,
// so it is taken again; an agree that stood meanwhile left a newer yes in the cache.
async function readConsent(guildId: string, userId: string, now: number): Promise<boolean> {
	const key = memberKey(guildId, userId);
	if (owed.has(key)) return false;
	const withdrawalsBefore = withdrawalsOf(key);
	const cachedBefore = trust.get(key);
	const current = isMeetingConsentCurrent(await meetingConsentStore.findByMember(guildId, userId));
	if (withdrawalsOf(key) !== withdrawalsBefore) return readConsent(guildId, userId, now);
	const cachedSince = trust.get(key);
	if (cachedSince && cachedSince !== cachedBefore) return cachedSince.current;
	trust.set(key, { current, until: now + BOT_CONSTANTS.MEETINGS.CONSENT_TRUST_MS });
	return current;
}

/**
 * Whether this member may be recorded, read from the row now, never from the cache: the check
 * the recorder makes as it writes words. What it read refreshes the cache.
 */
export async function hasMeetingConsentNow(guildId: string, userId: string): Promise<boolean> {
	return readConsent(guildId, userId, Date.now());
}

/**
 * Which of these members withdrew: a revoked or missing row, or a withdrawal still owed. A row
 * below the version is an old yes, not a withdrawal, so it is not among them.
 */
export async function withdrawnAmong(guildId: string, userIds: readonly string[]): Promise<string[]> {
	const active = new Set((await meetingConsentStore.findActiveRows(guildId, userIds)).map((row) => row.userId));
	return userIds.filter((userId) => !active.has(userId) || owed.has(memberKey(guildId, userId)));
}

/** Which of these members may be recorded, in one read. The store already leaves revoked rows out. */
export async function consentingMembers(guildId: string, userIds: readonly string[]): Promise<Set<string>> {
	const consenting = await consentingAmong(
		userIds,
		async (ids) => (await meetingConsentStore.findActiveRows(guildId, ids)).filter((row) => isMeetingConsentCurrent(row)),
		BOT_CONSTANTS.MEETINGS.CONSENT_VERSION
	);
	return new Set([...consenting].filter((userId) => !owed.has(memberKey(guildId, userId))));
}

// ── agree and withdraw ──────────────────────────────────────────────────────

/**
 * I agree: the current version, accepted now, any earlier revoke cleared. Answers whether the
 * yes stood, and the caller lets the recorder hear the member only then. A removal an earlier
 * withdrawal still owes runs first, or agreeing again would cancel it: the row is the only mark
 * of it a restart leaves.
 */
export async function agreeToRecording(guildId: string, userId: string, now: Date = new Date()): Promise<AgreeOutcome> {
	const key = memberKey(guildId, userId);
	const pressed = withdrawalsOf(key);
	return consentQueue.run(key, async () => {
		if (withdrawalsOf(key) !== pressed) return "overtaken";
		const row = await meetingConsentStore.findByMember(guildId, userId);
		if ((row?.revokedAt || owed.has(key)) && !(await tryRemoveWords(guildId, userId))) return "removalFailed";
		if (withdrawalsOf(key) !== pressed) return "overtaken";
		await meetingConsentStore.accept(guildId, userId, BOT_CONSTANTS.MEETINGS.CONSENT_VERSION, now);
		// Pressed while the accept was being written: that withdrawal is next in this queue and
		// revokes the row just accepted, so the yes never counts.
		if (withdrawalsOf(key) !== pressed) return "overtaken";
		owed.delete(key);
		trust.set(key, { current: true, until: now.getTime() + BOT_CONSTANTS.MEETINGS.CONSENT_TRUST_MS });
		return "agreed";
	});
}

/**
 * No thanks or Stop recording me. Everything up to the queue place happens before this returns:
 * the member's generation is raised, the cache forgets them, and they read as a no until their
 * row is written and their words are removed. Writes no row for a member who has none.
 */
export function revokeMeetingConsent(guildId: string, userId: string, now: Date = new Date()): Withdrawal {
	const key = memberKey(guildId, userId);
	withdrawals.set(key, withdrawalsOf(key) + 1);
	trust.delete(key);
	const entry: OwedWithdrawal = { guildId, userId, rowWritten: false, live: true };
	owed.set(key, entry);
	const outcome = consentQueue.run(key, async (): Promise<WithdrawalOutcome> => {
		const revoked = await meetingConsentStore.revoke(guildId, userId, now);
		entry.rowWritten = true;
		if (revoked) return "withdrawn";
		return (await meetingConsentStore.findByMember(guildId, userId)) ? "alreadyWithdrawn" : "neverAgreed";
	});
	const finish = async (): Promise<void> => {
		await settleWithdrawal(key, entry);
		entry.live = false;
	};
	return { outcome, finish };
}

// Write what one withdrawal still owes, behind whatever the member pressed since. An entry no
// longer in the map was settled by an agree, or replaced by a newer press that settles itself.
async function settleWithdrawal(key: string, entry: OwedWithdrawal): Promise<void> {
	await consentQueue.run(key, async () => {
		if (owed.get(key) !== entry) return;
		if (!entry.rowWritten) {
			try {
				await meetingConsentStore.revoke(entry.guildId, entry.userId, new Date());
				entry.rowWritten = true;
			}
			catch (error) {
				console.error(`[meetings] withdrawal not written guild=${entry.guildId} member=${entry.userId}`, error instanceof Error ? error.name : "unknown");
			}
		}
		const removed = await tryRemoveWords(entry.guildId, entry.userId);
		if (removed && entry.rowWritten && owed.get(key) === entry) owed.delete(key);
	});
}

/** Retry every withdrawal whose row or removal failed. meetingBootRecovery's repair pass. */
export async function retryOwedWithdrawals(): Promise<void> {
	for (const [key, entry] of [...owed.entries()]) {
		if (!entry.live) await settleWithdrawal(key, entry);
	}
}

async function tryRemoveWords(guildId: string, userId: string): Promise<boolean> {
	try {
		await removeWordsFromOpenMeetings(guildId, userId);
		return true;
	}
	catch (error) {
		console.error(`[meetings] words not removed, kept for the repair pass guild=${guildId} member=${userId}`, error instanceof Error ? error.name : "unknown");
		return false;
	}
}

/**
 * Remove a withdrawn member's words, and keep the removal for the repair pass when it fails.
 * False when it failed. summaryResult and meetingBootRecovery, whose member pressed nothing in
 * this process.
 */
export async function removeWithdrawnWords(guildId: string, userId: string): Promise<boolean> {
	const key = memberKey(guildId, userId);
	if (await tryRemoveWords(guildId, userId)) return true;
	if (!owed.has(key)) owed.set(key, { guildId, userId, rowWritten: true, live: false });
	return false;
}

/**
 * The owner's "delete her words" rule (D1 sub answer): every segment of this member in a
 * meeting of this server still recording, waiting for its summary or failed is deleted, they
 * leave that meeting's speakerIds, and its leased summary job goes back to pending under a fresh
 * leaseId with its attempt given back, so a launcher holding the old lease has its result refused
 * and the next claim reads the transcript without them. A meeting that holds nothing of theirs is
 * not touched at all, or any member could reset any job (2026-11 item 420, L10). A meeting already
 * summarized keeps its notes. Spend already metered is not refunded.
 *
 * Per meeting the speaker entry goes last, because with a revoked row it is the durable mark of a
 * removal still owed. Throws when any meeting's removal failed, after trying every one of them.
 * Returns how many segments went.
 */
export async function removeWordsFromOpenMeetings(guildId: string, userId: string): Promise<number> {
	let removed = 0;
	const failures: unknown[] = [];
	for (const meetingId of await meetingStore.findOpenIds(guildId)) {
		try {
			removed += await removeWordsFrom(guildId, meetingId, userId);
		}
		catch (error) {
			failures.push(error);
		}
	}
	if (failures.length > 0) throw failures[0];
	return removed;
}

async function removeWordsFrom(guildId: string, meetingId: string, userId: string): Promise<number> {
	const isInMeeting = (await meetingTranscriptStore.hasSpeaker(guildId, meetingId, userId)) || (await meetingStore.hasSpeaker(guildId, meetingId, userId));
	if (!isInMeeting) return 0;
	await meetingSummaryJobStore.resetLease(guildId, meetingId, shortId());
	const removed = await meetingTranscriptStore.deleteForSpeaker(guildId, [meetingId], userId);
	await meetingStore.removeSpeaker(guildId, meetingId, userId);
	return removed;
}

/** Forget every trusted answer and every withdrawal still owed. Tests only. */
export function _resetMeetingConsentCache(): void {
	trust.clear();
	withdrawals.clear();
	owed.clear();
}
