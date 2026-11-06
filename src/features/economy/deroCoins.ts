import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { CoinAwardOutcome } from "@db/models/CoinAward.js";
import { deroCoinStore } from "@db/stores/deroCoinStore.js";
import { GAME_SLUGS, type GameSlug } from "@features/game-rooms/roomTypes.js";
import type { GameOutcome, LevelingGameSlug } from "@features/leveling/levelingTypes.js";
import { RATED_GAMES } from "@features/ratings/ratingEngine.js";
import { isBotSeatId } from "@utils/botSeatId.js";
import { utcDayKey, utcDayStart } from "@utils/utcMonthKey.js";

// ── deroCoins ────────────────────────────────────────────────────────
// What:  Dero coins, the Verse currency (2026-10 item 257, Phase 3a): what a game
//        result and the daily claim pay, into one global wallet per member.
// Who:   features/games/gameXp.ts beside every game's XP award (awardForResult), the
//        Hold'em placements in roomHoldemHandlers.ts, the daily claim round in
//        features/economy/chipClaim.ts (awardForClaim), a release's Claim button
//        (awardReleaseGift), and the /account card (readCoinBalance).
// Does NOT: spend coins, or decide amounts inline: every number
//        is BOT_CONSTANTS.DERO_COINS, the owner's to tune.
// How:   ① insert the CoinAward row; ② only when that insert succeeded, $inc the wallet.
//        A duplicate key at ① means the award was already paid (risk R3: a retry, a
//        rematch, a sweep finishing a finished room), so it returns quietly. Every call
//        is fire and forget after the result is on screen (rulebook convention 7):
//        nothing here throws to its caller.

/** A round against Dero alone: the solo luck rooms, solo hangman and solo blackjack. */
export type SoloCoinGame = Extract<GameSlug, `solo-${string}`>;

/** Every game a coin award can name: the leveling slugs, plus the solo rounds against Dero. */
export type CoinGame = LevelingGameSlug | SoloCoinGame;

// Every solo- slug, read off the room slug list so a new solo game joins the solo row and
// its daily cap without an edit here.
const SOLO_COIN_GAMES = GAME_SLUGS.filter((slug): slug is SoloCoinGame => slug.startsWith("solo-"));

type CoinTier = "rated" | "room" | "solo";

/** One finished result: the game, its stable key, and how it read for each player, bot seats included. */
export interface CoinResult {
	guildId: string;
	game: CoinGame;
	// The room id for a game played in a room. A channel game names a stable key of its
	// own: a channel hangman round its board message, an inline blackjack table its
	// channel and opening time, a solo round in place its interaction, a solo room round
	// its result message.
	resultKey: string;
	players: ReadonlyArray<{ userId: string; outcome: CoinAwardOutcome }>;
	now?: Date;
}

// ⚠️ BLACKJACK IS RATED BUT KEEPS THE ROOM ROW. It joined RATED_GAMES for its ratings (2026-10
// item 276, owner decision D8), and nothing in that decision moved its coins: a table is played
// against the house, so a seat alone could take the rated row's win off Dero's dealer hand after
// hand. Raising it is the owner's call, made by deleting it from this list.
const ROOM_TIER_RATED_GAMES: readonly CoinGame[] = ["blackjack"];
const isRatedGame = (game: CoinGame): boolean => (RATED_GAMES as readonly string[]).includes(game) && !ROOM_TIER_RATED_GAMES.includes(game);
const isSoloGame = (game: CoinGame): boolean => (SOLO_COIN_GAMES as readonly string[]).includes(game);

/** Which row of the coin table a game pays from. */
export function coinTierOf(game: CoinGame): CoinTier {
	if (isRatedGame(game)) return "rated";
	if (isSoloGame(game)) return "solo";
	return "room";
}

/**
 * The table amount for one player's result, before the solo daily cap. A match with any
 * Dero bot seat pays every human the play amount only (owner decision 9), so a member
 * cannot farm wins off a bot they seated themselves.
 */
export function coinAmountFor(game: CoinGame, outcome: CoinAwardOutcome, hasBotSeat: boolean): number {
	const { RATED, ROOM, SOLO } = BOT_CONSTANTS.DERO_COINS;
	const tier = coinTierOf(game);
	if (tier === "solo") return outcome === "won" ? SOLO.WIN : SOLO.OTHER;
	const row = tier === "rated" ? RATED : ROOM;
	if (hasBotSeat) return row.PLAY;
	if (outcome === "won") return row.WIN;
	if (outcome === "drawn") return row.DRAW;
	return row.PLAY;
}

/**
 * The coin reading of an XP outcome. An assist and a loss both pay the play amount: the
 * coin table rewards showing up, a win and a draw, and has no assist row.
 */
export function coinOutcomeOf(outcome: GameOutcome): CoinAwardOutcome {
	if (outcome === "won") return "won";
	if (outcome === "drawn") return "drawn";
	return "played";
}

/**
 * Pay every human player of one finished result. Bot seats are never paid: they are not
 * members. Fire and forget: logs and never throws.
 */
export async function awardForResult(result: CoinResult): Promise<void> {
	const now = result.now ?? new Date();
	const hasBotSeat = result.players.some((player) => isBotSeatId(player.userId));
	const humans = result.players.filter((player) => !isBotSeatId(player.userId));
	for (const player of humans) {
		try {
			await payGameAward(result, player, hasBotSeat, now);
		} catch (error) {
			console.error(`[economy] paying Dero coins for ${result.game} result ${result.resultKey} to ${player.userId} failed`, error);
		}
	}
}

async function payGameAward(result: CoinResult, player: CoinResult["players"][number], hasBotSeat: boolean, now: Date): Promise<void> {
	const amount = await cappedAmount(result.game, player.userId, coinAmountFor(result.game, player.outcome, hasBotSeat), now);
	// ⚠️ Money invariant (R3): the insert is the claim on this award. A duplicate means it
	// was paid already, and the wallet must not move a second time.
	const inserted = await deroCoinStore.insertAward({
		userId: player.userId,
		guildId: result.guildId,
		amount,
		source: "game",
		game: result.game,
		outcome: player.outcome,
		roomId: result.resultKey,
		at: now,
	});
	if (!inserted || amount <= 0) return;
	await deroCoinStore.credit(player.userId, amount);
}

// A solo round pays only what is left of SOLO_DAILY_CAP today. A capped round still
// writes its row at zero, so the ledger counts every round played and a retry of it
// stays a duplicate. Two rounds finishing in the same instant can both read the same
// remainder and pass the cap by one round's coins; a few coins is the accepted cost of
// keeping the cap a read rather than a second counter collection.
async function cappedAmount(game: CoinGame, userId: string, amount: number, now: Date): Promise<number> {
	if (coinTierOf(game) !== "solo") return amount;
	const paidToday = await deroCoinStore.sumGameCoinsSince(userId, SOLO_COIN_GAMES, utcDayStart(now));
	return Math.max(0, Math.min(amount, BOT_CONSTANTS.DERO_COINS.SOLO_DAILY_CAP - paidToday));
}

// ── the daily claim ──

/** How the daily claim's round of rock paper scissors went for the member, the key of DERO_COINS.CLAIM. */
export type ClaimRoundOutcome = keyof typeof BOT_CONSTANTS.DERO_COINS.CLAIM;

/**
 * The claim key: the UTC day alone, so a member claims coins once a day across every
 * server (2026-10 item 267 Session 1a). Rows written before that carry the day plus the
 * guild, so on the day this shipped a member could take one more claim; never again.
 */
export function claimKeyFor(now: Date): string {
	return utcDayKey(now);
}

/** Whether the member already took today's coins, in any server. */
export function hasClaimedCoinsToday(userId: string, now: Date): Promise<boolean> {
	return deroCoinStore.hasClaim(claimKeyFor(now), userId);
}

// ── the claim log ──
// Every coin claim runs ① write the log row, open; ② the coins and a receipt in one wallet write;
// ③ close the row. The row says a member is owed, and the receipt says they were paid, so a crash
// at any step is finished by the next press or the next boot and can neither lose the coins
// nor pay them twice. Game awards keep the plainer insert then credit in payPlayer.

interface LoggedClaim {
	userId: string;
	guildId: string;
	amount: number;
	claimKey: string;
	at: Date;
}

// True when this call paid the claim. A row already there is finished rather than refused
// when it is still open, which is what lets a press after a failed credit pay.
async function payLoggedClaim(claim: LoggedClaim): Promise<boolean> {
	const inserted = await deroCoinStore.insertAward({ ...claim, source: "claim", settled: false });
	if (inserted) return settleClaim(claim);
	const logged = await deroCoinStore.findClaim(claim.claimKey, claim.userId);
	return logged?.settled === false ? settleClaim({ ...claim, amount: logged.amount }) : false;
}

async function settleClaim(claim: Pick<LoggedClaim, "userId" | "amount" | "claimKey">): Promise<boolean> {
	const paid = await deroCoinStore.creditClaim(claim.userId, claim.amount, claim.claimKey);
	// The member has their coins by now, so a failed close must not read as a failed claim. The
	// receipt keeps the row from paying again, and the boot sweep closes it.
	await deroCoinStore.settleClaim(claim.claimKey, claim.userId).catch((error: unknown) => console.warn(`[economy] closing coin claim ${claim.claimKey} for ${claim.userId} failed`, error));
	return paid;
}

/**
 * Finish every claim a crash left open, so a member owed coins never has to press again. Called
 * once at boot from main.ts, because a crash is exactly what ends in a boot. Never throws.
 */
export async function settleOpenCoinClaims(): Promise<number> {
	let paid = 0;
	try {
		for (const claim of await deroCoinStore.findOpenClaims()) {
			if (claim.claimKey && (await settleClaim({ userId: claim.userId, amount: claim.amount, claimKey: claim.claimKey }))) paid += 1;
		}
	} catch (error) {
		console.error("[economy] settling open coin claims at boot failed, the next boot tries again", error);
	}
	return paid;
}

/**
 * Pay the daily claim's coins: DERO_COINS.CLAIM's amount for the round's outcome. Answers
 * the coins paid, 0 when today's claim was already paid or the write failed. Never throws.
 * The guild only names where the claim was made on its ledger row.
 */
export async function awardForClaim(claim: { guildId: string; userId: string; outcome: ClaimRoundOutcome; now: Date }): Promise<number> {
	const amount = BOT_CONSTANTS.DERO_COINS.CLAIM[claim.outcome];
	try {
		// ⚠️ Money invariant: one claim row per member per UTC day, across every server, so
		// a second Submit of the same day, here or in another server, pays nothing.
		const paid = await payLoggedClaim({ userId: claim.userId, guildId: claim.guildId, amount, claimKey: claimKeyFor(claim.now), at: claim.now });
		return paid ? amount : 0;
	} catch (error) {
		console.error(`[economy] paying the daily claim's Dero coins to ${claim.userId} in guild ${claim.guildId} failed`, error);
		return 0;
	}
}

/** What a press of a release's Claim button did. `unknown` is a gift DERO_COINS does not list. */
export type ReleaseGiftOutcome = { status: "paid"; amount: number } | { status: "already" } | { status: "unknown" } | { status: "failed" };

/**
 * Pay a release's apology coins, once per member per gift across every server. Each gift takes
 * a claim row of its own, keyed so no UTC day key can ever equal it, which keeps the existing
 * unique claim index as the guard and leaves the daily claim's own row untouched. Never throws.
 */
export async function awardReleaseGift(gift: { guildId: string; userId: string; giftKey: string; now: Date }): Promise<ReleaseGiftOutcome> {
	const amount = BOT_CONSTANTS.DERO_COINS.RELEASE_GIFTS[gift.giftKey];
	if (!amount) return { status: "unknown" };
	try {
		const paid = await payLoggedClaim({ userId: gift.userId, guildId: gift.guildId, amount, claimKey: `release:${gift.giftKey}`, at: gift.now });
		return paid ? { status: "paid", amount } : { status: "already" };
	} catch (error) {
		console.error(`[economy] paying release gift ${gift.giftKey} to ${gift.userId} in guild ${gift.guildId} failed`, error);
		return { status: "failed" };
	}
}

/** A member's coin balance, 0 before their first award. */
export async function readCoinBalance(userId: string): Promise<number> {
	const wallet = await deroCoinStore.findWallet(userId);
	return wallet?.balance ?? 0;
}
