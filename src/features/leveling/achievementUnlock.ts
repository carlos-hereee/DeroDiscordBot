import type { Client } from "discord.js";
import { LOG_MESSAGES } from "@base/constants/log-messages.js";
import { memberLevelStore } from "@db/stores/memberLevelStore.js";
import type { IMemberLevel } from "@db/models/MemberLevel.js";
import { awardXp } from "./awardXp.js";
import { buildCounters, evaluate, unlockedKey, type UnlockedTier } from "./achievementEngine.js";
import { levelFromTotalXp } from "./levelCurve.js";
import { milestoneLevelsUpTo } from "./primeLevels.js";
import { announceAchievements } from "./levelUpAnnouncer.js";
import { reconcileRewards } from "./roleRewards.js";
import type { LevelingSettings } from "./levelingConfig.js";

// ── achievementUnlock ──────────────────────────────────────────────────────
// The impure half of the achievement system: everything that happens AFTER the
// pure engine says a tier was crossed.
//
// What:  persist the unlock, pay its xp, grant its role, announce it.
// Who:   called from the flush path in xpWriter, once per flushed member per
//        flush, and from NOWHERE else. That single call site is half of the
//        recursion defense described in achievementEngine.ts.
// When:  after the flush's own writes have landed, so the counters this reads
//        are the ones the flush just produced.
// Where: never throws. It runs after a successful primary write and must not be
//        able to break it (convention 7).
//
// ⚠️ ORDER MATTERS HERE. The unlock is PERSISTED FIRST, before the xp, the role
// or the announcement. If the process dies between the persist and the rest, the
// member keeps an achievement they earned and simply misses its bonus; if the
// order were reversed they could be paid the bonus repeatedly on every flush
// until the write finally landed. Losing a bonus once beats paying it forever.

export async function runAchievementPass(
	client: Client,
	guildId: string,
	member: Pick<IMemberLevel, "userId" | "username" | "totalXp" | "messages" | "reactionsGiven" | "voiceMinutes" | "fortuneReadings" | "games" | "unlocked">,
	settings: LevelingSettings
): Promise<void> {
	try {
		const level = levelFromTotalXp(member.totalXp, settings.curve, settings.curveMultiplier, settings.maxLevel);
		const counters = buildCounters(member, level, milestoneLevelsUpTo(level));
		const held = (member.unlocked ?? []).map((entry) => unlockedKey(entry.id, entry.tier));

		const newly = evaluate(counters, held);
		// The overwhelming majority of flushes land here and cost nothing beyond the
		// arithmetic above: no query, no write, no Discord call.
		if (newly.length === 0) return;

		const at = new Date();

		// ① PERSIST. $addToSet rather than $push, so a replayed pass cannot
		// duplicate an entry, and never a read-modify-write, so two unlocks landing
		// together cannot overwrite each other.
		await memberLevelStore.addUnlocked(
			guildId,
			member.userId,
			newly.map((unlock) => ({ id: unlock.id, tier: unlock.tier, at, earnedBy: unlock.earnedBy }))
		);

		// ② PAY. Staged through awardXp with source "achievement", which BUFFERS
		// exactly like message xp, so it lands in the NEXT flush window as an
		// ordinary award. That is what keeps this pass from feeding itself: the xp
		// cannot cross a level inside the same pass that granted it.
		const bonus = newly.reduce((sum, unlock) => sum + unlock.xp, 0);
		if (bonus > 0) {
			await awardXp({
				client,
				guildId,
				userId: member.userId,
				username: member.username,
				amount: bonus,
				source: "achievement",
			});
		}

		// ③ GRANT, and ④ ANNOUNCE. Both fire and forget, both after the record is
		// already durable.
		if (newly.some((unlock) => unlock.roleId)) {
			void reconcileRewards(client, guildId, member.userId, level);
		}
		void announceAchievements(client, guildId, member.userId, newly, member.username);
	} catch (error) {
		console.error(LOG_MESSAGES.leveling.achievementFailed(guildId, member.userId), error);
	}
}

export type { UnlockedTier };
