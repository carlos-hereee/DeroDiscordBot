import type { Client } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { IPlayerRating } from "@db/models/PlayerRating.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { networkBanStore } from "@db/stores/networkBanStore.js";
import { networkConsentStore } from "@db/stores/networkConsentStore.js";
import { playerRatingStore } from "@db/stores/playerRatingStore.js";
import { isGuildBanned, isOnNetwork, isUserBanned, type NetworkGuildConfig } from "@features/game-rooms/networkRules.js";
import { RATED_GAMES, type RatedGame } from "./ratingEngine.js";

// ── serverRatings ────────────────────────────────────────────────────
// What:  the server board (2026-10 item 244 Phase 5b): servers on the network ranked by
//        the players who WEAR their Discord server tag. A server's rating in one game is
//        the mean of the top SERVER_BOARD_MIN_MEMBERS display ratings among its tag
//        wearers who accepted the network notice; across every game, it is the mean of
//        its per game ratings. /rating servers reads it.
// Who:   /rating servers [game], and the platform ratings report Dero's Castle reads
//        (platformRatings, Phase 5c), through serverBoardsByGame.
// Does NOT: store anything. A server's rating is recomputed on read from who wears its tag
//        right now (the plan's risk R11): a member who changes their tag moves their
//        points at the next read, with no stale row to clean up.
//
// The owner's eligibility rule, applied in full: a server is ranked only when it is on
// the network (Dero is in it and its reach is network), Discord gives it the GUILD_TAGS
// feature, it is not banned from the network, and at least SERVER_BOARD_MIN_MEMBERS rated
// players wear its tag WITH identityEnabled true and have accepted the network notice.
// A member wearing no tag, or hiding it, earns no server points. A player the owner
// banned from the network earns none either.
//
// ⚠️ THE TAG IS READ FROM EACH PLAYER, NOT FROM THE SERVER. Only consenting players with
// a rating are looked at, cache first and one Discord read for each one not cached, so
// the cost follows the number of rated network players, never the size of any server.

const NETWORK = BOT_CONSTANTS.NETWORK;

/** A rated, consenting player and the server whose tag they wear and show. */
export interface TagWearer {
	userId: string;
	guildId: string;
	tag: string | null;
}

/** A server eligible for the board, before its wearers are counted. */
export interface EligibleServer {
	guildId: string;
	name: string;
}

/** One server on the board. */
export interface ServerRatingRow {
	guildId: string;
	name: string;
	tag: string | null;
	rating: number;
	// How many of its wearers stand behind the rating (rated in the game, or in any game).
	members: number;
}

// ── the pure core ─────────────────────────────────────────────────────
/** The mean of the top `minimum` display ratings, rounded, or null when fewer than `minimum` stand. */
export function topMeanRating(displayRatings: readonly number[], minimum: number = NETWORK.SERVER_BOARD_MIN_MEMBERS): number | null {
	if (displayRatings.length < minimum || minimum < 1) return null;
	const top = [...displayRatings].sort((first, second) => second - first).slice(0, minimum);
	return Math.round(top.reduce((sum, rating) => sum + rating, 0) / minimum);
}

/**
 * Rank the eligible servers by their wearers' ratings, in one game or across every rated
 * game (`game` null). A server short of the minimum in a game has no rating in it; across
 * every game, a server is ranked by the mean of the games it does have a rating in. Best
 * first; more members breaks a tie, then the name, so the board never reshuffles.
 */
export function rankServers(
	servers: readonly EligibleServer[],
	wearers: readonly TagWearer[],
	ratings: readonly Pick<IPlayerRating, "userId" | "game" | "displayRating">[],
	game: RatedGame | null
): ServerRatingRow[] {
	const rows: ServerRatingRow[] = [];
	for (const server of servers) {
		const own = wearers.filter((wearer) => wearer.guildId === server.guildId);
		const row = rateServer(server, own, ratings, game);
		if (row) rows.push(row);
	}
	return rows.sort((first, second) => second.rating - first.rating || second.members - first.members || first.name.localeCompare(second.name));
}

function rateServer(
	server: EligibleServer,
	wearers: readonly TagWearer[],
	ratings: readonly Pick<IPlayerRating, "userId" | "game" | "displayRating">[],
	game: RatedGame | null
): ServerRatingRow | null {
	const wearerIds = new Set(wearers.map((wearer) => wearer.userId));
	const tag = wearers.find((wearer) => wearer.tag)?.tag ?? null;
	const ratingsIn = (rated: RatedGame) => ratings.filter((row) => row.game === rated && wearerIds.has(row.userId));

	if (game) {
		const inGame = ratingsIn(game);
		const rating = topMeanRating(inGame.map((row) => row.displayRating));
		return rating === null ? null : { guildId: server.guildId, name: server.name, tag, rating, members: inGame.length };
	}

	const perGame: number[] = [];
	const standing = new Set<string>();
	for (const rated of RATED_GAMES) {
		const inGame = ratingsIn(rated);
		const rating = topMeanRating(inGame.map((row) => row.displayRating));
		if (rating === null) continue;
		perGame.push(rating);
		for (const row of inGame) standing.add(row.userId);
	}
	if (perGame.length === 0) return null;
	const rating = Math.round(perGame.reduce((sum, value) => sum + value, 0) / perGame.length);
	return { guildId: server.guildId, name: server.name, tag, rating, members: standing.size };
}

// ── reading the board ─────────────────────────────────────────────────
/** What every server board is ranked from, read once: the eligible servers, their tag wearers, and the ratings behind them. */
interface ServerBoardInputs {
	servers: EligibleServer[];
	wearers: TagWearer[];
	ratings: IPlayerRating[];
}

/** The server board, best first, at most SERVER_BOARD_SIZE servers. */
export async function serverBoard(client: Client, game: RatedGame | null): Promise<ServerRatingRow[]> {
	const inputs = await readServerBoardInputs(client);
	return inputs ? rankServers(inputs.servers, inputs.wearers, inputs.ratings, game).slice(0, NETWORK.SERVER_BOARD_SIZE) : [];
}

/**
 * Every rated game's server board from ONE read, for the platform ratings report in Dero's
 * Castle (2026-10 item 244 Phase 5c). Three calls to serverBoard would read the same
 * consents, bans and ratings three times and walk the same tag wearers three times.
 */
export async function serverBoardsByGame(client: Client): Promise<Map<RatedGame, ServerRatingRow[]>> {
	const inputs = await readServerBoardInputs(client);
	const boards = new Map<RatedGame, ServerRatingRow[]>();
	for (const game of RATED_GAMES) {
		boards.set(game, inputs ? rankServers(inputs.servers, inputs.wearers, inputs.ratings, game).slice(0, NETWORK.SERVER_BOARD_SIZE) : []);
	}
	return boards;
}

// Null when no server is eligible, before any rating or tag is read.
async function readServerBoardInputs(client: Client): Promise<ServerBoardInputs | null> {
	const [configs, bans, consenting] = await Promise.all([
		guildConfigStore.findNetworkBoardConfigs() as Promise<NetworkGuildConfig[]>,
		networkBanStore.findAll(),
		networkConsentStore.allConsentingUserIds(NETWORK.CONSENT_VERSION),
	]);
	const servers = eligibleServers(client, configs, (guildId) => isGuildBanned(bans, guildId));
	if (servers.length === 0) return null;

	const players = consenting.filter((userId) => !isUserBanned(bans, userId));
	const ratings = await playerRatingStore.findForPlayersInAllGames(players);
	const wearers = await tagWearers(client, [...new Set(ratings.map((row) => row.userId))], new Set(servers.map((server) => server.guildId)));
	return { servers, wearers, ratings };
}

/** The servers that may be ranked at all: on the network, given server tags by Discord, and not banned. */
export function eligibleServers(client: Client, configs: readonly NetworkGuildConfig[], isBanned: (guildId: string) => boolean): EligibleServer[] {
	const servers: EligibleServer[] = [];
	for (const config of configs) {
		if (!isOnNetwork(client, config) || isBanned(config.guildId)) continue;
		const guild = client.guilds.cache.get(config.guildId);
		if (!guild?.features.includes(NETWORK.GUILD_TAGS_FEATURE)) continue;
		servers.push({ guildId: guild.id, name: guild.name });
	}
	return servers;
}

// The players among `userIds` who wear and show the tag of one of `serverIds`. A player
// Discord cannot find reads as wearing no tag, so they simply earn nothing this read.
async function tagWearers(client: Client, userIds: readonly string[], serverIds: ReadonlySet<string>): Promise<TagWearer[]> {
	const wearers: TagWearer[] = [];
	for (const userId of userIds) {
		const user = client.users.cache.get(userId) ?? (await client.users.fetch(userId).catch(() => null));
		const identity = user?.primaryGuild;
		if (!identity?.identityEnabled || !identity.identityGuildId || !serverIds.has(identity.identityGuildId)) continue;
		wearers.push({ userId, guildId: identity.identityGuildId, tag: identity.tag ?? null });
	}
	return wearers;
}
