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

	// ── the move trail ──
	trail: {
		// A join is the one move kind posted by the room itself rather than by a game.
		joined: (actorId: string): string => `<@${actorId}> joined the room.`,
		forfeited: (actorId: string): string => `<@${actorId}> forfeited.`,
	},
} as const;
