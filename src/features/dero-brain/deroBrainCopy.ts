import type { BrainActionType } from "./brainTypes.js";

// ── Dero brain user-facing copy ───────────────────────────────────────
// Feature-local copy module, the sibling of voiceCopy.ts and gameRoomsCopy.ts,
// with their reasoning: tasks are a bot feature rather than a platform plugin,
// and "Dero's brain is offline" reads the same in the kingdom voice and the
// streamer voice, so a two-pack split would double the authoring for content
// that comes out the same twice.
//
// Every string here is what a member sees in an ephemeral reply to /dero. Each
// refusal names its cause, so a member learns whether to wait, ask an admin, or
// rephrase, rather than that "something failed".
//
// House rule for every string below: no dashes in user-facing copy.

// The actions still to be built, one honest line each, so a stub never reads as
// a success. `say` and `leave_voice` left this list when voice calls landed.
export type NotYetAvailableAction = Exclude<BrainActionType, "post_message" | "say" | "leave_voice">;

const NOT_AVAILABLE_YET: Record<NotYetAvailableAction, string> = {
	open_holdem: "Opening a Hold'em table is not available yet, so no table was opened.",
};

export const deroBrainCopy = {
	// ── the /dero command itself ──
	command: {
		description: "Give Dero a task, bring Dero into your voice call, or check whether Dero's brain is online",
		tell: "Give Dero a short task, like posting a message in an allowed channel",
		taskOption: "What you want Dero to do, in your own words",
		status: "Show whether Dero's brain is online and whether Dero is in a voice call",
		join: "Bring Dero into the voice channel you are in. Dero speaks there but does not listen",
		leave: "Send Dero out of this server's voice call",
	},

	// ── /dero tell, before and after the brain answers ──
	tell: {
		replyTitle: "🧠 Dero's task",
		notInGuild: "Run this in a server, not a DM.",
		notSetUp: "Dero's tasks are not set up in this server yet.",
		switchedOff: "Dero is switched off in this server right now.",
		notAuthorized: "You are not on the list of members who can give Dero tasks.",
		// R9: the brain is the owner's PC, so offline is a normal state and the
		// reply says so plainly instead of promising it will be right back.
		brainOffline: "Dero's brain is offline right now. It runs on its owner's computer, so try again later.",
		emptyTask: "Tell Dero what to do in a few words.",
		taskTooLong: (max: number): string => `That task is too long. Keep it under ${max} characters.`,
		cooldown: (seconds: number): string => `Give Dero a moment. Try again in ${seconds}s.`,
		busy: "Dero is busy with something else. Try again in a minute.",
		timeout: "Dero's brain took too long to answer. Try again in a moment.",
		notUnderstood: "Dero's brain could not understand that task. Try saying it another way.",
		failed: "Something went wrong on Dero's side. Try again in a moment.",
		nothingToDo: "Dero had nothing to do for that task.",
	},

	// ── one line per action the executor handled ──
	result: {
		posted: (channelId: string): string => `Posted in <#${channelId}>.`,
		channelNotAllowed: "Dero is not allowed to post in that channel.",
		channelUnavailable: "That channel is not available to Dero right now.",
		botLacksPermission: "Dero does not have permission to post in that channel.",
		channelNotVisible: "You cannot see that channel, so Dero will not post there for you.",
		notAuthorized: "You can no longer give Dero tasks, so nothing was done.",
		switchedOff: "Dero was switched off before the task ran, so nothing was done.",
		sendFailed: "Dero could not post that message.",
		notAvailableYet: (type: NotYetAvailableAction): string => NOT_AVAILABLE_YET[type],

		// say and leave_voice. "Left" reuses voiceCopy.call.left, the same line
		// /dero leave answers with.
		spoke: "Dero said it in the call.",
		sayNoCall: "Dero is not in a voice call in this server, so nothing was said.",
		sayNotSetUp: "Dero's voice is not set up in this server, so nothing was said.",
		sayCapReached: "Dero's voice budget for the month is used up, so nothing was said.",
		sayFailed: "Dero could not find his voice just now, so nothing was said.",
		sayQueueFull: "Dero has too much to say in the call right now, so that line was dropped.",
		leaveNoCall: "Dero is not in a voice call in this server, so there was nothing to leave.",
	},

	// ── /dero status ──
	status: {
		title: "🧠 Dero's brain",
		online: "Dero's brain is **online**.",
		offline: "Dero's brain is **offline** right now. It runs on its owner's computer, so tasks wait until it is back.",
		canTell: "You can give Dero tasks with /dero tell.",
		switchedOffForYou: "You are on the task list, but Dero is switched off in this server right now.",
	},
};
