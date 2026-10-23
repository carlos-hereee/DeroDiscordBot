import { escapeMarkdown, MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction, type EmbedBuilder, type Guild } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { COLORS } from "@base/copy/brand.js";
import { getPluginCopy, type IPluginCopy } from "@base/copy/index.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { gameRoomsCopy } from "@features/game-rooms/gameRoomsCopy.js";
import { memberNameResolver } from "@features/ratings/memberNames.js";
import {
	formatLuckScore,
	formatRating,
	luckBoardInGuild,
	memberRatings,
	topRatedInGuild,
	type RatingSnapshot,
} from "@features/ratings/ratingBoards.js";
import { isRatedGame, RATED_GAMES, type RatedGame } from "@features/ratings/ratingEngine.js";
import { errorEmbed, infoEmbed } from "@utils/embedBuilder.js";
import { utcMonthKey } from "@utils/utcMonthKey.js";

// ── /rating ────────────────────────────────────────────────────────────────
// What:  the arcade ratings, member side (2026-10 item 244 Phase 3b). `me [game]`
//        is the member's own rating in each rated game; `board <game>` is this
//        server's best rated players of one game; `luck` is this server's luck
//        board for the month. Members call it a rating, never Elo.
// Who:   every member. PUBLIC, like /account and /levels, and in neither admin
//        mechanism: not in ADMIN_COMMANDS and no default member permission.
// When:  on demand. The monthly arcade post is the passive half.
// Where: reads through features/ratings/ratingBoards.ts, the same reads the monthly
//        post makes, so the command and the post can never rank two ways. Writes
//        nothing; the finish sites write (Phase 3a).
// How:   ① guild gate (a rating is only ever shown inside a server); ② defer,
//        since a board is a few round trips; ③ dispatch on the subcommand;
//        ④ one embed.
//
// ⚠️ NOTHING NETWORK WIDE. A rating follows its player across servers, but every
// board here starts from the players with a MatchResult in THIS server, and `me`
// only ever shows the asking member their own numbers (risk R9).
//
// Item 245 Phase 4b (the command merge) has not run yet, so /rating is a new top
// level name that phase must fold into its command layout.

const words = rokCommanderCopy.arcadeRatings;
const GAME_OPTION = "game";
const LIMITS = BOT_CONSTANTS.RATINGS;

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
	)
	.addSubcommand((sub) => sub.setName("luck").setDescription(words.command.luck));

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
		await interaction.reply({ embeds: [errorEmbed(words.notInGuild)], flags: MessageFlags.Ephemeral });
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
	return myAnswer(request);
}

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
	const players = await topRatedInGuild({ guildId: guild.id, game: ratedGame, limit: LIMITS.BOARD_SIZE, resolveNames: memberNameResolver(guild) });

	const title = copy.board.title(gameRoomsCopy.gameLabel(ratedGame));
	if (players.length === 0) return infoEmbed(title, copy.board.empty, COLORS.ARCADE);

	const rows = players.map((player, index) => copy.board.row(index + 1, escapeMarkdown(player.displayName), formatRating(player, copy.provisionalMark)));
	const body = [rows.join("\n"), provisionalNoteFor(players, copy)].filter(Boolean).join("\n\n");
	return infoEmbed(title, body, COLORS.ARCADE);
}

// ── luck ──

async function luckAnswer({ guild, words: copy }: RatingRequest): Promise<EmbedBuilder> {
	const players = await luckBoardInGuild({
		guildId: guild.id,
		month: utcMonthKey(new Date()),
		limit: LIMITS.BOARD_SIZE,
		resolveNames: memberNameResolver(guild),
	});
	const rows = players.map((player, index) =>
		copy.luck.row(index + 1, escapeMarkdown(player.displayName), formatLuckScore(player.score), player.wins, player.decided)
	);
	const board = rows.length > 0 ? rows.join("\n") : copy.luck.empty(LIMITS.LUCK_MIN_DECIDED);
	return infoEmbed(copy.luck.title, `${copy.luck.description}\n\n${board}`, COLORS.ARCADE);
}

// The note explaining the mark, only when a number on screen carries it.
function provisionalNoteFor(ratings: readonly Pick<RatingSnapshot, "provisional">[], copy: RatingWords): string {
	return ratings.some((rating) => rating.provisional) ? `*${copy.provisionalNote}*` : "";
}
