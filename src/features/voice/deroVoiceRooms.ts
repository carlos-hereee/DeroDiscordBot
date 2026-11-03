import { deroVoiceConfigStore } from "@db/stores/deroVoiceConfigStore.js";

// ── Dero's own voice rooms on his voice allow list ──────────────────────────
// What:  puts the voice rooms Dero builds (🏛️ Meeting Hall and 🎮 Arcade Lounge) on
//        DeroVoiceConfig.allowedVoiceChannelIds, and takes them off again, so Dero
//        may join the rooms he made out of the box (2026-10 item 257, owner item 8).
// Who:   GuildSetupManager (a full build, and the repair of one room) adds them;
//        self destruct removes them.
// Where: the allow list is the gate /dero join reads. Joining is all it unlocks:
//        Dero hears a member only while the master voice switch is on AND that
//        member passes the speaker allow list (voiceListener's operator gate), so
//        a room on this list transcribes nobody by itself. The master switch keeps
//        its default, off, because voice costs money. A later feature that
//        transcribes a whole room still needs its own consent design and must not
//        lean on this list (the item 235 plan's R3).
// How:   $addToSet and $pull, one id at a time, so an id is never listed twice and
//        an admin's own entries are never touched. Fire and forget after the
//        primary write (rulebook convention 7): every failure logs and never throws.

/** The GuildConfig fields that hold Dero's own voice rooms. */
export const DERO_VOICE_ROOM_FIELDS = ["meetingVoiceChannelId", "arcadeVoiceChannelId"] as const;

type MaybeId = string | null | undefined;

function presentIds(ids: ReadonlyArray<MaybeId>): string[] {
	return ids.filter((id): id is string => typeof id === "string" && id.length > 0);
}

/** Add each of Dero's voice rooms to the guild's voice allow list. Never throws. */
export async function allowDeroVoiceRooms(guildId: string, ids: ReadonlyArray<MaybeId>): Promise<void> {
	for (const id of presentIds(ids)) {
		await deroVoiceConfigStore
			.addToList(guildId, "allowedVoiceChannelIds", id)
			.catch((error: unknown) => console.warn(`[dero-voice] adding Dero's voice room ${id} to the allow list of guild ${guildId} failed`, error));
	}
}

/** Take each of Dero's voice rooms off the guild's voice allow list. Never throws. */
export async function revokeDeroVoiceRooms(guildId: string, ids: ReadonlyArray<MaybeId>): Promise<void> {
	for (const id of presentIds(ids)) {
		await deroVoiceConfigStore
			.removeFromList(guildId, "allowedVoiceChannelIds", id)
			.catch((error: unknown) => console.warn(`[dero-voice] removing Dero's voice room ${id} from the allow list of guild ${guildId} failed`, error));
	}
}

/**
 * A rebuilt room has a new id: the old one (a channel that no longer exists) comes
 * off and the new one goes on. Never throws.
 */
export async function replaceDeroVoiceRoom(guildId: string, previousId: MaybeId, nextId: string): Promise<void> {
	if (previousId && previousId !== nextId) await revokeDeroVoiceRooms(guildId, [previousId]);
	await allowDeroVoiceRooms(guildId, [nextId]);
}
