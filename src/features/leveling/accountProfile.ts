import type { RepliableInteraction, User } from "discord.js";
import { errorEmbed } from "@utils/embedBuilder.js";
import { memberLevelStore } from "@db/stores/memberLevelStore.js";
import { xpPeriodStore } from "@db/stores/xpPeriodStore.js";
import { levelFromTotalXp, xpIntoLevel, xpToNextLevel } from "@features/leveling/levelCurve.js";
import { nextMilestoneAtOrAbove } from "@features/leveling/primeLevels.js";
import { periodKeysFor } from "@features/leveling/levelPeriod.js";
import { getLevelingConfig } from "@features/leveling/levelingConfig.js";
import { levelingCopy } from "@features/leveling/levelingCopy.js";
import { reconcileRewards } from "@features/leveling/roleRewards.js";
import { buildAccountCardEmbed, buildAccountEmbed, type AccountView } from "@features/leveling/levelingEmbeds.js";
import { ACCOUNT_AVATAR_SIZE, renderAccountCard } from "@features/leveling/accountRenderer.js";
import { LEVELING_GAME_SLUGS, type IGameRecord } from "@features/leveling/levelingTypes.js";
import { avatarRequestFor, isRenderPayload, withRenderFallback } from "@features/renderer/index.js";
import { memberLuckInGuild } from "@features/ratings/ratingBoards.js";
import { isChipEconomyOn, readWallet } from "@features/economy/chipWallet.js";
import { readCoinBalance } from "@features/economy/deroCoins.js";
import { ULTRA_WEIGHT } from "@features/fortune/rollFortune.js";
import { fortuneBuffStore } from "@db/stores/fortuneBuffStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { utcMonthKey } from "@utils/utcMonthKey.js";
import { beginChannelAnswer, type PendingChannelAnswer } from "@utils/answerInChannel.js";
import { showErrorNotice } from "@utils/textModal.js";

// ── the account profile ────────────────────────────────────────────────────
// What:  a member's full leveling profile: level and progress, standing, the
//        per game record, presence counters, and achievements.
// Who:   /account (view profile, the default), PUBLIC, and the #command-center
//        guide's Account button, PRIVATE, because a guide's buttons answer only
//        the member who pressed them (2026-10 item 245 Phase 4b; the Fortune
//        button set that rule). Both call showAccountProfile.
// Where: this ABSORBS what would otherwise be a /rank command. One profile
//        surface, not two, following the owner's standing rule that too many
//        slash commands is itself a usability problem. Rank is the second
//        section here rather than its own command.
// How:   one document read, two index-only counts, and two period lookups. No
//        sort of the guild anywhere.

/** Whose profile to show. */
export interface AccountProfileRequest {
	target: User;
}

/** Reply with `target`'s profile card, or the text profile when the card cannot draw. */
export async function showAccountProfile(interaction: RepliableInteraction, { target }: AccountProfileRequest): Promise<void> {
	const guildId = interaction.guildId;
	if (!guildId) {
		await showErrorNotice(interaction, levelingCopy.errors.outsideGuild);
		return;
	}

	const isSelf = target.id === interaction.user.id;

	if (target.bot) {
		await showErrorNotice(interaction, levelingCopy.errors.botMember);
		return;
	}

	// The profile is a handful of round trips, comfortably past Discord's three
	// second window on a cold connection, so acknowledge first.
	const answer = await beginProfileAnswer(interaction);

	const context = await getLevelingConfig(guildId);
	if (!context) {
		await answer.send({ embeds: [errorEmbed(levelingCopy.errors.noData)] });
		return;
	}

	const record = await memberLevelStore.findOne(guildId, target.id);

	// Someone ELSE with no row is genuinely nothing to show. Your OWN empty
	// profile is worth rendering: a level 1 card with an empty bar is an
	// invitation, and an error reads as the feature being broken.
	if (!record && !isSelf) {
		await answer.send({ embeds: [errorEmbed(levelingCopy.errors.memberNoData)] });
		return;
	}

	const settings = context.settings;
	const totalXp = record?.totalXp ?? 0;
	const level = levelFromTotalXp(totalXp, settings.curve, settings.curveMultiplier, settings.maxLevel);

	// Rank is an INDEX ONLY COUNT against the { guildId, totalXp: -1 } index,
	// never a sort of the guild in application code. A member with no row has
	// earned nothing, so they sit one place behind everyone who has.
	const guildSize = await memberLevelStore.countInGuild(guildId);
	const guildRank = record ? await memberLevelStore.rankOf(guildId, totalXp) : guildSize + 1;

	const now = new Date();
	const { week, month } = periodKeysFor(now, context.weekStart);
	const [weekRank, monthRank, luck, chips, coins, luckBoost] = await Promise.all([
		rankInPeriod(guildId, target.id, week),
		rankInPeriod(guildId, target.id, month),
		readLuck(guildId, target.id, now),
		readChips(guildId, target.id, isSelf, now),
		readCoins(target.id),
		readLuckBoost(target.id),
	]);

	const member = interaction.guild?.members.cache.get(target.id) ?? null;

	const view: AccountView = {
		displayName: member?.displayName ?? target.globalName ?? target.username,
		avatarUrl: target.displayAvatarURL(),
		level,
		totalXp,
		xpIntoLevel: xpIntoLevel(totalXp, settings.curve, settings.curveMultiplier, settings.maxLevel),
		xpToNext: xpToNextLevel(totalXp, settings.curve, settings.curveMultiplier, settings.maxLevel),
		// A small nudge that only works once members have noticed the pattern, and
		// noticing it is the point of the hidden prime-mover achievement.
		nextLevelIsMilestone: settings.milestoneMode === "prime" && nextMilestoneAtOrAbove(level + 1) === level + 1,
		guildRank,
		guildSize,
		weekRank,
		monthRank,
		messages: record?.messages ?? 0,
		reactionsGiven: record?.reactionsGiven ?? 0,
		voiceMinutes: record?.voiceMinutes ?? 0,
		games: readGames(record?.games),
		luck,
		chips,
		coins,
		luckBoost,
		unlocked: record?.unlocked ?? [],
		avatar: avatarRequestFor(target, ACCOUNT_AVATAR_SIZE),
	};

	// The card when it renders, the text profile when it does not (no canvas
	// library on the host, a draw that threw). Either way one reply.
	const profile = await withRenderFallback(
		() => renderAccountCard(view),
		() => buildAccountEmbed(view)
	);
	if (isRenderPayload(profile)) {
		await answer.send({ embeds: [buildAccountCardEmbed(view, profile.ref)], files: [profile.attachment] });
	} else {
		await answer.send({ embeds: [profile] });
	}

	// ── reward role reconciliation, as a SIDE EFFECT of viewing a profile ──
	// Fire and forget, and deliberately after the reply: a role write must never
	// delay or break the profile the member asked for.
	//
	// It looks like an odd place for a role write, so the reason is written down.
	// Reward roles are NEVER mass assigned (Discord does not want it, and at ten
	// thousand members it is ten thousand calls against one per-guild bucket), so
	// an admin who adds a level 10 reward sees NOTHING happen for existing level 40
	// members and reports the feature as broken. Reconciling here is the pull based
	// half of the fix: the member's own profile view is the moment they are most
	// likely to notice a missing role, and it costs one cached read when there is
	// nothing to change. Arcane shipped exactly this on 2025-07-28 "due to a large
	// number of users needing the ability to apply role rewards retroactively".
	void reconcileRewards(interaction.client, guildId, target.id, level);
}

/**
 * Acknowledge a profile, standings, achievements or saved matches view before its reads
 * run. Every /account view, from the command or a guide button, posts in 💬dero-commands
 * (2026-10 item 257, owner decision 3 of Phase 5), so one helper keeps the four alike.
 */
export function beginProfileAnswer(interaction: RepliableInteraction): Promise<PendingChannelAnswer> {
	return beginChannelAnswer(interaction, "member");
}

// Null rather than a number when the member earned nothing in the period, which
// the embed renders as an omitted line rather than a misleading "#1 of nobody".
async function rankInPeriod(guildId: string, userId: string, period: string): Promise<number | null> {
	const row = await xpPeriodStore.findOne(guildId, userId, period);
	if (!row) return null;
	return xpPeriodStore.rankInPeriod(guildId, period, row.xp);
}

// The luck board's numbers for this UTC month (the board's own month key, not the
// leveling period, which follows the server's week start). A failed read leaves the
// line out as "nothing decided" rather than failing the profile around it.
async function readLuck(guildId: string, userId: string, now: Date): Promise<AccountView["luck"]> {
	try {
		return await memberLuckInGuild(guildId, userId, utcMonthKey(now));
	} catch (error) {
		console.error(`[account] reading the luck of ${userId} in guild ${guildId} failed`, error);
		return null;
	}
}

// The member's chips (2026-10 item 250 Phase 5): "off" when the server has chips off,
// which the currencies say (2026-10 item 257 Phase 3a), and a failed read leaves the line
// out rather than failing the profile around it, like the luck. The claim hint is only
// for the member's own profile.
async function readChips(guildId: string, userId: string, isSelf: boolean, now: Date): Promise<AccountView["chips"]> {
	try {
		const config = await guildConfigStore.findByGuildId(guildId);
		if (!isChipEconomyOn(config)) return "off";
		const wallet = await readWallet({ guildId, userId });
		return { balance: wallet.balance, claim: isSelf ? { nextClaimAt: wallet.nextClaimAt, now } : null };
	} catch (error) {
		console.error(`[account] reading the chips of ${userId} in guild ${guildId} failed`, error);
		return null;
	}
}

// The member's Dero coins, global across servers (2026-10 item 257 Phase 3a). A failed
// read leaves the line out, like the chips.
async function readCoins(userId: string): Promise<number | null> {
	try {
		return await readCoinBalance(userId);
	} catch (error) {
		console.error(`[account] reading the Dero coins of ${userId} failed`, error);
		return null;
	}
}

// The secret code luck boost (FortuneBuff, global): the gold reading chance a redeemed
// code granted above rollFortune's base ULTRA_WEIGHT, in whole percentage points, so
// GILDED-BY-SILENT's 0.19 reads +16. Null with no code, or when the read fails, which
// leaves the line out rather than failing the profile.
async function readLuckBoost(userId: string): Promise<number | null> {
	try {
		const { weight } = await fortuneBuffStore.stateFor(userId);
		return luckBoostPercent(weight);
	} catch (error) {
		console.error(`[account] reading the luck boost of ${userId} failed`, error);
		return null;
	}
}

/** A FortuneBuff weight as the account card's boost: percentage points above the base gold chance, or null for none. */
export function luckBoostPercent(weight: number | undefined): number | null {
	if (weight === undefined || weight <= ULTRA_WEIGHT) return null;
	return Math.round((weight - ULTRA_WEIGHT) * 100);
}

// The games map arrives as a Mongoose Map. Games the member has never played are
// omitted entirely rather than rendered as a row of zeros, and the order follows
// the declared slug list so two members' profiles line up column for column.
function readGames(games: Map<string, IGameRecord> | undefined): AccountView["games"] {
	if (!games) return [];
	const rows: AccountView["games"] = [];
	for (const slug of LEVELING_GAME_SLUGS) {
		const record = games.get(slug);
		if (record && record.played > 0) rows.push({ slug, record });
	}
	return rows;
}
