import { Client, Guild } from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { BOT_LOG_EVENTS } from "@base/constants/BOT_LOG_EVENTS.js";
// Category names come from the pack rather than being retyped here. Both are
// universal across packs (the 2026-05-22 decision), which is why this reads the
// rok-commander pack directly, exactly as resolveCategoryName does.
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { fetchOnboardingSnapshot } from "@features/community/onboardingChannels.js";

// ── Discord Onboarding compatibility (FUTURE_PLANS item 35) ─────────
// When a guild has Discord Onboarding enabled (Community Server feature),
// new members only see channels that the admin has added to the
// "Default Channels" list. Channels outside the default list stay
// hidden until the member opts in via Channels & Roles. If our homebase
// category is not in defaults, new members never discover the bot and
// the introductions / announcements / leaderboard channels are
// effectively dead for them.
//
// This helper checks the onboarding state and DMs the guild owner once
// with instructions to add the homebase category to defaults. It is
// idempotent via the ONBOARDING_HEADSUP_SENT log key, every restart
// re-checks but only DMs the first time. If the owner ignores the DM,
// silence is the correct outcome rather than nagging on every deploy.
//
// Called from two places in main.ts:
//   - guildCreate handler, after autoSetup succeeds (new installs)
//   - ClientReady boot sweep, after ensureHomebase (existing guilds
//     paired before this feature shipped)
//
// All failures are swallowed. Onboarding readability is operational
// hygiene, not load-bearing for bot function, a guild without the
// DM still has a perfectly working bot, just one its new members
// cannot find by accident.
export async function checkOnboardingAndNotifyOwner(_client: Client, guild: Guild): Promise<void> {
	// Idempotency gate first. Skipping ahead of any Discord or DB calls
	// when we already sent the DM keeps restart-cost minimal for the
	// common case (most guilds, most boots).
	const alreadySent = await botLogStore.has(guild.id, BOT_LOG_EVENTS.ONBOARDING_HEADSUP_SENT);
	if (alreadySent) return;

	// Skip non-community guilds without spending a Discord API call.
	// Onboarding is a Community Server feature; guilds without the
	// COMMUNITY flag in their features list cannot have Onboarding
	// enabled at all, so there is nothing to check. fetchOnboarding
	// would throw for these guilds anyway, but the property read is
	// O(1) and free, no rate limit, no network round trip. If the
	// admin later enables Community on the guild, the features list
	// updates on the next gateway tick and the next boot picks it up.
	if (!guild.features.includes("COMMUNITY")) return;

	// Load the stored config to learn the homebase category id. If no
	// config exists yet (eg guildCreate is mid-flight and autoSetup
	// has not persisted), bail and let a future call try again. The
	// idempotency log has not been written so we will retry next time.
	const stored = await guildConfigStore.findByGuildId(guild.id);
	if (!stored?.categoryId) return;

	// fetchOnboarding requires ManageGuild permission. Failures here
	// (missing perm, transient outage, etc) are real exceptional cases
	// for a community-enabled guild; bail without logging so the next
	// restart retries after the admin grants permission or the outage
	// clears. The non-community case is already handled by the
	// guild.features check above.
	// Through the one shared read (onboardingChannels), so every Onboarding consumer
	// sees the same plain snapshot.
	let onboarding;
	try {
		onboarding = await fetchOnboardingSnapshot(guild);
	} catch (error) {
		console.warn(`[onboarding] fetchOnboarding failed for guild ${guild.id}, skipping check`, error);
		return;
	}

	// Onboarding off → no compat needed. New members see channels per
	// normal Discord permission rules. Do NOT log the idempotency key
	// because the owner might enable Onboarding later and we want a
	// future restart to catch that transition.
	if (!onboarding.enabled) return;

	// ── which managed categories are hidden from new members ──
	// BOTH categories count as of the 🎮 ARCADE GAMES work. A guild whose
	// homebase is defaulted but whose arcade is not has members who can read
	// announcements and cannot find a single game, which is exactly the
	// discovery problem this check exists to prevent, just one surface over.
	//
	// The arcade id is nullable on any row written before it existed, so it is
	// filtered out rather than reported as hidden: a category that does not
	// exist yet is the boot sweep's problem, not the owner's.
	const managed = [
		{ id: stored.categoryId, name: rokCommanderCopy.setup.categoryName },
		{ id: (stored as unknown as { gamesCategoryId?: string | null }).gamesCategoryId, name: rokCommanderCopy.setup.gamesCategoryName },
	].filter((category): category is { id: string; name: string } => Boolean(category.id));

	const hidden = managed.filter((category) => !onboarding.defaultChannelIds.includes(category.id));

	// All managed categories already in defaults → new members see the bot on
	// join, no warning needed. Same "do not log idempotency" rule: if the admin
	// later removes one from defaults, the next restart should catch it.
	if (hidden.length === 0) return;

	// Onboarding is enabled AND at least one managed category is not a default
	// channel. New members are blind to that surface until they opt in. DM the
	// owner with targeted instructions. We deliberately do NOT modify the
	// onboarding config from the bot side; that would be invasive without
	// explicit consent (and would require additional Discord permissions the bot
	// does not currently request).
	//
	// Owner-focused framing. The DM helps the owner solve a discovery problem
	// (new members not seeing what they post), so the copy avoids first-person
	// bot references and stays direct.
	//
	// Names the categories that are ACTUALLY hidden rather than a hardcoded one,
	// so an owner who already defaulted the homebase is not told to go and do the
	// thing they have done. The names are read from the pack rather than retyped,
	// which is what stops this DM from citing a category name that has since
	// changed (the 🎮 ARCADE GAMES rename would have broken a literal here).
	const hiddenNames = hidden.map((category) => category.name);
	const list = hiddenNames.length === 1 ? `the **${hiddenNames[0]}** category` : `these categories: **${hiddenNames.join("**, **")}**`;

	const dmBody = [
		`Heads up about ${guild.name}.`,
		``,
		`Onboarding is enabled in this server. By default, new members will not see ${list} until they opt in through Channels & Roles.`,
		``,
		`To ensure members can see what the bot posts, go to **Server Settings → Onboarding → Default Channels** and add ${hiddenNames.length === 1 ? "it" : "them"} to the list.`,
		``,
		`One-time setup. No action needed if you prefer members to opt in on their own.`,
	].join("\n");

	let dmSent = false;
	try {
		const owner = await guild.fetchOwner();
		await owner.send(dmBody);
		dmSent = true;
	} catch (error) {
		// DM failures are expected for any owner who has blocked DMs
		// from server members or who is otherwise unreachable. We still
		// log the attempt below so we do not retry forever in that case.
		console.warn(`[onboarding] could not DM owner of guild ${guild.id}`, error);
	}

	// Log the audit row unconditionally so subsequent boots see the
	// idempotency key and skip the whole check. Metadata captures
	// dmSent for operators investigating why a specific owner never
	// got the heads-up.
	try {
		await botLogStore.log(guild.id, BOT_LOG_EVENTS.ONBOARDING_HEADSUP_SENT, {
			dmSent,
			// Which categories were hidden at the time, so an operator can tell a
			// homebase-only warning from an arcade-only one without re-reading the DM.
			hiddenCategoryIds: hidden.map((category) => category.id),
			guildName: guild.name,
		});
	} catch (error) {
		console.error(`[onboarding] failed to write headsup audit row for ${guild.id}`, error);
	}
}
