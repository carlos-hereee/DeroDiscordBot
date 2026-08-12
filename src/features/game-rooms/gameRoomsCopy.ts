import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { GameSlug } from "./roomTypes.js";

// ── game rooms user-facing copy ──────────────────────────────────────
// Feature-local copy module, the exact sibling of gamesCopy.ts and fortuneCopy.ts,
// including their reasoning: a game room is a bot feature rather than a platform
// plugin, and "the room is locked" reads identically in the kingdom voice and the
// streamer voice, so a two-pack split here would double the authoring for content
// that would come out the same twice. If game rooms ever graduate into a real
// plugin this file moves into the pack + copyOverrides system wholesale.
//
// House rule for every string below: no dashes in user-facing copy.

// Human labels for the slugs. Kept here rather than derived from the slug because
// "coinflip" is not a phrase anyone writes, and a room's cards are read by members
// who never see the slug.
const GAME_LABELS: Record<GameSlug, string> = {
	hangman: "Hangman",
	coinflip: "Coin flip",
	diceroll: "Dice roll",
	rps: "Rock paper scissors",
};

export const gameRoomsCopy = {
	gameLabel: (game: GameSlug): string => GAME_LABELS[game] ?? game,

	// ── the opener card, pinned inside the room ──
	opener: {
		title: (game: GameSlug): string => `${GAME_LABELS[game] ?? game} room`,
		// Rendered once, at open. The visibility line matters because it is the only
		// place a player is told who else can read what they type.
		description: (hostId: string, playerIds: string[], isPublic: boolean): string => {
			const roster = playerIds.map((id) => `<@${id}>`).join(" versus ");
			const audience = isPublic
				? "Anyone in the server can watch this room. Only the players can type."
				: "This room is invite only. Only the players and the members they invited can see it.";
			return [`Host: <@${hostId}>`, "", roster, "", audience].join("\n");
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
		// 50013. Names the missing permission, because the member who clicked cannot
		// fix it and the admin who can needs to know what to grant.
		missingPermissions: "Dero cannot create a channel in the arcade category. An admin needs to grant Manage Channels.",
		// Anything else. Deliberately does not promise a retry loop; there is none.
		createFailed: "Something went wrong opening that room. Try again in a moment.",
		noArcadeCategory: "This server has no arcade category yet. An admin can run /setup to build it.",
		notFound: "That room no longer exists.",
		notYours: "Only the host or an admin can do that.",
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

		visibilityInviteLabel: "Invite only",
		visibilityOpenLabel: "Open to all",
		joinLabel: "Join",
		startLabel: "Start the match",
		cancelLabel: "Call it off",

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

	// ── the move trail ──
	trail: {
		// A join is the one move kind posted by the room itself rather than by a game.
		joined: (actorId: string): string => `<@${actorId}> joined the room.`,
		forfeited: (actorId: string): string => `<@${actorId}> forfeited.`,
	},
} as const;
