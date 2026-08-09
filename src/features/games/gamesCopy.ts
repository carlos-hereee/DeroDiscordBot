// ── /mini-game user-facing copy ────────────────────────────────────────────
// Feature-local copy module. Centralizes every string the command shows so none
// is hardcoded in a handler, WITHOUT threading through the pluginId copy packs
// (the games are not a platform plugin). This mirrors fortuneCopy.ts verbatim,
// including its reasoning: "rock beats scissors" has no kingdom voice and no
// streamer voice, so a two-voice split here would double the authoring work for
// content that would read identically in both packs. If the games ever graduate
// into a real plugin, this content moves into the pack + copyOverrides system.
//
// The ONE place games touch the copy packs is the commandGuide field added in
// Phase 5, which is a command LISTING, not game content. Do not move anything
// from this file into a pack.
//
// House rule for every string below: no dashes in user-facing copy. Hyphens
// inside slash command identifiers (mini-game, secret-code) are identifiers,
// not dashes, and are correct.

export const gamesCopy = {
	// Parent command description. /mini-game is a pure container: Discord does
	// not let a member invoke it without picking a subcommand, so this string is
	// only ever read inside the command picker, above the four game entries.
	commandDescription: "Play a quick game with Dero",

	duel: {
		subcommandDescription: "Challenge a member to a dice roll or a coin flip",
		opponentOptionDescription: "The member you want to challenge",
		flipOptionDescription: "Settle it with a dice roll or a coin flip",
		diceChoiceLabel: "Dice roll",
		coinChoiceLabel: "Coin flip",
		label: "a duel",
	},

	rps: {
		subcommandDescription: "Challenge a member to rock paper scissors",
		opponentOptionDescription: "The member you want to challenge",
		label: "rock paper scissors",
	},

	hangman: {
		subcommandDescription: "Start a hangman round anyone in this channel can play",
		label: "hangman",
	},

	// ── shared challenge and accept engine copy ──
	// Consumed only by challengeFlow.ts. The duel and rps handlers pass their own
	// `label` from above so one set of strings covers both games.
	challenge: {
		title: "⚔️ A challenge has been issued",
		closedTitle: "⚔️ Challenge closed",

		// Rendered as the message CONTENT, not inside the embed, because a mention
		// inside an embed does not notify anyone. The reply pins allowedMentions to
		// this one user id so the ping reaches the opponent and nothing else can
		// smuggle a mass ping through.
		mentionLine: (opponentId: string): string => `<@${opponentId}>, you have been called out.`,

		description: (challengerId: string, opponentId: string, gameLabel: string): string =>
			`<@${challengerId}> challenges <@${opponentId}> to ${gameLabel}.\n\nDo you accept?`,

		footer: "Company Uno • for fun only",

		acceptLabel: "Accept",
		declineLabel: "Decline",

		declined: (opponentId: string): string => `<@${opponentId}> declined. The moment passes.`,
		timedOut: "Nobody answered the call. The challenge fades.",

		// Rejection reasons, all shown ephemerally to the challenger before any
		// public message posts, so a rejected challenge never clutters a channel.
		selfChallenge: "You cannot challenge yourself. Find a worthy opponent.",
		botOpponent: "Bots do not play games with mortals. Pick a real member.",
		duplicate: "You two already have a challenge open. Settle that one first.",
		outsideGuild: "Challenges only work inside a server, not in a DM.",
	},

	// Phase 1 placeholder for the three games whose handlers land in Phases 2
	// through 4. It exists so the command shell is invokable and the routing test
	// has something real to assert against; every use of it is deleted as its
	// phase lands.
	comingSoon: (gameLabel: string): string => `Dero is still sharpening ${gameLabel}. Try again after the next release.`,

	// Shown when a subcommand is declared in the builder but has no entry in the
	// dispatch table. A member cannot reach this: Discord will not send a
	// subcommand the builder never declared. It only fires on a developer
	// mistake, so the copy points at the bug rather than blaming the player.
	unknownSubcommand: "That game is not wired up yet. This is a bug, not you.",
};
