import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { STARTING_CHIPS } from "@features/games/monopolyBoard.js";
import type { BuildingKind } from "@features/games/monopolyState.js";
import type { GameSlug, RoomVisibility, SpectatorMode } from "./roomTypes.js";
import type { HangmanCategory } from "@features/games/hangmanWords.js";
import type { FlavorTable } from "./matchOutcome.js";
// Aliased: Monopoly's copy below names its own parameters `chips`.
import { chips as chipAmount } from "@features/economy/economyCopy.js";

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

// A room's archive window in words: whole hours when it is a whole number of hours, minutes
// otherwise, so 4 hours reads "4 hours" and 30 minutes reads "30 minutes".
const MS_PER_MINUTE = 60 * 1000;
const MINUTES_PER_HOUR = 60;
function archiveWindowWords(delayMs: number): string {
	const minutes = Math.round(delayMs / MS_PER_MINUTE);
	if (minutes >= MINUTES_PER_HOUR && minutes % MINUTES_PER_HOUR === 0) {
		const hours = minutes / MINUTES_PER_HOUR;
		return hours === 1 ? "1 hour" : `${hours} hours`;
	}
	return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

// Who can see a room, one sentence per setting. A solo room is its own sentence because
// it is nobody's choice: it admits its one player and the admins, by construction.
function openerAudienceLine(visibility: RoomVisibility, audience: SpectatorMode): string {
	if (visibility === "solo") return "This is a solo room. Only you and the admins can see it.";
	if (audience === "open") return "Anyone in the server can watch this room. Only the players can type or react.";
	if (audience === "invite") return "Only the players and the spectators they invited can see this room. Only the players can type or react.";
	return "No spectators: only the players and the admins can see this room.";
}

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
	blackjack: "Blackjack",
	"solo-hangman": "Hangman (solo)",
	"solo-blackjack": "Blackjack (solo)",
	"solo-coinflip": "Coin flip against Dero",
	"solo-diceroll": "Dice roll against Dero",
	"solo-rps": "Rock paper scissors against Dero",
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

// ── the post match flavor table (post-launch plan item 21) ──────────────
// One line under the winner on the closed challenge card, picked at random from the
// shelf for (game, bucket); matchOutcome.pickFlavor falls back to the shared shelf for
// a bucket a game has no shelf of its own for. Hand written in the kingdom voice and
// never brain generated (risk R10). Every line follows "**winner** won." on the card,
// so none names the winner or a count it cannot know.
//
// ⚠️ NOT LOCKED. The owner reviews the first ten lines (hold em decisive and tactic)
// before the full table is locked; until then the rest stands as a draft in the same
// voice, and the plan's Phase 2 build record says which state it is in.
const POST_MATCH_FLAVOR: FlavorTable = {
	byGame: {
		holdem: {
			decisive: [
				"Rode in with a war chest and left with the whole treasury.",
				"The table bent the knee long before the last card fell.",
				"Every stack at this table now flies one banner.",
				"Not a siege. A coronation.",
				"The vault doors swung one way all night.",
			],
			tactic: [
				"Waited in the tall grass with a monster hand and sprang the trap.",
				"Showed a hand built like castle walls and dared anyone to scale them.",
				"The cards were sharpened in the armory before the duel began.",
				"Laid the ambush on the flop and let the river close the pass.",
				"A hand like that is not luck. It is a standing army.",
			],
			routing: [
				"One hand, one sweep, and the whole table emptied at once.",
				"Every rival rode into the same ambush and none rode out.",
				"The last hand was not a duel. It was a rout.",
				"Every crown at the table fell on a single deal.",
			],
			narrow: [
				"The river decided it, and the river does not apologize.",
				"Won by a card's width, the way the old songs tell it.",
				"Down to the last street with nothing to spare.",
				"A close siege, settled at the final gate.",
			],
		},
		monopoly: {
			routing: [
				"The board was conquered before the season turned.",
				"Rents fell like arrows and the rivals ran out of gold early.",
				"A swift campaign. The bank barely had time to count.",
				"Every rival was bankrupt before the dice grew warm.",
			],
			comeback: [
				"Down to their last coins and still they took the kingdom.",
				"Counted out by the treasury, crowned by the end.",
				"From an empty purse to every deed on the board.",
				"The realm wrote them off. The realm was wrong.",
			],
			decisive: [
				"Not a single lot went to the auction block. They took what they wanted.",
				"Bought clean, built high, never bargained.",
				"Every deed signed at full price and every rent collected.",
				"No auctions, no mercy, no rival left standing.",
			],
			narrow: [
				"Two treasuries, one crown, and a long night of rent.",
				"The last bankruptcy came hard and late.",
				"A long war of rents, won by the one who held on longest.",
				"Every lot was contested and the margin was thin.",
			],
		},
		battleship: {
			decisive: [
				"The enemy fleet sank and the home fleet barely got wet.",
				"The home fleet sailed home nearly untouched.",
				"A clean sweep of the seas.",
				"The enemy never found the range.",
			],
			comeback: [
				"Outgunned for a while, then the tide turned.",
				"Lost ships early and won the war anyway.",
				"The admiralty had written them off. The sea had other plans.",
				"Behind on hulls, ahead on nerve.",
			],
			narrow: [
				"Barely a plank left above water, but the flag still flies.",
				"A war of attrition, won by whatever was left afloat.",
				"Both fleets bled. Only one kept a mast.",
				"The sea took nearly everything, but not the crown.",
			],
		},
		hangman: {
			decisive: [
				"Not a single wrong letter. The gallows stood idle.",
				"Clean as a royal decree.",
				"The hangman never lifted the rope.",
				"Read the word like a herald reads a scroll.",
			],
			narrow: [
				"One more miss and the rope would have won.",
				"Pulled back from the gallows at the last breath.",
				"The trapdoor creaked, and held.",
				"Spared by a single letter.",
			],
		},
		luck: {
			narrow: [
				"Fate favored the bold this time.",
				"Fortune picked a side, and it was theirs.",
				"The fates rolled, and rolled their way.",
				"A small battle, a fair victory.",
			],
		},
	},
	shared: {
		decisive: ["A victory without a doubt in it.", "Clear, clean and beyond argument.", "The field was theirs from start to end.", "No rival came close."],
		narrow: ["Close enough to feel the other blade.", "Won by a hair and a prayer.", "The margin was thin, the crown is not.", "A hard fought win, and an honest one."],
		comeback: ["Written off, then written into the chronicle.", "Rose from behind and took the throne.", "The tide turned, and they rode it in.", "Down but never out."],
		routing: ["A rout from the first horn.", "The rivals broke and ran.", "Swift, total and decisive.", "Nothing left standing on the other side."],
		tactic: ["Planned like a siege, executed like a charge.", "A strategist's victory.", "Cunning won this one.", "The better plan carried the day."],
		forfeit: [
			"The rival left the field, and the field is theirs.",
			"Victory by the other side's retreat.",
			"An empty chair across the table, and a win.",
			"The challenger quit the field.",
		],
		timeout: ["The rival's clock ran dry.", "Time itself took the other side.", "The rival went quiet and the hourglass decided.", "Won while the rival slept."],
		draw: ["Neither side would yield.", "Two crowns, one table, no winner.", "Even steel, even luck.", "The realm calls it a draw."],
	},
};

export const gameRoomsCopy = {
	gameLabel: (game: GameSlug): string => GAME_LABELS[game] ?? game,
	tierName: (tierKey: string): string => TIER_NAMES[tierKey] ?? tierKey,

	// ── the drawing pause (drawingPause.ts) ──
	// The status line on a board while its card renders. Every timed or per turn
	// game shows the same words, so a player learns once that the clock is held.
	drawing: {
		status: "🎨 Dero is drawing the table…",
	},

	// ── notice titles (2026-10 item 254 Phase 5b) ──
	// The title over a private answer shown as a notice modal, one per part of the
	// arcade. Discord cuts a modal title at 45 characters.
	notices: {
		challenge: "⚔️ Challenge",
		room: "🎮 Game room",
		host: "🎮 Host controls",
		network: "🌐 Network tables",
		partyGames: "🎉 Party games",
		battleship: "🚢 Battleship",
		hangman: "🪢 Hangman",
		holdem: "🃏 Texas hold em",
		monopoly: "🎩 Monopoly",
	},

	// ── the opener card, pinned inside the room ──
	opener: {
		title: (game: GameSlug): string => `${GAME_LABELS[game] ?? game} room`,
		// Rendered once, at open. The audience line matters because it is the only place a
		// player is told who else can read what they type: the room's spectator setting
		// (2026-10 item 254, Arcade 11), resolved by roomPermissions.effectiveSpectatorMode
		// so it always says what the permission matrix does.
		//
		// The invite link appears only on a public room everyone may watch (roomInvite), so
		// a newcomer who follows it can see the room, and it says out loud that it stops
		// working when the match ends, which is when finish deletes it (Arcade 10).
		// Rendered as an inline URL rather than a button on purpose: a link component is not
		// tap-to-copy on mobile the way an inline URL is.
		description: (hostId: string, playerIds: string[], visibility: RoomVisibility, audience: SpectatorMode, inviteCode?: string | null): string => {
			const roster = playerIds.map((id) => `<@${id}>`).join(" versus ");
			const lines = [`Host: <@${hostId}>`, "", roster, "", openerAudienceLine(visibility, audience)];
			if (inviteCode) lines.push("", `Invite link, until the match ends: https://discord.gg/${inviteCode}`);
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
		// back, and saying the window out loud is what stops "where did my game go". It
		// names the window finish actually stamped, which is shorter for a solo luck round
		// against Dero (GAME_ROOM_SOLO_LUCK_ARCHIVE_DELAY_MS), so the card never promises
		// hours the channel does not have.
		archiveNotice: (delayMs: number = BOT_CONSTANTS.GAME_ROOM_ARCHIVE_DELAY_MS): string =>
			`This room is now read only. It disappears in ${archiveWindowWords(delayMs)}, or right now if the host presses Archive now.`,
		archiveButtonLabel: "Archive now",
		rematchButtonLabel: "Rematch",
		// Replaces the archive notice on the finished room's result card once a rematch
		// takes the channel over: the room no longer disappears, and the line answers
		// "who started this" for everyone scrolling back.
		rematchStarted: (presserId: string): string => `🔁 <@${presserId}> started a rematch. The next match is below.`,
	},

	// ── 🎉party-games (post-launch plan item 3) ──
	// The admin buttons and their replies are admin facing and practical; the
	// announcement and the RSVP card are member facing, in the kingdom voice.
	partyGames: {
		hostHangmanLabel: "Host hangman",
		// Hold'em and Monopoly from the party channel (2026-10 item 254, Arcade 4).
		hostHoldemLabel: "Host Texas hold em",
		hostMonopolyLabel: "Host Monopoly",
		scheduleLabel: "Schedule a party game",
		adminsOnly: "Only the server owner or an admin can host or schedule party games.",
		noChannel: "There is no 🎉party-games channel yet. An admin can run /setup to build it.",
		hostStarted: (channelId: string): string => `Hangman is open in <#${channelId}>.`,
		gameLabels: { hangman: GAME_LABELS.hangman, holdem: GAME_LABELS.holdem, monopoly: GAME_LABELS.monopoly } as const,

		// The schedule modal. Discord caps a modal title at 45 characters and a label at 45.
		modalTitle: "Schedule a party game",
		gameLabel: "Game",
		startLabel: "Starts (UTC, MM/DD @HH:MM)",
		startPlaceholder: "10/31 @19:00",
		durationLabel: "Runs for (minutes)",
		maxLabel: "Most attendees (0 for no limit)",

		// Refusals of the form, each naming what to fix.
		badStart: "The start time reads MM/DD @HH:MM in UTC, for example 10/31 @19:00.",
		pastStart: "That time has already passed. Pick a time ahead.",
		badDuration: (min: number, max: number): string => `The length is a whole number of minutes from ${min} to ${max}.`,
		badMax: (max: number): string => `Most attendees is a whole number from 0 (no limit) to ${max}.`,
		badGame: "Pick a game from the list.",
		noRsvpChannel: "There is no 🔜upcoming-events channel to post the RSVP card in. An admin can run /setup to build it.",
		scheduled: (rsvpChannelId: string): string => `Scheduled. The RSVP card is in <#${rsvpChannelId}>.`,

		// The line in 📢announcements. Mentions render as names and ping nobody.
		announcementTitle: "🎉 A party game is called",
		announcement: (hostId: string, game: string, startSeconds: number, minutes: number, partyChannelId: string | null, rsvpChannelId: string): string =>
			[
				`<@${hostId}> will host **${game}**${partyChannelId ? ` in <#${partyChannelId}>` : ""} on <t:${startSeconds}:F> (<t:${startSeconds}:R>), for about ${minutes} minutes.`,
				"",
				`Mark whether you will come in <#${rsvpChannelId}>.`,
			].join("\n"),

		// The RSVP card in 🔜upcoming-events.
		cardTitle: (game: string): string => `🎉 Party game: ${game}`,
		cardDescription: (hostId: string, startSeconds: number, minutes: number, partyChannelId: string | null): string =>
			`Hosted by <@${hostId}>${partyChannelId ? ` in <#${partyChannelId}>` : ""}. Starts <t:${startSeconds}:F> (<t:${startSeconds}:R>) and runs about ${minutes} minutes.`,
		attendingTitle: (count: number, max: number): string => (max > 0 ? `Attending (${count}/${max})` : `Attending (${count})`),
		decliningTitle: (count: number): string => `Not attending (${count})`,
		nobodyYet: "Nobody yet.",
		names: (ids: string[], shown: number): string => {
			const named = ids.slice(0, shown).map((id) => `<@${id}>`).join(", ");
			const hidden = ids.length - shown;
			return hidden > 0 ? `${named} and ${hidden} more` : named;
		},
		attendLabel: "I will attend",
		declineLabel: "I won't attend",
		full: "Every seat is taken. Watch this card in case one opens.",
		over: "This party game is over.",
		gone: "This party game is no longer on the schedule.",

		// The admin log's subject and the two moments it records.
		logSubject: (game: string): string => `Party game: ${game}`,
		logScheduled: (startSeconds: number, minutes: number, max: number): string =>
			`<t:${startSeconds}:f>, ${minutes} min, ${max > 0 ? `up to ${max}` : "no limit"}`,
		logFull: (max: number): string => `RSVP full at ${max}`,
		logReopened: (max: number): string => `RSVP back under ${max}`,

		// ── the timed open (2026-10 item 254, Arcade 4) ──
		// The RSVP card's last line once the start time came: where the game is, or why
		// Dero could not open it. A link and plain words, so the edit pings nobody.
		openedLine: (link: string): string => `▶️ **It is open.** [Go to the game](${link})`,
		notOpenedLine: (reason: string): string => `⚠️ **Dero could not open it at its time.** ${reason}`,
		openFailures: {
			alreadyHosting: "The host already had a room open, and a host can run one at a time. They can open it from 🎉party-games once that room is done.",
			noChannel: "Its channel is missing. An admin can run /setup to build it.",
			noAccess: "This server's plan does not include game rooms.",
			alreadyRunning: "A hangman round was already running in 🎉party-games.",
			failed: "Discord refused the post. The host can open it from 🎉party-games.",
		},
	},

	// ── the host's answer to a join request (2026-10 item 254, Arcade 6) ──
	// One DM line each, since the joiner's own press is long answered. It names the server
	// because a DM arrives outside it, and pings nobody.
	joinAnswer: {
		accepted: (game: string, server: string): string => `✅ The host accepted your request to join **${game}**${server ? ` in **${server}**` : ""}. You are in.`,
		declined: (game: string, server: string): string => `The host declined your request to join **${game}**${server ? ` in **${server}**` : ""}.`,
	},

	// ── the closed challenge card (post-launch plan item 21) ──
	// The card's last line once its match ends: who won and how, in one line. Mentions in
	// an embed render as names without pinging, which is what a closed card wants.
	postMatch: {
		flavor: POST_MATCH_FLAVOR,
		winnerLine: (winnerId: string, flavor: string): string => `👑 **<@${winnerId}>** won. ${flavor}`,
		// Hangman's guessers win together, so the room is the winner.
		roomWonLine: (flavor: string): string => `👑 **The room** won. ${flavor}`,
		drawLine: (flavor: string): string => `🤝 **A draw.** ${flavor}`,
		noWinnerLine: "The match is over. Nobody took it.",
		abandonedLine: "The match was abandoned, so Dero closed it.",
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
		// 50013. Names the missing permission and where to grant it (2026-10 item 257,
		// owner item 15), because the member who clicked cannot fix it and the admin who
		// can needs to know what to grant and where.
		missingPermissions:
			"Dero cannot create a channel in the 🎮 ARCADE GAMES category: it is missing the **Manage Channels** permission. An admin can grant it in Server Settings, Roles, on Dero's role, or on the category's own Permissions tab.",
		// A button from an older message whose action no longer exists. Discord keeps
		// every component clickable forever, so this is a normal thing for a member to
		// hit rather than an error, and the copy says so without apologising.
		controlRetired: "This control is no longer available.",
		// Anything else. Deliberately does not promise a retry loop; there is none.
		createFailed: "Something went wrong opening that room. Try again in a moment.",
		// The arcade switched off or never built (item 15): the command that builds it, as
		// inline code a member can copy to an admin.
		noArcadeCategory: "This server has no arcade yet. Send this command to an admin to build it:\n`/arcade on`",
		notFound: "That room no longer exists.",
		notYours: "Only the host or an admin can do that.",
		// One rematch per finished room, ever. Without this the still clickable button
		// on a scrolled back result card would spawn a room per press.
		rematchAlreadyOffered: "Someone already started a rematch from this room.",
	},

	// ── the confirms (2026-10 item 257, owner items 12 and 15) ──
	// Each one is a modal whose Submit performs the action (showConfirm in
	// utils/textModal.ts); closing it does nothing. So every body names what Submit does,
	// and none says it already happened.
	confirms: {
		archive: "Archive this room now? Its channel is deleted at once, and the match record is kept. Submit to archive it.",
		forfeit: "Forfeit this match? It counts as a loss for you. Submit to forfeit.",
		start: "Start the match? Dero opens its room now and seats the players. Submit to start.",
		newChallenge: (game: GameSlug): string =>
			`Start a ${GAME_LABELS[game] ?? game} challenge? Submit and Dero posts your challenge card, where you choose who can see it.`,
		// Item 15: the one room per host refusal, offering its fix.
		replaceDraft: "You already have a challenge open. Submit to close it and start this one.",
		// A running match is never closed from here: it is finished or archived in its own room.
		matchInPlay: (channelId: string | null): string =>
			channelId
				? `Your match is still in play in <#${channelId}>. Finish it or archive it there first, then start another.`
				: "Your match is still in play. Finish it or archive it in its room first, then start another.",
		// The pool grew past one while the start confirm stood open, so the host now picks
		// who plays, which takes a picker a modal Submit cannot open.
		startPickNeeded: "More players joined while you were deciding. Press Start match again to choose who plays.",
		leaveTable: "Leave the table? A hand you are in is folded and your seat is given up. Submit to leave.",
		endTable: "End the table now? It closes on the standings as they are. Submit to end it.",
		matchOver: "That match is already over, so there is nothing to forfeit.",
		// The archive confirm's one choice (2026-10 item 257 Phase 3b): a modal holds no button,
		// so keeping the match is a select applied on Submit, defaulting to no.
		saveToProfile: {
			label: "Save this match to my profile",
			yes: "Yes, save it",
			no: "No, just archive",
		},
	},

	// ── saved matches (2026-10 item 257 Phase 3b) ──
	// /account view:saved, the matches a member chose to keep when archiving a room.
	saved: {
		title: (name: string): string => `📌 ${name}'s saved matches`,
		empty: "No saved matches yet. Choose Save this match to my profile when you archive a finished match, and it is kept here.",
		// A bot cannot have saved matches, and the command can name any member.
		botMember: "A bot has no saved matches.",
		outsideGuild: "Saved matches belong to a server. Run this in a server.",
		readFailed: "Dero could not read the saved matches just now. Try again in a moment.",
		footer: (shown: number): string => `Showing the last ${shown}, newest first.`,
		// One row: "Hangman · Won · against <@a>, 🤖 Dero Red · <t:...:D>". Solo rooms have no opponent
		// to name, so the line says who the round was against.
		line: (input: { game: string; result: string; opponents: string; date: string }): string =>
			`**${input.game}** · ${input.result} · ${input.opponents} · ${input.date}`,
		versus: (opponents: string): string => `against ${opponents}`,
		results: { won: "Won", lost: "Lost", noWinner: "No winner" },
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
		// A Blackjack table's start refusal (2026-10 item 254, Arcade 1): the table has five
		// seats, counted like Monopoly's, the host included.
		blackjackTooManyPlayers: (maxSeats: number, joined: number): string =>
			`A Blackjack table seats at most ${maxSeats} players, counting you, and ${joined} have joined. Call this one off and start a new table with fewer.`,
		// ── Play Dero instead (post-launch plan item 13) ──
		// Coin flip, dice roll and rps only: the challenge closes and the host plays one
		// round against Dero in a solo room of their own (2026-10 item 254, Arcade 1), so
		// nothing is played in ⚔️challenges. The card points at the room.
		playDeroLabel: "Play Dero instead",
		cardPlayedDero: (hostId: string, channelId: string): string => `🤖 <@${hostId}> took on Dero instead, in <#${channelId}>.`,
		// The card's line when the solo room could not open: the challenge is still closed,
		// since the host chose Dero, and the host was told why privately.
		cardDeroUnavailable: (hostId: string): string => `🤖 <@${hostId}> chose to take on Dero instead.`,

		// ── the rated or casual badge (2026-10 item 254, Arcade 5) ──
		// One line at the top of every challenge card, from challengeBoardEmbeds.challengeBadge,
		// the one helper that decides it. Hold'em says when a table starts to count, because
		// a short table is recorded and never rated (ratingEngine.isRatedHoldemSession).
		badgeLine: (badge: "rated" | "casual", game: GameSlug): string => {
			if (badge === "casual") return "🎲 **CASUAL** · not rated";
			if (game === "holdem") return `🏆 **RATED** · counts once the table has played ${BOT_CONSTANTS.RATINGS.HOLDEM_MIN_RATED_HANDS} hands`;
			return "🏆 **RATED** · counts toward `/rating`";
		},

		// ── who may watch (2026-10 item 254, Arcade 11) ──
		// The host's spectator setting on the draft card: a select, so it costs one row
		// however many settings there are, with the current one as its default.
		spectators: {
			placeholder: "Who may watch",
			options: {
				open: { label: "Open to spectators", description: "Everyone in the server may watch." },
				invite: { label: "Invite only", description: "Only the members you invited watch." },
				none: { label: "No spectators", description: "Only the players see the room." },
			} satisfies Record<SpectatorMode, { label: string; description: string }>,
			cardLine: (mode: SpectatorMode): string => {
				if (mode === "open") return "👀 Open to spectators: everyone in the server may watch.";
				if (mode === "invite") return "👀 Invite only: the members who joined but do not play may watch.";
				return "👀 No spectators: only the players will see the room.";
			},
		},
		deroThrowModalTitle: "Your throw against Dero",
		deroThrowLabel: "Rock, paper or scissors",
		// ── Play vs bots (2026-10 item 250 Phase 5) ──
		// Hold'em, Monopoly and Battleship: the host fills seats with Dero bots, who sit
		// down when the match starts. Bots never take a member's place and never rate.
		playBotsLabel: "Play vs bots",
		botPickerPrompt: "How many Dero bots should take a seat? They sit down when you press Start, and a match with a bot is never rated.",
		botPickerPlaceholder: "Dero bots",
		botOptionNone: "No bots",
		botOptionCount: (count: number): string => (count === 1 ? "1 Dero bot" : `${count} Dero bots`),
		botsSaved: (count: number): string => (count === 0 ? "No Dero bots will sit down." : `${count === 1 ? "1 Dero bot" : `${count} Dero bots`} will sit down when you press Start.`),
		cardBots: (count: number): string => `🤖 ${count === 1 ? "1 Dero bot sits" : `${count} Dero bots sit`} down when the match starts. A match with a bot is never rated.`,
		botsOff: "An admin switched Dero bot opponents off in this server.",
		botsNotHere: "Dero bots can only join a Hold'em, Monopoly or Battleship challenge in this server.",
		// The 🗒️admin-log detail when the host removes a bot mid match.
		botRemovedDetail: (botName: string): string => `${botName} removed from the match`,
		// ── Rated or Casual (2026-10 item 254, Arcade 6) ──
		casual: {
			toggleLabel: (isCasual: boolean): string => (isCasual ? "Make it rated" : "Make it casual"),
			cardLine: "🎲 Casual: Dero bots fill the empty seats, and each person who joins before the start takes one bot's seat.",
			// The admin log's detail for a bot seat that changed through the Casual choice.
			logFilled: (bots: number): string => `Casual table: ${bots === 1 ? "1 Dero bot" : `${bots} Dero bots`}`,
			logCleared: "Rated table: every Dero bot removed",
			logSwapped: (bots: number): string => `A player took a Dero bot's seat, ${bots === 1 ? "1 bot" : `${bots} bots`} left`,
		},
		// Words drawn into the challenge card's picture (2026-10 item 243 Phase 4).
		// A picture cannot carry a mention, so it names nobody by id; the embed
		// text above it still does.
		cardImage: {
			kicker: (game: GameSlug): string => `${(GAME_LABELS[game] ?? game).toUpperCase()} CHALLENGE`,
			versus: "VS",
			// The badge pill beside the status (2026-10 item 254, Arcade 5), named by
			// challengeBoardEmbeds.challengeBadge like the embed's badge line.
			badge: { rated: "RATED", casual: "CASUAL" },
			waiting: "Waiting for challengers",
			more: (count: number): string => `+${count} more`,
			status: {
				choosing: "SETTING UP",
				invite: "INVITE ONLY",
				open: "OPEN TO ALL",
				started: "UNDER WAY",
				cancelled: "CALLED OFF",
				// The card after the match (item 21), or after a round against Dero (item 13).
				finished: "FINISHED",
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
		// Start and Play Dero are the host's alone, admins included (post-launch plan
		// item 18), so the refusal says exactly that rather than "the host or an admin".
		onlyHostStarts: "Only the host can start this match.",
		alreadyJoined: "You already joined this one.",
		hostCannotJoin: "You are the host. You are already in.",
		poolEmpty: "Nobody has joined yet, so there is nobody to play against.",
		poolFull: (max: number): string => `This challenge already has ${max} members. Start it or call it off.`,
		needVisibility: "Choose who can see the room first.",
		draftGone: "That challenge is no longer open.",
	},

	// ── the games, played inside a room (Phase 4) ──
	games: {
		// A player Discord no longer resolves, on the Dero die card (2026-10 item 250 Phase 5).
		unknownPlayer: "A player",
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
		// The same opener when the member chose the shelf at the 🕹️games category start.
		// Names the shelf, never the word (risk R12).
		soloCategoryOpener: (categoryLabel: string, hint: string): string =>
			[`Dero picked a word from **${categoryLabel}**.`, "", `**Hint:** ${hint}`, "", "Guess a letter."].join("\n"),

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
				? `<@${authorId}> set the word. Everyone else guesses with the button below.`
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

		// ── setup (post-launch plan item 17) ──
		// Dero lays both fleets at open; each captain may re-lay theirs, then locks it
		// in with Ready. The public lines name who is ready and never where anything is.
		setupLine: (players: { userId: string; ready: boolean }[]): string =>
			[
				"⚓ **Setup.** Dero laid both fleets. Press **View my board** to see yours, **Randomize** to lay it again, then **Ready**. The first shot waits for both captains.",
				"",
				...players.map((player) => (player.ready ? `✅ <@${player.userId}> is ready.` : `⏳ <@${player.userId}> is still laying their fleet.`)),
			].join("\n"),
		readyLabel: "Ready",
		randomizeLabel: "Randomize",
		readyLine: (userId: string): string => `⚓ <@${userId}> is ready.`,
		battleBegins: (firstId: string): string => `🎯 Both fleets are laid. <@${firstId}> fires first.`,
		setupTimedOut: "⏳ Setup time is up. The fleets sail as Dero laid them.",
		setupFirst: "Both captains have to press Ready before the first shot.",
		alreadyReady: "You are ready, so your fleet is locked in.",
		setupOver: "Setup is over. The fleets are where they are.",
		cardSetup: "Laying the fleets",
		// The private view's modal (item 16). Discord caps a modal title at 45 characters.
		privateModalTitle: "Your own waters",
		privateSetupHint: "Not happy with it? Close this and press Randomize. Happy? Press Ready.",

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
		// A table that plays for wallet chips (2026-10 item 250 Phase 5): the host's one buy
		// in comes out of each player's wallet and their stack goes back when they leave.
		chipsJoiningLine: (table: { seated: number; seatCap: number; buyIn: number; smallBlind: number; bigBlind: number }): string =>
			`Buy in for **${chipAmount(table.buyIn)}** from your wallet to take a seat. ${table.seated} of ${table.seatCap} seated so far, blinds start at ${table.smallBlind} and ${table.bigBlind}. Your stack goes back to your wallet when you leave or the table ends. Need chips? \`/claim\`.`,
		handLine: (hand: number, small: number, big: number): string => `Hand ${hand} · blinds ${small}/${big}`,
		finishedLine: (winnerId: string | null): string =>
			winnerId ? `👑 <@${winnerId}> takes the tournament.` : "The tournament is over.",

		allInTag: "all in",
		foldedTag: "folded",
		bustedTag: "out",
		sittingOutTag: "sitting out",

		// The clock lines under the board, as Discord relative timestamps so every
		// reader sees them count down. The turn clock starts when the board shows the
		// player their turn (BOT_CONSTANTS.HOLDEM_TURN_TIMEOUT_MS).
		turnClockLine: (userId: string, deadlineMs: number): string =>
			`⏳ <@${userId}> to act. Time runs out ${discordRelativeTime(deadlineMs)}.`,
		nextHandLine: (dueMs: number): string =>
			`🃏 The next hand deals itself ${discordRelativeTime(dueMs)}. The host can deal it now.`,
		// Between hands with fewer than two players at the table, the deal waits for a
		// player to come back rather than deal a hand nobody is there to play.
		nextHandWaitingLine: "🃏 The next hand waits until two players are back at the table. The host can still deal it.",

		buyInLabel: (stack: number): string => `Buy in (${stack})`,
		chipsBuyInLabel: (amount: number): string => `Buy in (${chipAmount(amount)})`,
		setBuyInLabel: "Set the buy in",
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
		imBackLabel: "I'm back",

		yourCardsTitle: "🂠 Your hand",
		// The private view modal's title (post-launch plan item 16). A modal title is
		// plain text with a 45 character cap, so no card back glyph.
		yourCardsModalTitle: "Your hand",
		noCardsYet: "You have no cards. Wait for the next deal.",
		yourStack: (stack: number): string => `Your stack: **${stack}**`,

		// ── refusals ──
		notSeated: "You are not in this tournament.",
		notSittingOut: "You are already playing. I'm back is for a seat that sits out.",
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
		// Dero closing a table only its bots are left at (2026-10 item 250 Phase 5).
		botsOnlyEnded: "🏁 Every member has left the table, so Dero closes it. The bots go back in the box.",
		// ── the chip buy in (2026-10 item 250 Phase 5) ──
		notEnoughChips: (buyIn: number): string => `The buy in is **${chipAmount(buyIn)}** and your wallet holds less. \`/claim\` your chips, then buy in again.`,
		buyInChanged: "The host changed the buy in as you sat down. Press Buy in again.",
		// Added after any refusal that came after the buy in left the wallet.
		buyInBack: "Your buy in went back to your wallet.",
		buyInModalTitle: "Set the buy in",
		buyInPresetLabel: "Buy in",
		buyInPresetOption: (amount: number): string => chipAmount(amount),
		buyInCustomLabel: "Or type another amount",
		buyInCustomPlaceholder: "for example 7500 or 7.5k",
		buyInInvalid: (min: number, max: number): string => `A buy in is a whole number of chips from ${min.toLocaleString("en-US")} to ${max.toLocaleString("en-US")}.`,
		buyInLocked: "Somebody already bought in, so the buy in stays as it is.",
		buyInFreeTable: "This table plays for table chips only, so it has no buy in to set.",

		// ── the trail ──
		seatTaken: (userId: string, seated: number): string => `🪙 <@${userId}> bought in. ${seated} at the table.`,
		chipsSeatTaken: (userId: string, buyIn: number, seated: number): string => `🪙 <@${userId}> bought in for ${chipAmount(buyIn)}. ${seated} at the table.`,
		buyInSet: (hostId: string, buyIn: number): string => `🪙 <@${hostId}> set the buy in to ${chipAmount(buyIn)}.`,
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
		// The second timeout in a row (BOT_CONSTANTS.HOLDEM_SIT_OUT_TIMEOUTS).
		satOut: (userId: string): string =>
			`💤 <@${userId}> ran out of time twice in a row and sits out. They post their blinds and fold each hand until they press I'm back.`,
		sittingOutFolded: (userId: string): string => `💤 <@${userId}> is sitting out and folds.`,
		backAtTable: (userId: string): string => `👋 <@${userId}> is back at the table.`,
		// One line per leave, whether or not it folded a hand. A leave that ends the
		// hand or the tournament still posts that hand's usual lines after this one.
		leftTable: (userId: string, foldedHand: boolean): string =>
			foldedHand ? `🚪 <@${userId}> folded and left the table.` : `🚪 <@${userId}> left the table.`,
		// A chip table's leave, saying what went back to the wallet.
		chipsLeftTable: (userId: string, foldedHand: boolean, stackLeft: number): string =>
			`🚪 <@${userId}> ${foldedHand ? "folded and left" : "left"} the table, and ${chipAmount(stackLeft)} went back to their wallet.`,
		// The end of a chip table: every stack still on it, back to its wallet.
		chipsReturned: (payouts: readonly { userId: string; amount: number }[]): string =>
			[`🪙 The table closed and its chips went back to the wallets:`, ...payouts.map((payout) => `<@${payout.userId}> ${chipAmount(payout.amount)}`)].join("\n"),
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

		// ── the live table card (dealerShowdownRenderer, every action) ──
		// What the table is waiting on, beside the board, and each seat's last decision
		// on its pill. The card names players by display name, never by mention.
		cardToAct: (name: string): string => `${name} to act`,
		cardBetweenHands: "Between hands",
		cardJoining: "Waiting for buy ins",
		cardFinished: "The tournament is over",
		cardBlinds: (small: number, big: number): string => `Blinds ${small}/${big}`,
		cardSittingOut: "Sitting out",
		cardFold: "Fold",
		cardCheck: "Check",
		cardCall: "Call",
		cardBet: (amount: number): string => `Bet ${amount}`,
		cardRaise: (amount: number): string => `Raise to ${amount}`,
		cardAllIn: "All in",
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
		// The same refusal with Dero bots in the count (2026-10 item 250 Phase 5).
		tooManyWithBots: (maxSeats: number, joined: number, bots: number): string =>
			`Monopoly seats at most ${maxSeats} players, counting you, and ${joined} joined with ${bots} Dero ${bots === 1 ? "bot" : "bots"} on top. Choose fewer bots with Play vs bots, then start.`,

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

		// ── the board stays last (2026-10 item 254, Arcade 8) ──
		// Over the turn's lines on the board, which carries them until the turn passes
		// and they post as one log message above the next board.
		thisTurnLabel: "This turn:",
		// Above the lines a board too long for one embed had to leave out; the turn's
		// log message still carries every one of them once the turn passes.
		earlierThisTurn: (count: number): string => `(${count} earlier ${count === 1 ? "line" : "lines"} this turn)`,

		// ── Surrender (2026-10 item 254, Arcade 12) ──
		surrenderLabel: "Surrender",
		// The private confirm, the first of the two presses.
		surrenderConfirmTitle: "Surrender this match?",
		surrenderConfirmPrompt:
			"Your chips and lots go back to the bank and you are out of the match for good. The match goes on without you. Submit to surrender.",
		surrenderDone: "You surrendered. The board shows the match going on without you.",
		surrenderStillSeated: "The board kept changing, so your seat is still in the match. Press Surrender again.",
		// Public trail lines, ahead of the engine's own forfeit line, which says where the
		// holdings went.
		surrendered: (userId: string): string => `🏳️ <@${userId}> surrendered.`,
		hostHandedOn: (userId: string): string => `👑 <@${userId}> hosts this match now.`,
		botsAloneEnd: "Only Dero bots are left, so the match ends on the standings as they are.",
		noHostLeftEnd: "Everyone left in the match already hosts another room, so the match ends on the standings as they are.",

		// ── the silent referee (2026-10 item 254, Arcade 7) ──
		// Posted once per match when the referee is on and could not speak, saying why.
		// The referee never joins a call by itself (the owner's decision 16), so each
		// line names the one press that fixes it, or says plainly that nothing can.
		refereeSilentTitle: "🔇 Dero's referee is silent",
		refereeSilent: {
			voiceOff: "Dero's voice is switched off in this server, so the referee cannot speak. A server admin can switch it on with the button below.",
			noCall: "Dero is not in a voice call, so the referee has nowhere to speak. Join a voice channel, then press the button below to bring Dero in.",
			noPlayerInCall: "Dero is in a voice call that no player in this match is in, so the referee stays quiet. A player can join that call, or bring Dero into theirs once it is free.",
			budgetSpent: "Dero's voice has spent this month's budget in this server, so the referee stays quiet until next month or until an admin raises the cap.",
		},
		enableVoiceLabel: "Enable Dero's voice",
		bringIntoCallLabel: "Bring Dero into the call",
		enableVoiceAdminOnly: "Only the server owner or an admin can switch Dero's voice on.",

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
