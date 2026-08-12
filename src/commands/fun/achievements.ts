import { SlashCommandBuilder, MessageFlags, type ChatInputCommandInteraction, type User } from "discord.js";
import { errorEmbed } from "@utils/embedBuilder.js";
import { memberLevelStore } from "@db/stores/memberLevelStore.js";
import { levelFromTotalXp } from "@features/leveling/levelCurve.js";
import { milestoneLevelsUpTo } from "@features/leveling/primeLevels.js";
import { getLevelingConfig } from "@features/leveling/levelingConfig.js";
import { levelingCopy } from "@features/leveling/levelingCopy.js";
import { buildAchievementsEmbed, type AchievementProgressView } from "@features/leveling/levelingEmbeds.js";
import { buildCounters, progressFor, unlockedKey } from "@features/leveling/achievementEngine.js";
import { ACHIEVEMENTS_BY_ID } from "@features/leveling/achievements.js";

// ── /achievements ──────────────────────────────────────────────────────────
// What:  which achievement tiers a member holds, with the action that earned
//        each one, plus the two they are closest to.
// Who:   every member. PUBLIC, in neither admin mechanism, like /account and
//        /levels.
// When:  on demand. Read only, and it never writes.
// Where: the counters it reads are the ones MemberLevel already maintains, so
//        this command adds no listener and no write anywhere.
//
// ⚠️ A HIDDEN TRACK IS OMITTED ENTIRELY UNTIL IT UNLOCKS. Not shown as a locked
// placeholder, not shown with its name blanked out, not counted in a "3 of 12"
// total. A placeholder tells a member a secret exists, which is most of what the
// secret was. Three of the twelve tracks are hidden, and prime-mover in
// particular only makes sense if a member DISCOVERS that prime levels are the
// loud ones rather than being told a mystery track is waiting for them.
//
// A hidden track that HAS unlocked renders exactly like any other.

// How many in-progress rows to show. Two, because the list is a nudge rather
// than a checklist and a wall of twelve bars is neither.
const IN_PROGRESS_SHOWN = 2;

export const data = new SlashCommandBuilder()
	.setName("achievements")
	.setDescription("See which achievements you hold and which are closest")
	.addUserOption((option) =>
		option.setName("member").setDescription("Whose achievements to show. Defaults to you.").setRequired(false)
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
	if (target.bot) {
		await interaction.reply({ embeds: [errorEmbed(levelingCopy.errors.botMember)], flags: MessageFlags.Ephemeral });
		return;
	}

	await interaction.deferReply();

	const context = await getLevelingConfig(guildId);
	if (!context) {
		await interaction.editReply({ embeds: [errorEmbed(levelingCopy.errors.noData)] });
		return;
	}

	const record = await memberLevelStore.findOne(guildId, target.id);
	const settings = context.settings;
	const totalXp = record?.totalXp ?? 0;
	const level = levelFromTotalXp(totalXp, settings.curve, settings.curveMultiplier, settings.maxLevel);

	const unlocked = record?.unlocked ?? [];
	const held = unlocked.map((entry) => unlockedKey(entry.id, entry.tier));
	const counters = buildCounters(record ?? {}, level, milestoneLevelsUpTo(level));

	// ⚠️ The hidden filter is applied HERE, on the way to the renderer, rather
	// than inside the engine. progressFor evaluates hidden tracks exactly like
	// visible ones on purpose (hidden governs listing, not earning), so this is
	// the one place that decides what a member is allowed to SEE.
	const inProgress: AchievementProgressView[] = progressFor(counters, held)
		.filter((row) => !row.hidden)
		.slice(0, IN_PROGRESS_SHOWN)
		.map((row) => ({
			id: row.id,
			label: row.label,
			current: row.current,
			threshold: row.threshold,
			nextTier: row.nextTier,
		}));

	const member = interaction.guild?.members.cache.get(target.id) ?? null;
	const displayName = member?.displayName ?? target.globalName ?? target.username;

	// Unlocked entries render whatever their track's hidden flag says: once a
	// member has earned a secret, it is theirs to show off.
	const shown = unlocked.filter((entry) => ACHIEVEMENTS_BY_ID.has(entry.id));

	await interaction.editReply({ embeds: [buildAchievementsEmbed(displayName, shown, inProgress)] });
}
