import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { IPluginCopy } from "@base/copy/index.js";
import type { IMeeting } from "@db/models/Meeting.js";
import type { CardPayload } from "@utils/cardMessage.js";
import { infoEmbed } from "@utils/embedBuilder.js";

// ── notesCard ───────────────────────────────────────────────────────────────
// What:  the final faces of a meeting's notes card in 📝meeting-notes (2026-11 item 388
//        Phase 4): filled with the summary, the decisions and the action items, or saying
//        honestly why there is no summary, or saying it was removed from the dashboard.
//        Drawn from the Meeting row alone.
// Who:   summaryResult, which edits the same message endMeeting posted pending
//        (Meeting.notesMessageId in Meeting.notesChannelId). The pending and nothing
//        recorded faces stay in meetingLifecycle.buildEndedCard. meetingLifecycle.deleteMeeting
//        draws the removed face.
// Does NOT: ping. An assignee is mentioned so the name links, never notified; the todo card
//        and its reminders are what reach them.

const MS_PER_MINUTE = 60_000;
// Discord refuses an embed description over this. The summary, ten decisions and
// fifteen action items at their caps can pass it, so lines past the limit are counted
// instead of drawn; every action item is still a todo of its own.
const DESCRIPTION_MAX = BOT_CONSTANTS.DISCORD_LIMITS.MAX_EMBED_DESCRIPTION_LENGTH;
const BULLET = "• ";
const quiet = { parse: [], users: [], roles: [] } as CardPayload["allowedMentions"];

function meetingMinutes(meeting: Pick<IMeeting, "startedAt" | "endedAt">): number {
	const span = new Date(meeting.endedAt ?? 0).getTime() - new Date(meeting.startedAt ?? 0).getTime();
	return Math.max(1, Math.round(span / MS_PER_MINUTE));
}

const joinBlocks = (lead: readonly string[], list: readonly string[], tail: readonly string[]): string => [...lead, list.join("\n"), ...tail].filter(Boolean).join("\n\n");

const bulletsIn = (lines: readonly string[]): number => lines.filter((line) => line.startsWith(BULLET)).length;

// Draws list lines in order while the description, with room kept for the closing "and N
// more" line, stays under the limit; the first line that does not fit stops the list. The
// lead (the stats and a summary of at most SUMMARY_MAX_CHARS) and the trail always fit.
function fitDescription(lead: readonly string[], listLines: readonly string[], trail: readonly string[], more: (count: number) => string): string {
	const kept: string[] = [];
	for (const [index, line] of listLines.entries()) {
		const withMore = (hidden: number): string[] => (hidden > 0 ? [more(hidden), ...trail] : [...trail]);
		if (joinBlocks(lead, [...kept, line], withMore(bulletsIn(listLines.slice(index + 1)))).length > DESCRIPTION_MAX) {
			return joinBlocks(lead, kept, withMore(bulletsIn(listLines.slice(index))));
		}
		kept.push(line);
	}
	return joinBlocks(lead, kept, trail);
}

/** The notes card once the summary is written. `todosChannelId` null keeps the items on the card. */
export function buildSummaryCard(meeting: IMeeting, copy: IPluginCopy, todosChannelId: string | null): CardPayload {
	const words = copy.meetingRecording.notes;
	const summary = meeting.summary;
	const decisions = summary?.decisions ?? [];
	const items = summary?.actionItems ?? [];

	const decisionLines = decisions.length > 0 ? decisions.map((decision) => `${BULLET}${decision}`) : [words.noDecisions];
	const itemLines = items.length > 0 ? items.map((item) => `${BULLET}${item.text} (${item.assigneeId ? `<@${item.assigneeId}>` : words.unassigned})`) : [words.noActionItems];
	const lead = [words.stats(meetingMinutes(meeting), meeting.speakerIds.length), `${words.summaryHeading}\n${summary?.text ?? ""}`];
	const listLines = [words.decisionsHeading, ...decisionLines, "", words.actionItemsHeading, ...itemLines];
	const pointer = items.length === 0 ? [] : [todosChannelId ? words.todosPointer(todosChannelId) : words.todosMissing];

	const description = fitDescription(lead, listLines, pointer, words.more);
	return { embeds: [infoEmbed(words.title(meeting.title), description, copy.COLORS.SCHEDULE)], components: [], allowedMentions: quiet };
}

/** The notes card when no summary can be written, with the line for why. */
export function buildFailedNotesCard(meeting: IMeeting, copy: IPluginCopy, code: string): CardPayload {
	const words = copy.meetingRecording.notes;
	const failed = words.failed;
	const line = code === "transcript_expired" || code === "transcript_empty" ? failed[code] : failed.generic;
	return { embeds: [infoEmbed(words.title(meeting.title), line, copy.COLORS.SCHEDULE)], components: [], allowedMentions: quiet };
}

/** A meeting's card once the dashboard deleted it: the notes and the transcript are gone, its todos stay. */
export function buildRemovedNotesCard(meeting: Pick<IMeeting, "title">, copy: IPluginCopy): CardPayload {
	const words = copy.meetingRecording.notes;
	return { embeds: [infoEmbed(words.title(meeting.title), words.removed, copy.COLORS.SCHEDULE)], components: [], allowedMentions: quiet };
}
