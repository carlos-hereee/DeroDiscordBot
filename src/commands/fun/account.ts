import { SlashCommandBuilder, MessageFlags, type ChatInputCommandInteraction, type User } from "discord.js";
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

// ── /account ───────────────────────────────────────────────────────────────
// What:  a member's full leveling profile: level and progress, standing, the
//        per game record, presence counters, and achievements.
// Who:   every member. PUBLIC.
// When:  on demand.
// Where: this ABSORBS what would otherwise be a /rank command. One profile
//        surface, not two, following the owner's standing rule that too many
//        slash commands is itself a usability problem. Rank is the second
//        section here rather than its own command.
// How:   one document read, two index-only counts, and two period lookups. No
//        sort of the guild anywhere.
//
// ⚠️ PUBLIC, so it is deliberately in NEITHER admin mechanism. It is not in
// BOT_CONSTANTS.ADMIN_COMMANDS and it carries no setDefaultMemberPermissions,
// exactly like /leaderboard and /list-events. Members seeing their own standing
// is the entire point of the feature.

export const data = new SlashCommandBuilder()
	.setName("account")
	.setDescription("See your level, rank, game record and achievements")
	.addUserOption((option) =>
		option.setName("member").setDescription("Whose profile to show. Defaults to you.").setRequired(false)
	);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
	const guildId = interaction.guildId;
	if (!guildId) {
		await interaction.reply({
			embeds: [errorEmbed(levelingCopy.errors.outsideGuild)],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const target: User = interaction.options.getUser("member") ?? interaction.user;
	const isSelf = target.id === interaction.user.id;

	if (target.bot) {
		await interaction.reply({ embeds: [errorEmbed(levelingCopy.errors.botMember)], flags: MessageFlags.Ephemeral });
		return;
	}

	// The profile is a handful of round trips, comfortably past Discord's three
	// second window on a cold connection, so acknowledge first.
	await interaction.deferReply();

	const context = await getLevelingConfig(guildId);
	if (!context) {
		await interaction.editReply({ embeds: [errorEmbed(levelingCopy.errors.noData)] });
		return;
	}

	const record = await memberLevelStore.findOne(guildId, target.id);

	// Someone ELSE with no row is genuinely nothing to show. Your OWN empty
	// profile is worth rendering: a level 1 card with an empty bar is an
	// invitation, and an error reads as the feature being broken.
	if (!record && !isSelf) {
		await interaction.editReply({ embeds: [errorEmbed(levelingCopy.errors.memberNoData)] });
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

	const { week, month } = periodKeysFor(new Date(), context.weekStart);
	const [weekRank, monthRank] = await Promise.all([
		rankInPeriod(guildId, target.id, week),
		rankInPeriod(guildId, target.id, month),
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
		await interaction.editReply({ embeds: [buildAccountCardEmbed(view, profile.ref)], files: [profile.attachment] });
	} else {
		await interaction.editReply({ embeds: [profile] });
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

// Null rather than a number when the member earned nothing in the period, which
// the embed renders as an omitted line rather than a misleading "#1 of nobody".
async function rankInPeriod(guildId: string, userId: string, period: string): Promise<number | null> {
	const row = await xpPeriodStore.findOne(guildId, userId, period);
	if (!row) return null;
	return xpPeriodStore.rankInPeriod(guildId, period, row.xp);
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
