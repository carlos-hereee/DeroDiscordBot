// ── How long an entitlement answer lives ──
// What:  the cache lifetimes shared by serverPlanAccess.ts and gameRoomAccess.ts, and the tier
//        key that marks an uncovered answer. One home, so a server's voice ceiling and its room
//        limit notice a purchase on the same clock (2026-11 item 424).
// Not:   a cache. Each module keeps its own map and decides for itself what an error falls to.

/**
 * A confirmed answer. An hour, because a plan change is rare and a voice click or a room button
 * should not wait on Heroku. After a cancel the delay therefore runs up to an hour, in the
 * customer's favor.
 */
export const CONFIRMED_TTL_MS = 60 * 60 * 1000;

/**
 * A confirmed UNCOVERED answer. Five minutes, because it is the one answer a purchase makes
 * wrong, nothing tells the bot that a purchase happened, and for the whole life of the answer a
 * server that has paid is refused and told to buy. Longer keeps a paying server waiting;
 * shorter puts a round trip to Heroku in front of most voice reservations in a free server.
 */
export const UNCOVERED_TTL_MS = 5 * 60 * 1000;

/**
 * The fallback after a failed read. A minute, so a recovered server is picked up quickly and one
 * bad round trip does not pin a stale answer.
 */
export const ERROR_TTL_MS = 60 * 1000;

/**
 * The tier key the server's game room route sends for a guild nothing covers. It shortens that
 * answer's life, and the room limit refusal (gameRoomsCopy) pitches the Dero server plan on it.
 */
export const UNCOVERED_TIER_KEY = "unsubscribed";
