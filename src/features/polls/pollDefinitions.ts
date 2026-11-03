// ── audience poll definitions ─────────────────────────────────────────
// Platform-research polls broadcast to every eligible guild by PollDispatcher.
// This is voice-neutral platform content, NOT guild pack voice, the same
// category as the ops/outage messages that deliberately live outside the copy
// packs. The question is a factual behavior probe, identical in every guild
// regardless of pluginId, so it does not get a per-pack phrasing.
//
// Each poll is dispatched at most once per guild (idempotent via the
// poll_sent:<pollId> bot-log key), so pollId MUST stay stable once shipped:
// changing it would re-broadcast to every guild. pollId and option keys MUST
// NOT contain ":", it is the customId delimiter the interactionRegistry splits
// on (customId is `poll:<pollId>:<optionKey>`).

export interface IPollOption {
	// stable key stored as PollResult.choice and embedded in the vote button
	// customId. Keep short and ":"-free.
	key: string;
	// member-facing button label (Discord caps button labels at 80 chars).
	label: string;
}

export interface IPollDefinition {
	pollId: string;
	question: string;
	options: IPollOption[];
}

// First poll (item 34a): the behavior attention probe. Asks members whether
// they noticed HOW the bot's intro changed after a config change. The data
// tells us whether edit-in-place vs repost is even perceptible before we invest
// in the follow-up tradeoff probe (a later, manually dispatched poll added to
// ACTIVE_POLLS once these results are in).
export const INTRO_AWARENESS_POLL: IPollDefinition = {
	pollId: "intro-awareness-2026-06",
	question:
		"After this server's bot setup changed recently, what do you think happened to the bot's introduction message?",
	options: [
		{ key: "updated", label: "It was quietly updated in place" },
		{ key: "reposted", label: "A brand new one was posted" },
		{ key: "unnoticed", label: "I did not notice any change" },
	],
};

// Polls the dispatcher broadcasts on boot. PARKED as of 2026-06-18: the boot-
// dispatched audience poll is shelved (the owner is reconsidering polls in favor
// of a future /poll slash command, possibly in a dedicated channel). The
// dispatcher framework stays in place but dormant, an empty list means
// dispatchPolls posts nothing and logPollTallies logs nothing. INTRO_AWARENESS_POLL
// above is retained for reference / reuse when the /poll work resumes. Re-adding a
// definition here is safe: the poll_sent bot-log keys keep already-asked guilds
// from being re-prompted.
export const ACTIVE_POLLS: IPollDefinition[] = [];
