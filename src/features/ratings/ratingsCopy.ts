// ── ratingsCopy ──────────────────────────────────────────────────────
// Admin facing copy for the arcade ratings settings (2026-10 item 244 Phase 3b):
// the `/dero-config arcade` group's descriptions and its ephemeral replies. Plain
// and practical, the bot's rule for admin copy, so it lives here rather than in
// the copy packs. What MEMBERS read (/rating, the monthly post) lives in the packs
// under arcadeRatings.

export const ratingsCopy = {
	config: {
		group: "Arcade settings: the monthly arcade post",
		monthlyPost: "Post last month's arcade highlights in the leaderboard channel on the 1st",
		monthlyPostOption: "On to post every month, off to stay quiet",
		title: "🎮 Arcade settings",
		monthlyPostSet: (on: boolean): string =>
			on
				? "Monthly arcade post: **ON**. On the 1st of each month, last month's top winning hands, top rated players and luckiest player post in the leaderboard channel."
				: "Monthly arcade post: **OFF**. Nothing posts on the 1st. Ratings and boards keep counting, and `/rating` still answers.",
		monthlyPostUnchanged: (on: boolean): string => `The monthly arcade post is already **${on ? "ON" : "OFF"}**. Nothing changed.`,
	},
};
