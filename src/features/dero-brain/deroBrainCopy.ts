import type { HandCategory } from "@features/games/holdemHand.js";
import type { HoldemTerms } from "@features/games/holdemTable.js";

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

// The bounds a refusal names, passed in by holdemTerms so the numbers live only
// in BOT_CONSTANTS.
export interface TermsBounds {
	minSeats: number;
	maxSeats: number;
	minStack: number;
	maxStack: number;
	minBigBlind: number;
	stackToBigBlind: number;
}

const rulesSentence = (label: string, terms: HoldemTerms, everyHands: number): string =>
	`${label}: up to ${terms.maxSeats} players, ${terms.startingStack} chips each, blinds ${terms.smallBlind} and ${terms.bigBlind}, and the blinds double every ${everyHands} hands.`;

// How a hand's category reads after "wins 300", so speech never says "with pair".
const HAND_PHRASES: Record<HandCategory, string> = {
	"high card": "high card",
	pair: "a pair",
	"two pair": "two pair",
	"three of a kind": "three of a kind",
	straight: "a straight",
	flush: "a flush",
	"full house": "a full house",
	"four of a kind": "four of a kind",
	"straight flush": "a straight flush",
};

// Spoken card names. The board embed shows pips; a voice reading the pip aloud
// would say nothing useful, so speech gets "the ace of spades".
const RANK_WORDS: Record<number, string> = {
	2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine",
	10: "ten", 11: "jack", 12: "queen", 13: "king", 14: "ace",
};
const SUIT_WORDS: Record<string, string> = { s: "spades", h: "hearts", d: "diamonds", c: "clubs" };

/** One winner of a settled hand, as the dealer reads it. */
export interface DealerWinner {
	name: string;
	amount: number;
	category: HandCategory | null;
}

const winnerPhrase = ({ name, amount, category }: DealerWinner): string =>
	category ? `${name} wins ${amount} with ${HAND_PHRASES[category]}.` : `${name} wins ${amount}.`;

export const deroBrainCopy = {
	// Dero's own area title (2026-10 item 263 R3-12), worn by the cooldown notices of /dero
	// tell, /dero join and the Listen button in place of the pack's error title.
	noticeTitle: "🎙️ Dero",

	// ── the /dero command itself ──
	command: {
		description: "Give Dero a task, bring Dero into your voice call, or check whether Dero's brain is online",
		tell: "Give Dero a short task, like posting a message in the Dero commands channel",
		taskOption: "What you want Dero to do, in your own words",
		status: "Show whether Dero's brain is online and whether Dero is in a voice call",
		join: "Bring Dero into your voice channel. Dero listens only to members on its task list",
		leave: "Send Dero out of this server's voice call",
	},

	// ── /dero tell, before and after the brain answers ──
	tell: {
		replyTitle: "🧠 Dero's task",
		notInGuild: "Run this in a server, not a DM.",
		notSetUp: "Dero's tasks are not set up in this server yet.",
		switchedOff: "Dero is switched off in this server right now.",
		notAuthorized: "You are not on the list of members who can give Dero tasks.",
		// Offline is a normal state (2026-10 item 216, risk R9), so the reply says
		// so instead of promising Dero will be right back. Owner decision
		// 2026-10-21: member copy never says where the brain runs.
		brainOffline: "Dero's brain is offline right now. Try again in a little while.",
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
		// open_holdem. The question is also what Dero speaks in a call, so it names
		// the choices in words rather than pointing at buttons by label.
		holdemCard: (rules: string): string =>
			`${rules} Do you want these rules or custom ones, and a public table or an invite only one? Choose on the rules card.`,
		holdemTermsRefused: (refusal: string): string => `${refusal} No table card was made.`,

		// say and leave_voice. "Left" reuses voiceCopy.call.left, the same line
		// /dero leave answers with.
		spoke: "Dero said it in the call.",
		sayNoCall: "Dero is not in a voice call in this server, so nothing was said.",
		sayCapReached: "Dero's voice budget for the month is used up, so nothing was said.",
		sayFailed: "Dero could not find his voice just now, so nothing was said.",
		sayQueueFull: "Dero has too much to say in the call right now, so that line was dropped.",
		leaveNoCall: "Dero is not in a voice call in this server, so there was nothing to leave.",
	},

	// ── the hold em rules card (open_holdem) ──
	holdem: {
		standardRules: (terms: HoldemTerms, everyHands: number): string => rulesSentence("Standard rules", terms, everyHands),
		customRules: (terms: HoldemTerms, everyHands: number): string => rulesSentence("Custom rules", terms, everyHands),
		termsRefused: {
			not_a_whole_number: (_bounds: TermsBounds): string => "Seats, the starting stack and the big blind must each be a whole number.",
			seats_out_of_range: (b: TermsBounds): string => `A table seats ${b.minSeats} to ${b.maxSeats} players.`,
			stack_out_of_range: (b: TermsBounds): string => `The starting stack must be between ${b.minStack} and ${b.maxStack} chips.`,
			big_blind_too_small: (b: TermsBounds): string => `The big blind must be at least ${b.minBigBlind}.`,
			big_blind_too_large: (b: TermsBounds): string =>
				`The big blind can be at most ${b.stackToBigBlind === 10 ? "a tenth" : `1 in ${b.stackToBigBlind}`} of the starting stack. Name a smaller big blind or a bigger stack.`,
		},

		cardTitle: "🃏 A Texas Hold'em table",
		chipsLine: "Chips exist only for this table and vanish when it ends.",
		pickLine:
			"Open a public table anyone can join, or pick who to invite below and open an invite only table. Change rules sets your own seats, stack and big blind.",
		invited: (userIds: string[]): string => `Invited: ${userIds.map((id) => `<@${id}>`).join(", ")}`,
		nobodyInvited: "Nobody is invited yet. An invite only table needs at least one member picked below.",
		expires: (unixSeconds: number): string => `This card expires <t:${unixSeconds}:R>.`,
		// The one deliberate mention on a card posted in a call's text channel.
		forSpeaker: (userId: string): string => `<@${userId}>, here are the table rules you asked for.`,

		openPublicLabel: "Open public table",
		openInviteLabel: "Open invite only table",
		changeRulesLabel: "Change rules",
		cancelLabel: "Cancel",
		pickerPlaceholder: "Pick who to invite",

		modalTitle: "Your table rules",
		seatsLabel: (min: number, max: number): string => `Seats (${min} to ${max})`,
		stackLabel: (min: number, max: number): string => `Starting stack (${min} to ${max})`,
		bigBlindLabel: (min: number): string => `Big blind (${min} up to a tenth of the stack)`,

		expired: "This table request has expired. Ask Dero again for a new one.",
		notYours: "Only the member who asked for this table can use this card.",
		notAuthorized: "You can no longer give Dero tasks, so no table was opened.",
		switchedOff: "Dero is switched off in this server right now, so no table was opened.",
		pickInviteesFirst: "Pick at least one member to invite first, or open a public table.",
		opened: (channelId: string): string => `The table is open in <#${channelId}>. Buy in there to take a seat, and Dero will deal.`,
		openedSpoken: (channelName: string): string => `The table is open in ${channelName}. Buy in there to take a seat, and I will deal.`,
		cancelled: "Table request cancelled. Nothing was opened.",
		openFailed: (reason: string): string => `${reason} No table was opened.`,
	},

	// ── the dealer's narration (dealerNarration) ──
	// `name` is a mention in text and a display name in speech; the text lines go
	// out with every ping off, so a mention only renders the name.
	dealer: {
		handStart: (hand: number, small: number, big: number, buttonName: string): string =>
			`Hand ${hand}. Blinds are ${small} and ${big}. ${buttonName} has the button.`,
		handStartBlindsUp: (hand: number, small: number, big: number, buttonName: string): string =>
			`Hand ${hand}. The blinds are up to ${small} and ${big}. ${buttonName} has the button.`,
		flop: (cards: string): string => `The flop: ${cards}.`,
		turn: (card: string): string => `The turn: ${card}.`,
		river: (card: string): string => `The river: ${card}.`,
		// Dero calling the action just taken, like a commentator (owner decision of 2026-10-29).
		// Spoken only; `amount` is the bet or raise total, or what an all in put in.
		actionCalls: {
			fold: [(name: string): string => `${name} folds.`, (name: string): string => `${name} lays the cards down. Folded.`, (name: string): string => `${name} wants no part of this one. Fold.`],
			check: [(name: string): string => `${name} checks.`, (name: string): string => `A quiet tap from ${name}. Check.`, (name: string): string => `${name} checks it along.`],
			call: [(name: string): string => `${name} calls.`, (name: string): string => `${name} is not going anywhere. Call.`, (name: string): string => `${name} matches the bet.`],
			bet: [(name: string, amount: number): string => `${name} bets ${amount}.`, (name: string, amount: number): string => `${name} leads out for ${amount}.`, (name: string, amount: number): string => `${amount} from ${name}. Who wants it?`],
			raise: [(name: string, amount: number): string => `${name} raises to ${amount}.`, (name: string, amount: number): string => `${name} turns up the heat. ${amount}.`, (name: string, amount: number): string => `A raise! ${name} makes it ${amount}.`],
			allIn: [(name: string): string => `${name} is all in!`, (name: string): string => `${name} pushes every chip forward. All in!`, (name: string): string => `All in from ${name}! This is the moment.`],
		} as Record<"fold" | "check" | "call" | "bet" | "raise" | "allIn", readonly ((name: string, amount: number) => string)[]>,
		// Battleship, called shot by shot (owner decision of 2026-10-29). `at` is the square, like "B7".
		battleshipCalls: {
			miss: [(name: string, at: string): string => `${name} fires at ${at}. Splash. A miss.`, (name: string, at: string): string => `${at}, says ${name}. Nothing but sea.`, (name: string, at: string): string => `${name} aims for ${at}. Missed!`],
			hit: [(name: string, at: string): string => `${name} fires at ${at}. Hit!`, (name: string, at: string): string => `Direct hit on ${at} from ${name}!`, (name: string, at: string): string => `${at}! ${name} finds steel.`],
			sunk: [(name: string, at: string, ship: string): string => `${name} hits ${at} and sinks the ${ship}!`, (name: string, _at: string, ship: string): string => `The ${ship} goes down! Well aimed, ${name}.`, (name: string, _at: string, ship: string): string => `Down goes the ${ship}. ${name} is hunting.`],
		},
		// Blackjack, the end of every hand (owner decision of 2026-10-29).
		blackjackCalls: {
			dealerBust: [(total: number): string => `The dealer busts with ${total}!`, (total: number): string => `${total} for the house. Bust!`],
			dealerStands: [(total: number): string => `The dealer stands on ${total}.`, (total: number): string => `House shows ${total}.`],
			blackjack: [(name: string): string => `Blackjack for ${name}!`, (name: string): string => `${name} hits a natural twenty one!`],
			win: [(name: string): string => `${name} wins the hand.`, (name: string): string => `${name} beats the house.`, (name: string): string => `A win for ${name}.`],
			push: [(name: string): string => `${name} pushes. Money back.`, (name: string): string => `A tie for ${name}. Push.`],
			lose: [(name: string): string => `${name} loses this one.`, (name: string): string => `The house takes ${name}'s bet.`, (name: string): string => `Not this time, ${name}.`],
		},
		// The opener Dero says before a finished match's result line (owner decision of 2026-10-29).
		// Said once the countdown opens the room (owner decision of 2026-10-29).
		matchStart: ["The match begins now!", "Let the games begin!", "Here we go. The match is on!", "Gates are open. Play!"],
		gameOver: ["Game over!", "And that's the match!", "The battle is done!", "That's it, the dust settles."],
		// Variants (pickLine), so a long table does not hear the same words every turn.
		toAct: [
			(name: string): string => `${name}, it is your turn.`,
			(name: string): string => `${name}, the table waits on you.`,
			(name: string): string => `Your move, ${name}.`,
			(name: string): string => `${name}, show us what you are made of.`,
			(name: string): string => `All eyes on ${name}.`,
		],
		result: (winners: DealerWinner[]): string => winners.map(winnerPhrase).join(" "),
		tournamentWon: (name: string): string => `${name} wins the tournament.`,
		// ── Dero calls the room to order (2026-10 item 267, decisions 13 to 15) ──
		// Spoken only, into the card's or the room's call: a member joining or asking to join a
		// card, the Start countdown, and the warning before a timed turn ends and its end. Each is
		// a list of variants Dero picks from (pickLine); the first is the plain one.
		challengers: [
			"New challengers at the door.",
			"Fresh blood at the gate. Make room at the table.",
			"Another brave soul answers the call.",
			"The table grows. Someone thinks they can win.",
			"I hear footsteps. A new challenger approaches.",
		],
		challengersAsking: [
			"New challengers at the door. Host, check Requests to let them in.",
			"Someone knocks at the gate. Host, check Requests.",
			"A challenger waits outside the walls. Host, open Requests and decide their fate.",
		],
		countdown: [
			(seconds: number): string => `The match starts in ${seconds} seconds.`,
			(seconds: number): string => `${seconds} seconds. Sharpen your blades.`,
			(seconds: number): string => `Take your seats. We begin in ${seconds} seconds.`,
			(seconds: number): string => `${seconds} seconds until the gates open. May the best one win.`,
		],
		turnWarning: [
			(name: string, seconds: number): string => `${name}, ${seconds} seconds left on your turn.`,
			(name: string, seconds: number): string => `${name}, the hourglass is nearly empty. ${seconds} seconds.`,
			(name: string, seconds: number): string => `Clock is ticking, ${name}. ${seconds} seconds left.`,
			(name: string, seconds: number): string => `${name}, ${seconds} seconds. Decide, or the clock decides for you.`,
		],
		turnOver: [
			(name: string): string => `${name}, your turn is over.`,
			(name: string): string => `Time is up, ${name}. The table moves on.`,
			(name: string): string => `${name} ran out the clock. Next.`,
			(name: string): string => `The sand has run out for ${name}.`,
		],
		// Said in place of a member whose server name cannot be read.
		unknownPlayer: "a player",
		spokenCard: (rank: number, suit: string): string => `the ${RANK_WORDS[rank] ?? String(rank)} of ${SUIT_WORDS[suit] ?? suit}`,
		// "the two of clubs, the ten of hearts and the ace of spades"
		spokenCards: (names: string[]): string =>
			names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`,
		// ── the showdown card (2026-10 item 243 Phase 3) ──
		// Drawn into pixels, so names arrive as display names. A winner's line on the
		// card is `result` above for that one winner, so card and text never disagree.
		cardHand: (hand: number): string => `HAND ${hand}`,
		cardPot: (pot: number): string => `POT ${pot.toLocaleString()}`,
		cardStack: (chips: number): string => `${chips.toLocaleString()} chips`,
		cardFolded: "Folded",
		cardAllIn: "All in",
		cardOut: "Out",
		cardButton: "Button",
		cardInHand: "In the hand",
	},

	// ── /dero status ──
	status: {
		title: "🧠 Dero's brain",
		online: "Dero's brain is **online**.",
		offline: "Dero's brain is **offline** right now, so Dero cannot take tasks until it is back.",
		canTell: "You can give Dero tasks with /dero tell.",
		switchedOffForYou: "You are on the task list, but Dero is switched off in this server right now.",
	},
};
