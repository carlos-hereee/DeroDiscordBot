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

	// The titles over a private answer shown as a notice modal (2026-10 item 254
	// Phase 5b). Discord cuts a modal title at 45 characters.
	notices: {
		miniGame: "🎲 Mini game",
		hangman: "🪢 Hangman",
	},

	// ── coin flip and dice roll ──
	// ONE game until 2026-08-12, when "duel" was split in two. It had asked
	// "dice or coin?" as a required option, which meant its name could never
	// describe it and a member had to make a rules decision before they had
	// played once. Two games, no mode question, and each keeps its own /account
	// record so a member can see which they actually play.
	//
	// The shared half stays shared: both go through the same challengeFlow
	// handshake, the same pure resolver, and the same result embed builder.
	// Only the words and the art differ.
	versus: {
		opponentOptionDescription: "The member you want to challenge",
		cooldownMessage: (seconds: number): string => `Dero is still clearing the field. Try again in ${seconds}s.`,
		winnerLine: (winnerId: string): string => `\n\n👑 <@${winnerId}> takes it.`,
		// ⚠️ Only ever reachable from a DICE roll. A single coin cannot tie, which
		// the VersusResult union guarantees at the type level.
		tieLine: "\n\nDead even. Nobody takes it. Run it back.",
	},

	coinFlip: {
		subcommandDescription: "Flip against a member or against Dero. One coin, one winner, no ties",
		label: "a coin flip",
		// ── result embed ──
		// The mentions here never ping: this embed is the payoff, and pinging both
		// players a second time (they were already pinged by the challenge) would
		// be noise. Mentions inside an embed render as names without notifying.
		resultTitle: "🪙 The coin has landed",
		coinLine: (face: string): string => `The coin lands on **${face}**.`,
	},

	diceRoll: {
		subcommandDescription: "Roll a d20 against a member or against Dero. Highest wins, ties are possible",
		label: "a dice roll",
		resultTitle: "🎲 The dice have spoken",
		// The Dero die card (2026-10 item 250 Phase 5): plain words, drawn on the canvas.
		cardRolled: (roll: number): string => `rolled ${roll}`,
		cardVersus: "VS",
		cardWin: "WINS",
		cardTie: "TIE",
		diceLine: (challengerId: string, challengerRoll: number, opponentId: string, opponentRoll: number): string =>
			`<@${challengerId}> rolled **${challengerRoll}**\n<@${opponentId}> rolled **${opponentRoll}**`,
	},

	rps: {
		subcommandDescription: "Play rock paper scissors against a member or against Dero",
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

		// ── the drawn reveal card (rpsRenderer, 2026-10 item 254 Phase 5a) ──
		cardThrew: (choice: string): string => `threw ${choice}`,
		cardVersus: "VS",
		cardWin: "WINS",
		cardTie: "TIE",

		// ── the accepted but never thrown timeout ──
		// Distinct from the challenge timeout: the challenge WAS accepted, so the
		// channel watched this round start and deserves to see it end.
		timeoutTitle: "🪨 📄 ✂️ The round expired",
		timeoutOneSided: (readyId: string, stalledId: string): string =>
			`<@${readyId}> threw in time. <@${stalledId}> never did, so the round is void.`,
		timeoutNeither: "Neither player threw in time. The round is void.",
	},

	// ── solo luck against Dero (the 1.7.0 test fixes, item 14) ──
	// A coin flip, dice roll or rps against Dero himself, played inline with no room.
	// Dero speaks here in his kingdom voice, because he is the opponent and the
	// result line is his to deliver. The XP line states the rule rather than a
	// payout, because the daily cap may already have spent a member's allowance and
	// a "+3 XP" the member never received would be a lie.
	soloLuck: {
		// The option every one of the three subcommands gains. A STRING choice, not a
		// user option: Dero is offered by the bot, never picked from a member list.
		againstOptionDescription: "Challenge a member on the board, or play Dero right here",
		againstMemberLabel: "A member, on the challenge board",
		againstDeroLabel: "Dero, right here and now",
		// In a challenge channel the throw is asked in the room instead (2026-10 item 257 Phase 4b).
		throwOptionDescription: "Your throw against Dero; in a challenge channel you pick it in the room instead",
		throwNeeded: "Pick your throw to face Dero: run it again with the throw option set to rock, paper or scissors.",

		coinTitle: "🪙 Dero flips a royal coin",
		coinLine: (memberId: string, face: string): string =>
			`Heads for <@${memberId}>, tails for Dero. The coin lands on **${face}**.`,
		diceTitle: "🎲 Dice at Dero's table",
		// Dero's side of the dice card (2026-10 item 250 Phase 5).
		deroName: "Dero",
		diceLine: (memberId: string, memberRoll: number, deroRoll: number): string =>
			`<@${memberId}> rolled **${memberRoll}**\nDero rolled **${deroRoll}**`,
		rpsTitle: "🪨 📄 ✂️ A duel of hands with Dero",
		rpsLine: (memberId: string, memberThrow: string, deroThrow: string): string =>
			`<@${memberId}> threw **${memberThrow}**\nDero threw **${deroThrow}**`,

		memberWins: (memberId: string): string => `\n\n👑 <@${memberId}> wins. The kingdom cheers your name.`,
		deroWins: "\n\n🛡️ Dero takes this one. The castle keeps its gold today.",
		tie: "\n\n⚖️ Even ground. Neither crown moves. Try your luck again.",
		xpRule: (winXp: number, otherXp: number, cap: number): string =>
			`A win pays ${winXp} XP and any other result ${otherXp}, inside the ${cap} XP daily limit.`,
	},

	// ── monopoly (2026-10 item 241) ──
	// Only the doorway's line lives here: everything a match shows is in the game
	// rooms pack (gameRoomsCopy.monopoly), because the match itself runs in a room.
	monopoly: {
		subcommandDescription: "Start a Monopoly challenge for 2 to 6 players on the challenge board",
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

		// ── the canvas card (2026-10 item 243 Phase 3) ──
		// Words drawn INTO the card's pixels, so none takes a mention. The word itself
		// is never here: the card draws only the letters already guessed.
		cardAttemptsLeft: (remaining: number): string => `${remaining} ${remaining === 1 ? "ATTEMPT" : "ATTEMPTS"} LEFT`,
		cardSolved: "SOLVED",
		cardLost: "OUT OF ATTEMPTS",
		cardExpired: "ROUND EXPIRED",
	},

	// ── blackjack ──
	// Three surfaces on one table: a solo game against the dealer, a table a host
	// opens for others, and joining a table somebody already opened. They share
	// every string below because they share one engine; only the seating board
	// differs, and a solo game simply never shows it.
	blackjack: {
		// The turn modal (turnPrompt.ts, 2026-10 item 257 Phase 4a): the hand is public at the table.
		turnModalTitle: "🃏 Your hand",
		turnHandText: (hand: string, total: string, dealerUpCard: string): string => [`Your hand: ${hand} (${total})`, dealerUpCard ? `Dealer shows: ${dealerUpCard}` : ""].filter(Boolean).join("\n"),
		subcommandDescription: "Play blackjack against Dero's dealer, alone or at a table",
		label: "blackjack",

		modeOptionDescription: "Play alone right now, or open a table others can join",
		soloChoiceLabel: "Solo, deal me in now",
		tableChoiceLabel: "Table, let others join first",

		cooldownMessage: (seconds: number): string => `The dealer is still shuffling. Try again in ${seconds}s.`,
		alreadyRunning: "A table is already running in this channel. Join that one, or wait for it to finish.",
		noChannel: "Could not find a channel to deal in.",
		outsideGuild: "Blackjack only works inside a server, not in a DM.",

		// ── the seating board, table mode only ──
		seatingTitle: "🃏 A table is open",
		seatingDescription: (hostId: string): string =>
			`<@${hostId}> has opened a table. Take a seat, and the dealer will begin shortly.`,
		seatsLabel: "Seated",
		noSeats: "nobody yet",
		joinLabel: "Take a seat",
		leaveLabel: "Leave",
		dealLabel: "Deal now",
		seatingClosesIn: (seconds: number): string => `Betting closes in ${seconds}s.`,
		joined: "You are seated. Wait for the deal.",
		left: "You have left the table.",
		alreadySeated: "You already have a seat at this table.",
		tableFull: "That table is full. Wait for the next one.",
		notSeated: "You are not seated at this table.",
		hostOnlyDeal: "Only the member who opened the table can deal early.",
		nobodyCame: "Nobody took a seat. The dealer packs up.",

		// ── the table board ──
		tableTitle: "🃏 Blackjack",
		dealerLabel: "Dealer",
		// The dealer's second card stays face down until every seat has acted, which
		// is what makes the whole game a decision rather than arithmetic.
		holeCard: "??",
		turnLine: (userId: string): string => `It is <@${userId}>'s turn.`,
		handLabel: (index: number, total: number): string => (total > 1 ? `Hand ${index + 1} of ${total}` : "Hand"),
		softTotal: (total: number): string => `soft ${total}`,

		hitLabel: "Hit",
		standLabel: "Stand",
		doubleLabel: "Double",
		splitLabel: "Split",
		// Leave during a hand (2026-10 item 254, Arcade 12): the seat gives its hand up as a loss.
		leaveHandLabel: "Leave",
		leftHand: "You left the table. Your hand counts as a loss.",
		leftAlready: "You already left this hand.",
		leftNote: "left the table",
		// The trail line in a room, so the table knows why a seat stopped playing.
		leftTrail: (userId: string): string => `🚪 <@${userId}> left the table mid hand, and the hand counts as a loss.`,

		notYourTurn: "It is not your turn at this table.",
		notPlaying: "You are not playing at this table.",
		illegalAction: "You cannot do that with this hand.",

		// ── results ──
		resultTitle: "🃏 The dealer settles up",
		outcomeBlackjack: "Blackjack",
		outcomeWin: "Win",
		outcomePush: "Push",
		outcomeLose: "Lose",
		bustNote: "bust",
		doubledNote: "doubled",
		// ── the canvas result card (2026-10 item 243 Phase 3) ──
		// The XP is what the HAND paid (gameXp.blackjackHandXp), which is the award
		// this table makes; a solo room's own top up lands when the room closes.
		cardDealer: "DEALER",
		cardHandXp: (xp: number): string => `+${xp} XP`,
		cardDoubled: "DOUBLED",
		cardMoreHands: (count: number): string => `and ${count} more ${count === 1 ? "hand" : "hands"}`,
		// ── the canvas table card, drawn every turn (Dero 1.7.0 test fixes, Phase 3a) ──
		// Where each hand stands while the table plays; a hand dealt a natural reads
		// as outcomeBlackjack, the same word the result card uses.
		cardActing: "To act",
		cardWaiting: "Waiting",
		cardStood: "Stood",
		cardBust: "Bust",
		cardLeft: "Left",
		// Stated on the result card because doubling is the one action whose cost is
		// invisible in the cards themselves.
		doubledLostAll: "A doubled hand that loses pays nothing at all.",
		tableTimedOut: "The table sat idle too long. The dealer clears the felt.",
	},

	// ── the challenge and accept engine copy: RETIRED (game rooms Phase 4) ──
	// This block held the strings for challengeFlow.ts, which ran a whole match
	// inside one slash invocation with an inline collector and, for rps, a
	// module-scoped Map of open rounds. All of it died on every Railway deploy.
	// The challenge board replaced it: a draft GameRoom row is the handshake, and it
	// survives the deploy. Its copy lives in
	// @features/game-rooms/gameRoomsCopy.ts under `board`.
	//
	// ⚠️ `botOpponent`, the refusal shown when somebody picked Dero as an opponent,
	// WENT WITH IT, and its absence is a feature rather than a deletion. The phrase
	// itself is deliberately not quoted anywhere in this repo: the plan's completion
	// criterion for this phase is a grep for it returning nothing, and a comment
	// containing it would defeat that check permanently. It existed because an
	// addUserOption is populated by DISCORD and can return a bot, so the rejection
	// had to happen after the fact, in a string. The board's two ways in are a
	// bot-populated StringSelect (a bot can never be an option) and a Join button (a
	// bot cannot click). There is nothing left to reject, so the string would be
	// answering a question that can no longer be asked. Requirement F9 is now
	// structural. Do not reintroduce it, and do not add a user option to a game.

	// Two strings that lived in that block and were never about challenges. Promoted
	// here when it retired rather than deleted, because both have consumers that have
	// nothing to do with two-player games: `footer` is the spine of EVERY embed this
	// feature builds, and `outsideGuild` is hangman's "not in a DM" refusal.
	footer: "Company Uno • for fun only",
	outsideGuild: "Games only work inside a server, not in a DM.",
	// Refused rather than allowed, because a casual round posted inside a game room
	// would put a SECOND hangman in the channel, drawn from the word bank, with no
	// author and no host bar, racing the room's own board for the scroll.
	hangmanInRoom: "This channel is a game room. Use the buttons on the room's own card to play the round in here.",

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
