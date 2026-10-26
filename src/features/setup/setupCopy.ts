import type { AdminLogKind } from "./adminLog.js";

// ── setup admin copy ─────────────────────────────────────────────────────
// Feature-local copy for the admin surfaces this folder owns, the sibling of
// communityCopy.ts and its reasoning: every string here is read by the owner or an
// admin in 🗒️admin-log, the admin guide or a private reply, and reads the same in
// the kingdom voice and the streamer voice, so a two-pack split would double the
// authoring for content that comes out the same twice.
// Who:   adminLog (the audit line), selfDestruct (the reset prompt, the CONFIRM
//        modal and every reply) and /dero-config's arcade off and on.
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

export const setupCopy = {
	adminLog: {
		label: (kind: AdminLogKind): string => ADMIN_LOG_LABELS[kind],
		actorDashboard: "the dashboard",
		actorDero: "Dero",
		/** One audit line: when, what, who, then the subject and detail when there are any. */
		line: ({ kind, atSeconds, actor, subject, detail }: AdminLogLineInput): string =>
			[`<t:${atSeconds}:f>`, `**${ADMIN_LOG_LABELS[kind]}**`, `by ${actor}`, subject ? clip(subject) : null, detail ? clip(detail) : null]
				.filter((part): part is string => part !== null)
				.join(" · "),
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
			// /channels hide and show, and /setup-level-system (post-launch plan item 9).
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
		resetPromptTitle: "💥 Self destruct?",
		resetPromptBody: [
			"**This resets all configs to default.** Dero's voice switch, lists and budget, the arcade's reach, network blocks and monthly post, auto heal, removed channels, channel renames, custom copy, your saved rules text, the leaderboard settings and the leveling settings all go back to how a new server starts.",
			"",
			"Your channels, roles, members' levels and game history stay as they are.",
			"",
			"After the reset you can also delete server data. That step is yours alone and asks you to type CONFIRM.",
		].join("\n"),
		confirmLabel: "Confirm",
		cancelLabel: "Cancel",
		cancelledTitle: "Cancelled",
		cancelledBody: "Nothing was changed.",
		resettingTitle: "💥 Resetting",
		resettingBody: "Putting every setting back to its default now.",
		resetDoneTitle: "Configs reset",
		resetDoneBody: [
			"Dero's settings are back to their defaults. Your channels and data are untouched.",
			"",
			"**Delete server data** goes further: it deletes both of Dero's categories and every channel in them, every match in progress, and this server's stored records (member levels and renown history, game rooms and their transcripts, game tallies and luck, game requests, poll votes, events and their attendance, and any unclaimed pairing code).",
			"",
			"Kept on purpose: the audit trail, this month's voice spending, network bans and consent, and players' network ratings. A welcome or rules channel your server had before Dero adopted it is kept too. **This cannot be undone.**",
		].join("\n"),
		resetFailed: "The reset failed partway. Run self destruct again to finish it; nothing was deleted.",
		deleteDataLabel: "Delete server data",
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
		auditReset: "configs reset to default",
		auditResetFailed: "config reset failed",
		auditDeleteConfirmed: "server data delete confirmed",
		auditDeleteRefused: "CONFIRM not typed, nothing deleted",
		auditDeleteFailed: "server data delete failed",
	},

	arcade: {
		offTitle: "🎮 Arcade off",
		offBody: "The 🎮 ARCADE GAMES category and every channel in it are deleted, matches in progress included. It stays off across restarts until `/dero-config arcade on`.",
		alreadyOff: "The arcade is already off. `/dero-config arcade on` brings it back.",
		offFailed: "Turning the arcade off failed before anything was deleted. Try again in a moment.",
		onTitle: "🎮 Arcade on",
		onBody: "The 🎮 ARCADE GAMES category and its channels are back.",
		onPending:
			"The arcade is switched back on, but its channels could not all be built just now. If auto heal is off, `/configure` turns it back on; otherwise the next restart finishes them.",
		offDescription: "Delete the arcade category and every channel in it, matches included",
		onDescription: "Bring the arcade category and its channels back",
		alreadyOn: "The arcade is already on.",
		onFailed: "Turning the arcade on failed. Try again in a moment.",
		auditOff: "arcade off, category and channels deleted",
		auditOn: "arcade on, category and channels rebuilt",
	},
} as const;
