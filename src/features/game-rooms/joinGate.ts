import { playerRatingStore } from "@db/stores/playerRatingStore.js";
import { fitsBand, isRatedGame, UNRATED_STANDING, type RatingStanding } from "@features/ratings/ratingEngine.js";
import { hasNetworkConsent } from "./networkConsent.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── joinGate ─────────────────────────────────────────────────────────
// What:  the one answer to "may this member join this room?" under the host's
//        controls (2026-10 item 244 Phase 4): refused if the host removed them or
//        their rating sits outside the host's band, asked to wait when the host
//        approves each joiner, admitted otherwise. At a network table (Phase 5b) a
//        member who has not accepted the network notice is refused first, because a
//        seat there shows their name and moves in other servers.
// Who:   every door into a room: the challenge card's Join, Hold'em's Buy in and
//        Take a seat inside the room, and the network board's request for a seat
//        from another server (networkJoin, Phase 5b). ONE function, so no door can forget a
//        rule the others apply; the host's own invite picker filters removed
//        members through invitePicker instead, since the host is the one choosing.
// Does NOT: write anything, check seats, pool caps or turn order (each door's own
//        job), or decide who the host is (the caller's gate).

/** Why a join was refused. "noConsent" sends the member to the network notice rather than away. */
export type JoinRefusal = "kicked" | "outsideBand" | "noConsent";

/** What a join attempt earns: in, a request for the host, or a refusal and why. */
export type JoinVerdict = { kind: "admit" } | { kind: "ask" } | { kind: "refuse"; reason: JoinRefusal };

/** The slice of a room row the gate reads. `network` is optional so an older caller's slice reads as a server room. */
export type JoinGateRoom = Pick<IGameRoom, "guildId" | "roomId" | "game" | "hostId" | "ratingBand" | "requireApproval" | "kickedIds"> &
	Partial<Pick<IGameRoom, "network">>;

/** True when the host removed this member from the room. Absent kickedIds (an older row) removes nobody. */
export function isKicked(room: Pick<IGameRoom, "kickedIds">, userId: string): boolean {
	return (room.kickedIds ?? []).includes(userId);
}

/** True when the room's band can refuse anybody: a rated game banded tighter than Any. */
export function hasActiveBand(room: Pick<IGameRoom, "game" | "ratingBand">): boolean {
	return isRatedGame(room.game) && (room.ratingBand ?? "any") !== "any";
}

/**
 * Whether the joiner's rating in this room's game fits the host's band, against the
 * host's own rating in the same game. A player with no rated result yet stands at the
 * fresh, provisional rating, which fitsBand admits to any band.
 *
 * ⚠️ FAILS OPEN ON A READ ERROR, deliberately. A band is the host's preference about
 * a fair match, not a security boundary (kickedIds is that, and it costs no read), so
 * a ratings read that fails admits the joiner with a log line rather than locking
 * every joiner out of every banded table while the database is having a moment.
 */
export async function fitsRoomBand(room: JoinGateRoom, joinerId: string): Promise<boolean> {
	if (!hasActiveBand(room)) return true;
	try {
		const stored = await playerRatingStore.findForPlayers([room.hostId, joinerId], room.game);
		const standingOf = (userId: string): RatingStanding => {
			const row = stored.find((entry) => entry.userId === userId);
			return row ? { displayRating: row.displayRating, ratedGames: row.ratedGames } : UNRATED_STANDING;
		};
		return fitsBand(standingOf(room.hostId), standingOf(joinerId), room.ratingBand);
	} catch (error) {
		console.warn("[game-rooms] rating band read failed, admitting the joiner", { guildId: room.guildId, roomId: room.roomId, error });
		return true;
	}
}

/**
 * Judge one join attempt, in this order: ① a removed member is refused, whoever they
 * are; ② at a network table, a member without network consent is refused, even one the
 * room already let in, since consent is about what other servers see, not about the
 * host's say; ③ a member the room already let in (the draft's pool, or a live room's
 * players) is admitted without asking twice, since they passed the band and the host's
 * answer on the way in; ④ a rating outside the band is refused; ⑤ a room whose host
 * approves each joiner asks; ⑥ everybody else is admitted.
 *
 * The band comes before the approval on purpose: asking the host to answer a request
 * the band would refuse anyway only spends their attention on a no.
 */
export async function judgeJoin(room: JoinGateRoom, joinerId: string, options: { alreadyApproved: boolean }): Promise<JoinVerdict> {
	if (isKicked(room, joinerId)) return { kind: "refuse", reason: "kicked" };
	// Only a network table reads consent, so every server room keeps its old cost: no read.
	if (room.network && !(await hasNetworkConsent(joinerId))) return { kind: "refuse", reason: "noConsent" };
	if (options.alreadyApproved) return { kind: "admit" };
	if (!(await fitsRoomBand(room, joinerId))) return { kind: "refuse", reason: "outsideBand" };
	if (room.requireApproval) return { kind: "ask" };
	return { kind: "admit" };
}
