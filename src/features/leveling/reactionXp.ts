import {
	Events,
	type Client,
	type MessageReaction,
	type PartialMessageReaction,
	type PartialUser,
	type User,
} from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { LOG_MESSAGES } from "@base/constants/log-messages.js";
import { awardXp } from "./awardXp.js";
import { getLevelingConfig } from "./levelingConfig.js";
import { isRestricted, resolveMultiplier, rollXp } from "./xpRules.js";
import { claimCooldown, releaseCooldown } from "./xpWriter.js";

// ── reactionXp ─────────────────────────────────────────────────────────────
// ⚠️ THIS IS THE SECOND Events.MessageReactionAdd LISTENER IN THIS CODEBASE.
// The first lives in src/features/activity-tracking/ActivityTracker.ts and it is
// NOT this one. Two listeners on one event reads as a bug on sight, so both
// files carry a comment pointing at the other. The differences are total:
//
//   ActivityTracker   filters to the ✅ emoji, ONLY on a message that is a stored
//                     ReminderLog, ONLY when that log is not a test fire, and
//                     writes PlayerActivity (ROK event participation).
//   this file         accepts ANY emoji on ANY message, ignores ReminderLog
//                     entirely, and writes MemberLevel (presence over time).
//
// Neither may touch the other's model, and folding them together would mean
// inventing a fake eventId for "somebody reacted to something", which corrupts
// the participation score, /leaderboard, the dashboard players route and the
// pinned board simultaneously.
//
// What:  award xp for reacting, and optionally for being reacted to.
// When:  on every reaction the bot can see, so the guards below are ordered by
//        cost exactly as the message listener's are.
// How:   ① free rejections, ② one claim per reactor per message, ③ a separate
//        rate claim per RECIPIENT, ④ award.
//
// ⚠️ A REMOVED REACTION NEVER CLAWS XP BACK, and there is deliberately no
// MessageReactionRemove listener in this feature at all. Reversing an award on
// removal turns into its own farm loop (react, unreact, react) and punishes the
// ordinary case of fixing a misclick.

export function registerReactionXp(client: Client): void {
	client.on(Events.MessageReactionAdd, (reaction, user) => {
		void handleReaction(reaction, user).catch((error) => {
			console.warn(LOG_MESSAGES.leveling.awardFailed("reaction", reaction.message?.guildId ?? "unknown"), error);
		});
	});
}

export async function handleReaction(
	reaction: MessageReaction | PartialMessageReaction,
	user: User | PartialUser
): Promise<void> {
	if (user.bot) return;

	// Discord sends a partial for anything not recently cached, so properties must
	// be fetched before they are read. Same discipline ActivityTracker uses.
	const fullReaction = reaction.partial ? await reaction.fetch() : reaction;
	const guildId = fullReaction.message.guildId;
	if (!guildId) return;

	const context = await getLevelingConfig(guildId);
	if (!context) return;
	const settings = context.settings;
	if (!settings.enabled || !settings.reaction.enabled) return;

	const message = fullReaction.message;
	const authorId = message.author?.id ?? null;
	const reactorId = user.id;

	// ⚠️ Never award a member for reacting to their own message, under ANY awards
	// mode. Under "both" that would be one member paying themselves twice, which
	// is the single most obvious farm in the whole feature.
	if (authorId && authorId === reactorId) return;

	// Channel restrictions apply here exactly as they do to messages: a channel an
	// admin excluded from earning must not become a reaction farm instead.
	const channelIds = [message.channelId, (message.channel as { parentId?: string | null } | null)?.parentId ?? null].filter(
		(id): id is string => typeof id === "string"
	);
	if (isRestricted(settings.restrictionMode, settings.restrictedChannels, channelIds)) return;

	// ── one claim per reactor per message ──
	// Stops a member piling ten emoji onto one message for ten awards. The window
	// is the sweep's maximum age rather than the guild's cooldown, because the
	// rule is "once per message" rather than "once per interval"; after the sweep
	// drops the entry the member could earn on that same message again, which is
	// an acceptable bound given the per recipient rate claim below still holds and
	// re-reacting to an hour old message one emoji at a time is not a real vector.
	const perMessageKey = `${guildId}:${reactorId}:reaction-msg:${message.id}`;
	if (!claimCooldown(perMessageKey, BOT_CONSTANTS.LEVELING.MAX_COOLDOWN_SECONDS * 1000)) return;

	const recipients = resolveRecipients(settings.reaction.awards, reactorId, authorId, message.author?.bot ?? false);
	if (recipients.length === 0) {
		releaseCooldown(perMessageKey);
		return;
	}

	const guild = message.guild;
	let awarded = 0;

	for (const recipient of recipients) {
		// ── the rate claim, PER RECIPIENT ──
		// Each member has their own reaction window. A popular member whose message
		// collects thirty reactions earns once per window, not thirty times, and
		// that is a different question from how fast the reactor may react.
		const rateKey = `${guildId}:${recipient.userId}:reaction`;
		if (!claimCooldown(rateKey, settings.reaction.cooldownSeconds * 1000)) continue;

		const member = guild?.members.cache.get(recipient.userId) ?? null;
		const roleIds = member ? [...member.roles.cache.keys()] : [];
		if (settings.restrictedRoles.length > 0 && isRestricted(settings.restrictionMode, settings.restrictedRoles, roleIds)) {
			releaseCooldown(rateKey);
			continue;
		}

		const multiplier = resolveMultiplier(
			[...settings.roleMultipliers, ...settings.channelMultipliers],
			[...roleIds, ...channelIds],
			settings.stackMultipliers
		);

		await awardXp({
			client: fullReaction.client,
			guildId,
			userId: recipient.userId,
			username: member?.displayName ?? recipient.fallbackName,
			// A flat REACTION_XP rather than a range (the 1.7.0 test fixes, item 5);
			// rollXp still applies the multiplier and its floor of 1.
			amount: rollXp(BOT_CONSTANTS.LEVELING.REACTION_XP, BOT_CONSTANTS.LEVELING.REACTION_XP, multiplier),
			source: "reaction",
			// Only the member who actually reacted has their "reactions given"
			// counter moved. The author was reacted TO, which is not the same act,
			// and the-applause achievement counts the giving.
			counters: recipient.isReactor ? { reactionsGiven: 1 } : {},
			channelId: message.channelId,
		});
		awarded += 1;
	}

	// Nobody was actually paid, so give the reactor their per message claim back
	// rather than silently consuming their one shot at this message.
	if (awarded === 0) releaseCooldown(perMessageKey);
}

interface Recipient {
	userId: string;
	fallbackName: string;
	isReactor: boolean;
}

// Who the guild's `awards` setting says gets paid. A bot author is dropped here
// rather than at the award, so "both" still pays the reactor for reacting to a
// bot's message instead of failing the whole event.
function resolveRecipients(
	awards: "reactor" | "author" | "both",
	reactorId: string,
	authorId: string | null,
	authorIsBot: boolean
): Recipient[] {
	const reactor: Recipient = { userId: reactorId, fallbackName: reactorId, isReactor: true };
	const author: Recipient | null =
		authorId && !authorIsBot ? { userId: authorId, fallbackName: authorId, isReactor: false } : null;

	if (awards === "reactor") return [reactor];
	if (awards === "author") return author ? [author] : [];
	return author ? [reactor, author] : [reactor];
}
