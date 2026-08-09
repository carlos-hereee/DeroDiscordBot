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

		// ── result embed ──
		// The mentions here never ping: this embed is the payoff, and pinging both
		// players a second time (they were already pinged by the challenge) would
		// be noise. Mentions inside an embed render as names without notifying.
		resultTitle: "⚔️ The duel is settled",
		cooldownMessage: (seconds: number): string => `Dero is still clearing the field. Try again in ${seconds}s.`,

		diceLine: (challengerId: string, challengerRoll: number, opponentId: string, opponentRoll: number): string =>
			`<@${challengerId}> rolled **${challengerRoll}**\n<@${opponentId}> rolled **${opponentRoll}**`,
		coinLine: (face: string): string => `The coin lands on **${face}**.`,

		winnerLine: (winnerId: string): string => `\n\n👑 <@${winnerId}> takes it.`,
		tieLine: "\n\nDead even. Nobody takes it. Run it back.",
	},

	rps: {
		subcommandDescription: "Challenge a member to rock paper scissors",
		opponentOptionDescription: "The member you want to challenge",
		label: "rock paper scissors",

		cooldownMessage: (seconds: number): string => `Dero is still resetting the ring. Try again in ${seconds}s.`,

		// ── the secret pick prompt ──
		// Sent as its OWN ephemeral message to each player, never one shared
		// message, so neither can see the other's throw before both are locked in.
		pickPrompt: "Throw in secret. Your opponent cannot see this.",
		rockLabel: "Rock",
		paperLabel: "Paper",
		scissorsLabel: "Scissors",

		// Shown to whichever player throws FIRST, so they are not left staring at
		// a message that appears to have done nothing.
		pickReceived: (choice: string, opponentId: string): string =>
			`Locked in: **${choice}**. Waiting on <@${opponentId}>.`,
		// Shown to the player who completes the round, in the same beat as the
		// public reveal.
		pickReceivedFinal: (choice: string): string => `Locked in: **${choice}**. Revealing now.`,
		alreadyPicked: (choice: string): string => `You already threw **${choice}**. No takebacks.`,
		roundClosed: "That round is already over.",

		// ── the public reveal ──
		revealTitle: "🪨 📄 ✂️ The throws are revealed",
		revealLine: (challengerId: string, challengerChoice: string, opponentId: string, opponentChoice: string): string =>
			`<@${challengerId}> threw **${challengerChoice}**\n<@${opponentId}> threw **${opponentChoice}**`,
		winnerLine: (winnerId: string): string => `\n\n👑 <@${winnerId}> takes it.`,
		tieLine: "\n\nSame throw. Nobody takes it. Run it back.",

		// ── the accepted but never thrown timeout ──
		// Distinct from the challenge timeout: the challenge WAS accepted, so the
		// channel watched this round start and deserves to see it end.
		timeoutTitle: "🪨 📄 ✂️ The round expired",
		timeoutOneSided: (readyId: string, stalledId: string): string =>
			`<@${readyId}> threw in time. <@${stalledId}> never did, so the round is void.`,
		timeoutNeither: "Neither player threw in time. The round is void.",
	},

	hangman: {
		subcommandDescription: "Start a hangman round anyone in this channel can play",
		label: "hangman",

		cooldownMessage: (seconds: number): string => `Dero is still setting the gallows. Try again in ${seconds}s.`,
		alreadyRunning: "A round is already running in this channel. Finish that one first.",
		started: "Round posted. Anyone in the channel can guess.",
		startedIn: (channelId: string): string => `Round posted in <#${channelId}>. Anyone there can guess.`,
		noChannel: "Could not find a channel to post the board in. Run /setup first.",

		// ── the public board ──
		boardTitle: "🪢 Hangman",
		guessButtonLabel: "Guess a letter",
		wordLabel: "Word",
		missesLabel: "Misses",
		attemptsLabel: "Attempts left",
		noMisses: "none yet",
		startedBy: (starterId: string): string => `Started by <@${starterId}>. Anyone in this channel can guess.`,

		// ── the modal ──
		modalTitle: "Guess a letter",
		modalInputLabel: "One letter",
		modalPlaceholder: "a",

		// ── per guess feedback, all ephemeral to the guesser ──
		// Only the BOARD is public. Telling the whole channel that someone typed a
		// digit would be noise, and the board already shows every real outcome.
		hit: (letter: string): string => `**${letter.toUpperCase()}** is in the word.`,
		miss: (letter: string, remaining: number): string =>
			`**${letter.toUpperCase()}** is not in the word. ${remaining} attempt${remaining === 1 ? "" : "s"} left.`,
		repeat: (letter: string): string => `**${letter.toUpperCase()}** was already tried. That one is free.`,
		invalid: "One letter, a through z. That one does not count against you.",
		closed: "That round is already over.",

		// ── end states ──
		wonTitle: "🪢 Solved",
		wonDescription: (word: string, solverId: string): string =>
			`The word was **${word.toUpperCase()}**.\n\n👑 <@${solverId}> landed the last letter.`,
		lostTitle: "🪢 Out of attempts",
		lostDescription: (word: string): string => `The word was **${word.toUpperCase()}**. Nobody got there.`,
		expiredTitle: "🪢 Round expired",
		expiredDescription: (word: string): string => `Nobody finished it in time. The word was **${word.toUpperCase()}**.`,
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
