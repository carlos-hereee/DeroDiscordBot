// ── botSeatId ────────────────────────────────────────────────────────
// Whether an id names a Dero bot seat rather than a member (2026-10 item 250 Phase 5).
// In the shared region because three features ask it and none may import another for
// it: leveling (a bot earns no XP), ratings (a match with a bot is never rated) and game
// rooms (which build the ids, in features/game-rooms/botSeat.ts). Pure, imports nothing.
//
// A bot seat id is `dero-bot-<variant>`. A Discord snowflake is digits only, so the two
// can never collide, and a bot id never reaches a call that expects a member.

/** Every bot seat id starts with this. */
export const BOT_SEAT_PREFIX = "dero-bot-";

/** Whether an id names a Dero bot seat rather than a member. */
export function isBotSeatId(id: string | null | undefined): boolean {
	return typeof id === "string" && id.startsWith(BOT_SEAT_PREFIX);
}
