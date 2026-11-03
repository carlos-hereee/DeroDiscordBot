import { type RepliableInteraction, type User } from "discord.js";
import { memberLevelStore } from "@db/stores/memberLevelStore.js";
import { levelFromTotalXp } from "@features/leveling/levelCurve.js";
import { milestoneLevelsUpTo } from "@features/leveling/primeLevels.js";
import { getLevelingConfig } from "@features/leveling/levelingConfig.js";
import { levelingCopy } from "@features/leveling/levelingCopy.js";
import { buildAchievementsCardEmbed, buildAchievementsEmbed, type AchievementProgressView } from "@features/leveling/levelingEmbeds.js";
import { ACHIEVEMENTS_AVATAR_SIZE, renderAchievementsCard } from "@features/leveling/achievementsRenderer.js";
import { avatarRequestFor, isRenderPayload, withRenderFallback } from "@features/renderer/index.js";
import { buildCounters, progressFor, unlockedKey } from "@features/leveling/achievementEngine.js";
import { ACHIEVEMENTS_BY_ID } from "@features/leveling/achievements.js";
import { beginProfileAnswer } from "@features/leveling/accountProfile.js";
import { showNotice } from "@utils/textModal.js";
import { getPluginCopy } from "@base/copy/getCopy.js";

// ── /account view:achievements ─────────────────────────────────────────────
// What:  which achievement tiers a member holds, with the action that earned
//        each one, plus the two they are closest to.
// Who:   every member. /account view:achievements is PUBLIC, in neither admin
//        mechanism; the #command-center guide's Achievements button answers
//        privately. Both call showAchievements (2026-10 item 245 Phase 4b folded
//        the old /achievements command into /account).
// When:  on demand. Read only, and it never writes.
// How:   a drawn card (achievementsRenderer, 2026-10 item 254), with the text embed
//        as the fallback when the canvas cannot draw.
// Where: the counters it reads are the ones MemberLevel already maintains, so
//        this view adds no listener and no write anywhere.
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

/** Whose honors to show. */
export interface AchievementsRequest {
	target: User;
}

/** Reply with `target`'s held achievements and the two closest to unlocking. */
export async function showAchievements(interaction: RepliableInteraction, { target }: AchievementsRequest): Promise<void> {
	const guildId = interaction.guildId;
	if (!guildId) {
		await showNotice(interaction, { title: getPluginCopy(null).notice.leveling, sections: [levelingCopy.errors.outsideGuild] });
		return;
	}

	if (target.bot) {
		await showNotice(interaction, { title: getPluginCopy(null).notice.leveling, sections: [levelingCopy.errors.botMember] });
		return;
	}

	// Read before the acknowledgement (a cached config read), so a server with no leveling data
	// is a notice while a modal can still open (owner rule 1 of the Round 3 list, 2026-10 item 263).
	const context = await getLevelingConfig(guildId);
	if (!context) {
		await showNotice(interaction, { title: getPluginCopy(null).notice.leveling, sections: [levelingCopy.errors.noData] });
		return;
	}

	const answer = await beginProfileAnswer(interaction);

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

	// The card when it renders, the text view when it does not. Either way one reply.
	const reply = await withRenderFallback(
		() => renderAchievementsCard({ displayName, avatar: avatarRequestFor(target, ACHIEVEMENTS_AVATAR_SIZE), unlocked: shown, inProgress }),
		() => buildAchievementsEmbed(displayName, shown, inProgress)
	);
	if (isRenderPayload(reply)) {
		await answer.send({ embeds: [buildAchievementsCardEmbed(displayName, reply.ref)], files: [reply.attachment] });
		return;
	}
	await answer.send({ embeds: [reply] });
}
