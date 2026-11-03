import type { Guild } from "discord.js";
import { snapshotOnboarding, type IOnboardingSnapshot } from "./onboardingDraft.js";

// ── onboardingChannels ───────────────────────────────────────────────
// What:  the ONE read of a guild's Discord Onboarding config (fetchOnboardingSnapshot)
//        and the set of channels Dero must never hide from @everyone because of it
//        (readOnboardingSafeChannels, 2026-10 item 257 Phase 1a). It never writes.
// Who:   OnboardingCheck (the owner heads up), configureOnboarding (the draft), the
//        boot gating reconcile in GuildSetupManager and adoptionChoice (moving a
//        server's own channel into the notice board).
// Why:   Discord refuses any overwrite that hides a channel Onboarding uses, with
//        DiscordAPIError 350003 "Onboarding channels must be readable by everyone".
//        Gating such a channel failed on every boot, and a refused overwrite during
//        adoption left the rules channel half moved. Reading the set first lets every
//        caller skip the write instead of meeting the refusal.
// How:   a safe channel is every Onboarding default channel, every channel an
//        Onboarding answer opens, and the guild's own rules channel, which Discord
//        requires readable on a Community server. A guild without Community has no
//        Onboarding, so it costs no API call. When the read is refused (Dero lacks
//        Manage Server), only the rules channel is known, and onboardingRead is false
//        so callers can treat every adopted channel as possibly safe.

/** The channels a guild's Onboarding needs readable by @everyone, and whether Onboarding itself could be read. */
export interface IOnboardingSafeChannels {
	onboardingRead: boolean;
	ids: ReadonlySet<string>;
}

const COMMUNITY_FEATURE = "COMMUNITY";

/** Read the live Onboarding config into plain data. Throws what Discord throws; callers decide what a refusal means. */
export async function fetchOnboardingSnapshot(guild: Pick<Guild, "fetchOnboarding">): Promise<IOnboardingSnapshot> {
	return snapshotOnboarding(await guild.fetchOnboarding());
}

/** Every channel id an Onboarding config uses: its defaults, and each channel an answer opens. */
export function channelsOnboardingUses(snapshot: Pick<IOnboardingSnapshot, "defaultChannelIds" | "prompts">): Set<string> {
	const ids = new Set(snapshot.defaultChannelIds);
	for (const prompt of snapshot.prompts) {
		for (const option of prompt.options) {
			for (const channelId of option.channelIds) ids.add(channelId);
		}
	}
	return ids;
}

/**
 * The channels Dero must keep readable by @everyone in this guild. Never throws: a
 * refused read logs one line and answers with the rules channel alone and
 * onboardingRead false.
 */
export async function readOnboardingSafeChannels(guild: Pick<Guild, "id" | "features" | "rulesChannelId" | "fetchOnboarding">): Promise<IOnboardingSafeChannels> {
	const rules = guild.rulesChannelId ? [guild.rulesChannelId] : [];
	// A real Guild always carries the array; a partial one (a test fake) has none, and
	// a guild that is not Community cannot have Onboarding at all.
	if (!(guild.features ?? []).includes(COMMUNITY_FEATURE)) return { onboardingRead: true, ids: new Set(rules) };
	try {
		const used = channelsOnboardingUses(await fetchOnboardingSnapshot(guild));
		return { onboardingRead: true, ids: new Set([...rules, ...used]) };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		console.warn(`[onboarding] guild ${guild.id}: could not read Onboarding (${reason}); keeping the rules channel and every adopted channel readable by everyone`);
		return { onboardingRead: false, ids: new Set(rules) };
	}
}

/**
 * Whether a channel must stay readable by @everyone: it is in the safe set, or
 * Onboarding could not be read and the channel is one the server already had
 * (adopted), which is the only kind Onboarding could be pointing at.
 */
export function mustStayReadable(safe: IOnboardingSafeChannels, channelId: string, isAdopted: boolean): boolean {
	return safe.ids.has(channelId) || (!safe.onboardingRead && isAdopted);
}
