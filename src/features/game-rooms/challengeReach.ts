import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { CHALLENGE_REACHES, type ChallengeReach, type RoomVisibility } from "./roomTypes.js";

// ── challengeReach ───────────────────────────────────────────────────
// What:  how far a server lets a host's challenge reach (2026-10 item 244 Phase 4):
//        the admin's ceiling on the visibility a host may pick, read from
//        GuildConfig.challengeReach, and the one predicate that applies it.
// Who:   the challenge card (which visibility choices it offers, and the refusal
//        on the choice itself) and RoomProvisioner.checkRoomAdmission (the refusal
//        every room open goes through: the board, a rematch, Dero's rules card).
//        /dero-config arcade reach writes the setting.
// Does NOT: decide anything about network tables. "network" allows every room "server"
//        allows; what it adds (the host's network choice, the network board) is
//        decided where those live, from networkRules.isOnNetwork (Phase 5b).

/** True for one of the three reaches. */
export function isChallengeReach(value: unknown): value is ChallengeReach {
	return (CHALLENGE_REACHES as readonly unknown[]).includes(value);
}

/** Narrow a STORED value to a reach. Anything unknown, an older row included, reads as "server", today's behavior. */
export function asChallengeReach(value: unknown): ChallengeReach {
	return isChallengeReach(value) ? value : "server";
}

/** Whether a room of this visibility is inside the server's reach. Invite and solo rooms always are. */
export function isWithinReach(reach: ChallengeReach, visibility: RoomVisibility): boolean {
	if (visibility !== "public") return true;
	return reach !== "invite-only";
}

/** The server's challenge reach. A guild with no config yet reads as "server". */
export async function readChallengeReach(guildId: string): Promise<ChallengeReach> {
	const config = await guildConfigStore.findByGuildId(guildId);
	return asChallengeReach((config as { challengeReach?: unknown } | null)?.challengeReach);
}
