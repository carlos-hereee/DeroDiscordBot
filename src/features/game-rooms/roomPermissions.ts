import { PermissionFlagsBits } from "discord.js";
import { buildBotSelfOverwrite } from "@utils/channelOverwrites.js";
import type { RoomVisibility } from "./roomTypes.js";

// ── roomPermissions ──────────────────────────────────────────────────
// What:  the complete permission overwrite array for one game room channel, for one
//        phase of its life.
// Who:   RoomProvisioner.open (phase "playing"), and roomLifecycle.applyRoomPhase with
//        channel.permissionOverwrites.set: "finished" from finish, and "playing" again
//        when a rematch takes a finished room's channel over for its own players.
// When:  twice per room, and never again. A room's membership is fixed at open.
// Where: PURE. It takes ids and returns an array; it never touches a Guild, a channel,
//        a store or the network. That is what makes the matrix testable, and the matrix
//        is the single thing in this feature that is genuinely hard to verify by hand:
//        a wrong entry produces a channel that LOOKS right and leaks.
// How:   one entry per actor, in a deterministic order (@everyone, bot, players,
//        spectators, admin role) so a diff of two arrays reads cleanly.

export type RoomPhase = "playing" | "finished";

// The overwrite shape guild.channels.create and permissionOverwrites.set both accept.
// Declared locally rather than importing discord.js's OverwriteResolvable so the return
// value stays a plain object a test can deep-equal.
export interface RoomOverwrite {
	id: string;
	allow?: bigint[];
	deny?: bigint[];
}

export interface RoomPermissionInput {
	everyoneRoleId: string;
	botId: string;
	hostId: string;
	// Write access. Includes hostId; duplicates are tolerated and collapsed.
	playerIds: string[];
	// Explicit read-only watchers. Meaningful in "invite" visibility only.
	spectatorIds: string[];
	visibility: RoomVisibility;
	phase: RoomPhase;
	// The guild's admin role, when one has been configured. Omitted or null on a guild
	// that has not run /setup's role step.
	adminRoleId?: string | null;
}

// ── the thread bypass ─────────────────────────────────────────────────
// Denying SendMessages alone does NOT stop someone typing in a channel: they can open a
// thread on it and type there instead, which reads to every other member as a bypass of
// the exact rule the room just applied. Both flags are needed, and they travel together
// everywhere they are used, so they are named once.
const THREAD_WRITE_DENIES = [PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.SendMessagesInThreads];

export function buildRoomOverwrites(input: RoomPermissionInput): RoomOverwrite[] {
	const { everyoneRoleId, botId, hostId, visibility, phase, adminRoleId } = input;
	const locked = phase === "finished";
	const overwrites: RoomOverwrite[] = [];

	// ── @everyone ─────────────────────────────────────────────────────
	// ⚠️ THE LOAD BEARING LINE OF THE WHOLE FEATURE: the public case is ONE overwrite,
	// never one per member. A 5000 member guild costs exactly what a 50 member guild
	// costs, and Discord's own per-channel overwrite cap is never approached. Any change
	// that starts emitting a per-member entry for a public room has re-broken the thing
	// this design exists to get right.
	//
	// ⚠️ AND THE LOCK LIVES HERE, NOT ON THE PLAYERS. Removing a player's SendMessages
	// ALLOW does not stop them typing: with no explicit deny anywhere, they fall through
	// to the guild-wide @everyone base permission, which grants SendMessages in almost
	// every server. So a finished room is locked by DENYING SendMessages on @everyone,
	// which no player overwrite then re-allows. The plan's matrix says the finished row
	// is "playing minus every SendMessages allow"; taken literally that leaves an
	// invite-only finished room fully writable by its players, which contradicts the
	// phase's own completion criterion ("on finish, nobody can type"). The criterion wins.
	// "solo" deliberately shares the else branch with "invite": identical @everyone deny,
	// identical admin row below, and the spectator loop further down is invite-only so a
	// solo room can never carry a per-member watcher entry.
	if (visibility === "public") {
		overwrites.push({
			id: everyoneRoleId,
			allow: [PermissionFlagsBits.ViewChannel],
			deny: locked
				? [PermissionFlagsBits.SendMessages, ...THREAD_WRITE_DENIES]
				: [PermissionFlagsBits.SendMessages],
		});
	} else {
		overwrites.push({
			id: everyoneRoleId,
			deny: locked
				? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, ...THREAD_WRITE_DENIES]
				: [PermissionFlagsBits.ViewChannel],
		});
	}

	// ── the bot ───────────────────────────────────────────────────────
	// Required in EVERY phase and both visibilities. The room denies @everyone
	// SendMessages (public) or ViewChannel (invite), and the bot is a member of
	// @everyone like anyone else, so without its own entry it cannot post the move
	// trail into a public room and cannot see an invite-only one at all. At "finished"
	// it is also the only actor that may still write, which is what lets the result
	// card land in a channel nobody else can type in.
	overwrites.push(buildBotSelfOverwrite(botId));

	// ── players ───────────────────────────────────────────────────────
	// hostId is included in playerIds by contract, but a caller that also passes it
	// separately (or twice) must not produce two overwrites for one member: Discord
	// takes the last one, so a duplicate is a silent last-write-wins rather than an
	// error. Collapse defensively.
	const playerSet = new Set<string>([hostId, ...input.playerIds]);
	for (const playerId of playerSet) {
		overwrites.push({
			id: playerId,
			allow: locked
				? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]
				: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
		});
	}

	// ── explicit spectators ───────────────────────────────────────────
	// Invite-only rooms ONLY. A public room expresses spectatorship with the single
	// @everyone overwrite above, so emitting per-spectator entries here would quietly
	// reintroduce the O(members) cost the public case exists to avoid. A caller that
	// passes spectators alongside "public" gets them ignored, deliberately.
	//
	// The denies: SendMessages so they cannot play, plus both thread flags so they
	// cannot open a thread and type in that instead. AddReactions is NOT denied on
	// purpose, a spectator reacting to a good move is the good kind of noise and is
	// most of what watching a match is for.
	if (visibility === "invite") {
		for (const spectatorId of new Set(input.spectatorIds)) {
			// A member who is both cannot be both: write access wins, and emitting a
			// second entry for them would overwrite the player grant with a deny.
			if (playerSet.has(spectatorId)) continue;
			overwrites.push({
				id: spectatorId,
				allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
				deny: [PermissionFlagsBits.SendMessages, ...THREAD_WRITE_DENIES],
			});
		}
	}

	// ── the admin role ────────────────────────────────────────────────
	// Read-only in every phase, including "playing". Moderators need to be able to see
	// into a room to handle a report; they do not need to be able to play in someone
	// else's match, and granting SendMessages here would put an admin's stray message
	// into a transcript that is supposed to be the match.
	if (adminRoleId) {
		overwrites.push({
			id: adminRoleId,
			allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
		});
	}

	return overwrites;
}
