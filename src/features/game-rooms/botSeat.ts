import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { DERO_VARIANTS, type DeroVariant } from "@base/copy/brand.js";
import { MAX_SEATS as MONOPOLY_MAX_SEATS } from "@features/games/monopolyBoard.js";
import { BOT_SEAT_PREFIX, isBotSeatId } from "@utils/botSeatId.js";
import type { GameSlug } from "./roomTypes.js";

export { BOT_SEAT_PREFIX, isBotSeatId };

// ── botSeat ──────────────────────────────────────────────────────────
// What:  who a Dero bot seat is (2026-10 item 250 Phase 5): its id, its name, which games
//        take bots and how many, and how a line naming one reads in a channel.
// Who:   the challenge card's Play vs bots (challengeBoard), the room seed that sits the
//        bots down (RoomProvisioner.seedRoom), the bot turn driver (botTurns), the
//        labelling choke point (satelliteRooms.labelForRoom), and every guard that keeps a
//        bot out of XP, ratings and Discord's own calls.
// Does NOT: decide a bot's move (games/holdemBot, monopolyBot, battleshipBot do) or
//        touch the room row.
//
// ⚠️ A BOT SEAT IS NEVER IN room.playerIds. That list is the members who may press a
// room's controls AND the members whose permission overwrites the channel carries, and a
// bot id there would be an overwrite Discord refuses. A bot lives only in its game's own
// state (a hold'em seat, a Monopoly seat, a battleship board), which is why every one is
// recognisable by its id alone: `dero-bot-<variant>`, never a snowflake, so it can never
// collide with a member and never pings anybody.
//
// ⚠️ THE LAW THIS REVERSES. Until this phase no bot could be an opponent, structurally:
// the only ways into a match were a select the BOT populates and a Join button a bot
// cannot press. Both stay closed to bots. The ONE way a bot sits down is the host's
// Play vs bots on the challenge card, an intentional human action (the owner's reversal
// of the CLAUDE.md invariant, 2026-10 item 250 item 20).

/** The games a host may fill with Dero bots: the player against player games with a bot to play them. */
export const BOT_GAMES: readonly GameSlug[] = ["holdem", "monopoly", "battleship"] as const;

const BOT_MENTION = /<@!?(dero-bot-[a-z]+)>/g;
const ROBOT_MARK = "🤖";

/** The seat id of one Dero variant: `dero-bot-red`. */
export function botSeatIdOf(variant: DeroVariant): string {
	return `${BOT_SEAT_PREFIX}${variant.name.toLowerCase()}`;
}

/** The variant a bot seat id names, or null for a member's id or an id no variant has. */
export function botVariantOf(id: string): DeroVariant | null {
	if (!isBotSeatId(id)) return null;
	const name = id.slice(BOT_SEAT_PREFIX.length);
	return DERO_VARIANTS.find((variant) => variant.name.toLowerCase() === name) ?? null;
}

/** How a bot seat is named everywhere a member's display name would go: "Dero Red". */
export function botSeatName(id: string): string {
	const variant = botVariantOf(id);
	return variant ? `Dero ${variant.name}` : "Dero";
}

/** Whether a game takes bots at all. */
export const takesBots = (game: GameSlug): boolean => BOT_GAMES.includes(game);

/**
 * The most bots a host may add. Hold'em and Monopoly leave at least the host's own seat
 * free; battleship is one against one, so one bot is the whole opposition.
 */
export function maxBotSeats(game: GameSlug): number {
	if (game === "holdem") return BOT_CONSTANTS.HOLDEM_MAX_SEATS - 1;
	if (game === "monopoly") return MONOPOLY_MAX_SEATS - 1;
	if (game === "battleship") return 1;
	return 0;
}

/**
 * The bot seat ids for `count` bots joining `humanSeats` members. In Monopoly a seat's
 * token is its place at the table (token 1 for seat 1), so a bot takes the variant of the
 * seat it sits in, which keeps "Dero Green" on the green token. Every other game takes
 * the variants in order from red.
 */
export function botSeatIdsFor(game: GameSlug, humanSeats: number, count: number): string[] {
	const first = game === "monopoly" ? humanSeats : 0;
	return DERO_VARIANTS.slice(first, first + Math.max(0, count)).map(botSeatIdOf);
}

/** A line with every bot mention turned into the bot's name, the way a member reads it. Pure, so it is safe on any text. */
export function labelBotMentions(text: string): string {
	return text.replace(BOT_MENTION, (_mention, id: string) => `${ROBOT_MARK} **${botSeatName(id)}**`);
}

/** The member ids among `ids`, for any Discord call that takes user ids (allowed mentions, member fetches). */
export function memberIdsOnly(ids: readonly string[]): string[] {
	return ids.filter((id) => !isBotSeatId(id));
}

/** Whether a server lets hosts add bots. A row that never stored the switch reads as on, the schema default. */
export function botsAllowedIn(config: { botOpponentsEnabled?: boolean | null } | null | undefined): boolean {
	return config?.botOpponentsEnabled ?? true;
}
