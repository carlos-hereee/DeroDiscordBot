import type { AdminLogFamily, AdminLogKind } from "./adminLog.js";
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
	"party.open": "Party game not opened",
	"config.change": "Setting changed",
	"powerup.toggle": "Admin power-up",
	"voice.allowlist": "Voice list edited",
	"voice.cap": "Voice budget changed",
	"voice.queue": "Waiting for Dero",
	"selfdestruct.attempt": "Self destruct",
	"chip.grant": "Chips granted",
	"vault.topup": "Vault topped up",
	"bot.slot": "Bot seat changed",
};

// The emoji each audit kind's embed title opens with (2026-10 item 257 Phase 2b), so
// an admin scrolling the log finds a kind by its picture before reading a word. A
// Record over the kind union for the same compile time reason as the labels.
const ADMIN_LOG_EMOJIS: Record<AdminLogKind, string> = {
	"schedule.create": "🗓️",
	"schedule.update": "✏️",
	"schedule.delete": "🗑️",
	"event.create": "📣",
	"event.update": "📝",
	"event.delete": "❌",
	"party.open": "🎉",
	"config.change": "⚙️",
	"powerup.toggle": "⚡",
	"voice.allowlist": "🎙️",
	"voice.cap": "💸",
	"voice.queue": "🔊",
	"selfdestruct.attempt": "💥",
	"chip.grant": "🪙",
	"vault.topup": "🏦",
	"bot.slot": "🤖",
};

// The footer an audit embed carries, naming the family its color stands for, so the
// color has a word beside it for a reader who cannot tell the colors apart.
const ADMIN_LOG_FAMILY_LABELS: Record<AdminLogFamily, string> = {
	settings: "Settings",
	schedules: "Schedules and events",
	destructive: "Destructive action",
	economy: "Economy",
	bots: "Bot opponents",
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
	// By and What sit side by side; Change takes the full width, since it is the longest.
	inline: boolean;
}

/** The words of one audit embed, without its color or time. */
export interface AdminLogEmbedParts {
	title: string;
	fields: AdminLogEmbedField[];
}

export const setupCopy = {
	adminLog: {
		label: (kind: AdminLogKind): string => ADMIN_LOG_LABELS[kind],
		emoji: (kind: AdminLogKind): string => ADMIN_LOG_EMOJIS[kind],
		/** The embed's title: the kind's emoji, then its label. */
		title: (kind: AdminLogKind): string => `${ADMIN_LOG_EMOJIS[kind]} ${ADMIN_LOG_LABELS[kind]}`,
		/** The embed's footer: the family the kind's color stands for. */
		footer: (family: AdminLogFamily): string => `Admin log · ${ADMIN_LOG_FAMILY_LABELS[family]}`,
		actorDashboard: "the dashboard",
		actorDero: "Dero",
		// The embed author when a dashboard route acted: no member stands behind it.
		authorDashboard: "Company Uno dashboard",
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
			title: `${ADMIN_LOG_EMOJIS[kind]} ${ADMIN_LOG_LABELS[kind]}`,
			fields: ([
				{ name: ADMIN_LOG_FIELD_NAMES.actor, value: actor, inline: true },
				subject ? { name: ADMIN_LOG_FIELD_NAMES.subject, value: clip(subject), inline: true } : null,
				detail ? { name: ADMIN_LOG_FIELD_NAMES.detail, value: clip(detail), inline: false } : null,
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
		// A notice board channel built on its first use (2026-11 item 285 Phase 3).
		noticeBoardChannel: (channelName: string): string => `${channelName} channel`,
		builtOnFirstUse: (channelId: string): string => `built <#${channelId}> in the notice board`,
		// A notice board channel taken away by its setup card's Remove (2026-11 item 289).
		removedFromCard: "deleted from its setup card",
		releasedFromCard: "released from its setup card, the channel stays",
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
			"It also puts every Dero setting back to its default and builds Dero fresh, starting with 🔒inner-sanctum alone. Stored records (announcements, schedules, members' levels, game history and the rest) stay unless you pick Delete my data, which deletes them too and asks you to type CONFIRM first.",
			"",
			"A welcome or rules channel your server had before Dero adopted it is kept.",
		].join("\n"),
		choiceLabel: "What should Dero do?",
		// The second select (2026-11 item 285 debug pass, owner ruling): auto heal is why a
		// deleted Dero channel comes back, so the owner decides it here and reads why.
		autoHealLabel: "Auto heal afterwards",
		autoHealHint: "Auto heal rebuilds any Dero channel that goes missing. Arcade only ignores this.",
		autoHealChoices: {
			on: { label: "Keep auto heal on", description: "Dero rebuilds any of its channels that go missing." },
			off: { label: "Turn auto heal off", description: "A deleted Dero channel stays gone until /server auto-heal turns it on." },
		},
		autoHealOffDone: "Auto heal is off, so a deleted Dero channel stays gone; /server auto-heal turns it back on.",
		autoHealOffFailed: "Auto heal could not be turned off; /server auto-heal turns it off.",
		choices: {
			channels: {
				label: "Just delete channels",
				description: "Delete Dero's channels and reset its settings, keep the records. Dero starts fresh.",
				emoji: "🧹",
			},
			data: {
				label: "Delete my data",
				description: "Delete the channels, stored data and settings. Asks you to type CONFIRM.",
				emoji: "🗑️",
			},
			arcade: {
				label: "Arcade only",
				description: "Delete only the 🎮 ARCADE GAMES category and its channels, like /arcade off.",
				emoji: "🎮",
			},
		},
		deletingChannelsBody: "Deleting Dero's channels and resetting its settings now. Every record is kept.",
		channelsDone: "Done. Dero's channels are gone and its settings are back to their defaults; every record is kept.",
		deleteDataTitle: "🗑️ Delete my data",
		deleteDataBody: [
			"This deletes both of Dero's categories and every channel in them, every match in progress, and this server's stored records (member levels and renown history, game rooms and their transcripts, game tallies and luck, game requests, poll votes, events and their attendance, and any unclaimed pairing code), and puts every Dero setting back to how a new server starts (Dero's voice switch, lists and budget, the arcade's settings, auto heal, removed channels, channel renames, custom copy, your saved rules text, and the leaderboard and leveling settings).",
			"",
			"Kept on purpose: the audit trail, this month's voice spending, network bans and consent, and players' network ratings. A welcome or rules channel your server had before Dero adopted it is kept too. **This cannot be undone.**",
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
		deletingBody: "Deleting Dero's channels and this server's data, and resetting its settings, now.",
		deleteDone: "Done. Dero's channels and this server's data are gone and its settings are back to their defaults.",
		// The second sentence of either teardown's done line: Dero builds 🏰 DERO
		// HEADQUARTERS fresh right after it (2026-11 item 285 debug pass), and the owner's
		// next step is the rebuilt inner sanctum's button. rebuiltSanctumFallback names
		// the channel only when the rebuilt row stores no id for it.
		rebuilt: (sanctum: string, buttonLabel: string): string => `Dero is built fresh: open ${sanctum} and press **${buttonLabel}**.`,
		rebuiltSanctumFallback: "Dero Headquarters",
		rebuildFailed: "Dero could not build its channels again, so run /setup to build Dero fresh.",
		deleteFailed: "The delete failed before anything was removed. Try again in a moment.",
		deletePartial: (failed: readonly string[]): string =>
			`Dero's channels are gone, but these could not be deleted or reset: ${failed.join(", ")}. Run self destruct again to retry them.`,
		// How a failed settings reset is named in deletePartial, beside the records' labels.
		settingsLabel: "settings",
		// The audit line's detail for each step of the flow.
		auditRefusedNotOwner: "refused, not the server owner",
		auditChannelsConfirmed: "just delete channels, settings reset",
		auditArcadeOff: "arcade only, category and channels deleted",
		auditArcadeAlreadyOff: "arcade only, the arcade was already off",
		auditArcadeFailed: "arcade only failed, nothing deleted",
		auditDeleteConfirmed: "server data delete confirmed",
		auditDeleteRefused: "CONFIRM not typed, nothing deleted",
		auditDeleteFailed: "server data delete failed",
	},

	// The member Fire a greeting power up, refused while its cooldown runs (bot audit 2026-10-30).
	fireGreeting: {
		cooldown: (seconds: number): string => `Dero greeted you a moment ago. Try again in ${seconds} seconds.`,
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

	// The server's own welcome and rules channels (2026-10 item 257 Phase 1a): the lines
	// 🧭onboarding's step 2 lists them by (2026-10 item 263 Phase 4b), the modal its
	// Choose button opens, and the result card posted in 🧭onboarding after Submit. A
	// modal title, a select label and an option label hold 45 characters, an option
	// description 100.
	adoptionChoice: {
		cardTitle: "📌 Your server's own channels",
		channelLine: (channelId: string, slot: string): string => `• <#${channelId}> as the ${slot}`,
		slots: { welcomeChannelId: "welcome log", rulesChannelId: "rules channel" },
		buttonLabel: "Choose",
		modalTitle: "Your server's own channels",
		modalPrompt: "Pick where each channel goes. Leave where it is changes nothing about it.",
		selectLabel: (channelName: string): string => `#${channelName}`,
		options: {
			move: { label: "Move into the notice board", description: "Dero moves it under 🪧 NOTICE BOARD and manages its permissions" },
			stay: { label: "Leave where it is", description: "Dero uses it where it is and leaves its permissions alone" },
		},
		notAllowed: "Only the server owner or an admin can choose where these channels go.",
		nothingToChoose: "There is no channel of your server's own left to place.",
		modalRefused: "The choice could not open. Press Choose again in a moment.",
		results: {
			moved: (channelId: string): string => `✅ <#${channelId}> moved into the notice board.`,
			already: (channelId: string): string => `✅ <#${channelId}> is already in the notice board.`,
			stayed: (channelId: string): string => `• <#${channelId}> stays where it is.`,
			refused: (channelId: string): string => `⚠️ <#${channelId}> could not be moved (Discord refused its permissions), so it stays where it is.`,
		},
		auditMoved: "moved into the notice board",
		auditStayed: "left where it is",
		auditRefused: "move refused, left where it is",
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

	// ── 🎛️admin-controls retired (2026-10 item 263 Phase 4a) ──
	// The one admin log line the boot sweep writes when it deletes the channel, and the
	// reason Discord's own audit log shows beside the delete. Admin facing.
	retiredAdminControls: {
		subject: "🎛️admin-controls",
		detail: "deleted: every control now lives in its own Dero Headquarters channel, and admin answers post in 🛠️server-config",
		deleteReason: "Dero retired 🎛️admin-controls: every control now lives in its own Dero Headquarters channel",
	},

	// ── 🏰 DERO HEADQUARTERS steps cards and settings charts (2026-10 item 257 Phase 2b) ──
	// Admin facing. A button label holds 80 characters; the step labels stay short so the
	// card reads as a checklist.
	headquarters: {
		done: "✅",
		todo: "⬜",
		skippedMark: "⏭️",
		skippedWord: "(skipped)",
		stepLine: (mark: string, step: number, label: string): string => `${mark} **Step ${step}** ${label}`,
		optional: "(optional)",
		buttonLabel: (step: number): string => `Step ${step}`,
		footer: "Press a step to open its settings. The marks update after every change.",
		switchesFooter: "Press a switch to change it. Refresh standings redraws the leaderboard.",
		on: "ON",
		off: "OFF",
		notSet: "not set",
		unknown: "unknown",
		count: (count: number): string => String(count),
		dollars: (usd: number): string => `$${usd} a month`,
		stepUnavailable: "That step could not open just now. Try again in a moment.",
		staleStep: "This step is no longer available. The card refreshes on the next change.",
		// What a step card says and carries (2026-11 item 289). The channel cards' own lines and
		// their Add this channel button are onboarding.tutorial's.
		stepCards: {
			openButton: "Open",
			skipButton: "Skip",
			continueButton: "Continue",
			removeButton: "Remove",
			skippedLine: "⏭️ Skipped. You can always come back and make edits.",
			continuedLine: "✅ Noted. You can always come back and make edits.",
			notAdmin: "Only the server owner or an admin can move a setup step along.",
		},
		// The step cards of the four config channels (2026-11 item 289). The 17 flow steps teach
		// here, keyed by domain and step, each written from what its flow does; a channel step
		// teaches from the guild's pack instead (channelContent.tutorial). tutorialCards reads
		// this table as the list of flow steps that have a card.
		stepTeaching: {
			deroConfig: {
				voice: "Turns Dero's voice and the Listen buttons on or off, and sets the task roles and the voice channels Dero may join. This step finishes once the voice is on with a channel to join.",
				priority: "Picks what gets Dero's voice first while Dero is busy in a call. A request waits its turn, and Dero never leaves a call for it.",
			},
			onboarding: {
				community:
					"Turns on Discord Community. A form picks your rules channel, your community updates channel and whether Membership Screening goes on, and a review shows what will change before you confirm.",
				adopted: "Says whether each welcome or rules channel your server already had moves into 🪧 NOTICE BOARD or stays where it is. Until you answer, Dero uses it where it stands.",
				discordOnboarding:
					"Once Discord Community is on, drafts the questions new members answer in Discord Onboarding, keeping any your server already has. You edit each question and answer in a review, and nothing is written until you confirm.",
				gating: "Once Discord Community is on and /setup has named a member role, Dero's channels open only to members who hold that role. There is nothing to press here: the gate follows on its own.",
			},
			arcadeControl: {
				chips: "Switches chips and the daily claim, the monthly post and Dero bot opponents on or off. All three start on, so you can keep them as they are.",
				reach: "Sets how far a host's challenge may reach: invite only rooms, rooms open to this server, or tables open to other servers on the network.",
				block: "Keeps one server off this server's network tables, both ways, by its server id. It only matters once your reach is the network.",
			},
			serverConfig: {
				timezone: "Picks the zone Dero reads typed times in for party games and stream announcements. A new weekly stream starts in it, and the KvK season stays on UTC.",
				template: "Sets how Dero speaks in this server, kingdom or streamer. Switching rewrites Dero's pinned intros and renames the channels still on their default names.",
				kvkSeason: "Builds the prebuilt event reminders for a Rise of Kingdoms KvK season. Pass this one by if your server does not play a season.",
				streams: "Sets up a weekly stream or event reminder on a fixed day and time.",
				events: "Lists your server's events, and pauses, resumes or deletes one.",
				channels: "Hides or shows a member facing channel, lists them, or renames one Dero keeps. A hidden channel still exists and Dero still posts in it; only members stop seeing it.",
				leveling: "Sets how members earn XP, how level ups are announced, the milestones and any restrictions. Leveling starts on, so you can keep it as it is.",
				rename: "Explains how a channel keeps a new name: a name set with /server channels rename stays, and a rename made straight in Discord is put back while auto heal is on.",
			},
		},
		deroConfig: {
			title: "⚙️ Dero's voice setup",
			steps: ["Dero's voice, Listen, the task roles and the voice channels Dero may join", "Set the voice priority order"],
			chartTitle: "⚙️ Dero's voice settings",
			chartSubtitle: "Every switch and setting of Dero's voice in this server.",
			rows: {
				voice: "Dero's voice",
				listen: "Listen buttons",
				roles: "Task list roles",
				voiceChannels: "Voice channels Dero may join",
				// Hidden by the owner's decision of 2026-10-27 (2026-10 item 263 Phase 4b); returns later.
				// cap: "Monthly speech budget",
				priority: "Voice priority",
			},
		},
		onboarding: {
			title: "🧭 Onboarding setup",
			steps: ["Turn on Discord Community", "Place your own rules and welcome channels", "Configure Discord Onboarding", "Gate Dero's channels behind the member role"],
			// Step 4 has no button: the member role is named in /setup, and the gate follows
			// on its own once Community is on (2026-10 item 257, the orchestrator's option A).
			gatingNote: "The member role is named in /setup; the gate follows on its own once Community is on.",
			// Step 2's line on a server where Dero adopted none of its own channels.
			nothingAdopted: "Dero found none of your server's own channels to use, so there is nothing to choose.",
			chartTitle: "🧭 Onboarding settings",
			chartSubtitle: "Community, Onboarding and who sees Dero's channels.",
			rows: {
				community: "Discord Community",
				onboarding: "Discord Onboarding",
				memberRole: "Member role",
				gating: "Channels gated by the member role",
				adoptedPlaced: "Your own channels placed",
			},
			// The notice board tutorial cards beneath the chart (2026-11 item 285 Phase 3). Each
			// card's teaching paragraph lives in the guild's pack (channelContent.tutorial);
			// these are the admin facing labels and answers around it.
			tutorial: {
				pendingLine: "⬜ Not built yet. Press the button to add it to 🪧 NOTICE BOARD.",
				doneLine: (channelId: string): string => `✅ Built: <#${channelId}>`,
				addButton: "Add this channel",
				doneButton: "Channel ready",
				answerTitle: "🪧 Notice board",
				built: (channelId: string): string => `<#${channelId}> is ready in the notice board.`,
				alreadyBuilt: (channelId: string): string => `<#${channelId}> is already there, so nothing new was built.`,
				notBuilt: "Dero could not build that channel just now. Check that Dero may manage channels, then press the button again.",
				notAdmin: "Only the server owner or an admin can add notice board channels.",
				// A ready channel card's Remove (2026-11 item 289). The confirm says which of the two
				// removes this is, because a built channel goes and an adopted one stays.
				remove: {
					title: "🪧 Remove this channel?",
					confirmBuilt: (channelId: string): string => `This deletes <#${channelId}> and every message in it. Add this channel on its card brings an empty one back.`,
					confirmAdopted: (channelId: string): string => `Dero stops using <#${channelId}>. The channel and its messages stay as they are.`,
					confirmButton: "Remove",
					cancelButton: "Cancel",
					cancelled: "Nothing changed. The channel stays as it is.",
					timedOut: "No answer came in time, so nothing changed. Press Remove again to ask once more.",
					alreadyGone: "That channel is already gone, so there is nothing to remove.",
					deleted: (label: string): string => `${label} is gone. Add this channel on its card brings an empty one back.`,
					released: (label: string): string => `Dero no longer uses ${label}. The channel and its messages stay as they are.`,
					gone: (label: string): string => `${label} was already gone, so nothing changed.`,
					refused: (label: string): string =>
						`Discord refused to delete ${label}, so nothing changed. A channel Discord Community requires, such as the rules or community updates channel, must be swapped in Server Settings first (Discord error 50074).`,
					failed: "Dero could not finish removing that channel. Check that Dero may manage channels, then press Remove again.",
					notAdmin: "Only the server owner or an admin can remove notice board channels.",
				},
			},
		},
		arcadeControl: {
			title: "🎰 Arcade setup",
			// The one card 🎰arcade-control shows while the arcade is off (2026-11 item 285
			// debug pass): its step is steps[0], and the full card above shows the rest.
			enableTitle: "🎰 Turn the arcade on",
			steps: ["Turn the arcade on", "Chips, the daily claim, the monthly post and Dero bot opponents", "Rated network reach and registration", "Block servers from your network"],
			chartTitle: "🎰 Arcade settings",
			chartSubtitle: "Every switch and setting of the arcade in this server.",
			rows: {
				arcade: "The arcade",
				chips: "Chips and the daily claim",
				monthlyPost: "Monthly post",
				bots: "Dero bot opponents",
				reach: "Challenge reach",
				blocked: "Blocked servers",
			},
			reach: { "invite-only": "invite only", server: "this server", network: "the rated network" } as Record<string, string>,
			// The button beside the numbered steps while the arcade is on (2026-11 item 285
			// Phase 4). Its replies are pack copy (responses.dismantle*).
			dismantleButton: "Dismantle Arcade",
			notAdmin: "Only the server owner or an admin can use the arcade controls.",
			// The confirm Dismantle Arcade asks before it deletes anything. Both voices read it
			// the same, like the self destruct choice it mirrors.
			dismantleConfirm: {
				title: "🎮 Dismantle the arcade?",
				body: "This deletes the 🎮 ARCADE GAMES category and every channel in it, matches in progress included. Stored data stays, and `/arcade on` brings the arcade back.",
				confirmButton: "Dismantle",
				cancelButton: "Cancel",
				cancelled: "Nothing was deleted. The arcade stays as it is.",
				timedOut: "No answer came in time, so nothing was deleted. Press Dismantle Arcade again to ask once more.",
			},
		},
		// 🛠️server-config (2026-10 item 263 Phase 4a). Steps are keyed, not listed, so an
		// inserted step (Phase 4c's timezone) moves its number with its label.
		serverConfig: {
			title: "🛠️ Server setup",
			steps: {
				timezone: "The server's timezone",
				template: "Dero's template: kingdom or streamer",
				kvkSeason: "The KvK season",
				streams: "The weekly stream schedule",
				events: "Your events: list, pause, resume or delete",
				channels: "The server's channels: hide, show, list or rename",
				leveling: "Leveling settings and XP",
				rename: "How a renamed channel keeps its name",
			},
			// Step 8, an info step (2026-11 item 285 Phase 4): its explainer is pack copy
			// (responses.renameInfoTitle and responses.renameInfoBody).
			rename: {
				notAdmin: "Only the server owner or an admin can open this step.",
			},
			chartTitle: "🛠️ Server settings",
			chartSubtitle: "This server's schedule, channels, leveling and switches.",
			rows: {
				timezone: "Timezone",
				template: "Dero's template",
				kvkSeason: "KvK season",
				weeklySchedules: "Weekly schedules",
				activeEvents: "Active events",
				pausedEvents: "Paused events",
				hiddenChannels: "Hidden channels",
				renamedChannels: "Renamed channels",
				leveling: "Leveling",
				autoHeal: "Auto heal",
				tracking: "Leaderboard tracking",
				weekStart: "Leaderboard week starts",
			},
			seasonEnds: (end: Date): string => `ends ${end.toISOString().slice(0, 10)}`,
			weekStarts: { sunday: "Sunday", monday: "Monday" } as Record<"sunday" | "monday", string>,
			switches: {
				title: "🛠️ Server switches",
				labels: { autoHeal: "Auto heal", tracking: "Leaderboard tracking", weekStart: "Week start" },
				line: (label: string, state: string): string => `**${label}** ${state}`,
			},
			// Step 1, the server's timezone (2026-10 item 263 Phase 4c). Discord caps a modal
			// title and a label at 45 characters.
			timezone: {
				modalTitle: "Server timezone",
				intro:
					"Times typed for party games and stream announcements are read in this zone, and a new weekly stream starts in it. The KvK season stays on UTC, the game's clock. Shown times already appear in each member's own time.",
				selectLabel: "This server's timezone",
				notAdmin: "Only the server owner or an admin can set the server's timezone.",
				saved: (zone: string): string => `This server's timezone is now **${zone}**. Times typed from now on are read in it.`,
				auditSubject: "server timezone",
			},
			// Step 2, Dero's template (2026-10 item 262 Phase 4): kingdom or streamer, free
			// for every server. Keyed by the plugin id each template stores. Discord caps a
			// modal title and a label at 45 characters, an option description at 100.
			template: {
				names: { "rok-commander": "Kingdom", "general-events": "Streamer" } as Record<"rok-commander" | "general-events", string>,
				descriptions: {
					"rok-commander": "Dero's medieval voice, made for Rise of Kingdoms alliances.",
					"general-events": "A plain voice for streamers and communities.",
				} as Record<"rok-commander" | "general-events", string>,
				modalTitle: "Dero's template",
				intro:
					"The template sets how Dero speaks in this server. Switching rewrites Dero's pinned intros and renames the channels still on their default names. A name set with /server channels rename stays. Both templates are free.",
				selectLabel: "Template",
				notAdmin: "Only the server owner or an admin can switch Dero's template.",
				unchanged: (name: string): string => `This server already uses the **${name}** template. Nothing changed.`,
				saved: (name: string): string => `Dero now uses the **${name}** template in this server. The pinned intros are rewritten.`,
				renamed: (count: number): string => `Renamed ${count} channel${count === 1 ? "" : "s"} to the new default name.`,
				kept: (count: number): string => `Kept ${count} channel name${count === 1 ? "" : "s"} an admin or the server set.`,
				failed: (count: number): string =>
					`Discord refused ${count} rename${count === 1 ? "" : "s"} for now. Dero tries again on its next restart while auto heal is on.`,
				auditSubject: "Dero's template",
			},
		},
	},
} as const;
