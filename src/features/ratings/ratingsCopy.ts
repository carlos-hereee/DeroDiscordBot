import type { ChallengeReach } from "@features/game-rooms/roomTypes.js";

// ── ratingsCopy ──────────────────────────────────────────────────────
// Admin facing copy for the arcade settings (2026-10 item 244 Phases 3b, 4 and 5b):
// the `/dero-config arcade` group's descriptions and its ephemeral replies, for
// the monthly post, the challenge reach and the network block list. Plain and practical, the bot's rule
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
		group: "Arcade settings: the monthly post, challenge reach, network block list and bot opponents",
		monthlyPost: "Post last month's arcade highlights in the leaderboard channel on the 1st",
		monthlyPostOption: "On to post every month, off to stay quiet",
		title: "🎮 Arcade settings",
		monthlyPostSet: (on: boolean): string =>
			on
				? "Monthly arcade post: **ON**. On the 1st of each month, last month's top winning hands, top rated players and luckiest player post in the leaderboard channel."
				: "Monthly arcade post: **OFF**. Nothing posts on the 1st. Ratings and boards keep counting, and `/rating` still answers.",
		monthlyPostUnchanged: (on: boolean): string => `The monthly arcade post is already **${on ? "ON" : "OFF"}**. Nothing changed.`,

		// ── bot opponents (2026-10 item 250 Phase 5) ──
		bots: "Let a challenge host fill empty seats with Dero bots",
		botsOption: "On to offer Play vs bots to challenge hosts, off to keep every seat for members",
		botsSet: (on: boolean): string =>
			on
				? "Dero bot opponents: **ON**. Hold'em, Monopoly and Battleship challenge cards offer Play vs bots to their host. Matches with a bot are never rated."
				: "Dero bot opponents: **OFF**. New challenge cards do not offer Play vs bots, and a press on an older card is refused. Matches already playing keep their bots.",
		botsUnchanged: (on: boolean): string => `Dero bot opponents are already **${on ? "ON" : "OFF"}**. Nothing changed.`,

		// ── challenge reach (2026-10 item 244 Phase 4, network tables in Phase 5b) ──
		reach: "Choose how far a host's challenge may reach: invite only, this server, or the network",
		reachOption: "Invite only rooms, public rooms in this server, or tables open to other network servers",
		reachName: (reach: ChallengeReach): string => REACH_NAMES[reach],
		reachSet: (reach: ChallengeReach): string => {
			if (reach === "invite-only") {
				return "Challenge reach: **Invite only**. Hosts can open invite only rooms; Open to all is no longer offered and is refused, including a rematch of a public room. Matches already playing are not changed.";
			}
			if (reach === "server") {
				return "Challenge reach: **Server**. Hosts can open invite only rooms or rooms open to the whole server.";
			}
			return "Challenge reach: **Network**. Hosts can also open a Hold'em table to players from other network servers, and a network board in the challenges channel lists other servers' open tables. Each player accepts a one time network notice before anything of theirs is shown in another server. Block a server with `/dero-config arcade block-server`.";
		},
		reachUnchanged: (reach: ChallengeReach): string => `Challenge reach is already **${REACH_NAMES[reach]}**. Nothing changed.`,
		reachUnknown: "That is not a challenge reach. Choose Invite only, Server or Network. Nothing changed.",

		// ── the network block list (2026-10 item 244 Phase 5b) ──
		// Both directions at once: a blocked server's tables are not listed here, and its
		// members cannot sit at this server's tables.
		blockServer: "Keep one server off this server's network tables, both ways",
		unblockServer: "Let a blocked server share network tables with this server again",
		serverIdOption: "The server's id (Developer Mode, then right click the server icon, Copy Server ID)",
		blockTitle: "🌐 Network block list",
		serverIdInvalid: "That is not a server id. A server id is 17 to 20 digits. Nothing changed.",
		blockSelf: "That is this server's own id. Nothing changed.",
		blocked: (serverId: string): string =>
			`Blocked server \`${serverId}\`. Its tables are no longer listed on this server's network board, and its members cannot sit at this server's tables. Seats already taken between the two servers, both ways, leave their tables now.`,
		alreadyBlocked: (serverId: string): string => `Server \`${serverId}\` is already blocked. Nothing changed.`,
		unblocked: (serverId: string): string => `Unblocked server \`${serverId}\`. It shares network tables with this server again.`,
		notBlocked: (serverId: string): string => `Server \`${serverId}\` is not blocked. Nothing changed.`,
	},
};
