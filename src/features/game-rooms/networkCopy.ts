import type { NetworkBanKind } from "@db/models/NetworkBan.js";

// ── networkCopy ──────────────────────────────────────────────────────
// Owner facing copy for the network bans (2026-10 item 244 Phase 5b): the /platform
// network group's descriptions and its ephemeral replies. Only the platform owner ever reads
// these, so they are plain and practical, the bot's rule for admin copy, and live here
// rather than in the copy packs. What MEMBERS read about the network lives in the
// packs under arcadeNetwork.

const KIND_NAMES: Record<NetworkBanKind, string> = {
	user: "member",
	guild: "server",
};

export const networkCopy = {
	command: {
		// /platform itself (commands/admin/platform.ts), whose network group is this file's.
		platformDescription: "Platform owner only: network bans, render analytics and the Verse's counts",
		description: "Keep a member or a server off every network table",
		ban: "Ban a member or a server from network tables",
		unban: "Lift a network ban",
		targetOption: "Whether the ban names a member or a server",
		targetChoices: { member: "A member", server: "A server, by its id" },
		userOption: "The member, when the target is a member",
		serverOption: "The server's id, when the target is a server",
		reasonOption: "A note for yourself, shown only to you",
	},
	title: "🌐 Network bans",
	notOwner: "Only the platform owner can manage network bans.",
	serverIdInvalid: "That is not a server id. A server id is 17 to 20 digits. Nothing changed.",
	// The target names which option the ban reads; that option left empty is refused, never guessed.
	missingTargetOption: (target: "member" | "server"): string =>
		target === "member" ? "The target is a member, so pick them in the user option. Nothing changed." : "The target is a server, so type its id in the server option. Nothing changed.",
	unknownSubcommand: (name: string): string => `Unknown subcommand: ${name}.`,
	banned: (kind: NetworkBanKind, label: string): string =>
		kind === "user"
			? `Banned member ${label} from network tables. The network board stops listing them and refuses every new seat they ask for. Their seats at network tables hosted elsewhere leave those tables now, and so do other servers' seats at the network tables they host. A room in their own server keeps them.`
			: `Banned server ${label} from network tables. The network board stops listing it and refuses its members' new seats. Its members' seats at network tables elsewhere leave those tables now, and so do other servers' seats at the network tables it hosts.`,
	alreadyBanned: (kind: NetworkBanKind, label: string): string => `That ${KIND_NAMES[kind]} (${label}) is already banned. Nothing changed.`,
	unbanned: (kind: NetworkBanKind, label: string): string => `Lifted the network ban on ${KIND_NAMES[kind]} ${label}.`,
	notBanned: (kind: NetworkBanKind, label: string): string => `That ${KIND_NAMES[kind]} (${label}) is not banned. Nothing changed.`,
	saveFailed: "The ban list could not be saved just now. Nothing changed. Try again in a moment.",
};
