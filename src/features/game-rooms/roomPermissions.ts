import { PermissionFlagsBits } from "discord.js";
import { buildBotSelfOverwrite } from "@utils/channelOverwrites.js";
import type { RoomVisibility, SpectatorMode } from "./roomTypes.js";

// ── roomPermissions ──────────────────────────────────────────────────
// What:  the complete permission overwrite array for one game room channel, for one
//        phase of its life.
// Who:   RoomProvisioner.open (phase "playing"), and roomLifecycle.applyRoomPhase with
//        channel.permissionOverwrites.set: "finished" from finish, and "playing" again
//        when a rematch takes a finished room's channel over for its own players. And
//        satelliteRooms, for a network table's channels in other guilds
//        (buildSatelliteOverwrites, 2026-10 item 244 Phase 5a).
// When:  twice per room, and never again. A room's membership is fixed at open, with
//        one exception that never calls this: the host removing a member deletes that
//        member's own overwrite and nothing else (hostControls, 2026-10 item 244 Phase 4).
// Where: PURE. It takes ids and returns an array; it never touches a Guild, a channel,
//        a store or the network. That is what makes the matrix testable, and the matrix
//        is the single thing in this feature that is genuinely hard to verify by hand:
//        a wrong entry produces a channel that LOOKS right and leaks.
// How:   one entry per actor, in a deterministic order (@everyone, bot, players,
//        spectators, admin role) so a diff of two arrays reads cleanly. Who may WATCH is
//        the host's spectator setting (effectiveSpectatorMode below, 2026-10 item 254,
//        Arcade 11); who may PLAY is always the players' own entries.

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
	// Explicit read-only watchers. Meaningful only while the spectator setting is "invite".
	spectatorIds: string[];
	visibility: RoomVisibility;
	// The host's spectator setting off the row. Null or absent reads as the visibility's
	// default (effectiveSpectatorMode), which is how a room opened before the setting
	// existed keeps exactly the matrix it was opened with.
	spectatorMode?: SpectatorMode | null;
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

// ── reactions belong to the players (2026-10 item 254, Arcade 11) ──
// The owner's rule: in every room and every spectator setting, only the people playing may
// react. ONE @everyone deny carries it for everybody else (watchers, admins, invited
// spectators, whose own entries never mention the flag and so fall through to it), and the
// players' existing entries carry the allow. Never an entry per member to deny it: that is
// the O(members) cost the single @everyone overwrite exists to avoid.
const REACTION_DENIES = [PermissionFlagsBits.AddReactions];

/**
 * The spectator setting a room actually has: the host's choice off the row, or the
 * default its visibility always had when the host never chose. A solo room is "none"
 * whatever the row says, because it admits exactly one member by construction.
 *
 * The one place the default is decided, read by the matrix below, the invite rule
 * (roomInvite) and the challenge card, so the three can never disagree about who watches.
 */
export function effectiveSpectatorMode(visibility: RoomVisibility, stored: SpectatorMode | null | undefined): SpectatorMode {
	if (visibility === "solo") return "none";
	if (stored) return stored;
	return visibility === "public" ? "open" : "invite";
}

export function buildRoomOverwrites(input: RoomPermissionInput): RoomOverwrite[] {
	const { everyoneRoleId, botId, hostId, visibility, phase, adminRoleId } = input;
	const locked = phase === "finished";
	const spectators = effectiveSpectatorMode(visibility, input.spectatorMode);
	const overwrites: RoomOverwrite[] = [];

	// ── @everyone ─────────────────────────────────────────────────────
	// ⚠️ THE LOAD BEARING LINE OF THE WHOLE FEATURE: a room everyone may watch is ONE
	// overwrite, never one per member. A 5000 member guild costs exactly what a 50 member
	// guild costs, and Discord's own per-channel overwrite cap is never approached. Any
	// change that starts emitting a per-member entry for watchers has re-broken the thing
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
	//
	// Open to spectators is the only setting that lets @everyone see the room, whatever
	// the visibility; Invite only and No spectators both hide it, the first then showing it
	// to the invited spectators below. A solo room is always No spectators.
	if (spectators === "open") {
		overwrites.push({
			id: everyoneRoleId,
			allow: [PermissionFlagsBits.ViewChannel],
			deny: locked
				? [PermissionFlagsBits.SendMessages, ...THREAD_WRITE_DENIES, ...REACTION_DENIES]
				: [PermissionFlagsBits.SendMessages, ...REACTION_DENIES],
		});
	} else {
		overwrites.push(hiddenEveryoneOverwrite(everyoneRoleId, locked));
	}

	// ── the bot ───────────────────────────────────────────────────────
	// Required in EVERY phase and every setting. The room denies @everyone
	// SendMessages (open) or ViewChannel (hidden), and the bot is a member of
	// @everyone like anyone else, so without its own entry it cannot post the move
	// trail into an open room and cannot see a hidden one at all. At "finished"
	// it is also the only actor that may still write, which is what lets the result
	// card land in a channel nobody else can type in.
	overwrites.push(buildBotSelfOverwrite(botId));

	// ── players ───────────────────────────────────────────────────────
	// hostId is included in playerIds by contract, but a caller that also passes it
	// separately (or twice) must not produce two overwrites for one member: Discord
	// takes the last one, so a duplicate is a silent last-write-wins rather than an
	// error. Collapse defensively.
	const playerSet = new Set<string>([hostId, ...input.playerIds]);
	for (const playerId of playerSet) overwrites.push(playerOverwrite(playerId, locked));

	// ── explicit spectators ───────────────────────────────────────────
	// The Invite only setting ONLY. Open to spectators expresses watching with the single
	// @everyone overwrite above, so emitting per-spectator entries there would quietly
	// reintroduce the O(members) cost it exists to avoid, and No spectators has nobody to
	// list. A caller that passes spectators under either gets them ignored, deliberately.
	//
	// The denies: SendMessages so they cannot play, plus both thread flags so they
	// cannot open a thread and type in that instead. AddReactions is denied to them by the
	// @everyone entry, which their entry never re-allows.
	if (spectators === "invite") {
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
	if (adminRoleId) overwrites.push(adminReadOnlyOverwrite(adminRoleId));

	return overwrites;
}

// ── the entries a satellite shares with a room ────────────────────────
// Named once because a satellite (below) is built from the same three entries as an
// invite room, and a second copy of any of them is a second matrix to keep in step.

// A private channel's @everyone entry: invisible while playing, and once locked also
// unwritable, threads included, for the lock reason the @everyone note above gives. It
// carries the reactions deny too, since an admin or an invited spectator who can see the
// channel falls through to it.
function hiddenEveryoneOverwrite(everyoneRoleId: string, locked: boolean): RoomOverwrite {
	return {
		id: everyoneRoleId,
		deny: locked
			? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, ...THREAD_WRITE_DENIES, ...REACTION_DENIES]
			: [PermissionFlagsBits.ViewChannel, ...REACTION_DENIES],
	};
}

// A player may react while the match is played, the allow that beats the @everyone
// reactions deny. Once locked nobody reacts, the same line the SendMessages lock draws.
function playerOverwrite(playerId: string, locked: boolean): RoomOverwrite {
	return {
		id: playerId,
		allow: locked
			? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]
			: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AddReactions],
	};
}

function adminReadOnlyOverwrite(adminRoleId: string): RoomOverwrite {
	return { id: adminRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] };
}

// ── a satellite's matrix (2026-10 item 244 Phase 5a) ──────────────────
export interface SatellitePermissionInput {
	// The REMOTE guild's @everyone role, never the host guild's.
	everyoneRoleId: string;
	botId: string;
	// The members of the remote guild seated through this satellite.
	playerIds: readonly string[];
	phase: RoomPhase;
	// The remote guild's own admin role, when it has one.
	adminRoleId?: string | null;
}

/**
 * The overwrite set for one satellite channel: an invite room whose players are the
 * remote guild's seated members, with no host entry, because the host is a member of
 * another guild and a member overwrite needs a member of this one.
 *
 * ⚠️ PLAYERS ONLY, AND NO @everyone ALLOW IN ANY PHASE. A satellite is a window onto a
 * table hosted elsewhere, so nobody else in the remote guild sees it, whatever the host
 * room's own visibility: a public host room's single @everyone allow is the host
 * guild's, and copying it here would show a stranger's table to a whole other server.
 * The admin role reads, as it does in every room, so a moderator can see what their
 * members are part of.
 */
export function buildSatelliteOverwrites(input: SatellitePermissionInput): RoomOverwrite[] {
	const locked = input.phase === "finished";
	return [
		hiddenEveryoneOverwrite(input.everyoneRoleId, locked),
		buildBotSelfOverwrite(input.botId),
		...[...new Set(input.playerIds)].map((playerId) => playerOverwrite(playerId, locked)),
		...(input.adminRoleId ? [adminReadOnlyOverwrite(input.adminRoleId)] : []),
	];
}
