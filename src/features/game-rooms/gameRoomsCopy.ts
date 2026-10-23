import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { STARTING_CHIPS } from "@features/games/monopolyBoard.js";
import type { BuildingKind } from "@features/games/monopolyState.js";
import type { GameSlug, RoomVisibility } from "./roomTypes.js";
import type { HangmanCategory } from "@features/games/hangmanWords.js";

// ── game rooms user-facing copy ──────────────────────────────────────
// Feature-local copy module, the exact sibling of gamesCopy.ts and fortuneCopy.ts,
// including their reasoning: a game room is a bot feature rather than a platform
// plugin, and "the room is locked" reads identically in the kingdom voice and the
// streamer voice, so a two-pack split here would double the authoring for content
// that would come out the same twice. If game rooms ever graduate into a real
// plugin this file moves into the pack + copyOverrides system wholesale.
//
// House rule for every string below: no dashes in user-facing copy.

// The Monopoly idle budget in whole hours, derived from the one constant the sweep
// reads, so the opener's promise and the forfeit line can never name a different
// number from the clock that enforces it.
const monopolyIdleHours = (): number => Math.round(BOT_CONSTANTS.GAME_ROOM_MONOPOLY_IDLE_MS / (60 * 60 * 1000));
const monopolyAuctionSeconds = (): number => Math.round(BOT_CONSTANTS.MONOPOLY_AUCTION_ROUND_MS / 1000);
// Discord's relative timestamp ("in 45 seconds"), which every reader sees in their
// own clock and which ticks down on its own.
const discordRelativeTime = (epochMs: number): string => `<t:${Math.floor(epochMs / 1000)}:R>`;

// Human labels for the slugs. Kept here rather than derived from the slug because
// "coinflip" is not a phrase anyone writes, and a room's cards are read by members
// who never see the slug.
const GAME_LABELS: Record<GameSlug, string> = {
	hangman: "Hangman",
	coinflip: "Coin flip",
	diceroll: "Dice roll",
	rps: "Rock paper scissors",
	battleship: "Battleship",
	holdem: "Texas hold em",
	monopoly: "Monopoly",
	"solo-hangman": "Hangman (solo)",
	"solo-blackjack": "Blackjack (solo)",
};

// Human names for the server's tier keys, used only in quota copy. The keys are the
// SERVER's vocabulary (nexious-server resolves the tier; the bot never stores one),
// so an unknown key renders as itself rather than crashing a refusal message.
const TIER_NAMES: Record<string, string> = {
	unsubscribed: "free",
	free: "Starter",
	pro: "Creator Pro",
	business: "Creator Studio",
};

export const gameRoomsCopy = {
	gameLabel: (game: GameSlug): string => GAME_LABELS[game] ?? game,
	tierName: (tierKey: string): string => TIER_NAMES[tierKey] ?? tierKey,

	// ── the opener card, pinned inside the room ──
	opener: {
		title: (game: GameSlug): string => `${GAME_LABELS[game] ?? game} room`,
		// Rendered once, at open. The visibility line matters because it is the only
		// place a player is told who else can read what they type.
		//
		// ⚠️ THE INVITE LINE IS HONEST ONLY WITH ITS CAVEAT. A discord.gg URL is a GUILD
		// invite: it lets a stranger join the SERVER, and it does not touch the room's
		// permission overwrites. A public room's @everyone allow already covers the
		// newcomer; an invite-only room stays hidden from them even after they join
		// through the link, so the caveat sentence is what keeps the link from reading
		// as broken. Rendered as an inline URL rather than a button on purpose: a link
		// component is not tap-to-copy on mobile the way an inline URL is.
		description: (hostId: string, playerIds: string[], visibility: RoomVisibility, inviteCode?: string | null): string => {
			const roster = playerIds.map((id) => `<@${id}>`).join(" versus ");
			const audience =
				visibility === "public"
					? "Anyone in the server can watch this room. Only the players can type."
					: visibility === "solo"
					  ? "This is a solo room. Only you and the admins can see it."
					  : "This room is invite only. Only the players and the members they invited can see it.";
			const lines = [`Host: <@${hostId}>`, "", roster, "", audience];
			if (inviteCode) {
				if (visibility === "invite") lines.push("", "Invite only rooms are hidden from members who were not invited.");
				lines.push("", `Invite link: https://discord.gg/${inviteCode}`);
			}
			return lines.join("\n");
		},
	},

	// ── the result card, posted at finish ──
	result: {
		title: "The match is over",
		winnerLine: (winnerId: string): string => `👑 <@${winnerId}> takes it.`,
		// Every game that can end without a winner routes here: a drawn round, a
		// forfeit by the only remaining player, an abandoned room reaped at boot.
		noWinnerLine: "Nobody takes it.",
		abandonedLine: "This room was abandoned, so Dero closed it.",
		// The room stays readable for a while precisely so the players can scroll it
		// back, and saying the window out loud is what stops "where did my game go".
		archiveNotice: (): string => {
			const hours = Math.round(BOT_CONSTANTS.GAME_ROOM_ARCHIVE_DELAY_MS / (60 * 60 * 1000));
			return `This room is now read only. It disappears in ${hours} hours, or right now if the host presses Archive now.`;
		},
		archiveButtonLabel: "Archive now",
		rematchButtonLabel: "Rematch",
		// Replaces the archive notice on the finished room's result card once a rematch
		// takes the channel over: the room no longer disappears, and the line answers
		// "who started this" for everyone scrolling back.
		rematchStarted: (presserId: string): string => `🔁 <@${presserId}> started a rematch. The next match is below.`,
	},

	// ── ephemeral replies from the provisioner ──
	errors: {
		// F11. Carries a jump link, so the reply answers "where is it" rather than
		// only "no".
		alreadyHosting: (channelId: string | null): string =>
			channelId
				? `You already have a room open. Finish it first: <#${channelId}>`
				: "You already have a room open. Finish it before starting another.",
		// The honest version of a full arena. A silent no-op here would read as the
		// button being broken.
		guildFull: (): string =>
			`This server already has ${BOT_CONSTANTS.GAME_ROOM_MAX_PER_GUILD} rooms open. Wait for one to finish and try again.`,
		// The tier-gated private ceiling. Names the number, the plan, and all three
		// ways out, because "no" alone reads as the button being broken.
		privateQuotaHit: (quota: number, tierName: string): string =>
			`This server has reached its private room limit (${quota}) for the ${tierName} plan. Wait for one to finish, upgrade the plan, or start a public room.`,
		// 50013. Names the missing permission, because the member who clicked cannot
		// fix it and the admin who can needs to know what to grant.
		missingPermissions: "Dero cannot create a channel in the arcade category. An admin needs to grant Manage Channels.",
		// A button from an older message whose action no longer exists. Discord keeps
		// every component clickable forever, so this is a normal thing for a member to
		// hit rather than an error, and the copy says so without apologising.
		controlRetired: "This control is no longer available.",
		// Anything else. Deliberately does not promise a retry loop; there is none.
		createFailed: "Something went wrong opening that room. Try again in a moment.",
		noArcadeCategory: "This server has no arcade category yet. An admin can run /setup to build it.",
		notFound: "That room no longer exists.",
		notYours: "Only the host or an admin can do that.",
		// One rematch per finished room, ever. Without this the still clickable button
		// on a scrolled back result card would spawn a room per press.
		rematchAlreadyOffered: "Someone already started a rematch from this room.",
	},

	// ── the challenge board (Phase 4) ──
	board: {
		introTitle: "⚔️ The challenge board",
		introDescription: [
			"Pick a game to start a challenge. Dero posts a card here, you choose who can see it, and the match plays out in its own channel.",
			"",
			"**Invite only** hides the room from everyone but the people you pick.",
			"**Open to all** lets anyone in the server press Join, and you choose who plays.",
			"",
			"You can hold one challenge at a time. Finish it and the next one is yours.",
		].join("\n"),
		startButtonLabel: (game: GameSlug): string => GAME_LABELS[game] ?? game,

		// ── the opener card, which is edited in place as the draft progresses ──
		cardTitle: (game: GameSlug): string => `${GAME_LABELS[game] ?? game} challenge`,
		cardWaitingVisibility: (hostId: string): string =>
			`<@${hostId}> is starting a challenge. They are choosing who can see it.`,
		cardInviteOnly: (hostId: string): string => `<@${hostId}> is picking who to invite.`,
		cardOpenToAll: (hostId: string): string =>
			`<@${hostId}> is looking for an opponent. Press Join to put your name in.`,
		// The pool line. It names the cap out loud when it truncates, because a silent
		// cut reads as "that is everyone" and the host would pick from a list that
		// quietly lost people.
		cardPool: (ids: string[], shown: number): string => {
			if (ids.length === 0) return "Nobody has joined yet.";
			const names = ids.slice(0, shown).map((id) => `<@${id}>`).join(", ");
			const hidden = ids.length - shown;
			return hidden > 0 ? `Joined (${ids.length}): ${names} and ${hidden} more` : `Joined (${ids.length}): ${names}`;
		},
		cardCancelled: (hostId: string): string => `<@${hostId}> called off the challenge.`,
		cardStarted: (channelId: string): string => `The match is under way in <#${channelId}>.`,
		// Words drawn into the challenge card's picture (2026-10 item 243 Phase 4).
		// A picture cannot carry a mention, so it names nobody by id; the embed
		// text above it still does.
		cardImage: {
			kicker: (game: GameSlug): string => `${(GAME_LABELS[game] ?? game).toUpperCase()} CHALLENGE`,
			versus: "VS",
			waiting: "Waiting for challengers",
			more: (count: number): string => `+${count} more`,
			status: {
				choosing: "SETTING UP",
				invite: "INVITE ONLY",
				open: "OPEN TO ALL",
				started: "UNDER WAY",
				cancelled: "CALLED OFF",
			},
		},

		// The quota status line a host sees when choosing a private form, so the
		// ceiling is visible BEFORE the refusal would be. Rendered only while the
		// tier surface is enforcing (a finite quota).
		privateQuotaStatus: (open: number, quota: number, tierName: string): string =>
			`Your server has ${open}/${quota} private rooms open on the ${tierName} plan.`,

		visibilityInviteLabel: "Invite only",
		visibilityOpenLabel: "Open to all",
		joinLabel: "Join",
		startLabel: "Start the match",
		cancelLabel: "Call it off",

		// ── Monopoly's auction choice (2026-10 item 241) ──
		// The card line says what the setting MEANS, since "auctions" alone does not
		// tell a host what happens to a lot nobody buys.
		cardMonopolyAuctions: (enabled: boolean): string =>
			enabled
				? `Auctions are **on**: a lot a player passes on goes to a ${monopolyAuctionSeconds()} second sealed bid.`
				: "Auctions are **off**: a lot a player passes on stays with the bank.",
		// The toggle names the state it SWITCHES TO, so the press does what it says.
		monopolyAuctionsToggleLabel: (enabled: boolean): string => (enabled ? "Turn auctions off" : "Turn auctions on"),

		// ── Monopoly's voice referee (2026-10 item 241, Session 5c) ──
		// Dero only speaks into a call somebody started, so the "on" line says how one
		// starts; /dero join is gated to the members the server lets call Dero.
		cardMonopolyReferee: (enabled: boolean): string =>
			enabled
				? "Voice referee is **on**: Dero calls the key moments out loud while it is in a voice call with a player. Someone allowed to call Dero starts one with `/dero join`."
				: "Voice referee is **off**: the match plays in text only.",
		monopolyRefereeToggleLabel: (enabled: boolean): string => (enabled ? "Turn referee off" : "Turn referee on"),

		// ── the invite picker ──
		pickerPlaceholder: "Choose who to invite",
		pickerPrompt: [
			"Pick the members you want in this room. The first one you choose plays; anyone else can watch.",
			"",
			"Only real members appear here. Dero does not play games.",
		].join("\n"),
		pickerEmpty: "There is nobody else in this server to invite yet.",
		pickerSaved: (count: number): string =>
			count === 1 ? "Invited 1 member. Press Start the match when you are ready." : `Invited ${count} members. Press Start the match when you are ready.`,

		// ── the acceptance step ──
		chooseOpponentPlaceholder: "Choose who plays",
		chooseOpponentPrompt: "More than one member joined. Pick who plays; the rest can watch.",

		// ── refusals ──
		notYourChallenge: "This is somebody else's challenge.",
		alreadyJoined: "You already joined this one.",
		hostCannotJoin: "You are the host. You are already in.",
		poolEmpty: "Nobody has joined yet, so there is nobody to play against.",
		poolFull: (max: number): string => `This challenge already has ${max} members. Start it or call it off.`,
		needVisibility: "Choose who can see the room first.",
		draftGone: "That challenge is no longer open.",
	},

	// ── the games, played inside a room (Phase 4) ──
	games: {
		coinLine: (face: string): string => `The coin lands on **${face}**.`,
		// The double-press correction. Posted when a flip line landed AFTER another press had
		// already decided the match, so the channel and the transcript both say which of the
		// two lines is the real outcome instead of leaving two contradictory results standing.
		flipSuperseded: "That one landed after the match was already decided. The earlier result stands.",
		diceLine: (challengerId: string, challengerRoll: number, opponentId: string, opponentRoll: number): string =>
			`<@${challengerId}> rolled **${challengerRoll}**. <@${opponentId}> rolled **${opponentRoll}**.`,

		rpsPlaceholder: "Rock, paper or scissors",
		rpsPrompt: "Pick in secret. Nobody sees it until you have both chosen.",
		rpsLabel: (choice: string): string => choice.charAt(0).toUpperCase() + choice.slice(1),
		rpsLocked: (choice: string): string => `Locked in: **${choice}**. Waiting on the other player.`,
		rpsAlreadyPicked: "You already made your pick.",
		// ⚠️ NAMES THE PLAYER, NEVER THE CHOICE. This one is PUBLIC, and it exists so
		// the other player knows to go. Adding the throw here would leak it to every
		// spectator one message before the reveal.
		rpsLockedPublic: (actorId: string): string => `<@${actorId}> has locked in their pick.`,
		rpsReveal: (challengerId: string, challengerPick: string, opponentId: string, opponentPick: string): string =>
			`<@${challengerId}> threw **${challengerPick}**. <@${opponentId}> threw **${opponentPick}**.`,
	},

	// ── hangman in a room (Phase 5) ──
	hangman: {
		authorButtonLabel: "Set the word",
		guessButtonLabel: "Guess a letter",

		// The solo form's opener: the word and its hint come from the bundled bank (no
		// author), so the line says so instead of pointing at a host who is the guesser.
		soloOpener: (hint: string): string =>
			["Dero picked a word from the word bank.", "", `**Hint:** ${hint}`, "", "Guess a letter."].join("\n"),

		// ── letting Dero pick (the 1.7.0 test fixes, item 12) ──
		// The select beside the host's authoring button. A word Dero draws has no
		// author, so the host never saw it and guesses with everyone else.
		categoryPlaceholder: "Or let Dero pick a word from a category",
		categoryLabels: {
			animals: "Animals",
			food: "Food",
			places: "Places",
			objects: "Objects",
			nature: "Nature",
			jobs: "Jobs",
			sports: "Sports",
			music: "Music",
			space: "Space",
			realm: "Dero's realm",
		} satisfies Record<HangmanCategory, string>,
		// Ephemeral to the host. Names the shelf, never the word (risk R12).
		categoryPicked: (categoryLabel: string): string =>
			`Dero drew a word from ${categoryLabel}. You have not seen it either, so you guess too.`,
		categoryOpener: (hostId: string, categoryLabel: string, hint: string): string =>
			[
				`<@${hostId}> asked Dero for a word from **${categoryLabel}**.`,
				"",
				`**Hint:** ${hint}`,
				"",
				"Everyone guesses, the host included.",
			].join("\n"),
		// A pick that arrives after a word already exists, from a second click or a
		// host who authored one in the modal first.
		wordAlreadySet: "This round already has its word.",

		modalTitle: "Set the word",
		wordLabel: "The word",
		wordPlaceholder: "4 to 12 letters, a to z only",
		hintLabel: "A hint (required)",
		hintPlaceholder: "Something true that does not give it away",
		extraHintsLabel: "Extra hints, one per line (optional)",
		extraHintsPlaceholder: "Earned after 2, 4 and 5 wrong guesses",

		// ⚠️ ECHOES THE HINT, NEVER THE WORD (risk R12). The host already knows the
		// word; repeating it buys nothing and puts it one mis-click from a channel.
		authored: (hint: string, extraCount: number): string =>
			extraCount > 0
				? `The word is set. Your hint: "${hint}" (plus ${extraCount} more to be earned).`
				: `The word is set. Your hint: "${hint}"`,

		waitingForWord: (hostId: string): string => `<@${hostId}> is choosing a word.`,
		// The bar, said out loud on the card rather than only enforced. A host who
		// finds out by being refused reads it as a bug.
		hostCannotGuess: "You set the word, so you do not get to guess it.",
		opener: (hostId: string, hint: string): string =>
			[`<@${hostId}> set the word.`, "", `**Hint:** ${hint}`, "", "Everyone else: guess a letter."].join("\n"),
		// The line under the title on each gallows card. A solo round has no author,
		// because Dero drew its word from the bank.
		boardDescription: (authorId: string | null): string =>
			authorId
				? `<@${authorId}> set the word. Everyone else guesses with the button on the pinned opener.`
				: "Dero picked this word from the word bank.",

		guessModalTitle: "Guess a letter",
		guessLabel: "One letter",

		// ── the move trail ──
		// Each of these is its own message. The scroll IS the game's history, which
		// is the whole reason a room exists rather than one edited board.
		hit: (actorId: string, letter: string, mask: string, remaining: number): string =>
			`✅ <@${actorId}> played **${letter.toUpperCase()}**\n\`${mask}\`\nMisses left: ${remaining}`,
		miss: (actorId: string, letter: string, mask: string, misses: string[], remaining: number): string =>
			[
				`❌ <@${actorId}> played **${letter.toUpperCase()}**`,
				`\`${mask}\``,
				misses.length ? `Tried and failed: ${misses.map((m) => m.toUpperCase()).join(" ")}` : "",
				`Misses left: ${remaining}`,
			]
				.filter(Boolean)
				.join("\n"),
		hintRevealed: (hint: string): string => `💡 The room has earned a hint: **${hint}**`,
		repeat: (letter: string): string => `**${letter.toUpperCase()}** has already been played.`,
		invalid: "That is not a single letter from A to Z.",
		closed: "This round is already over.",

		// The ONLY place the word is ever rendered.
		wonLine: (word: string): string => `🎉 The room got it. The word was **${word.toUpperCase()}**.`,
		lostLine: (word: string): string => `💀 The gallows wins. The word was **${word.toUpperCase()}**.`,
	},

	// ── battleship in a room (Phase 7) ──
	battleship: {
		boardTitle: "🚢 The fleets",
		ownBoardTitle: "🗺️ Your own waters",
		turnLine: (userId: string): string => `It is <@${userId}>'s turn to fire.`,
		finished: (winnerId: string | null): string =>
			winnerId ? `👑 <@${winnerId}> has sunk the fleet.` : "The match is over.",
		fleetLine: (afloat: string[]): string =>
			afloat.length ? `Still afloat: ${afloat.join(", ")}` : "Every ship you had is on the bottom.",

		columnPlaceholder: "Column (A to J)",
		rowPlaceholder: "Row (1 to 10)",
		fireLabel: "Fire",
		viewLabel: "View my board",
		forfeitLabel: "Surrender",
		rerollLabel: "Reroll my fleet",

		aimed: (coord: string): string => `Target set: **${coord}**. Press Fire when you are ready.`,
		aimedPartial: "Target set. Pick the other half of the coordinate, then Fire.",
		noTarget: "Pick a column and a row first.",
		notYourTurn: "It is not your turn.",
		offGrid: "That is not on the grid.",
		matchOver: "This match is already over.",
		alreadyFired: (coord: string): string => `You have already fired on **${coord}**.`,
		rerolled: "Your fleet has been laid out again. Only you can see where.",

		// The idle clock's two outcomes. Both are public, because the other player
		// needs to know why the board moved without them firing.
		forfeitedTurn: (userId: string): string => `⏳ <@${userId}> took too long. Their turn passes.`,
		forfeitedMatch: (userId: string): string =>
			`⏳ <@${userId}> missed two turns in a row and forfeits the match.`,
		rerollTooLate: "The first shot has been fired. The fleets are where they are.",

		// The public narration. None of these names an UNFIRED position, which is the
		// property the whole feature turns on.
		miss: (shooterId: string, coord: string): string => `🌊 <@${shooterId}> fired on **${coord}**. Miss.`,
		hit: (shooterId: string, coord: string): string => `💥 <@${shooterId}> fired on **${coord}**. Hit.`,
		sank: (shooterId: string, coord: string, ship: string): string =>
			`🔥 <@${shooterId}> fired on **${coord}** and sank the **${ship}**.`,

		// ── the canvas cards (2026-10 item 243 Phase 3) ──
		// Drawn into pixels, so names arrive as display names, never mentions. The
		// private card reuses fleetLine above, which already names nobody.
		cardFiringOn: (shooter: string, target: string): string => `${shooter} firing on ${target}`,
		cardShipsLeft: (count: number): string => `${count} ${count === 1 ? "ship" : "ships"} left`,
		cardTurn: (name: string): string => `${name} to fire`,
		cardWinner: (name: string): string => `${name} sank the fleet`,
		cardOver: "The match is over",
		cardSank: (shooter: string, ship: string): string => `${shooter} sank the ${ship.toUpperCase()}`,
		cardOwnTitle: "YOUR OWN WATERS",
	},

	// ── hold em in a room (Phase 8) ──
	holdem: {
		tableTitle: "🃏 The table",
		boardLabel: "Board:",
		potLabel: "Pot:",
		noBoardYet: "*nothing dealt yet*",

		joiningLine: (seated: number): string =>
			`Buy in to take a seat. ${seated} seated so far. Chips are for this table only and vanish when it ends.`,
		// The joining line for a table opened with host defined terms (Dero's rules card).
		joiningTermsLine: (terms: { seated: number; seatCap: number; stack: number; smallBlind: number; bigBlind: number }): string =>
			`Buy in to take a seat. ${terms.seated} of ${terms.seatCap} seated so far. Everyone starts with ${terms.stack} chips, blinds start at ${terms.smallBlind} and ${terms.bigBlind}. Chips are for this table only and vanish when it ends.`,
		handLine: (hand: number, small: number, big: number): string => `Hand ${hand} · blinds ${small}/${big}`,
		finishedLine: (winnerId: string | null): string =>
			winnerId ? `👑 <@${winnerId}> takes the tournament.` : "The tournament is over.",

		allInTag: "all in",
		foldedTag: "folded",
		bustedTag: "out",

		buyInLabel: (stack: number): string => `Buy in (${stack})`,
		startLabel: "Deal",
		// The same control between hands, worded so the host can tell the first deal
		// from the ones after it.
		nextHandLabel: "Deal the next hand",
		foldLabel: "Fold",
		checkLabel: "Check",
		callLabel: "Call",
		raiseLabel: "Raise",
		allInLabel: "All in",
		halfPotLabel: (amount: number): string => `Half pot (${amount})`,
		potLabelButton: (amount: number): string => `Pot (${amount})`,
		showCardsLabel: "Show my cards",
		leaveLabel: "Leave table",
		endLabel: "End table",

		yourCardsTitle: "🂠 Your hand",
		noCardsYet: "You have no cards. Wait for the next deal.",
		yourStack: (stack: number): string => `Your stack: **${stack}**`,

		// ── refusals ──
		notSeated: "You are not in this tournament.",
		alreadySeated: "You already have a seat.",
		tableFull: "Every seat is taken.",
		alreadyStarted: "This tournament has already started.",
		needMorePlayers: "You need at least two players to deal.",
		notYourTurn: "It is not your turn.",
		tournamentOver: "This tournament is over.",
		// Distinct from notYourTurn on purpose. Telling the player whose turn it IS
		// that it is not their turn is what the raise refusal used to do, and it reads
		// as the bot losing track of the table rather than as a rejected action.
		illegalMove: "That is not a legal action right now.",
		handInProgress: "A hand is already running. Finish it before dealing again.",
		// Somebody else's write landed first. Ordinary, so the copy is not an apology.
		tableBusy: "The table just changed. Try that again.",

		// ── the trail ──
		seatTaken: (userId: string, seated: number): string => `🪙 <@${userId}> bought in. ${seated} at the table.`,
		handDealt: (hand: number, small: number, big: number): string =>
			`🃏 **Hand ${hand}** is dealt. Blinds are ${small}/${big}.`,
		blindsUp: (small: number, big: number): string => `⏫ Blinds are up: ${small}/${big}.`,
		streetDealt: (street: string, cards: string): string => `**${street}:** ${cards}`,
		handWon: (userId: string, amount: number): string => `<@${userId}> takes ${amount}.`,
		// NOT a win, and worded so nobody reads it as one. These are chips the player
		// bet that nobody ever matched, so they were never at risk.
		uncalledReturned: (userId: string, amount: number): string =>
			`↩️ ${amount} goes back to <@${userId}>, uncalled.`,
		showdownLine: (userId: string, hand: string): string => `<@${userId}> shows ${hand}.`,
		busted: (userId: string): string => `💀 <@${userId}> is out.`,
		// ⚠️ FORCE FOLD, NEVER PAUSE. Said out loud so the table knows why a player's
		// turn passed without them doing anything.
		timedOut: (userId: string, action: string): string => `⏳ <@${userId}> ran out of time and ${action}.`,
		// One line per leave, whether or not it folded a hand. A leave that ends the
		// hand or the tournament still posts that hand's usual lines after this one.
		leftTable: (userId: string, foldedHand: boolean): string =>
			foldedHand ? `🚪 <@${userId}> folded and left the table.` : `🚪 <@${userId}> left the table.`,
		// The host's End table line. `standings` is best first; a stack of null marks a
		// seat that was already out. Before the first deal there is nothing to rank.
		tableEnded: (hostId: string, standings: { userId: string; stack: number | null }[], anyHandDealt: boolean): string =>
			anyHandDealt
				? [
						`🏁 <@${hostId}> ended the table. Final standings:`,
						...standings.map(
							(entry, index) => `${index + 1}. <@${entry.userId}> (${entry.stack === null ? "out" : entry.stack})`
						),
				  ].join("\n")
				: `🏁 <@${hostId}> ended the table before the first deal.`,
	},

	// ── monopoly in a room (2026-10 item 241) ──
	// The engine composes its own trail lines (rolls, rent, cards), so this pack
	// holds only what the room layer adds around them: the board, the buttons,
	// the private peek and the refusals.
	monopoly: {
		boardTitle: "🏠 Monopoly",
		// The rules in a few sentences, on the pinned opener, because the board
		// message that gets edited every turn has no room for them.
		openerRules: (): string =>
			[
				`Everyone starts on GO with $${STARTING_CHIPS}. Roll, buy what you land on, and collect rent from anyone who lands on yours. The last player standing wins.`,
				"",
				`A player who stays on the clock for ${monopolyIdleHours()} hours without a move is out of the match.`,
			].join("\n"),

		onTheClock: (userId: string): string => `<@${userId}> is on the clock.`,
		finishedLine: (winnerId: string | null): string =>
			winnerId ? `👑 <@${winnerId}> wins the match.` : "The match is over.",
		// What the player on the clock can do now, one line under whose turn it is.
		rollPrompt: "Roll the dice.",
		jailPrompt: "In Jail: pay bail, use a card, or roll for doubles.",
		buyPrompt: (tileName: string, price: number): string => `Buy ${tileName} for $${price}, or skip it.`,
		endTurnPrompt: "End your turn when you are ready.",
		auctionPrompt: (tileName: string, closesAt: number): string =>
			`${tileName} is up for auction. Everyone still playing may place one sealed bid; it closes ${discordRelativeTime(closesAt)}.`,
		// "in-trade", the one phase nothing enters (a trade never moves the phase).
		// Said plainly rather than left blank, so a board that ever shows it reads as
		// waiting rather than broken.
		waitingPrompt: "Waiting on the table.",

		// The seat list. Parentheses and middle dots rather than dashes (house rule 1).
		seatLine: (seatNumber: number, userId: string, chips: number, lotCount: number, tileName: string): string =>
			`**${seatNumber}.** <@${userId}> · $${chips} · ${lotCount} ${lotCount === 1 ? "lot" : "lots"} · on ${tileName}`,
		inJailTag: "in Jail",
		outTag: "out",
		boardMapLabel: "Board (tile number, then a seat number where a token stands; + is two or more):",
		lastMoveLabel: "Last move:",
		noMovesYet: "No moves yet.",

		rollLabel: "Roll",
		buyLabel: (tileName: string, price: number): string => `Buy ${tileName} for $${price}`,
		skipLabel: "Skip",
		endTurnLabel: "End turn",
		bailLabel: (bail: number): string => `Pay bail ($${bail})`,
		useCardLabel: "Use card",
		jailRollLabel: "Roll for doubles",
		inventoryLabel: "Inventory",
		buildLabel: "Build",
		tradeLabel: "Trade",
		// While an offer waits, the same button opens it for the two players in it.
		tradeOpenLabel: "Trade offer open",
		bidLabel: (tileName: string): string => `Bid on ${tileName}`,

		// ── the auction (Session 5b) ──
		// The trail line after the engine's "goes up for auction". Public, so it says
		// nothing about any bid; bids stay sealed until the close names the winner.
		auctionOpened: (tileName: string, closesAt: number): string =>
			`🔨 Sealed bids on ${tileName} close ${discordRelativeTime(closesAt)}. Everyone still playing may bid once; a second bid replaces the first.`,
		bidModalTitle: "Place a sealed bid",
		// A modal label holds at most 45 characters; the longest lot name keeps this under 40.
		bidAmountLabel: (tileName: string): string => `Your bid on ${tileName}, in chips`,
		bidAmountPlaceholder: (chips: number): string => `Nobody sees it until the close. You have $${chips}.`,
		bidPlaced: (amount: number, tileName: string, closesAt: number): string =>
			`Your sealed bid of $${amount} on ${tileName} is in. It closes ${discordRelativeTime(closesAt)}, and a new bid replaces this one.`,
		bidNotANumber: "A bid is a whole number of chips, like 120.",
		noAuction: "There is no auction open right now.",
		auctionOver: "That auction has already closed.",

		// ── the build picker (Session 5b) ──
		buildPickerPrompt: "Pick a lot to build on. Each pick builds one house, or the hotel once a lot has four houses.",
		buildPickerPlaceholder: "Choose a lot",
		buildOptionLabel: (tileName: string, kind: BuildingKind, cost: number): string => `${tileName}: a ${kind} for $${cost}`,
		buildPickerAgain: "Built. Pick another lot, or dismiss this message.",
		buildPickerDone: "Built. There is nothing else you can build right now.",
		nothingToBuild:
			"Nothing to build right now. Building needs a whole color group with no mortgages in it, chips for the next building, and your turn before you roll.",

		// ── trades (Session 5b) ──
		// Every trade surface below is EPHEMERAL to the two players in it. The public
		// trail says only who offered whom (risk M6): the terms stay private until the
		// trade is accepted, when the engine's trail lines say what moved.
		tradePartnerPrompt: "Who do you want to trade with?",
		tradePartnerPlaceholder: "Choose a player",
		noTradePartners: "There is nobody left in the match to trade with.",
		tradeModalTitle: "Make a trade offer",
		giveLotsLabel: "Lots you give",
		wantLotsLabel: "Lots you want",
		lotsPlaceholder: "None",
		giveChipsLabel: "Chips you give",
		wantChipsLabel: "Chips you want",
		chipsPlaceholder: "0",
		jailCardsLabel: "Jail cards: you give, you want",
		jailCardsPlaceholder: "0, 0",
		tradeNotANumber: "Chips and jail cards are whole numbers, zero or more. Jail cards take two, like 1, 0.",
		tradeSent: (partnerId: string): string =>
			`Your offer is with <@${partnerId}>. They answer it from the Trade button on the board, and you can withdraw it from the same button.`,
		tradeOfferTitle: "🤝 Trade offer",
		tradeOfferToYou: (initiatorId: string): string => `<@${initiatorId}> offers you a trade.`,
		tradeOfferFromYou: (counterpartyId: string): string => `Your offer to <@${counterpartyId}> is waiting for an answer.`,
		tradeYouGet: (items: string): string => `**You get:** ${items}`,
		tradeYouGive: (items: string): string => `**You give:** ${items}`,
		// ── the canvas cards (2026-10 item 243 Phase 3) ──
		// Trade, auction and winner. Drawn into pixels, so nothing takes a mention.
		cardYouGet: "YOU GET",
		cardYouGive: "YOU GIVE",
		cardChips: (amount: number): string => `$${amount.toLocaleString()}`,
		cardJailCards: (count: number): string => `${count} Get Out of Jail Free ${count === 1 ? "card" : "cards"}`,
		cardNothing: "Nothing",
		cardMoreLots: (count: number): string => `and ${count} more`,
		cardAuction: "AUCTION",
		cardListPrice: (price: number): string => `List price $${price.toLocaleString()}`,
		cardYourBid: (amount: number): string => `Your sealed bid $${amount.toLocaleString()}`,
		cardWinner: "WINNER",
		cardNoWinner: "The match is over",
		cardLots: (count: number): string => `${count} ${count === 1 ? "lot" : "lots"}`,
		cardBankrupt: "Bankrupt",
		cardSeat: (index: number): string => `Seat ${index + 1}`,
		tradeBetweenOthers: (initiatorId: string, counterpartyId: string): string =>
			`A trade between <@${initiatorId}> and <@${counterpartyId}> is waiting for an answer. One trade can be open at a time.`,
		acceptTradeLabel: "Accept",
		declineTradeLabel: "Decline",
		withdrawTradeLabel: "Withdraw",
		tradeGone: "That offer has already been answered or withdrawn.",
		tradeAccepted: "Trade accepted. The board shows what moved.",
		tradeDeclined: "Trade declined.",
		tradeWithdrawn: "Offer withdrawn.",

		// ── the private peek ──
		inventoryTitle: "🏠 Your holdings",
		inventoryChips: (chips: number): string => `Chips: **$${chips}**`,
		inventoryJailCards: (count: number): string => `Get Out of Jail Free cards: **${count}**`,
		inventoryLotsHeader: "**Lots:**",
		inventoryNoLots: "Lots: none yet.",
		// One lot per line, with what is on it, so a player can see what a mortgage or
		// a build would touch before choosing. Parentheses rather than dashes (rule 1).
		inventoryLotLine: (tileName: string, details: string[]): string =>
			details.length > 0 ? `• ${tileName} (${details.join(", ")})` : `• ${tileName}`,
		lotHouses: (count: number): string => (count === 1 ? "1 house" : `${count} houses`),
		lotHotel: "hotel",
		lotMortgaged: (liftCost: number): string => `mortgaged, $${liftCost} to lift`,
		inventoryOut: "You are out of this match.",
		// Under the lot list when the peek offers mortgage controls.
		inventoryMortgageHint:
			"A mortgaged lot charges no rent. A lot whose color group has buildings cannot be mortgaged until they are sold.",
		mortgagePlaceholder: "Mortgage a lot for cash",
		mortgageOptionLabel: (tileName: string, amount: number): string => `${tileName}: get $${amount}`,
		unmortgagePlaceholder: "Lift a mortgage",
		unmortgageOptionLabel: (tileName: string, cost: number): string => `${tileName}: pay $${cost}`,
		sellPlaceholder: "Sell a building back to the bank",
		sellOptionLabel: (tileName: string, kind: BuildingKind, amount: number): string => `${tileName}: sell the ${kind} for $${amount}`,

		// ── a held debt (Session 5b) ──
		// The board's prompt while the match waits on a debt. It names who must act,
		// because the debtor is not always the seat on the clock (a card can charge a rival).
		debtPrompt: (debtorId: string, creditor: string, amount: number, chips: number): string =>
			`<@${debtorId}> owes ${creditor} $${amount} and has $${chips}. They raise the rest by mortgaging or selling from Inventory, then press Pay.`,
		bankCreditor: "the bank",
		payDebtLabel: (amount: number): string => `Pay $${amount}`,
		// At the top of the debtor's own peek, so the controls below read as the way out.
		inventoryDebtLine: (amount: number, creditor: string, shortBy: number): string =>
			shortBy > 0
				? `⚠️ You owe ${creditor} $${amount}. Raise $${shortBy} more below, then press Pay on the board.`
				: `⚠️ You owe ${creditor} $${amount}, and you have it. Press Pay on the board.`,

		// ── refusals ──
		notSeated: "You are not in this match.",
		notYourTurn: "It is not your turn.",
		matchOver: "This match is already over.",
		noBoard: "This match has no board yet. Try again in a moment.",
		// Somebody else's write landed first. Ordinary, so the copy is not an apology.
		boardBusy: "The board just changed. Try that again.",
		// The challenge board's start refusal. The pool is everyone who joined; the host
		// is the extra seat, which is why the copy says "counting you".
		tooManyPlayers: (maxSeats: number, joined: number): string =>
			`Monopoly seats at most ${maxSeats} players, counting you, and ${joined} have joined. Call this one off and start a new challenge with fewer.`,

		// ── the idle sweep ──
		// Public, so the table knows why a seat left without anyone pressing anything.
		// The engine's own forfeit line follows it and says where the holdings went,
		// so this one only says why.
		idleForfeit: (userId: string): string =>
			`⏳ <@${userId}> stayed on the clock for ${monopolyIdleHours()} hours without a move, so Dero forfeits their seat.`,
		// The sweep's line for a debtor who never paid: bankrupt to whoever they owed,
		// which is the engine's next line, rather than forfeited to the bank.
		idleDebtDefault: (userId: string): string =>
			`⏳ <@${userId}> left a debt unpaid for ${monopolyIdleHours()} hours, so Dero settles it the only way left.`,

		// ── the voice referee (Session 5c) ──
		// Spoken in place of a player whose display name cannot be found (they left the
		// server), because Dero must never read a raw mention or snowflake aloud.
		refereeUnknownPlayer: "a player",
	},

	// ── the move trail ──
	trail: {
		// A join is the one move kind posted by the room itself rather than by a game.
		joined: (actorId: string): string => `<@${actorId}> joined the room.`,
		forfeited: (actorId: string): string => `<@${actorId}> forfeited.`,
		// A departure ends the match the way a forfeit does; the line is why the board
		// moved without anyone pressing anything.
		playerLeftGuild: (userId: string): string => `<@${userId}> left the server. The match ends.`,
		// The boot sweep's line for a solo blackjack room whose hand did not survive a redeploy.
		// Says plainly that no result was settled, so nobody reads the closed room as a loss.
		tableLostToRestart: "Dero restarted mid hand and this table was lost. No hand was settled, so nothing was paid or lost. Dero is closing the room.",
	},
} as const;
