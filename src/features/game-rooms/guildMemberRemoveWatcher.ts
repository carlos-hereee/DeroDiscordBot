import { Events, type Client } from "discord.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { roomTrail } from "./roomTrail.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { departMatch, leaveDraft } from "./roomDeparture.js";

// ── guildMemberRemoveWatcher ─────────────────────────────────────────
// What:  takes a departing member out of every live room they were playing in, with a
//        system line in the room saying WHY the match moved (announcement 4a).
// Who:   registered once at boot from main.ts, beside ChannelDeleteWatcher; shares
//        the GuildMembers intent the greeter already requires.
// When:  on every GuildMemberRemove, which in a busy guild is roughly one event a
//        minute, almost all of them for members in no room at all. That cadence is
//        why the lookup rides the { guildId, playerIds, endedAt } compound index
//        (see gameRoomStore.findOpenByPlayer) and why a non-participant departure
//        must cost exactly one indexed read and zero writes.
// Where: everything downstream is the room's ordinary machinery: a match in play goes
//        through the game's own departure (roomDeparture), the one its Leave, Surrender or
//        Forfeit button plays, and the rest through roomLifecycle.finish. No new mechanism. ⚠️ A SECOND
//        GuildMemberRemove LISTENER EXISTS ON PURPOSE: satelliteSeats seats out a member
//        of a network table's satellite server who leaves THAT server, and the table
//        plays on (2026-10 item 244 Phase 5a). This one only ever sees the host guild.
// How:   a departure is that player's own forfeit, NOT abandonment (owner decision D12 of
//        2026-10 item 276): a Monopoly seat surrenders and the match goes on, a Hold'em or
//        Blackjack seat leaves the table, a Battleship captain loses rated, so the survivors
//        keep their match and their result. A member waiting in someone else's draft leaves
//        it and the draft goes on (roomDeparture.leaveDraft, 2026-10 item 276): a draft's
//        joiners sit in its pool, not its playerIds, so a second small read finds them. Two
//        cases go abandoned instead: a SOLO room (the only player is gone, there is no top
//        up to pay and nobody to win), and a draft its HOST left (a challenge nobody hosts
//        has no match to score, and paying the top up for a match never played would be
//        free xp for whoever remained); finish refunds a draft's buy ins itself.

// The slice of GuildMemberRemove's payload this watcher reads. discord.js hands a
// GuildMember or PartialGuildMember; both carry these, and typing the slice keeps
// the handler drivable from a test without constructing either.
export interface DepartedMember {
	id: string;
	guild: { id: string };
}

export async function handleGuildMemberRemove(client: Client, member: DepartedMember): Promise<void> {
	const rooms = await gameRoomStore.findOpenByPlayer(member.guild.id, member.id);
	// A draft holds a joiner in its pool, and a draft being built holds them in playerIds too, so
	// one draft can answer both reads; it is left once.
	const draftsLeft = new Set<string>();

	for (const room of rooms) {
		if (room.visibility !== "solo" && room.status !== "playing" && room.hostId !== member.id) {
			draftsLeft.add(room.roomId);
			await leaveDraft(client, room, member.id);
			continue;
		}
		if (room.visibility === "solo" || room.status !== "playing") {
			// The line first, then the ending, so the transcript reads in the order the room
			// experienced it: the player left, therefore the room closes.
			await roomTrail.postMove(client, room, {
				actorId: member.id,
				kind: "system",
				text: gameRoomsCopy.trail.playerLeftGuild(member.id),
			});
			await roomLifecycle.finish(client, room, { abandoned: true });
			continue;
		}
		// ⚠️ THE GAME'S OWN DEPARTURE, never a finish naming a winner from playerIds (audit
		// P1-4): bots are never in playerIds, and only the game knows whether its match goes on.
		// It posts the line itself, since Monopoly carries it on the turn's board. One room's
		// failure is logged and never keeps the member seated in their other rooms.
		await departMatch(client, room, member.id, "leftServer").catch((error) =>
			console.error("[game-rooms] a departing member could not leave their match", { roomId: room.roomId, userId: member.id, error })
		);
	}

	const drafts = await gameRoomStore.findDraftsByPoolMember(member.guild.id, member.id);
	for (const draft of drafts.filter((candidate) => !draftsLeft.has(candidate.roomId))) {
		await leaveDraft(client, draft, member.id).catch((error) =>
			console.error("[game-rooms] a departing member could not leave a draft", { roomId: draft.roomId, userId: member.id, error })
		);
	}
}

/**
 * Bind the GuildMemberRemove listener. Called once at boot from main.ts, beside
 * registerChannelDeleteWatcher, which handles the channel half of the same class of
 * "the world changed under a live room" events.
 */
export function registerGameRoomMemberRemoveWatcher(client: Client): void {
	client.on(Events.GuildMemberRemove, (member) => {
		void handleGuildMemberRemove(client, member).catch((error) =>
			console.error("[game-rooms] member-remove sweep failed", { guildId: member.guild.id, userId: member.id, error })
		);
	});
}
