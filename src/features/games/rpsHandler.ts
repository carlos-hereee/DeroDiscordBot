import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ComponentType,
	MessageFlags,
	type ButtonInteraction,
	type ChatInputCommandInteraction,
	type Message,
} from "discord.js";
import { errorEmbed } from "@utils/embedBuilder.js";
import { CooldownManager } from "@utils/cooldownManager.js";
import { gamesCopy } from "./gamesCopy.js";
import { resolveGameAsset, type GameAssetKey } from "./gamesAssets.js";
import { buildRpsRevealEmbed, buildRpsTimeoutEmbed } from "./gamesEmbeds.js";
import { issueChallenge } from "./challengeFlow.js";
import { scoreRps, type RpsChoice } from "./rpsWinner.js";
import { createRpsRound, applyPick, closeRound, type RpsRoundState, type RpsSide } from "./rpsRound.js";

// ── /mini-game rps ─────────────────────────────────────────────────────────
// What:  the Discord half of rock paper scissors. Challenge and accept belong to
//        challengeFlow, scoring belongs to rpsWinner, and the race belongs to
//        rpsRound. What is left here, and it is the genuinely new problem in
//        this plan, is delivering two SECRET choices without either player
//        seeing the other's before both are locked in.
// Who:   MINI_GAME_HANDLERS in src/commands/fun/mini-game.ts.
// When:  every /mini-game rps invocation. The handler stays awaited for the life
//        of the round (up to the pick window) so cleanup runs in one finally.
// Where: each player gets their OWN ephemeral message. This is not a style
//        choice: CHANGELOG.md records a discord.js 14.25 bug this codebase
//        already hit where a select and a button silently dropped input when
//        they shared ONE ephemeral message. Two players' controls never share a
//        message here, and each collector pins both the clicker and the customId.
// How:   ① gate on this game's own cooldown, ② hand the challenge to the engine,
//        ③ on accept, reply ephemerally to the opponent's own Accept click and
//        followUp a SEPARATE ephemeral to the challenger, ④ let whichever pick
//        completes the round post the single public reveal, ⑤ clean up on every
//        exit including the accepted but never thrown timeout.

// Its own instance, never a shared /mini-game window: a parent level cooldown
// would let a rps round block a fortune reading, a regression on a shipped
// feature. Matches duel's window since both post publicly and ping a second
// member.
const RPS_COOLDOWN_MS = 15_000;
const cooldown = new CooldownManager(RPS_COOLDOWN_MS);

// How long a player has to throw AFTER the challenge was accepted. Distinct from
// the challenge window: this clock starts once both players are already engaged,
// so it can be the same length without feeling long.
export const RPS_PICK_TIMEOUT_MS = 60_000;

// customId: minigame:rps:<challengeId>:<side>:<choice>. The challengeId keeps a
// stale prompt from an earlier round inert, and the side keeps the two players'
// buttons distinguishable in a log. Well inside Discord's 100 character cap.
const RPS_CUSTOM_ID_PREFIX = "minigame:rps";

// Which art the reveal carries: the WINNING throw, so the image says something
// the text does not already say twice. A tie gets its own image so the flattest
// outcome still reads as an outcome.
const ART_BY_CHOICE: Record<RpsChoice, GameAssetKey> = {
	rock: "rpsRock",
	paper: "rpsPaper",
	scissors: "rpsScissors",
};

const BUTTONS: { choice: RpsChoice; label: string; emoji: string }[] = [
	{ choice: "rock", label: gamesCopy.rps.rockLabel, emoji: "🪨" },
	{ choice: "paper", label: gamesCopy.rps.paperLabel, emoji: "📄" },
	{ choice: "scissors", label: gamesCopy.rps.scissorsLabel, emoji: "✂️" },
];

// ── in-memory round state ──
// Process-scoped and single-process, the same accepted v1 tradeoff the challenge
// engine makes: a round open when Railway redeploys is lost. Keyed by
// challengeId, and deleted in the handler's finally on EVERY exit path.
const rpsRounds = new Map<string, RpsRoundState>();

// Test seams, matching earlyAccess.ts' `_clearEarlyAccessCache` convention.
export const _clearRpsRounds = (): void => rpsRounds.clear();
export const _activeRpsRoundCount = (): number => rpsRounds.size;

interface RpsContext {
	interaction: ChatInputCommandInteraction;
	round: RpsRoundState;
	challengerId: string;
	opponentId: string;
	// Ends the round exactly once, from a pick, a timeout, or an error.
	finish: () => void;
}

export async function runRps(interaction: ChatInputCommandInteraction): Promise<void> {
	// Required and validated by Discord before this runs, so it cannot be missing.
	const opponent = interaction.options.getUser("opponent", true);

	// ── ① spam gate, before any public message ──
	// Checked before issueChallenge so a rate limited challenger never pings
	// their target, and recorded only once a round genuinely starts.
	const cooldownKey = `${interaction.guildId ?? "dm"}:${interaction.user.id}`;
	const gate = cooldown.check(cooldownKey);
	if (gate.onCooldown) {
		await interaction.reply({
			embeds: [errorEmbed(gamesCopy.rps.cooldownMessage(Math.ceil(gate.remainingMs / 1000)))],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	// ── ② challenge and accept, entirely the engine's problem ──
	// Self challenge, bot opponent, duplicate, decline and timeout have all been
	// reported to the right person already, so anything but accepted is a silent
	// bail rather than a second message.
	const outcome = await issueChallenge({
		interaction,
		opponent,
		kind: "rps",
		gameLabel: gamesCopy.rps.label,
	});
	if (outcome.status !== "accepted") return;

	const { challengeId, accept } = outcome;
	const round = createRpsRound(challengeId);
	rpsRounds.set(challengeId, round);

	// Assigned below once the settle promise exists. Declared here so the context
	// handed to every collector is a single stable object.
	const context: RpsContext = {
		interaction,
		round,
		challengerId: interaction.user.id,
		opponentId: opponent.id,
		finish: () => undefined,
	};

	try {
		// ── ③ two SEPARATE ephemeral prompts ──
		// The opponent's rides their own Accept click, which challengeFlow handed
		// back deliberately unacknowledged for exactly this. Discord allows three
		// seconds to respond to that click and this path does no I/O first, so the
		// window is comfortable.
		await accept.reply({
			content: gamesCopy.rps.pickPrompt,
			components: [buildPickRow(challengeId, "opponent")],
			flags: MessageFlags.Ephemeral,
		});
		const opponentPrompt = await accept.fetchReply();

		// The challenger is not clicking anything at this moment, so their prompt
		// is a followUp on the ORIGINAL slash interaction. Interaction tokens stay
		// valid for followUp for 15 minutes, far longer than any accept window, so
		// this needs no DM and does not depend on either player having DMs open
		// from server members.
		const challengerPrompt = await interaction.followUp({
			content: gamesCopy.rps.pickPrompt,
			components: [buildPickRow(challengeId, "challenger")],
			flags: MessageFlags.Ephemeral,
		});

		// The round is genuinely underway, so the challenger's window burns now. A
		// declined or timed out CHALLENGE never reaches here, which is the point of
		// recording after the primary action rather than before it.
		cooldown.record(cooldownKey);

		// ── ④ wait for both throws, or the window to close ──
		await new Promise<void>((settle) => {
			let settled = false;
			const collectors: { stop: () => void }[] = [];

			const timer = setTimeout(() => {
				void handleTimeout(context).finally(() => context.finish());
			}, RPS_PICK_TIMEOUT_MS);

			context.finish = (): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				for (const collector of collectors) collector.stop();
				// Best effort: drop the buttons from whichever prompt is still
				// showing live controls, so a late click gets a stripped message
				// rather than Discord's bare "interaction failed".
				void clearPrompts(accept, interaction, challengerPrompt.id);
				settle();
			};

			collectors.push(wirePickCollector(opponentPrompt, opponent.id, "opponent", challengeId, context));
			collectors.push(wirePickCollector(challengerPrompt, interaction.user.id, "challenger", challengeId, context));
		});
	} finally {
		// ── ⑤ cleanup on EVERY exit ──
		// Revealed, timed out, or thrown mid flight. Without this a round that
		// errored would leak its state for the life of the process.
		rpsRounds.delete(challengeId);
	}
}

// ── private ────────────────────────────────────────────────────────────────

function buildPickRow(challengeId: string, side: RpsSide): ActionRowBuilder<ButtonBuilder> {
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		BUTTONS.map(({ choice, label, emoji }) =>
			new ButtonBuilder()
				.setCustomId(`${RPS_CUSTOM_ID_PREFIX}:${challengeId}:${side}:${choice}`)
				.setLabel(label)
				.setEmoji(emoji)
				.setStyle(ButtonStyle.Secondary)
		)
	);
}

// No `max` on the collector on purpose. A second click from the same player must
// receive a real "no takebacks" answer, and a click after the reveal must be told
// the round is over; capping at one would leave both showing Discord's bare
// interaction failure instead.
function wirePickCollector(
	message: Message,
	userId: string,
	side: RpsSide,
	challengeId: string,
	context: RpsContext
): { stop: () => void } {
	const collector = message.createMessageComponentCollector({
		componentType: ComponentType.Button,
		// Pins the clicker AND the round AND the side, so a stale prompt from an
		// earlier round between the same two players cannot resolve this one.
		filter: (i) => i.user.id === userId && i.customId.startsWith(`${RPS_CUSTOM_ID_PREFIX}:${challengeId}:${side}:`),
		time: RPS_PICK_TIMEOUT_MS,
	});
	collector.on("collect", (i) => {
		void onPick(i as ButtonInteraction, side, context);
	});
	return collector;
}

async function onPick(click: ButtonInteraction, side: RpsSide, context: RpsContext): Promise<void> {
	const choice = parseChoice(click.customId);
	if (!choice) {
		// Only reachable if buildPickRow and this parser drift apart, so say so in
		// the log rather than swallowing it.
		console.error(`[mini-game] rps could not parse a choice from customId '${click.customId}'`);
		await click.reply({ content: gamesCopy.rps.roundClosed, flags: MessageFlags.Ephemeral }).catch(swallow("rps parse reply"));
		return;
	}

	// ⚠️ The claim is synchronous and must stay that way. applyPick decides, in
	// this one uninterrupted tick, whether this click merely recorded a throw or
	// completed the round, and it can answer "reveal" to at most one caller ever.
	// Nothing may be awaited between the click arriving and this line.
	const result = applyPick(context.round, side, choice);

	if (result.status === "duplicate") {
		const existing = context.round.picks[side] ?? choice;
		await click
			.reply({ content: gamesCopy.rps.alreadyPicked(existing), flags: MessageFlags.Ephemeral })
			.catch(swallow("rps duplicate reply"));
		return;
	}

	if (result.status === "closed") {
		await click.reply({ content: gamesCopy.rps.roundClosed, flags: MessageFlags.Ephemeral }).catch(swallow("rps closed reply"));
		return;
	}

	if (!result.reveal) {
		// First to throw. Update their OWN ephemeral and drop its buttons, so they
		// get real feedback instead of a message that looks like it did nothing,
		// and cannot click again by habit.
		const waitingOn = side === "challenger" ? context.opponentId : context.challengerId;
		await click
			.update({ content: gamesCopy.rps.pickReceived(choice, waitingOn), components: [] })
			.catch(swallow("rps first pick update"));
		return;
	}

	// This click completed the round, and applyPick guarantees it is the only one
	// that will. Acknowledge the clicker first (their three second window is the
	// tighter constraint), then post the one public reveal.
	await click.update({ content: gamesCopy.rps.pickReceivedFinal(choice), components: [] }).catch(swallow("rps final pick update"));
	await postReveal(context);
	context.finish();
}

async function postReveal(context: RpsContext): Promise<void> {
	const challengerChoice = context.round.picks.challenger;
	const opponentChoice = context.round.picks.opponent;
	// Unreachable: applyPick only answers "reveal" once both are recorded. Guarded
	// anyway so a future refactor cannot turn this into a crash inside a live round.
	if (!challengerChoice || !opponentChoice) return;

	const outcome = scoreRps(challengerChoice, opponentChoice);
	const winningChoice = outcome === "challenger" ? challengerChoice : opponentChoice;
	const art = resolveGameAsset(outcome === "tie" ? "rpsTie" : ART_BY_CHOICE[winningChoice]);

	await context.interaction
		.followUp({
			embeds: [
				buildRpsRevealEmbed(
					context.challengerId,
					challengerChoice,
					context.opponentId,
					opponentChoice,
					outcome,
					art.ref
				),
			],
			files: [art.attachment],
			// Both players were already pinged by the challenge; pinging again on
			// the payoff would be noise. Mentions inside an embed do not notify, and
			// this pins that shut for the message as a whole.
			allowedMentions: { parse: [] },
		})
		.catch(swallow("rps reveal"));
}

async function handleTimeout(context: RpsContext): Promise<void> {
	// A pick landing in the same tick as the timer wins: closeRound answers true
	// to exactly one caller, so the channel can never get a reveal AND a "round
	// expired" contradicting each other.
	if (!closeRound(context.round)) return;

	const challengerReady = Boolean(context.round.picks.challenger);
	const opponentReady = Boolean(context.round.picks.opponent);

	// Deliberately never names the throw of whoever did commit. The round is void,
	// so publishing one player's choice would hand their opponent free information
	// for the rematch.
	const description =
		!challengerReady && !opponentReady
			? gamesCopy.rps.timeoutNeither
			: challengerReady
				? gamesCopy.rps.timeoutOneSided(context.challengerId, context.opponentId)
				: gamesCopy.rps.timeoutOneSided(context.opponentId, context.challengerId);

	await context.interaction
		.followUp({ embeds: [buildRpsTimeoutEmbed(description)], allowedMentions: { parse: [] } })
		.catch(swallow("rps timeout notice"));
}

// Strip the live buttons from both secret prompts once the round is over.
// Cosmetic and entirely best effort: the opponent's prompt is reachable through
// their own Accept interaction, the challenger's only through the interaction
// webhook, since a followUp is not the original reply.
async function clearPrompts(
	accept: ButtonInteraction,
	interaction: ChatInputCommandInteraction,
	challengerPromptId: string
): Promise<void> {
	await accept.editReply({ components: [] }).catch(swallow("rps clear opponent prompt"));
	await interaction.webhook.editMessage(challengerPromptId, { components: [] }).catch(swallow("rps clear challenger prompt"));
}

function parseChoice(customId: string): RpsChoice | null {
	const tail = customId.split(":").pop();
	return tail === "rock" || tail === "paper" || tail === "scissors" ? tail : null;
}

// Every Discord send after the round's primary action is fire and forget: logged
// and swallowed, never thrown back into a handler whose game already resolved.
// The house convention, and it matters more here than usual because these run
// inside collector callbacks with no caller left to catch them.
function swallow(label: string): (error: unknown) => void {
	return (error: unknown) => console.warn(`[mini-game] ${label} failed`, error);
}
