import { escapeMarkdown, MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction, type EmbedBuilder, type Guild } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { COLORS } from "@base/copy/brand.js";
import { getPluginCopy, type IPluginCopy } from "@base/copy/index.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { networkConsentStore } from "@db/stores/networkConsentStore.js";
import { playerRatingStore } from "@db/stores/playerRatingStore.js";
import { gameRoomsCopy } from "@features/game-rooms/gameRoomsCopy.js";
import { scheduleNetworkBoardRefresh } from "@features/game-rooms/networkBoard.js";
import { memberNameResolver, networkNameResolver } from "@features/ratings/memberNames.js";
import {
	formatLuckScore,
	formatRating,
	luckBoardInGuild,
	luckBoardOnNetwork,
	memberRatings,
	topRatedInGuild,
	topRatedOnNetwork,
	type LuckyPlayer,
	type RatedPlayer,
	type RatingSnapshot,
} from "@features/ratings/ratingBoards.js";
import { serverBoard } from "@features/ratings/serverRatings.js";
import { isRatedGame, RATED_GAMES, type RatedGame } from "@features/ratings/ratingEngine.js";
import { errorEmbed, infoEmbed } from "@utils/embedBuilder.js";
import { utcMonthKey } from "@utils/utcMonthKey.js";
import { showErrorNotice } from "@utils/textModal.js";

// ── /rating ────────────────────────────────────────────────────────────────
// What:  the arcade ratings, member side (2026-10 item 244 Phase 3b). `me [game]`
//        is the member's own rating in each rated game; `board <game>` is this
//        server's best rated players of one game; `luck` is this server's luck
//        board for the month. Members call it a rating, never Elo.
// Who:   every member. PUBLIC, like /account and /account view:levels, and in neither admin
//        mechanism: not in ADMIN_COMMANDS and no default member permission.
// When:  on demand. The monthly arcade post is the passive half.
// Where: reads through features/ratings/ratingBoards.ts, the same reads the monthly
//        post makes, so the command and the post can never rank two ways. Writes
//        nothing; the finish sites write (Phase 3a).
// How:   ① guild gate (a rating is only ever shown inside a server); ② defer,
//        since a board is a few round trips; ③ dispatch on the subcommand;
//        ④ one embed.
//
// The network (2026-10 item 244 Phase 5b): `board` and `luck` take a scope, this
// server (the default) or the network; `servers [game]` ranks the servers on the
// network by the players who wear their tag; `network leave` deletes the member's
// network consent and every rating they hold, privately.
//
// ⚠️ NOTHING NETWORK WIDE WITHOUT CONSENT. A rating follows its player across servers,
// but a server board starts from the players with a MatchResult in THIS server, a
// network scope board and the server ranking count only players who accepted the
// network notice, and `me` only ever shows the asking member their own numbers (R9).

const words = rokCommanderCopy.arcadeRatings;
const GAME_OPTION = "game";
const SCOPE_OPTION = "scope";
const NETWORK_SCOPE = "network";
const LIMITS = BOT_CONSTANTS.RATINGS;

// This server or the network, offered on `board` and `luck`. Leaving it out reads as this
// server, the boards as they were before the network existed.
const SCOPE_CHOICES = [
	{ name: words.command.scopeServer, value: "server" },
	{ name: words.command.scopeNetwork, value: NETWORK_SCOPE },
];

// Choices rather than free text, so Discord refuses an unrated game before the
// interaction reaches the bot. Built from RATED_GAMES, so a newly rated game
// appears here without a second list to keep in step.
const GAME_CHOICES = RATED_GAMES.map((game) => ({ name: gameRoomsCopy.gameLabel(game), value: game }));

export const data = new SlashCommandBuilder()
	.setName("rating")
	.setDescription(words.command.description)
	.addSubcommand((sub) =>
		sub
			.setName("me")
			.setDescription(words.command.me)
			.addStringOption((option) => option.setName(GAME_OPTION).setDescription(words.command.gameOption).setRequired(false).addChoices(...GAME_CHOICES))
	)
	.addSubcommand((sub) =>
		sub
			.setName("board")
			.setDescription(words.command.board)
			.addStringOption((option) => option.setName(GAME_OPTION).setDescription(words.command.gameOption).setRequired(true).addChoices(...GAME_CHOICES))
			.addStringOption((option) => option.setName(SCOPE_OPTION).setDescription(words.command.scopeOption).setRequired(false).addChoices(...SCOPE_CHOICES))
	)
	.addSubcommand((sub) =>
		sub
			.setName("luck")
			.setDescription(words.command.luck)
			.addStringOption((option) => option.setName(SCOPE_OPTION).setDescription(words.command.scopeOption).setRequired(false).addChoices(...SCOPE_CHOICES))
	)
	.addSubcommand((sub) =>
		sub
			.setName("servers")
			.setDescription(words.command.servers)
			.addStringOption((option) =>
				option.setName(GAME_OPTION).setDescription(words.command.serversGameOption).setRequired(false).addChoices(...GAME_CHOICES)
			)
	)
	.addSubcommandGroup((group) =>
		group
			.setName("network")
			.setDescription(words.command.networkGroup)
			.addSubcommand((sub) => sub.setName("leave").setDescription(words.command.leave))
	);

type RatingWords = IPluginCopy["arcadeRatings"];

/** Everything a subcommand needs: the guild, the asking member, and the guild's pack words. */
interface RatingRequest {
	interaction: ChatInputCommandInteraction;
	guild: Guild;
	words: RatingWords;
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
	// ①
	const guild = interaction.guild;
	if (!guild) {
		await showErrorNotice(interaction, words.notInGuild);
		return;
	}

	// Leaving the network answers privately and writes, so it takes its own path before
	// the public defer every board shares.
	if (interaction.options.getSubcommandGroup(false) === "network") {
		await leaveNetwork(interaction, guild);
		return;
	}

	// ②
	await interaction.deferReply();
	// A failed config read only costs the guild its pack voice, never the answer.
	const guildConfig = await guildConfigStore.findByGuildId(guild.id).catch(() => null);
	const request: RatingRequest = { interaction, guild, words: getPluginCopy(guildConfig).arcadeRatings };

	try {
		// ③ and ④
		const embed = await answerFor(interaction.options.getSubcommand(true), request);
		await interaction.editReply({ embeds: [embed] });
	}
	catch (error) {
		console.error(`[rating] the ${interaction.options.getSubcommand(false) ?? "unknown"} subcommand failed in guild ${guild.id}`, error);
		await interaction.editReply({ embeds: [errorEmbed(request.words.readFailed, guildConfig)] }).catch(() => undefined);
	}
}

function answerFor(subcommand: string, request: RatingRequest): Promise<EmbedBuilder> {
	if (subcommand === "board") return boardAnswer(request);
	if (subcommand === "luck") return luckAnswer(request);
	if (subcommand === "servers") return serversAnswer(request);
	return myAnswer(request);
}

const isNetworkScope = (interaction: ChatInputCommandInteraction): boolean => interaction.options.getString(SCOPE_OPTION) === NETWORK_SCOPE;

// ── me [game] ──

async function myAnswer({ interaction, words: copy }: RatingRequest): Promise<EmbedBuilder> {
	const chosen = interaction.options.getString(GAME_OPTION);
	const games: readonly RatedGame[] = chosen && isRatedGame(chosen) ? [chosen] : RATED_GAMES;
	const ratings = await memberRatings(interaction.user.id, games);

	const lines = ratings.map(({ game, rating }) => {
		const label = gameRoomsCopy.gameLabel(game);
		return rating ? copy.me.rated(label, formatRating(rating, copy.provisionalMark), rating.ratedGames) : copy.me.unrated(label);
	});
	const settling = ratings.flatMap(({ rating }) => (rating ? [rating] : []));
	const body = [lines.join("\n"), copy.me.footer, provisionalNoteFor(settling, copy)].filter(Boolean).join("\n\n");
	return infoEmbed(copy.me.title(escapeMarkdown(memberName(interaction))), body, COLORS.ARCADE);
}

// The member's name in this server, which is what the title should greet, falling
// back to their account name when the interaction carries no cached member.
function memberName(interaction: ChatInputCommandInteraction): string {
	return interaction.inCachedGuild() ? interaction.member.displayName : interaction.user.displayName;
}

// ── board <game> ──

async function boardAnswer({ interaction, guild, words: copy }: RatingRequest): Promise<EmbedBuilder> {
	const ratedGame = interaction.options.getString(GAME_OPTION, true);
	// The choices already restrict this; a hand built request still gets an honest error, never another game's board.
	if (!isRatedGame(ratedGame)) throw new Error(`/rating board was asked for "${ratedGame}", which is not a rated game`);
	const network = isNetworkScope(interaction);
	const players: RatedPlayer[] = network
		? await topRatedOnNetwork({ game: ratedGame, limit: LIMITS.BOARD_SIZE, resolveNames: networkNameResolver(interaction.client) })
		: await topRatedInGuild({ guildId: guild.id, game: ratedGame, limit: LIMITS.BOARD_SIZE, resolveNames: memberNameResolver(guild) });

	const gameLabel = gameRoomsCopy.gameLabel(ratedGame);
	const title = network ? copy.board.networkTitle(gameLabel) : copy.board.title(gameLabel);
	if (players.length === 0) return infoEmbed(title, network ? copy.board.networkEmpty : copy.board.empty, COLORS.ARCADE);

	const rows = players.map((player, index) => copy.board.row(index + 1, escapeMarkdown(player.displayName), formatRating(player, copy.provisionalMark)));
	const body = [rows.join("\n"), provisionalNoteFor(players, copy)].filter(Boolean).join("\n\n");
	return infoEmbed(title, body, COLORS.ARCADE);
}

// ── luck ──

async function luckAnswer({ interaction, guild, words: copy }: RatingRequest): Promise<EmbedBuilder> {
	const network = isNetworkScope(interaction);
	const month = utcMonthKey(new Date());
	const players: LuckyPlayer[] = network
		? await luckBoardOnNetwork({ month, limit: LIMITS.BOARD_SIZE, resolveNames: networkNameResolver(interaction.client) })
		: await luckBoardInGuild({ guildId: guild.id, month, limit: LIMITS.BOARD_SIZE, resolveNames: memberNameResolver(guild) });
	const rows = players.map((player, index) =>
		copy.luck.row(index + 1, escapeMarkdown(player.displayName), formatLuckScore(player.score), player.wins, player.decided)
	);
	const empty = network ? copy.luck.networkEmpty(LIMITS.LUCK_MIN_DECIDED) : copy.luck.empty(LIMITS.LUCK_MIN_DECIDED);
	const board = rows.length > 0 ? rows.join("\n") : empty;
	return infoEmbed(network ? copy.luck.networkTitle : copy.luck.title, `${copy.luck.description}\n\n${board}`, COLORS.ARCADE);
}

// ── servers [game] (2026-10 item 244 Phase 5b) ──

async function serversAnswer({ interaction, words: copy }: RatingRequest): Promise<EmbedBuilder> {
	const chosen = interaction.options.getString(GAME_OPTION);
	const game = chosen && isRatedGame(chosen) ? chosen : null;
	const servers = await serverBoard(interaction.client, game);

	const title = copy.servers.title(game ? gameRoomsCopy.gameLabel(game) : null);
	const description = copy.servers.description(BOT_CONSTANTS.NETWORK.SERVER_BOARD_MIN_MEMBERS);
	if (servers.length === 0) return infoEmbed(title, `${description}\n\n${copy.servers.empty}`, COLORS.ARCADE);
	const rows = servers.map((server, index) =>
		copy.servers.row(index + 1, escapeMarkdown(server.name), server.tag ? escapeMarkdown(server.tag) : null, server.rating, server.members)
	);
	return infoEmbed(title, `${description}\n\n${rows.join("\n")}`, COLORS.ARCADE);
}

// ── network leave (2026-10 item 244 Phase 5b) ──

/**
 * Delete the member's network consent and every rating they hold, privately. Their luck
 * rows stay, because luck is kept per server and was never shown across servers without
 * consent. Consent goes FIRST, so a failure part way leaves them off the network rather
 * than shown there; running it again deletes whatever is left. The network boards are
 * redrawn, since a host who left is no longer listed.
 */
async function leaveNetwork(interaction: ChatInputCommandInteraction, guild: Guild): Promise<void> {
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });
	const guildConfig = await guildConfigStore.findByGuildId(guild.id).catch(() => null);
	const copy = getPluginCopy(guildConfig).arcadeRatings;
	try {
		const hadConsent = await networkConsentStore.deleteForUser(interaction.user.id);
		const ratingsDeleted = await playerRatingStore.deleteAllForPlayer(interaction.user.id);
		scheduleNetworkBoardRefresh();
		const text = !hadConsent && ratingsDeleted === 0 ? copy.leave.nothing : copy.leave.done(ratingsDeleted);
		await interaction.editReply({ content: text });
	}
	catch (error) {
		console.error(`[rating] network leave failed for user ${interaction.user.id} in guild ${guild.id}`, error);
		await interaction.editReply({ content: copy.leave.failed }).catch(() => undefined);
	}
}

// The note explaining the mark, only when a number on screen carries it.
function provisionalNoteFor(ratings: readonly Pick<RatingSnapshot, "provisional">[], copy: RatingWords): string {
	return ratings.some((rating) => rating.provisional) ? `*${copy.provisionalNote}*` : "";
}
