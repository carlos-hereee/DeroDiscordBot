// ── suggestion box copy ────────────────────────────────────────────────────
// What:  the notice the Suggestion Box modal's Submit answers a refusal with: its area
//        title and the two refusals, each a state rather than a failure (owner rule 1 of
//        the Round 3 list, 2026-10 item 263).
// Who:   SuggestionBox.ts. It reads the same in every pack, like commandButtonsCopy,
//        because the suggestion goes to the Company Uno team, not to a server's voice.
// Where: the rest of the feature's lines are still inline in SuggestionBox.ts.

export const suggestionBoxCopy = {
	// Discord cuts a notice title at 45 characters.
	noticeTitle: "💡 Suggestion Box",
	empty: "Suggestion cannot be empty.",
	outsideGuild: "This must be used inside a server, not a DM.",
} as const;
