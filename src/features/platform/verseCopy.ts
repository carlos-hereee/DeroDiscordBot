import { GAME_SLUGS, type GameSlug } from "@features/game-rooms/roomTypes.js";
import { gameRoomsCopy } from "@features/game-rooms/gameRoomsCopy.js";
import type { VerseProgress } from "./verseProgress.js";

// ── verse copy ───────────────────────────────────────────────────────
// Every string /platform verse shows. Feature local and outside the copy packs, like
// renderAnalyticsCopy, because only the platform owner ever reads it and it has no
// kingdom or streamer voice to choose between (bot rule 5 lets admin facing ephemeral
// copy be practical). It formats; it computes nothing.

const isGameSlug = (game: string): game is GameSlug => (GAME_SLUGS as readonly string[]).includes(game);

const count = (value: number): string => value.toLocaleString("en-US");

export const verseCopy = {
	command: {
		description: "The Verse in counts: players, servers, games completed and Dero coins collected",
	},
	title: "🌌 The Verse",
	errors: {
		notOwner: "Only the platform owner can read the Verse.",
		readFailed: "Dero could not read the Verse just now. Try again in a moment.",
	},
	/** The embed description for a read: the four counts, the games by game, and the privacy line. */
	describe: (progress: VerseProgress): string =>
		[
			`**Players:** ${count(progress.players)} (${count(progress.monthlyActivePlayers)} active in the last 30 days)`,
			`**Servers:** ${count(progress.servers.setUp)} set up, ${count(progress.servers.onNetwork)} on the network`,
			`**Games completed:** ${count(progress.gamesCompleted.total)}`,
			...progress.gamesCompleted.byGame.map((row) => `• ${isGameSlug(row.game) ? gameRoomsCopy.gameLabel(row.game) : row.game}: ${count(row.count)}`),
			`**Dero coins collected:** ${count(progress.coins.total)} in total, ${count(progress.coins.thisMonth)} this month (UTC)`,
			"",
			"Only you see this. It is never posted anywhere.",
		].join("\n"),
};
