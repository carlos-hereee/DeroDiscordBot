// ── Dero brain contract types ─────────────────────────────────────────────
// What:  the shapes that cross the link between the bot (the body) and the
//        launcher's local Dero (the brain): the job the bot hands out, the result
//        the brain sends back, and the closed list of actions a result may hold.
// Who:   brainQueue, parseBrainResult, brainJob, executor, the /brain routes and
//        /dero. The launcher keeps a hand mirror of these shapes in its own
//        contract file (another repository, no shared package).
// Where: types only. The limits live in BOT_CONSTANTS (DERO_BRAIN_*), and the
//        parser is the only thing that turns untrusted JSON into these types.
//
// ⚠️ THE BRAIN PROPOSES, THE BOT DECIDES. Nothing in a result is trusted because
// it type checks: the executor re-checks every id against the guild's allowlists
// and the live Discord cache, and authorization never reads a field the brain sent.

/** The four action names a result may carry. Anything else rejects the whole result. */
export const BRAIN_ACTION_TYPES = ["post_message", "say", "open_holdem", "leave_voice"] as const;
export type BrainActionType = (typeof BRAIN_ACTION_TYPES)[number];

export type BrainJobSource = "text" | "voice";

/** A channel the brain may name in a post_message, already filtered for the speaker. */
export interface BrainJobChannel {
	id: string;
	name: string;
}

/**
 * One task handed to the brain. Built by the bot from an authorized member's
 * own words; carries no secrets, no other member's messages, and only channels
 * the speaker can already see.
 */
export interface BrainJob {
	jobId: string;
	source: BrainJobSource;
	guild: { id: string; name: string };
	speaker: { id: string; displayName: string };
	text: string;
	channels: BrainJobChannel[];
	capabilities: BrainActionType[];
}

/** A job before the queue gives it an id. */
export type BrainJobInput = Omit<BrainJob, "jobId">;

export interface PostMessageAction {
	type: "post_message";
	channelId: string;
	text: string;
}

export interface SayAction {
	type: "say";
	text: string;
}

/** Every term is optional: a missing term means the standard table rules. */
export interface OpenHoldemAction {
	type: "open_holdem";
	maxSeats?: number;
	startingStack?: number;
	bigBlind?: number;
	channelId?: string;
}

export interface LeaveVoiceAction {
	type: "leave_voice";
}

export type BrainAction = PostMessageAction | SayAction | OpenHoldemAction | LeaveVoiceAction;

export type BrainResultStatus = "ok" | "busy" | "error";

/** What the brain answers for one job. Actions are empty unless status is "ok". */
export interface BrainResult {
	jobId: string;
	status: BrainResultStatus;
	actions: BrainAction[];
}

/**
 * How a job ended, as the waiting /dero tell sees it: the brain's parsed answer,
 * a body the parser refused (reason code only), or no answer in time.
 */
export type BrainOutcome =
	| { kind: "result"; result: BrainResult }
	| { kind: "rejected"; reason: string }
	| { kind: "timeout" };
