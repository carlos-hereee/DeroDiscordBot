import type { ChallengeReach } from "@features/game-rooms/roomTypes.js";

// ── ratingsCopy ──────────────────────────────────────────────────────
// Admin facing copy for the arcade settings (2026-10 item 244 Phases 3b and 4):
// the `/dero-config arcade` group's descriptions and its ephemeral replies, for
// the monthly post and the challenge reach. Plain and practical, the bot's rule
// for admin copy, so it lives here rather than in the copy packs. What MEMBERS
// read (/rating, the monthly post, the host controls) lives in the packs under
// arcadeRatings and arcadeHostControls.

// The admin facing name of each challenge reach, for the reach option's choices
// and its replies.
const REACH_NAMES: Record<ChallengeReach, string> = {
	"invite-only": "Invite only",
	server: "Server",
	network: "Network",
};

export const ratingsCopy = {
	config: {
		group: "Arcade settings: the monthly arcade post and challenge reach",
		monthlyPost: "Post last month's arcade highlights in the leaderboard channel on the 1st",
		monthlyPostOption: "On to post every month, off to stay quiet",
		title: "🎮 Arcade settings",
		monthlyPostSet: (on: boolean): string =>
			on
				? "Monthly arcade post: **ON**. On the 1st of each month, last month's top winning hands, top rated players and luckiest player post in the leaderboard channel."
				: "Monthly arcade post: **OFF**. Nothing posts on the 1st. Ratings and boards keep counting, and `/rating` still answers.",
		monthlyPostUnchanged: (on: boolean): string => `The monthly arcade post is already **${on ? "ON" : "OFF"}**. Nothing changed.`,

		// ── challenge reach (2026-10 item 244 Phase 4) ──
		// Network is accepted and stored now; until network tables exist it allows
		// exactly what Server does, and the reply says so rather than promising them.
		reach: "Choose how far a host's challenge may reach: invite only, this server, or the network",
		reachOption: "Invite only rooms, public rooms in this server, or network tables when they arrive",
		reachName: (reach: ChallengeReach): string => REACH_NAMES[reach],
		reachSet: (reach: ChallengeReach): string => {
			if (reach === "invite-only") {
				return "Challenge reach: **Invite only**. Hosts can open invite only rooms; Open to all is no longer offered and is refused, including a rematch of a public room. Matches already playing are not changed.";
			}
			if (reach === "server") {
				return "Challenge reach: **Server**. Hosts can open invite only rooms or rooms open to the whole server.";
			}
			return "Challenge reach: **Network**. Saved. Until network tables arrive, hosts can open invite only rooms or rooms open to the whole server, the same as Server.";
		},
		reachUnchanged: (reach: ChallengeReach): string => `Challenge reach is already **${REACH_NAMES[reach]}**. Nothing changed.`,
		reachUnknown: "That is not a challenge reach. Choose Invite only, Server or Network. Nothing changed.",
	},
};
