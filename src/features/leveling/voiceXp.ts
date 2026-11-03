import { ChannelType, type Client, type Guild, type GuildMember } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { LOG_MESSAGES } from "@base/constants/log-messages.js";
import { awardXp } from "./awardXp.js";
import { getLevelingConfig, type LevelingVoiceSettings } from "./levelingConfig.js";
import { isRestricted, resolveMultiplier } from "./xpRules.js";
import { claimCooldown } from "./xpWriter.js";

// ── voiceXp ────────────────────────────────────────────────────────────────
// A SWEEP over cached voice states, not an award on VoiceStateUpdate, and NOT a
// bot that joins the channel to listen.
//
// What:  pay members who are genuinely present in an admin approved voice
//        channel, on an interval, with three anti farm gates and a decay.
// Who:   started once from main.ts. Nothing else calls into it.
// When:  every VOICE_SWEEP_INTERVAL_MS. Pays for elapsed MINUTES rather than per
//        tick, so the award stays honest even if a tick is late.
// Where: this does NOT touch ActivityTracker's VoiceStateUpdate listener, which
//        tracks ROK event participation inside an event window and stays exactly
//        as it is. Two systems, two questions, one event source.
//
// ⚠️ DO NOT MAKE THE BOT JOIN A VOICE CHANNEL to measure this. Arcane's own
// documentation gives the reasoning and it is sound: joining would limit voice
// xp to one channel per guild, be expensive to run, and be a privacy problem.
// Everything below reads cached state the gateway already sends.
//
// ⚠️ AN EMPTY approvedChannels LIST MEANS NOBODY EARNS. This is the opposite
// polarity from every other list in the config and it is deliberate: voice xp is
// opt in PER CHANNEL by construction, so a guild that never configures it never
// has a voice farming surface at all. It is also the cheapest possible sweep for
// the overwhelming majority of guilds, which bail on the very first check.

interface VoiceSession {
	// When this continuous session started. Resets when the member leaves every
	// approved channel, which is what makes the decay measure one sitting rather
	// than a lifetime.
	startedAt: number;
	lastAwardAt: number;
}

// Keyed `${guildId}:${userId}`. Bounded by construction: every sweep deletes the
// entries of members no longer present in an approved channel.
const sessions = new Map<string, VoiceSession>();

let sweepTimer: ReturnType<typeof setInterval> | null = null;

export function startVoiceSweep(client: Client, intervalMs = BOT_CONSTANTS.LEVELING.VOICE_SWEEP_INTERVAL_MS): void {
	stopVoiceSweep();
	sweepTimer = setInterval(() => void sweepVoiceXp(client), intervalMs);
	sweepTimer.unref?.();
}

export function stopVoiceSweep(): void {
	if (sweepTimer) clearInterval(sweepTimer);
	sweepTimer = null;
}

export async function sweepVoiceXp(client: Client, now: number = Date.now()): Promise<void> {
	const stillPresent = new Set<string>();

	for (const guild of client.guilds.cache.values()) {
		try {
			await sweepGuild(guild, now, stillPresent);
		} catch (error) {
			// One guild's failure must not stall the sweep for the rest, the same
			// posture refreshAllLeaderboards takes.
			console.error(LOG_MESSAGES.leveling.voiceSweepFailed(guild.id), error);
		}
	}

	// A member who left every approved channel loses their session, so their next
	// stretch starts a fresh decay clock rather than inheriting an old one. This
	// is also what keeps the map bounded without a separate sweep.
	for (const key of sessions.keys()) {
		if (!stillPresent.has(key)) sessions.delete(key);
	}
}

async function sweepGuild(guild: Guild, now: number, stillPresent: Set<string>): Promise<void> {
	const context = await getLevelingConfig(guild.id);
	if (!context) return;
	const settings = context.settings;
	if (!settings.enabled || !settings.voice.enabled) return;
	// The cheapest possible exit, and the one almost every guild takes.
	if (settings.voice.approvedChannels.length === 0) return;

	for (const channelId of settings.voice.approvedChannels) {
		const channel = guild.channels.cache.get(channelId);
		if (!channel) continue;
		if (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice) continue;

		// ── GATE 2: a minimum headcount ──
		// Bots do not count toward it. Without this, one member sitting alone in a
		// channel earns indefinitely, which is the simplest farm there is and the
		// reason a 24/7 voice self bot works against most competitors.
		const humans = [...channel.members.values()].filter((member) => !member.user.bot);
		if (humans.length < settings.voice.minMembers) continue;

		for (const member of humans) {
			const key = `${guild.id}:${member.id}`;
			stillPresent.add(key);
			await awardMember(member, key, settings.voice, context, now, channelId);
		}
	}
}

async function awardMember(
	member: GuildMember,
	key: string,
	voice: LevelingVoiceSettings,
	context: Awaited<ReturnType<typeof getLevelingConfig>>,
	now: number,
	channelId: string
): Promise<void> {
	if (!context) return;
	const settings = context.settings;

	// ── GATE 3: actually participating ──
	// Self muted, self deafened, server muted or server deafened all mean the
	// member is not in the conversation. Arcane's anti farm set, copied wholesale,
	// because idling muted in a channel is the second simplest farm after idling
	// alone in one.
	const state = member.voice;
	if (state.selfMute || state.selfDeaf || state.serverMute || state.serverDeaf) return;

	// A restricted role earns nowhere, voice included.
	const roleIds = [...member.roles.cache.keys()];
	if (settings.restrictedRoles.length > 0 && isRestricted(settings.restrictionMode, settings.restrictedRoles, roleIds)) {
		return;
	}

	const session = sessions.get(key);
	if (!session) {
		// First sighting. Start the clock and pay nothing: the member has been
		// present for zero measured minutes so far, and paying on arrival would
		// reward joining and leaving repeatedly.
		sessions.set(key, { startedAt: now, lastAwardAt: now });
		return;
	}

	// Its OWN cooldown, never shared with message or reaction xp. See T6: the
	// three passive sources each keep their own window.
	if (!claimCooldown(`${member.guild.id}:${member.id}:voice`, voice.cooldownSeconds * 1000, now)) return;

	// Pay for elapsed MINUTES rather than per tick, so a late or missed tick does
	// not silently underpay, and cap it so a paused process cannot hand out a lump
	// sum for wall clock nobody was watched through.
	const elapsedMinutes = Math.floor((now - session.lastAwardAt) / 60_000);
	if (elapsedMinutes < 1) return;
	const payableMinutes = Math.min(elapsedMinutes, BOT_CONSTANTS.LEVELING.VOICE_MAX_MINUTES_PER_AWARD);
	session.lastAwardAt = now;

	// ── GATE 4: anti idle decay ──
	// Past decayAfterMinutes in one continuous sitting the award is multiplied
	// down. Somebody genuinely in a long call still earns; somebody who left the
	// tab open overnight earns a fraction.
	const sessionMinutes = (now - session.startedAt) / 60_000;
	const decay = sessionMinutes > voice.decayAfterMinutes ? voice.decayFactor : 1;

	const multiplier = resolveMultiplier(
		[...settings.roleMultipliers, ...settings.channelMultipliers],
		[...roleIds, channelId],
		settings.stackMultipliers
	);

	const amount = Math.floor(voice.perMinute * payableMinutes * decay * multiplier);
	// A heavy decay on a low rate can round to zero. The minutes still count
	// toward the round-table achievement, so the counter rides along even when the
	// xp does not.
	await awardXp({
		client: member.client,
		guildId: member.guild.id,
		userId: member.id,
		username: member.displayName,
		amount,
		source: "voice",
		counters: { voiceMinutes: payableMinutes },
	});
}

// ── test seams ──
export const _clearVoiceSessions = (): void => sessions.clear();
export const _voiceSessionCount = (): number => sessions.size;
export const _seedVoiceSession = (key: string, session: VoiceSession): void => {
	sessions.set(key, session);
};
