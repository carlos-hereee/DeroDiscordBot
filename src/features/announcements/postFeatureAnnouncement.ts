import { ActionRowBuilder, ButtonBuilder, Client, TextChannel } from "discord.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { featureAnnouncedEvent } from "@base/constants/BOT_LOG_EVENTS.js";
import { getPluginCopy } from "@base/copy/getCopy.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { buildReleaseGiftButton } from "@features/announcements/releaseCoinGift.js";
import { buildSuggestionBoxButton } from "@features/suggestion-box/SuggestionBox.js";
import { isDev } from "@utils/config.js";
import { infoEmbed } from "@utils/embedBuilder.js";

// ── postFeatureAnnouncement ──────────────────────────────────────────
// What:  once per (guild, version) broadcast posted on bot boot. Two
//        surfaces per guild: #announcements (public, godly voice) and
//        #inner-sanctum (admin, plain voice, no ping). Copy lives in
//        each pack's featureAnnouncement block (resolved per guild via
//        getPluginCopy) and is keyed by the bot's
//        current package.json version; idempotency is enforced via
//        botLogStore with a `feature_announced:<version>` event key
//        so every new release gets its own bucket.
// Who:   called once at the tail of main.ts's ClientReady boot loop,
//        after ensureHomebase, refreshIntroEmbeds, and
//        refreshAllSchedules have finished. No other caller.
// When:  every boot. Most boots are no-ops (every guild has already
//        logged this version). Only the first boot after a deploy
//        actually posts anything.
// Where: reads the bot's version by resolving ../../../package.json
//        relative to the COMPILED module location in dist/. The
//        postinstall tsc-alias step does not rewrite relative paths,
//        so we build the path from import.meta.url at runtime.
// How:   ① load package.json version once (cheap, synchronous, runs
//           only on ClientReady);
//        ② iterate cached guilds sequentially so one guild's Discord
//           hiccup cannot stall the rest;
//        ③ for each guild: skip if setupComplete is false (new guilds
//           see the intro embed instead). skip if the version has
//           already been logged. otherwise post public + inner-sanctum
//           and log success.
//        ④ failures on either post are swallowed with a log. the
//           botLogStore write only fires after BOTH posts succeed so
//           a partial failure re-attempts next boot.

// The channels release copy names, with the GuildConfig field holding each one's id. The copy
// stays one plain string shared by every server, and each server's post swaps in its own link.
const LINKED_CHANNELS = {
	"⚙️dero-config": "deroConfigChannelId",
	"🧭onboarding": "onboardingConfigChannelId",
	"🎰arcade-control": "arcadeControlChannelId",
	"🛠️server-config": "serverConfigChannelId",
	"🕹️games": "arcadeGamesChannelId",
} as const;

/**
 * Turn each channel release copy names into a real link for this server. A server without that
 * channel keeps its plain name, because a mention of a missing channel reads as #unknown.
 */
export function linkReleaseChannels(text: string, config: Partial<Record<(typeof LINKED_CHANNELS)[keyof typeof LINKED_CHANNELS], string | null>>): string {
	return Object.entries(LINKED_CHANNELS).reduce((linked, [name, field]) => {
		const channelId = config[field];
		return channelId ? linked.replaceAll(name, `<#${channelId}>`) : linked;
	}, text);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── resolve bot version from package.json ───────────────────────────
// Compiled module lives at dist/features/announcements/postFeatureAnnouncement.js
// so package.json is three directories up. Resolve once at module load
// and cache, version cannot change without a new process. fs.readFileSync
// is correct here: this is one-shot init, not a hot path.
function loadBotVersion(): string {
	try {
		const pkgPath = path.resolve(__dirname, "..", "..", "..", "package.json");
		const raw = fs.readFileSync(pkgPath, "utf-8");
		const pkg = JSON.parse(raw) as { version?: string };
		if (!pkg.version) {
			console.warn("[feature-announcement] package.json has no version field; announcements disabled");
			return "";
		}
		return pkg.version;
	} catch (error) {
		// If we cannot read package.json, skip announcements entirely
		// rather than risk a weird idempotency key. The bot's other
		// features keep running; this is a degraded-mode fallback.
		console.warn("[feature-announcement] could not read package.json; announcements disabled", error);
		return "";
	}
}

const BOT_VERSION = loadBotVersion();

// Version → shipped-at cutoff. Compared against each guild's GuildConfig.createdAt
// so a brand-new guild does not see a historical changelog about a bug it never
// experienced. We hit this 2026-05-05 when the test guild joined post-1.4.0 and
// got the bug-fix announcement on first boot. Update this map whenever shipping
// a new version with a featureAnnouncement. ISO 8601 strings.
// If the release slips by more than two days, re date the entry to the actual bump day.
const VERSION_SHIPPED_AT: Record<string, string> = {
	"1.4.0": "2026-04-25T00:00:00Z",
	"1.5.0": "2026-05-11T00:00:00Z",
	"1.5.1": "2026-05-13T00:00:00Z",
	// The release prepared as 1.7.0 ships as 2.0.0, so 1.7.0 never reached a guild.
	"2.0.0": "2026-11-03T00:00:00Z",
	"2.0.1": "2026-11-04T00:00:00Z",
};

export async function postFeatureAnnouncements(client: Client): Promise<void> {
	if (!BOT_VERSION) {
		console.warn("[feature-announcement] disabled: could not resolve a bot version from package.json");
		return;
	}

	const eventKey = featureAnnouncedEvent(BOT_VERSION);

	// Per-reason counters so the boot summary explains exactly why each guild
	// did or did not get the announcement. A single `skipped` bucket made a
	// genuine miss (setup not complete) indistinguishable from a normal no-op
	// (already announced) in the logs, which is why "nothing posted" was opaque.
	let posted = 0;
	let skippedNotSetup = 0;
	let skippedJoinedAfter = 0;
	let skippedAlready = 0;
	let deferredNoChannels = 0;
	let failed = 0;

	console.log(`[feature-announcement] version ${BOT_VERSION}: evaluating ${client.guilds.cache.size} guild(s)`);

	// Sequential loop so one guild's Discord failure does not stall
	// the others. Parallel (Promise.all) would be slightly faster at
	// boot but loses the isolation guarantee and makes log ordering
	// harder to read when something does go wrong.
	for (const guild of client.guilds.cache.values()) {
		try {
			const config = await guildConfigStore.findByGuildId(guild.id);

			// Skip new guilds: setupComplete false means they either just
			// joined or never finished /setup. The intro embed covers the
			// "what does this bot do" question for them; a feature
			// announcement would be confusing when they have not yet
			// experienced the baseline features.
			if (!config?.setupComplete) {
				// setupComplete only flips true when an admin RUNS /setup to
				// completion. Auto-created channels on bot-join are not enough, so a
				// dev/test guild that never finished /setup lands here every boot.
				console.log(`[feature-announcement] guild ${guild.id} skipped: /setup not completed (setupComplete=false)`);
				skippedNotSetup += 1;
				continue;
			}

			// Skip guilds that joined AFTER this version shipped. They did
			// not experience the bug or feature being announced, so sending
			// them a historical changelog is confusing. Existing guilds
			// (joined before the cutoff) still see the announcement, and
			// the botLogStore check below keeps that exactly-once.
			const shippedAt = VERSION_SHIPPED_AT[BOT_VERSION];
			const guildCreatedAt = (config as { createdAt?: Date }).createdAt;
			if (shippedAt && guildCreatedAt && guildCreatedAt.getTime() > new Date(shippedAt).getTime()) {
				skippedJoinedAfter += 1;
				continue;
			}

			// Idempotency: has this guild already seen this version?
			// botLogStore.has is a single-document indexed lookup, cheap
			// enough to run once per guild per boot without batching.
			// A dev bot skips this so every boot reposts while the owner iterates on release copy,
			// with no reset-feature-announcement run. isDev, never a weaker check: production
			// must stay once per version, or every restart posts in every server.
			const alreadyAnnounced = !isDev && (await botLogStore.has(guild.id, eventKey));
			if (alreadyAnnounced) {
				skippedAlready += 1;
				continue;
			}

			// Resolve target channels. Both must exist and be TextChannels
			// for the announcement to fire, a missing announcements
			// channel is either a brand-new guild (caught above) or a
			// destroyed homebase (ensureHomebase's problem, not ours).
			const announcementsChannelId = config.announcementsChannelId;
			const adminChannelId = config.adminChannelId;
			if (!announcementsChannelId || !adminChannelId) {
				// Not a failure, just nothing to do. Do not log so the
				// next boot (when ensureHomebase has rebuilt) re-attempts.
				console.warn(`[feature-announcement] guild ${guild.id} missing announcement channels; deferring`);
				deferredNoChannels += 1;
				continue;
			}

			const announcementsChannel = await client.channels.fetch(announcementsChannelId).catch(() => null);
			const adminChannel = await client.channels.fetch(adminChannelId).catch(() => null);
			if (!(announcementsChannel instanceof TextChannel) || !(adminChannel instanceof TextChannel)) {
				console.warn(`[feature-announcement] guild ${guild.id} channels missing or wrong type; deferring`);
				deferredNoChannels += 1;
				continue;
			}

			// Resolve copy in this guild's pack voice. The public block diverges
			// by pack (kingdom vs plain English); the inner-sanctum changelog and
			// the colors are shared, but reading them from the same resolved pack
			// keeps a single source per guild.
			const packCopy = getPluginCopy(config);
			const c = packCopy.featureAnnouncement;

			// ── ① public announcement ─────────────────────────────
			// Posted WITHOUT a role ping per the owner's preference for
			// inner-sanctum-style quiet posts. The embed itself is loud
			// enough; a role ping here would feel like spam on every
			// release boot (since this fires once per version per guild
			// and existing members already have the notification dot).
			//
			// allowedMentions: { parse: [] } is belt-and-suspenders,
			// if a future edit ever adds a raw @everyone to the copy,
			// this prevents accidental mass notifications.
			// Inject the release version into the title from BOT_VERSION (package.json),
			// the single source of truth this announcement is keyed to, so the title
			// always reads the right version with no hardcoded version in the copy packs.
			const publicEmbed = infoEmbed(`${c.public.title} (v${BOT_VERSION})`, linkReleaseChannels(c.public.description, config), packCopy.COLORS.ANNOUNCEMENTS);

			// Suggestion Box rides the PUBLIC announcement only. A release post is the
			// one moment a member is already reading about what changed, which is when
			// "what should we build next" actually gets answers; #command-center's copy
			// of this button is passive and only found by someone already looking.
			// Safe to attach anywhere: registerSuggestionBoxHandlers (main.ts) dispatches
			// by customId PREFIX at the client level, so the button is not bound to the
			// message or channel it was built in. The admin send deliberately omits it,
			// admins have the same button in #command-center and the inner-sanctum post
			// is a changelog, not a call to action.
			// The Claim button rides beside it while a release offers a gift (releaseCoinGift.ts).
			const giftButton = buildReleaseGiftButton(BOT_CONSTANTS.DERO_COINS.CURRENT_RELEASE_GIFT);
			const suggestionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(...(giftButton ? [giftButton] : []), buildSuggestionBoxButton());
			await announcementsChannel.send({
				embeds: [publicEmbed],
				components: [suggestionRow],
				allowedMentions: { parse: [] },
			});

			// ── ② inner-sanctum admin update ───────────────────────
			// Plain voice, no ping, same allowedMentions guard. Posted
			// AFTER the public one so a failure on the public post does
			// not leave the admin with a "here's what shipped" while
			// the community has not seen anything yet.
			const adminEmbed = infoEmbed(`${c.innerSanctum.title} (v${BOT_VERSION})`, linkReleaseChannels(c.innerSanctum.description, config), packCopy.COLORS.ADMIN);
			await adminChannel.send({
				embeds: [adminEmbed],
				allowedMentions: { parse: [] },
			});

			// ── ③ log success ──────────────────────────────────────
			// Only AFTER both posts succeeded. A partial failure above
			// leaves the log blank, so the next boot re-attempts. This
			// is why the public post comes first, a duplicate public
			// post on retry is visible to the community, so we want the
			// admin post to be the one that retries, not the public one.
			// ...Actually on second thought that reasoning is reversed:
			// if the public post succeeds and the admin post fails, a
			// retry will double-post publicly. Leaving this ordering
			// for now because a boot-loop failure scenario is rare
			// enough that accepting possible double-publics is the
			// lesser evil vs. skipping the admin update entirely. If
			// this ever becomes a real issue, swap to log-after-public
			// with a separate admin retry.
			await botLogStore.log(guild.id, eventKey, { version: BOT_VERSION });
			posted += 1;
		} catch (error) {
			console.error(`[feature-announcement] guild ${guild.id} announcement failed`, error);
			failed += 1;
		}
	}

	console.log(
		`[feature-announcement] version ${BOT_VERSION} done: posted ${posted}, ` +
			`skipped ${skippedNotSetup + skippedJoinedAfter + skippedAlready} ` +
			`(not-setup ${skippedNotSetup}, joined-after-ship ${skippedJoinedAfter}, already-sent ${skippedAlready}), ` +
			`deferred ${deferredNoChannels}, failed ${failed}`
	);
}
