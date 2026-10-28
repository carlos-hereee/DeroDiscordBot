import { TextChannel, type Client, type Guild, type Message, type MessageEditOptions } from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { isRenderPayload, withRenderFallback } from "@features/renderer/index.js";
import { roomOpenerLogo } from "./gameRoomsEmbeds.js";
import { openerCardEmbed, openerCardRows, type OpenerCardState } from "./challengeBoardEmbeds.js";
import { challengeCardView, renderChallengeCard } from "./challengeCardRenderer.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { flavorGameOf, pickFlavor, type OutcomeBucket } from "./matchOutcome.js";
import { refereeOn, type GameSlug } from "./roomTypes.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { labelBotMentions } from "./botSeat.js";
import { isRatedGame } from "@features/ratings/ratingEngine.js";
import { effectiveSpectatorMode } from "./roomPermissions.js";

// ── challengeCard ────────────────────────────────────────────────────
// What:  the challenge card as a message: finding its channel (⚔️challenges, or
//        🏆rated-challenges for a rated match, 2026-10 item 254, Arcade 5, and since
//        2026-10 item 263 Phase 2a only when the match is not casual), building its
//        state from the room row, and editing it in place with its picture. It decides
//        nothing about the challenge itself.
// Who:   challengeBoard, at every step of a draft, and roomLifecycle.finish, which
//        closes the card with the match's result (post-launch plan item 21).
// Where: its own module because finish needs it and challengeBoard imports
//        roomLifecycle, so leaving these in challengeBoard would make finish import
//        its own importer.

// ── which channel a challenge lives in ────────────────────────────────
// The two challenge channels' ids, off one GuildConfig read.
export interface ChallengeChannelIds {
	arcadeChallengesChannelId?: string | null;
	arcadeRatedChallengesChannelId?: string | null;
}

export async function readChallengeChannelIds(guildId: string): Promise<ChallengeChannelIds> {
	const stored = await guildConfigStore.findByGuildId(guildId);
	return (stored as unknown as ChallengeChannelIds | null) ?? {};
}

async function fetchTextChannel(guild: Guild, channelId: string | null | undefined): Promise<TextChannel | null> {
	if (!channelId) return null;
	const channel = await guild.channels.fetch(channelId).catch(() => null);
	return channel instanceof TextChannel ? channel : null;
}

/**
 * Whether a card of this game and match belongs in 🏆rated-challenges: a rated game
 * (ratingEngine.RATED_GAMES) whose match is not casual (owner decision 8, 2026-10 item 263
 * R3-5). The match is fixed at creation, so this never changes for a card once it posted.
 */
export const postsInRatedChannel = (game: GameSlug, casual: boolean): boolean => isRatedGame(game) && !casual;

/**
 * The channel a challenge card is posted in: 🏆rated-challenges for a rated game's rated
 * match, ⚔️challenges for every other, a casual Hold'em, Battleship or Monopoly match
 * included. Decided by the game AND the match, once, at creation; never by the card's badge
 * later, so a card never moves.
 *
 * A rated match falls back to ⚔️challenges while its guild has no 🏆rated-challenges yet
 * (the boot repair builds it on the next boot, and an admin can remove it), so a rated
 * challenge is never refused for a channel the member cannot do anything about.
 */
export async function resolveChallengesChannel(guild: Guild, game: GameSlug, casual = false): Promise<TextChannel | null> {
	const ids = await readChallengeChannelIds(guild.id);
	if (postsInRatedChannel(game, casual)) {
		const rated = await fetchTextChannel(guild, ids.arcadeRatedChallengesChannelId);
		if (rated) return rated;
	}
	return fetchTextChannel(guild, ids.arcadeChallengesChannelId);
}

/**
 * A link to a draft's challenge card, for a refusal that has to say where the slot is held
 * (2026-10 item 263 R3-9): the card's message in the channel its game and match post in, or
 * null for a row with no card. Built from ids alone, so it costs no fetch; a card that fell
 * back to ⚔️challenges while 🏆rated-challenges was missing links to the wrong channel, the
 * one case this cannot see.
 */
export function challengeCardLink(ids: ChallengeChannelIds, room: Pick<IGameRoom, "guildId" | "game" | "casual" | "boardMessageId">): string | null {
	if (!room.boardMessageId) return null;
	const channelId = (postsInRatedChannel(room.game, room.casual ?? false) ? ids.arcadeRatedChallengesChannelId : null) ?? ids.arcadeChallengesChannelId;
	return channelId ? `https://discord.com/channels/${room.guildId}/${channelId}/${room.boardMessageId}` : null;
}

/**
 * Whether a channel is one of the guild's two challenge channels, where nothing is
 * played (2026-10 item 254, Arcade 1): /mini-game typed there opens a room instead.
 */
export async function isChallengeChannel(guildId: string, channelId: string | null): Promise<boolean> {
	if (!channelId) return false;
	const ids = await readChallengeChannelIds(guildId);
	return channelId === ids.arcadeChallengesChannelId || channelId === ids.arcadeRatedChallengesChannelId;
}

// The card message, looked for in the channel its game and match post in first and then in
// the other challenge channel: a rated card posted before 🏆rated-challenges existed (or
// while it was missing) lives in ⚔️challenges, and so does a casual card of a rated game
// posted before the match decided the channel, and each must keep updating until its match ends.
async function findCardMessage(guild: Guild, room: IGameRoom): Promise<Message | null> {
	if (!room.boardMessageId) return null;
	const ids = await readChallengeChannelIds(guild.id);
	const preferred = postsInRatedChannel(room.game, room.casual ?? false)
		? [ids.arcadeRatedChallengesChannelId, ids.arcadeChallengesChannelId]
		: [ids.arcadeChallengesChannelId, ids.arcadeRatedChallengesChannelId];
	for (const channelId of preferred) {
		const channel = await fetchTextChannel(guild, channelId);
		const message = channel ? await channel.messages.fetch(room.boardMessageId).catch(() => null) : null;
		if (message) return message;
	}
	return null;
}

export function cardStateFor(room: IGameRoom, overrides: Partial<OpenerCardState> = {}): OpenerCardState {
	return {
		game: room.game,
		hostId: room.hostId,
		// A draft row carries the schema default "invite" before the host has chosen,
		// so the CARD's notion of "not chosen yet" cannot read the row's visibility
		// field. `status === "draft"` plus a null boardMessageId is not enough either.
		// The honest signal is startedAt: null and an explicit override from the
		// caller that knows whether the chooser has been answered.
		visibility: overrides.visibility ?? null,
		pool: room.spectatorIds ?? [],
		monopolyAuctions: room.monopolyAuctions ?? false,
		referee: refereeOn(room),
		// A table the host opened to the network (2026-10 item 244 Phase 5b), off the row.
		network: room.network ?? false,
		// The host's say over who joins (2026-10 item 244 Phase 4), off the draft row.
		hostControls: {
			ratingBand: room.ratingBand ?? "any",
			requireApproval: room.requireApproval ?? false,
			pendingJoinCount: (room.pendingJoinIds ?? []).length,
			// Who may watch (2026-10 item 254, Arcade 11), resolved from the visibility the
			// row holds, so the card's line and select show what the room will do.
			spectatorMode: effectiveSpectatorMode(overrides.visibility ?? room.visibility, room.spectatorMode),
		},
		// Play vs bots (2026-10 item 250 Phase 5), off the draft row.
		...(room.botsOffered ? { bots: { count: room.botSeats ?? 0 } } : {}),
		// The host's Casual choice (2026-10 item 254, Arcade 6), so even the closed card of a
		// casual match keeps its CASUAL badge.
		casual: room.casual ?? false,
		// Hold'em's buy in, set on the card (2026-10 item 257 Phase 4a).
		holdemBuyIn: room.holdemBuyIn ?? null,
		// What the creation modal or Edit settings could not apply (2026-10 item 263 Phase 2a).
		settingsNotes: room.settingsNotes ?? [],
		...overrides,
	};
}

// Re-render the opener card for a room's current state. Cosmetic, so a failure is
// logged and swallowed: the draft row is the truth and the next edit will catch up.
export async function refreshCard(guild: Guild, room: IGameRoom, state: OpenerCardState): Promise<void> {
	const message = await findCardMessage(guild, room);
	if (!message) return;
	await editOpenerCard(guild, room.roomId, message, state);
}

// ── the opener card's picture (2026-10 item 243 Phase 4) ──────────────
// Every card edit draws the host's and the joiners' faces and sends them with the
// text in ONE edit, so the picture and the pool line never disagree on screen.
// When the picture does not draw, the edit carries the text card alone, exactly
// as before. `attachments: []` drops the previous picture rather than letting it
// pile up as a loose file under the card on every edit.
//
// ⚠️ LATEST WINS. A render takes longer than a text edit (a cold avatar fetch can
// take seconds), so two joins close together could otherwise land out of order
// and leave the card showing the older pool. Each edit takes a generation number
// for its room, and an edit that finishes rendering after a newer one started is
// dropped: the newer one carries the newer state.
const cardGenerations = new Map<string, number>();

export type EditableCard = { edit(options: MessageEditOptions): Promise<unknown> };

export async function editOpenerCard(guild: Guild, roomId: string, message: EditableCard, state: OpenerCardState): Promise<void> {
	const generation = (cardGenerations.get(roomId) ?? 0) + 1;
	cardGenerations.set(roomId, generation);
	const picture = await withRenderFallback(
		async () => renderChallengeCard(await challengeCardView(guild, state)),
		() => null
	);
	if (cardGenerations.get(roomId) !== generation) return;
	// A cancelled or started card is never edited again, so its counter can go.
	if (state.cancelled || state.startedChannelId || state.resultLine) cardGenerations.delete(roomId);
	const card = isRenderPayload(picture) ? picture : null;
	// The picture leads with the game's logo; without it the text card carries the
	// logo as its thumbnail instead (openerCardEmbed).
	const logo = card ? null : roomOpenerLogo(state.game);
	const file = card?.attachment ?? logo?.attachment;
	// Cosmetic, so a failure is logged and swallowed: the draft row is the truth
	// and the next edit will catch up.
	try {
		await message.edit({
			embeds: [openerCardEmbed(state, card?.ref, logo?.ref)],
			components: openerCardRows(roomId, state),
			files: file ? [file] : [],
			attachments: [],
		});
	} catch (error) {
		console.warn("[game-rooms] failed to refresh the opener card", error);
	}
}

/**
 * Close a finished match's challenge card with its result line (post-launch plan item
 * 21). Rooms that never had a card (solo rooms, a rematch, a room opened by Dero) have
 * no boardMessageId and are skipped. Cosmetic and fire and forget, like every card edit:
 * a failure is logged and the result card in the room still says how it ended.
 */
export async function closeChallengeCard(client: Client, room: IGameRoom, resultLine: string): Promise<void> {
	if (!room.boardMessageId) return;
	try {
		const guild = client.guilds.cache.get(room.guildId) ?? (await client.guilds.fetch(room.guildId).catch(() => null));
		if (!guild) return;
		// The players face the host on the closed card, the people who actually played.
		const pool = room.playerIds.filter((id) => id !== room.hostId);
		await refreshCard(guild, room, cardStateFor(room, { visibility: room.visibility, pool, resultLine }));
	} catch (error) {
		console.warn("[game-rooms] could not close the challenge card", { roomId: room.roomId, error });
	}
}

/** What the closed card says about how the match ended, as finish knows it. */
export interface ChallengeResult {
	game: GameSlug;
	winnerId: string | null;
	abandoned: boolean;
	// Absent when the finishing call site named none: a match with a winner then reads
	// as "narrow", the plan's default, and one without reads as having no winner.
	bucket?: OutcomeBucket;
	// Hangman's guessers won together, so the room is named rather than a member.
	roomWon?: boolean;
}

/**
 * The closed card's line (post-launch plan item 21): "**winner** won." and a flavor
 * line for how, a draw, the room for hangman, or no flavor at all when nobody won.
 */
export function challengeResultLine(result: ChallengeResult, rng: () => number = Math.random): string {
	const words = gameRoomsCopy.postMatch;
	if (result.abandoned) return words.abandonedLine;
	const shelf = flavorGameOf(result.game);
	const flavorFor = (bucket: OutcomeBucket): string => (shelf ? pickFlavor(words.flavor, shelf, bucket, rng) : "");
	// A Dero bot can win (2026-10 item 250 Phase 5), and its mention resolves to nobody, so it is named.
	if (result.winnerId) return labelBotMentions(words.winnerLine(result.winnerId, flavorFor(result.bucket ?? "narrow")).trimEnd());
	if (result.roomWon) return words.roomWonLine(flavorFor(result.bucket ?? "narrow")).trimEnd();
	if (result.bucket === "draw") return words.drawLine(flavorFor("draw")).trimEnd();
	return words.noWinnerLine;
}
