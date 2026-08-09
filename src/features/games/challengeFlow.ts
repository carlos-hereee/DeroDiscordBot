import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ComponentType,
	MessageFlags,
	type ButtonInteraction,
	type ChatInputCommandInteraction,
	type User,
} from "discord.js";
import { v4 as uuid } from "uuid";
import { errorEmbed } from "@utils/embedBuilder.js";
import { gamesCopy } from "./gamesCopy.js";
import { resolveGameAsset } from "./gamesAssets.js";
import { buildChallengeEmbed, buildChallengeClosedEmbed } from "./gamesEmbeds.js";

// ── challengeFlow ──────────────────────────────────────────────────────────
// What:  the one shared "X challenges Y, Y accepts or declines" engine. Both
//        /mini-game duel and /mini-game rps call issueChallenge and act only on
//        an "accepted" outcome; every other path (self challenge, bot opponent,
//        duplicate, decline, timeout) is reported to the players HERE so neither
//        game repeats that handling.
// Who:   duelHandler.ts (Phase 2) and rpsHandler.ts (Phase 3). Hangman and
//        fortune never touch this file, they have no opponent.
// When:  once per challenge, start to finish, inside one slash command
//        execution. Nothing here survives a restart, see the state note below.
// Where: an INLINE component collector, not the persistent interactionRegistry.
//        A challenge is a one shot control tied to one message, so it does not
//        need to stay clickable forever or survive a redeploy, and putting it in
//        the registry would mean defending its customId space permanently. This
//        is the same distinction configure-rok-reminders and decreeEditHandlers
//        already draw. Because no handler registers the "minigame" prefix,
//        main.ts' dispatchButton returns false for these clicks and the inline
//        collector receives them, exactly as documented in main.ts.
// How:   ① reject the impossible matchups before anything posts publicly,
//        ② claim the pair slot synchronously so two clicks in one tick cannot
//           both open a challenge, ③ post the prompt and wait on the collector,
//        ④ release the pair slot in a finally, on EVERY exit path.

// A challenge nobody answers must not sit clickable forever. 60s matches the
// confirm window delete-event already uses, long enough to notice a ping,
// short enough that a forgotten challenge clears itself quickly.
export const CHALLENGE_TIMEOUT_MS = 60_000;

// Prefix segment before the first ":" in every customId this file builds. It is
// deliberately NOT registered with interactionRegistry (see the Where note
// above); registering it would swallow these clicks before the collector sees
// them.
const CHALLENGE_CUSTOM_ID_PREFIX = "minigame:challenge";

export type ChallengeKind = "duel" | "rps";

export type ChallengeRejectionReason = "selfChallenge" | "botOpponent" | "duplicate" | "outsideGuild";

// The accepted branch hands back the opponent's Accept click UNACKNOWLEDGED on
// purpose: rps needs to reply to that exact interaction with the opponent's own
// ephemeral secret choice prompt (Phase 3), which is only possible if this file
// has not already replied to or updated it. The public challenge message is
// tidied through the original slash interaction instead, so the two never race.
export type ChallengeOutcome =
	| { status: "accepted"; challengeId: string; accept: ButtonInteraction }
	| { status: "declined" }
	| { status: "timedOut" }
	| { status: "rejected"; reason: ChallengeRejectionReason };

interface ActiveChallenge {
	challengeId: string;
	guildId: string;
	challengerId: string;
	opponentId: string;
	kind: ChallengeKind;
	createdAt: number;
}

// ── in-memory challenge state ──
// Process-scoped, single-process only, exactly like ActivityTracker's voice
// session cache and PowerUps' in-flight role resolve map. Railway sends SIGTERM
// on every deploy, so a challenge open at that moment is simply lost; that is an
// accepted v1 tradeoff for low stakes fun, not an oversight. There is no
// timeout handle stored here because the collector's own `time` option IS the
// timeout, one clock instead of two that could disagree.
//
// Keyed by an unordered PAIR so A challenging B collides with B challenging A
// while either is open. A player may still hold challenges against DIFFERENT
// opponents at once; per-user spam is the calling game's CooldownManager job,
// not this engine's.
const activeChallenges = new Map<string, ActiveChallenge>();

function pairKey(guildId: string, challengerId: string, opponentId: string): string {
	return `${guildId}:${[challengerId, opponentId].sort().join(":")}`;
}

// Test seams, matching earlyAccess.ts' `_clearEarlyAccessCache` convention.
// Underscore-prefixed so the intent is obvious at a call site: production code
// never calls these.
export const _clearActiveChallenges = (): void => activeChallenges.clear();
export const _activeChallengeCount = (): number => activeChallenges.size;

export interface IssueChallengeOptions {
	// The slash command interaction that started this. Kept as the anchor for
	// every edit to the public challenge message, so the Accept button click
	// stays untouched for the caller.
	interaction: ChatInputCommandInteraction;
	opponent: User;
	kind: ChallengeKind;
	// The calling game's own label from gamesCopy (for example "a duel"), so one
	// prompt embed serves every challenge-based game.
	gameLabel: string;
}

export async function issueChallenge(options: IssueChallengeOptions): Promise<ChallengeOutcome> {
	const { interaction, opponent, kind, gameLabel } = options;
	const challengerId = interaction.user.id;

	// ── ① reject impossible matchups BEFORE anything posts publicly ──
	// Every rejection replies ephemerally, so a bad challenge never leaves a
	// stray message in the channel for other members to read.
	const guildId = interaction.guildId;
	if (!guildId) {
		return reject(interaction, "outsideGuild", gamesCopy.challenge.outsideGuild);
	}
	if (opponent.id === challengerId) {
		return reject(interaction, "selfChallenge", gamesCopy.challenge.selfChallenge);
	}
	if (opponent.bot) {
		return reject(interaction, "botOpponent", gamesCopy.challenge.botOpponent);
	}

	// ── ② claim the pair slot, synchronously ──
	// The check and the write MUST stay adjacent with no await between them. Node
	// is single threaded, so an uninterrupted check-then-set cannot interleave;
	// awaiting in the middle would yield the event loop and let a second click in
	// the same tick pass the same check and open a duplicate challenge.
	const key = pairKey(guildId, challengerId, opponent.id);
	if (activeChallenges.has(key)) {
		return reject(interaction, "duplicate", gamesCopy.challenge.duplicate);
	}
	const challengeId = uuid();
	activeChallenges.set(key, { challengeId, guildId, challengerId, opponentId: opponent.id, kind, createdAt: Date.now() });

	// From here on every exit path runs the finally below, so the slot is always
	// released: accepted, declined, timed out, or a thrown Discord error.
	try {
		const acceptId = `${CHALLENGE_CUSTOM_ID_PREFIX}:${challengeId}:accept`;
		const declineId = `${CHALLENGE_CUSTOM_ID_PREFIX}:${challengeId}:decline`;
		const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder().setCustomId(acceptId).setLabel(gamesCopy.challenge.acceptLabel).setStyle(ButtonStyle.Success),
			new ButtonBuilder().setCustomId(declineId).setLabel(gamesCopy.challenge.declineLabel).setStyle(ButtonStyle.Secondary)
		);

		// Custom challenge art when it exists on disk, the bundled Dero avatar
		// until then. The attachment and the embed's reference MUST ride the same
		// message or the thumbnail slot renders empty.
		const art = resolveGameAsset("challenge");

		// Public, because the whole channel watching is half the fun, and because
		// the opponent has to be able to click it. The notifying mention rides the
		// message CONTENT (a mention inside an embed never pings) with
		// allowedMentions pinned to this one user, so the opponent is notified and
		// no other mention in this message can resolve.
		await interaction.reply({
			content: gamesCopy.challenge.mentionLine(opponent.id),
			embeds: [buildChallengeEmbed(challengerId, opponent.id, gameLabel, art.ref)],
			components: [row],
			files: [art.attachment],
			allowedMentions: { users: [opponent.id] },
		});

		// ── ③ wait for the opponent's answer ──
		// createMessageComponentCollector rather than awaitMessageComponent: 14.25
		// silently dropped input through the awaitMessageComponent pipeline in this
		// codebase before (see decreeEditHandlers' collector note), so the
		// streaming collector wrapped in a one shot Promise is the pattern that is
		// actually known to work here. The filter pins BOTH the clicker (only the
		// challenged member may answer) and the customId (a stray click on an older
		// challenge message cannot resolve this one).
		const message = await interaction.fetchReply();
		let answer: ButtonInteraction | null = null;
		await new Promise<void>((resolve) => {
			const collector = message.createMessageComponentCollector({
				componentType: ComponentType.Button,
				filter: (i) => i.user.id === opponent.id && (i.customId === acceptId || i.customId === declineId),
				time: CHALLENGE_TIMEOUT_MS,
				max: 1,
			});
			collector.on("collect", (i) => {
				answer = i as ButtonInteraction;
			});
			collector.on("end", () => resolve());
		});

		if (!answer) {
			// Timed out. Strip the buttons so a late clicker gets no dead control,
			// and say so in place rather than posting a second message.
			await closeChallenge(interaction, gamesCopy.challenge.timedOut);
			return { status: "timedOut" };
		}

		// Re-bind through a const annotated with the NON-nullable type. `answer` is
		// only ever written inside a Promise callback, which control flow analysis
		// cannot see, so TS believes it is still null here and narrows it to `never`
		// past the guard above. `never` is assignable to anything, so this const
		// recovers the real type for every reference below. Same trick, same reason,
		// as decreeEditHandlers' tzInteraction.
		const answered: ButtonInteraction = answer;

		if (answered.customId === declineId) {
			// Decline is fully terminal here, so this file owns the acknowledgement
			// and updates the public message through the button itself.
			// files: [] drops the challenge art. The closed embed sets no image, so
			// leaving the attachment behind would render a stray file card under a
			// message about nothing happening.
			await answered.update({
				content: "",
				embeds: [buildChallengeClosedEmbed(gamesCopy.challenge.declined(opponent.id))],
				components: [],
				files: [],
			});
			return { status: "declined" };
		}

		// Accepted. Tidy the public prompt through the ORIGINAL interaction so the
		// Accept click stays unacknowledged for the caller (rps replies to it with
		// the opponent's ephemeral secret pick prompt). Discord gives the caller
		// three seconds to respond to that click, so this edit must not be slow,
		// and it must not be awaited on a path that could throw the caller off, a
		// failed cosmetic edit is swallowed.
		await interaction
			.editReply({ content: "", components: [] })
			.catch((error: unknown) => console.warn("[mini-game] failed to clear challenge buttons after accept", error));

		return { status: "accepted", challengeId, accept: answered };
	} finally {
		// ── ④ release the pair slot on EVERY exit ──
		// Accepted, declined, timed out, or thrown. Without this a challenge that
		// errored mid-flight would block those two players from ever challenging
		// each other again for the life of the process.
		activeChallenges.delete(key);
	}
}

// ── private ────────────────────────────────────────────────────────────────

// Ephemeral rejection, so a rejected challenge never posts publicly. Returns the
// outcome so each guard above stays a single line.
async function reject(
	interaction: ChatInputCommandInteraction,
	reason: ChallengeRejectionReason,
	message: string
): Promise<ChallengeOutcome> {
	await interaction.reply({ embeds: [errorEmbed(message)], flags: MessageFlags.Ephemeral });
	return { status: "rejected", reason };
}

// Replace the public prompt with its terminal state and drop the components.
// Cosmetic, so a failure is logged and swallowed rather than thrown back at a
// caller whose game already resolved (fire and forget after a primary action,
// the house convention).
async function closeChallenge(interaction: ChatInputCommandInteraction, description: string): Promise<void> {
	await interaction
		.editReply({ content: "", embeds: [buildChallengeClosedEmbed(description)], components: [], files: [] })
		.catch((error: unknown) => console.warn("[mini-game] failed to close out the challenge message", error));
}
