import type { Client } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { IMeeting } from "@db/models/Meeting.js";
import type { IMeetingSummaryJob } from "@db/models/MeetingSummaryJob.js";
import { meetingStore } from "@db/stores/meetingStore.js";
import { meetingSummaryJobStore } from "@db/stores/meetingSummaryJobStore.js";
import { meetingTranscriptStore } from "@db/stores/meetingTranscriptStore.js";
import { shortId } from "@utils/shortId.js";
import { resolveSpeakerNames } from "./speakerNames.js";
import { failSummaryJob } from "./summaryResult.js";

// ── summaryJobs ─────────────────────────────────────────────────────────────
// What:  the claim side of the meeting summary contract (2026-11 item 388 Phase 4, owner
//        decision D9): take the next summary job under a fresh lease and build the body the
//        launcher summarizes.
// Who:   GET /brain/meeting-summary/next (api/routes/meetingSummary.routes.ts), and nobody
//        else. The launcher's twin of SummaryJobBody is meetingSummaryJobSchema in
//        dev-launcher src/dero/brainContracts.ts; the shared fixture
//        meetingSummary.fixture.json pins both, byte for byte.
// How:   one conditional write claims a job (meetingSummaryJobStore.claimJob). A claimed job
//        that is past its attempts, lost its meeting or has no words left is failed on the
//        spot and the next one is claimed, so the launcher only ever receives work it can do.
// Does NOT: log what anyone said. Logs carry job ids, counts and codes only.

/** The body GET /brain/meeting-summary/next answers. Field order is the fixture's. */
export interface SummaryJobBody {
	jobId: string;
	leaseId: string;
	meeting: { title: string; startedAt: string; durationMs: number };
	speakers: Array<{ label: string; name: string }>;
	segments: Array<{ label: string; offsetMs: number; text: string }>;
	trimmed: boolean;
}

/** One stored segment, reduced to what the body needs. */
export interface JobSegment {
	speakerId: string;
	offsetMs: number;
	text: string;
}

export interface SummaryJobInput {
	jobId: string;
	leaseId: string;
	title: string;
	startedAt: Date;
	durationMs: number;
	segments: readonly JobSegment[];
	// Each speaker's server display name; one missing is named by its label.
	names: ReadonlyMap<string, string>;
	maxBytes: number;
}

const MEETINGS = BOT_CONSTANTS.MEETINGS;
const MS_PER_DAY = 86_400_000;
const LABEL_PREFIX = "S";
// The comma that joins one more segment into the JSON array.
const SEPARATOR_BYTES = 1;

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

function draftBody(input: SummaryJobInput, segments: readonly JobSegment[], trimmed: boolean): SummaryJobBody {
	// Labels follow the order of first speech among the segments sent, S1 first, so a body
	// that was trimmed never names a speaker it carries no words for.
	const labels = new Map<string, string>();
	for (const segment of segments) {
		if (!labels.has(segment.speakerId)) labels.set(segment.speakerId, `${LABEL_PREFIX}${labels.size + 1}`);
	}
	return {
		jobId: input.jobId,
		leaseId: input.leaseId,
		meeting: { title: input.title, startedAt: input.startedAt.toISOString(), durationMs: input.durationMs },
		speakers: [...labels.entries()].map(([speakerId, label]) => ({ label, name: input.names.get(speakerId) ?? label })),
		segments: segments.map((segment) => ({ label: labels.get(segment.speakerId) ?? LABEL_PREFIX, offsetMs: segment.offsetMs, text: segment.text })),
		trimmed,
	};
}

/**
 * The job body for one meeting, ordered by offset, at most `maxBytes` of JSON. A longer
 * transcript drops its OLDEST segments and says trimmed: the end of a meeting is where its
 * decisions and action items usually land. Exported for the tests.
 */
export function buildSummaryJobBody(input: SummaryJobInput): SummaryJobBody {
	const ordered = [...input.segments].sort((a, b) => a.offsetMs - b.offsetMs);
	const full = draftBody(input, ordered, false);
	if (jsonBytes(full) <= input.maxBytes) return full;

	// ① estimate with every label and speaker still present, an upper bound, so the drop
	// count is found in one pass rather than by restringifying the body per segment;
	let start = 0;
	let estimate = jsonBytes(draftBody(input, ordered, true));
	while (start < ordered.length && estimate > input.maxBytes) {
		estimate -= jsonBytes(full.segments[start]) + SEPARATOR_BYTES;
		start += 1;
	}
	// ② the real body, relabelled, can only be smaller; the loop is the guarantee anyway.
	let body = draftBody(input, ordered.slice(start), true);
	while (body.segments.length > 0 && jsonBytes(body) > input.maxBytes) {
		start += 1;
		body = draftBody(input, ordered.slice(start), true);
	}
	return body;
}

/** Whether the 30 day TTL has taken a meeting's transcript, as opposed to every speaker revoking. */
export function isTranscriptExpired(meeting: Pick<IMeeting, "endedAt" | "startedAt">, now: Date): boolean {
	const ended = meeting.endedAt ?? meeting.startedAt;
	if (!ended) return false;
	return now.getTime() - new Date(ended).getTime() >= MEETINGS.TRANSCRIPT_TTL_DAYS * MS_PER_DAY;
}

// The body for a job just claimed, or null after failing it (the caller then claims again).
async function bodyForClaim(client: Client, job: IMeetingSummaryJob, leaseId: string, now: Date): Promise<SummaryJobBody | null> {
	if (job.attempts > MEETINGS.SUMMARY_MAX_ATTEMPTS) {
		await failSummaryJob(client, job, "attempts");
		return null;
	}
	const meeting = await meetingStore.findById(job.guildId, job.meetingId);
	if (!meeting) {
		await meetingSummaryJobStore.markFailed(job.jobId, "meeting_gone");
		return null;
	}
	const stored = await meetingTranscriptStore.listForMeeting(job.guildId, job.meetingId);
	if (stored.length === 0) {
		// Phase 3's revoke can leave a finished meeting with no words at all.
		await failSummaryJob(client, job, isTranscriptExpired(meeting, now) ? "transcript_expired" : "transcript_empty");
		return null;
	}
	const speakerIds = [...new Set(stored.map((segment) => segment.speakerId))];
	const resolved = await resolveSpeakerNames(client, job.guildId, speakerIds);
	const names = new Map([...resolved.entries()].map(([userId, name]) => [userId, name.displayName]));
	const startedAt = new Date(meeting.startedAt ?? meeting.createdAt ?? now);
	const endedAt = new Date(meeting.endedAt ?? now);
	return buildSummaryJobBody({
		jobId: job.jobId,
		leaseId,
		title: meeting.title,
		startedAt,
		durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
		segments: stored.map((segment) => ({ speakerId: segment.speakerId, offsetMs: segment.offsetMs, text: segment.text })),
		names,
		maxBytes: MEETINGS.SUMMARY_JOB_MAX_BYTES,
	});
}

/**
 * Claim the next summary job the launcher can work, under a fresh leaseId and a
 * SUMMARY_LEASE_MS lease, and build its body. Null when no job waits. A launcher that dies
 * holding the lease leaves the job to the next claim once the lease runs out.
 */
export async function claimNextSummaryJob(client: Client, now: Date = new Date()): Promise<SummaryJobBody | null> {
	// Every pass either answers or fails the job it claimed, which no claim matches again, so
	// the loop ends when the waiting jobs do.
	for (;;) {
		const leaseId = shortId();
		const job = await meetingSummaryJobStore.claimJob(now, leaseId, new Date(now.getTime() + MEETINGS.SUMMARY_LEASE_MS));
		if (!job) return null;
		const body = await bodyForClaim(client, job, leaseId, now);
		if (!body) continue;
		console.info(`[meetings] summary job claimed job=${job.jobId} guild=${job.guildId} attempt=${job.attempts} segments=${body.segments.length} trimmed=${body.trimmed}`);
		return body;
	}
}
