import { Events, type Client, type Message } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { LOG_MESSAGES } from "@base/constants/log-messages.js";
import { awardXp } from "./awardXp.js";
import { getLevelingConfig, peekLevelingConfig, type GuildLevelingContext } from "./levelingConfig.js";
import { isRestricted, resolveMultiplier, rollXp } from "./xpRules.js";
import { claimCooldown, releaseCooldown } from "./xpWriter.js";

// ── messageXp ──────────────────────────────────────────────────────────────
// THE BOT'S FIRST EVER messageCreate LISTENER. Every ordering decision below is
// a hard requirement rather than a style preference, because this runs on every
// message in every channel of every guild the bot is in, forever.
//
// What:  award xp for participating in a conversation, once per cooldown.
// Who:   registered from main.ts beside registerActivityListeners.
// When:  on Events.MessageCreate. The overwhelming majority of invocations must
//        die at ZERO I/O, which is what the guard order exists for.
// Where: this is the hot path the whole xpWriter design exists to serve.
// How:   cheapest guards first, then a synchronous cooldown claim, then a TTL
//        cached config read, then the restriction and multiplier arithmetic, and
//        only then a staged award.
//
// ⚠️ NO MESSAGE CONTENT IS READ, STORED, OR LOGGED, and the bot does not request
// the MessageContent privileged intent. The GuildMessages intent alone tells the
// bot THAT a message happened, in which channel, from which member, which is the
// complete input a cooldown gated award needs. MessageContent would only be
// required for per word or length based xp, which is simultaneously the most
// gameable mode in this category, a privacy surface, and a Discord verification
// hurdle at 100 guilds. The structural guarantee is in xpRules: rollXp takes a
// range and a multiplier and has no parameter message text could be passed
// through, so length based xp cannot be added without deliberately changing a
// signature.

export function registerMessageXp(client: Client): void {
	client.on(Events.MessageCreate, (message) => {
		void handleMessage(message).catch((error) => {
			// Fire and forget. A leveling failure must never surface to a member who
			// was only trying to talk in a channel.
			console.warn(LOG_MESSAGES.leveling.awardFailed("message", message.guildId ?? "unknown"), error);
		});
	});
}

export async function handleMessage(message: Message): Promise<void> {
	// ── ① to ③, free rejections ──
	// No property read here costs anything, and together they discard bots, DMs,
	// webhooks and Discord's own system notices before any state is touched.
	if (message.author?.bot) return;
	if (!message.guildId || !message.guild) return;
	if (message.system) return;
	// A webhook message has no real member behind it. Its `author` is a synthetic
	// user, so awarding it would credit xp to an id nobody can look up.
	if (message.webhookId) return;

	// ── ④ the cooldown claim ──
	// The window is per guild, so it has to come from config, and config comes
	// from a TTL cache. PEEK first: on a warm cache (every message after the
	// first in a 30 second window) this reaches the claim with no await in front
	// of it, which is what keeps the claim's own race defense meaningful for two
	// messages arriving in the same tick.
	let context = peekLevelingConfig(message.guildId);
	if (context === undefined) {
		context = await getLevelingConfig(message.guildId);
	}
	if (!context) return;

	const settings = context.settings;
	if (!settings.enabled || !settings.message.enabled) return;

	// ⚠️ SYNCHRONOUS, and nothing may be awaited between the read and the write
	// inside it. Claimed BEFORE the restriction and multiplier work below, so a
	// member spamming a channel costs one Map.get per message rather than the
	// whole evaluation.
	const cooldownKey = `${message.guildId}:${message.author.id}:message`;
	if (!claimCooldown(cooldownKey, settings.message.cooldownSeconds * 1000)) return;

	// ── ⑦ and ⑧ restrictions ──
	// One mode plus one list, applied to channels and roles independently: a
	// member restricted by role earns nowhere, and a restricted channel pays
	// nobody. The channel's PARENT category rides along in the candidate list so
	// an admin can exclude a whole category with one entry, which is the common
	// intent and otherwise takes one entry per channel.
	const channelIds = [message.channelId, message.channel?.isThread?.() ? message.channel.parentId : null].filter(
		(id): id is string => typeof id === "string"
	);
	const parentId = (message.channel as { parentId?: string | null } | null)?.parentId ?? null;
	if (parentId && !channelIds.includes(parentId)) channelIds.push(parentId);

	// A restricted message earned nothing, so it gives the claim back, the way
	// reactionXp does: otherwise one message in an excluded channel would cost the
	// member a whole window of paying messages elsewhere (2026-10 item 280).
	if (isRestricted(settings.restrictionMode, settings.restrictedChannels, channelIds)) {
		releaseCooldown(cooldownKey);
		return;
	}

	const roleIds = message.member ? [...message.member.roles.cache.keys()] : [];
	// A guild with no role restrictions configured must never reject on this,
	// including when the member cache is cold and roleIds is empty.
	if (settings.restrictedRoles.length > 0 && isRestricted(settings.restrictionMode, settings.restrictedRoles, roleIds)) {
		releaseCooldown(cooldownKey);
		return;
	}

	// ── ⑨ the roll ──
	// A flat MESSAGE_XP rather than a range (the 1.7.0 test fixes, item 5), still
	// through rollXp so the multiplier and its floor of 1 behave exactly as before.
	const { MESSAGE_XP } = BOT_CONSTANTS.LEVELING;
	const multiplier = combinedMultiplier(settings, roleIds, channelIds);
	const amount = rollXp(MESSAGE_XP, MESSAGE_XP, multiplier);

	// ── ⑩ stage it ──
	// source "message" is the only buffered source. awardXp decides that, not this
	// file, so a change of policy lands in one place.
	await awardXp({
		client: message.client,
		guildId: message.guildId,
		userId: message.author.id,
		username: message.member?.displayName ?? message.author.globalName ?? message.author.username,
		amount,
		source: "message",
		counters: { messages: 1 },
		channelId: message.channelId,
	});
}

// Role and channel multipliers resolved together under ONE stacking rule, so a
// member who matches both a boosted role and a boosted channel gets an answer an
// admin can predict. Under stack=false the single highest applicable multiplier
// wins across both lists; under stack=true they all multiply.
export function combinedMultiplier(
	settings: GuildLevelingContext["settings"],
	roleIds: readonly string[],
	channelIds: readonly string[]
): number {
	return resolveMultiplier(
		[...settings.roleMultipliers, ...settings.channelMultipliers],
		[...roleIds, ...channelIds],
		settings.stackMultipliers
	);
}
