import type { AdminLogKind } from "./adminLog.js";
import type { BoardRefreshProblem } from "@base/interfaces/IBoardRefreshResult.js";

// ── setup admin copy ─────────────────────────────────────────────────────
// Feature-local copy for the admin surfaces this folder owns, the sibling of
// communityCopy.ts and its reasoning: every string here is read by the owner or an
// admin in 🗒️admin-log, the admin guide or a private reply, and reads the same in
// the kingdom voice and the streamer voice, so a two-pack split would double the
// authoring for content that comes out the same twice.
// Who:   adminLog (the audit line), selfDestruct (the choice modal, the CONFIRM
//        modal and every reply) and /arcade off and on.
//
// House rule for every string below: no dashes in user-facing copy.

// The label each audit kind reads as in 🗒️admin-log. A Record over the kind union,
// so a kind added to adminLog.ts without a label is a compile error here.
const ADMIN_LOG_LABELS: Record<AdminLogKind, string> = {
	"schedule.create": "Schedule created",
	"schedule.update": "Schedule changed",
	"schedule.delete": "Schedule removed",
	"event.create": "Event created",
	"event.update": "Event changed",
	"event.delete": "Event removed",
	"config.change": "Setting changed",
	"powerup.toggle": "Admin power-up",
	"voice.allowlist": "Voice list edited",
	"voice.cap": "Voice budget changed",
	"selfdestruct.attempt": "Self destruct",
	"chip.grant": "Chips granted",
	"vault.topup": "Vault topped up",
	"bot.slot": "Bot seat changed",
};

// Discord caps a message at 2000 characters; one audit line stays far below that
// even with a long event name, and a cut keeps a pasted title from flooding the log.
const MAX_LINE_PART_LENGTH = 200;

function clip(text: string): string {
	return text.length > MAX_LINE_PART_LENGTH ? `${text.slice(0, MAX_LINE_PART_LENGTH - 1)}…` : text;
}

export interface AdminLogLineInput {
	kind: AdminLogKind;
	// Unix seconds, rendered by Discord in each reader's own time zone.
	atSeconds: number;
	// Already rendered: a member mention, or the dashboard or Dero label below.
	actor: string;
	subject?: string;
	detail?: string;
}

// The field names of an audit embed: who acted, what it was about, what changed.
const ADMIN_LOG_FIELD_NAMES = {
	actor: "By",
	subject: "What",
	detail: "Change",
} as const;

/** One field of an audit embed. */
export interface AdminLogEmbedField {
	name: string;
	value: string;
}

/** The words of one audit embed, without its color or time. */
export interface AdminLogEmbedParts {
	title: string;
	fields: AdminLogEmbedField[];
}

export const setupCopy = {
	adminLog: {
		label: (kind: AdminLogKind): string => ADMIN_LOG_LABELS[kind],
		actorDashboard: "the dashboard",
		actorDero: "Dero",
		/** One audit line: when, what, who, then the subject and detail when there are any. The embed's fallback. */
		line: ({ kind, atSeconds, actor, subject, detail }: AdminLogLineInput): string =>
			[`<t:${atSeconds}:f>`, `**${ADMIN_LOG_LABELS[kind]}**`, `by ${actor}`, subject ? clip(subject) : null, detail ? clip(detail) : null]
				.filter((part): part is string => part !== null)
				.join(" · "),
		/**
		 * The words of one audit embed: the same label and the same clipped parts the
		 * line uses, so the embed and its text fallback cannot say different things. An
		 * empty subject or detail has no field. adminLog.ts adds the color and the time.
		 */
		embedParts: ({ kind, actor, subject, detail }: AdminLogLineInput): AdminLogEmbedParts => ({
			title: ADMIN_LOG_LABELS[kind],
			fields: ([
				{ name: ADMIN_LOG_FIELD_NAMES.actor, value: actor },
				subject ? { name: ADMIN_LOG_FIELD_NAMES.subject, value: clip(subject) } : null,
				detail ? { name: ADMIN_LOG_FIELD_NAMES.detail, value: clip(detail) } : null,
			] as Array<AdminLogEmbedField | null>).filter((field): field is AdminLogEmbedField => field !== null),
		}),
		// Subjects and details the setting writers pass, so every caller names a
		// setting the same way in the log.
		subjects: {
			voice: "Dero's voice",
			listen: "Listen",
			cap: "monthly speech budget",
			arcadeMonthlyPost: "arcade monthly post",
			arcadeReach: "arcade reach",
			networkBlock: "network block list",
			botOpponents: "Dero bot opponents",
			arcade: "the arcade",
			autoHeal: "auto heal",
			leaderboardTracking: "leaderboard tracking",
			weekStart: "leaderboard week",
			community: "Discord Community",
			welcomeLog: "welcome log",
			rulesChannel: "rules channel",
			onboarding: "Discord Onboarding",
			refreshStandings: "standings refreshed",
			postHangman: "hangman round posted",
			// /server channels hide and show, and /leveling settings (post-launch plan item 9).
			channelVisibility: (channelName: string): string => `${channelName} channel`,
			leveling: (setting: string): string => `leveling ${setting}`,
		},
		on: "on",
		off: "off",
		hidden: "hidden from members",
		shown: "visible to members",
		// A leveling list (rewards, multipliers, restrictions) changed; its entries are in the reply, not the log.
		listUpdated: "list updated",
		cleared: "cleared",
		added: (mention: string): string => `added ${mention}`,
		removed: (mention: string): string => `removed ${mention}`,
		// Dero took a channel the server already had (post-launch plan item 2).
		adopted: (channelId: string): string => `now <#${channelId}>, the server's own channel`,
		capSet: (usd: number): string => `$${usd} a month`,
		set: (value: string): string => `set to ${value}`,
		blocked: (serverId: string): string => `blocked ${serverId}`,
		unblocked: (serverId: string): string => `unblocked ${serverId}`,
		// Schedule and event lines.
		allSchedules: "every schedule",
		paused: "paused",
		pausedUntil: (unixSeconds: number): string => `paused until <t:${unixSeconds}:f>`,
		resumed: "resumed",
		pausedCount: (count: number): string => `${count} paused`,
		resumedCount: (count: number): string => `${count} resumed`,
		streamAnnounced: "one time stream announced",
		weeklyStream: "weekly stream scheduled",
		editedOnce: "edited for its next fire only",
		editedEveryFire: "edited for every fire",
		created: "created",
		updated: "updated",
		deleted: "deleted",
		kvkSeason: "KvK season events set up",
	},

	selfDestruct: {
		buttonLabel: "Self destruct",
		notInGuild: "Run this in a server, not a DM.",
		ownerOnly: "Only the server owner can self destruct.",
		staleControl: "This control is no longer available.",
		// The choice modal. A modal title holds 45 characters, a select label 45 and
		// an option's description 100.
		choiceModalTitle: "💥 Self destruct",
		choiceModalBody: [
			"**Self destruct deletes every Dero channel and its message history.**",
			"",
			"It does **not** delete stored data: announcements, schedules, settings, members' levels, game history and the rest stay. Delete my data also deletes the stored records and asks you to type CONFIRM first.",
			"",
			"A welcome or rules channel your server had before Dero adopted it is kept.",
		].join("\n"),
		choiceLabel: "What should Dero do?",
		choices: {
			channels: {
				label: "Just delete channels",
				description: "Delete Dero's channels, keep every setting. /setup brings them back as they were.",
				emoji: "🧹",
			},
			data: {
				label: "Delete my data",
				description: "Delete the channels and this server's stored data. Asks you to type CONFIRM.",
				emoji: "🗑️",
			},
			arcade: {
				label: "Arcade only",
				description: "Delete only the 🎮 ARCADE GAMES category and its channels, like /arcade off.",
				emoji: "🎮",
			},
		},
		deletingChannelsBody: "Deleting Dero's channels now. Every setting and record is kept.",
		channelsDone: "Done. Dero's channels are gone and every setting is kept. Run /setup to bring them back as they were.",
		deleteDataTitle: "🗑️ Delete my data",
		deleteDataBody: [
			"This deletes both of Dero's categories and every channel in them, every match in progress, and this server's stored records (member levels and renown history, game rooms and their transcripts, game tallies and luck, game requests, poll votes, events and their attendance, and any unclaimed pairing code).",
			"",
			"Kept on purpose: Dero's settings for this server (so /setup rebuilds with them), the audit trail, this month's voice spending, network bans and consent, and players' network ratings. A welcome or rules channel your server had before Dero adopted it is kept too. **This cannot be undone.**",
			"",
			"Press **Type CONFIRM** to finish. Nothing is deleted until you do.",
		].join("\n"),
		typeConfirmLabel: "Type CONFIRM",
		modalTitle: "Delete server data",
		modalInputLabel: "Type CONFIRM to delete everything",
		modalPlaceholder: "CONFIRM",
		confirmWord: "CONFIRM",
		mismatch: "That was not CONFIRM, so nothing was deleted.",
		deletingTitle: "💥 Deleting",
		deletingBody: "Deleting Dero's channels and this server's data now.",
		deleteDone: "Done. Dero's channels and this server's data are gone, and they stay gone until you run /setup.",
		deleteFailed: "The delete failed before anything was removed. Try again in a moment.",
		deletePartial: (failed: readonly string[]): string =>
			`Dero's channels are gone, but these records could not be deleted: ${failed.join(", ")}. Run self destruct again to retry them.`,
		// The audit line's detail for each step of the flow.
		auditRefusedNotOwner: "refused, not the server owner",
		auditChannelsConfirmed: "just delete channels, settings kept",
		auditArcadeOff: "arcade only, category and channels deleted",
		auditArcadeAlreadyOff: "arcade only, the arcade was already off",
		auditArcadeFailed: "arcade only failed, nothing deleted",
		auditDeleteConfirmed: "server data delete confirmed",
		auditDeleteRefused: "CONFIRM not typed, nothing deleted",
		auditDeleteFailed: "server data delete failed",
	},

	// Refresh standings on the admin guide (2026-10 item 254): one line per board of
	// the leaderboard channel, saying it refreshed or why not.
	refreshStandings: {
		boards: { participation: "Participation board", levels: "Levels board" },
		refreshed: (board: string): string => `✅ ${board}: refreshed.`,
		failed: (board: string, reason: string): string => `⚠️ ${board}: not refreshed, ${reason}.`,
		problems: {
			"homebase-destroyed": "Dero's channels were self destructed (run /setup)",
			"not-set-up": "the leaderboard channel is not set up yet",
			"channel-missing": "the leaderboard channel is missing or Dero cannot see it",
			"foreign-message": "the stored board message belongs to another bot",
			"edit-failed": "Discord refused the edit (check Dero's permissions there)",
			"post-failed": "Discord refused the post (check Dero's permissions there)",
			"unexpected-error": "the standings could not be read, try again in a moment",
		} satisfies Record<BoardRefreshProblem, string>,
		auditAllRefreshed: "both boards refreshed",
		auditSomeFailed: (failed: readonly string[]): string => `not refreshed: ${failed.join(", ")}`,
	},

	arcade: {
		offTitle: "🎮 Arcade off",
		offBody: "The 🎮 ARCADE GAMES category and every channel in it are deleted, matches in progress included. It stays off across restarts until `/arcade on`.",
		alreadyOff: "The arcade is already off. `/arcade on` brings it back.",
		offFailed: "Turning the arcade off failed before anything was deleted. Try again in a moment.",
		onTitle: "🎮 Arcade on",
		onBody: "The 🎮 ARCADE GAMES category and its channels are back.",
		onPending:
			"The arcade is switched back on, but its channels could not all be built just now. If auto heal is off, `/server auto-heal` turns it back on; otherwise the next restart finishes them.",
		offDescription: "Delete the arcade category and every channel in it, matches included",
		onDescription: "Bring the arcade category and its channels back",
		alreadyOn: "The arcade is already on.",
		onFailed: "Turning the arcade on failed. Try again in a moment.",
		auditOff: "arcade off, category and channels deleted",
		auditOn: "arcade on, category and channels rebuilt",
	},
} as const;
