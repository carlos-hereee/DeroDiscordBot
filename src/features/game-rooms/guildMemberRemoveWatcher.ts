import { Events, type Client } from "discord.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { roomTrail } from "./roomTrail.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";

// ── guildMemberRemoveWatcher ─────────────────────────────────────────
// What:  ends every live room a departing member was playing in, with a system line
//        in the room saying WHY the match moved (announcement 4a).
// Who:   registered once at boot from main.ts, beside ChannelDeleteWatcher; shares
//        the GuildMembers intent the greeter already requires.
// When:  on every GuildMemberRemove, which in a busy guild is roughly one event a
//        minute, almost all of them for members in no room at all. That cadence is
//        why the lookup rides the { guildId, playerIds, endedAt } compound index
//        (see gameRoomStore.findOpenByPlayer) and why a non-participant departure
//        must cost exactly one indexed read and zero writes.
// Where: everything downstream is the room's ordinary machinery: the trail for the
//        line, roomLifecycle.finish for the ending. No new mechanism. ⚠️ A SECOND
//        GuildMemberRemove LISTENER EXISTS ON PURPOSE: satelliteSeats seats out a member
//        of a network table's satellite server who leaves THAT server, and the table
//        plays on (2026-10 item 244 Phase 5a). This one only ever sees the host guild.
// How:   a departure is treated as a forfeit from that player, NOT as abandonment:
//        the match ended, the player just ended it by leaving instead of pressing
//        Forfeit, so the survivors keep their result and the room-rate top up. The
//        two exceptions go abandoned instead: a SOLO room (the only player is gone,
//        there is no top up to pay and nobody to win), and a room that never reached
//        "playing" (a draft or open challenge has no match to score, and paying the
//        top up for a match never played would be free xp for whoever remained).

// The slice of GuildMemberRemove's payload this watcher reads. discord.js hands a
// GuildMember or PartialGuildMember; both carry these, and typing the slice keeps
// the handler drivable from a test without constructing either.
export interface DepartedMember {
	id: string;
	guild: { id: string };
}

export async function handleGuildMemberRemove(client: Client, member: DepartedMember): Promise<void> {
	const rooms = await gameRoomStore.findOpenByPlayer(member.guild.id, member.id);

	for (const room of rooms) {
		// The line first, then the ending, so the transcript reads in the order the
		// room experienced it: the player left, therefore the match ends.
		await roomTrail.postMove(client, room, {
			actorId: member.id,
			kind: "system",
			text: gameRoomsCopy.trail.playerLeftGuild(member.id),
		});

		if (room.visibility === "solo" || room.status !== "playing") {
			await roomLifecycle.finish(client, room, { abandoned: true });
			continue;
		}

		// Forfeit semantics, identical to the Forfeit button's: the winner is whoever
		// did not leave, and only when exactly one player remains. finish's own claim
		// makes this safe against racing the sweep or a simultaneous forfeit press.
		const remaining = room.playerIds.filter((id) => id !== member.id);
		await roomLifecycle.finish(client, room, {
			winnerId: remaining.length === 1 ? remaining[0] : null,
		});
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
