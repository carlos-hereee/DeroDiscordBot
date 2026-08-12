import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { errorEmbed } from "@utils/embedBuilder.js";
import { CooldownManager } from "@utils/cooldownManager.js";
import { gamesCopy } from "./gamesCopy.js";
import { resolveGameAsset, type GameAssetKey } from "./gamesAssets.js";
import { buildVersusResultEmbed } from "./gamesEmbeds.js";
import { issueChallenge } from "./challengeFlow.js";
import { resolveVersus, type VersusFlip, type VersusResult } from "./versusResolve.js";
import { awardTwoPlayerResult } from "./gameXp.js";

// ── /mini-game coin-flip and /mini-game dice-roll ──────────────────────────
// What:  the thin Discord facing half of both head to head wagers. Every guard,
//        prompt, button and timeout belongs to challengeFlow; every odds
//        decision belongs to versusResolve. This file reads the opponent, gates
//        spam, and renders.
// Who:   MINI_GAME_HANDLERS in src/commands/fun/mini-game.ts, and (indirectly)
//        the arcade rules card once the challenge board can host them.
// When:  every /mini-game coin-flip or /mini-game dice-roll invocation.
// Where: the first games to consume the Phase 1 challenge engine, so also the
//        proof its contract is usable without modification.
// How:   ① gate on the shared cooldown before anything posts, ② hand the
//        challenge to the engine and bail on any outcome but "accepted",
//        ③ resolve purely and reply to the ACCEPT click with the result.
//
// ⚠️ ONE GAME UNTIL 2026-08-12. This was `/mini-game duel`, which asked "dice or
// coin?" as a REQUIRED option, so its name could never describe it and a member
// had to make a rules decision before playing once. Splitting it removed the
// question entirely and gave each half its own /account record. The two share
// this core deliberately: the handshake, the resolver and the result embed are
// identical, and only the words, the art and the color differ.

// One wager per challenger every 15 seconds, SHARED across both games on
// purpose: they cost a target member the same interruption either way, so
// alternating between them must not double the spam a member can aim at
// somebody. Per game instances would allow exactly that.
//
// A shared /mini-game cooldown would be wrong for the opposite reason: starting
// a wager would block a fortune reading, which is a behavior regression on a
// shipped feature. Longer than fortune's 10s because this posts publicly and
// pings a second member, so the cost of spamming lands on someone else.
const VERSUS_COOLDOWN_MS = 15_000;
const cooldown = new CooldownManager(VERSUS_COOLDOWN_MS);

export const runCoinFlip = (interaction: ChatInputCommandInteraction): Promise<void> => runVersus(interaction, "coin");
export const runDiceRoll = (interaction: ChatInputCommandInteraction): Promise<void> => runVersus(interaction, "dice");

async function runVersus(interaction: ChatInputCommandInteraction, flip: VersusFlip): Promise<void> {
	// Required and validated by Discord before this runs: the builder declares
	// opponent as a required user option, so it cannot arrive missing. `flip` is
	// no longer an option at all, it is fixed by which subcommand was invoked.
	const opponent = interaction.options.getUser("opponent", true);
	const copy = flip === "coin" ? gamesCopy.coinFlip : gamesCopy.diceRoll;

	// ── ① spam gate, before any public message ──
	// Checked here rather than inside the engine because the window belongs to
	// this game, and checked BEFORE issueChallenge so a rate limited challenger
	// never pings their target. Recorded only after a full successful round, so a
	// declined or timed out challenge does not burn the challenger's window.
	const cooldownKey = `${interaction.guildId ?? "dm"}:${interaction.user.id}`;
	const gate = cooldown.check(cooldownKey);
	if (gate.onCooldown) {
		await interaction.reply({
			embeds: [errorEmbed(gamesCopy.versus.cooldownMessage(Math.ceil(gate.remainingMs / 1000)))],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	// ── ② challenge and accept, entirely the engine's problem ──
	// A self challenge, a bot opponent, a duplicate, a decline, and a timeout have
	// all already been reported to the right person by the time this returns, so
	// anything but "accepted" is a silent bail here, not a second message.
	const outcome = await issueChallenge({
		interaction,
		opponent,
		kind: flip === "coin" ? "coinflip" : "diceroll",
		gameLabel: copy.label,
	});
	if (outcome.status !== "accepted") return;

	// ── ③ resolve and render ──
	// Pure, synchronous, no rng passed so production takes Math.random. The
	// accept click comes back deliberately unacknowledged (rps needs that), and
	// duel has no secret step, so duel is the one that acknowledges it, by
	// replying publicly with the result. Discord allows three seconds to respond
	// to that click and this path does no I/O before it, so the window is safe.
	const result = resolveVersus(flip);
	const art = resolveGameAsset(assetKeyFor(result));

	await outcome.accept.reply({
		embeds: [buildVersusResultEmbed(interaction.user.id, opponent.id, result, art.ref)],
		files: [art.attachment],
		// The result names both players. They were already pinged by the challenge,
		// so pinging again on the payoff would be noise; mentions inside an embed
		// do not notify, and this pins that shut for the message as a whole.
		allowedMentions: { parse: [] },
	});

	cooldown.record(cooldownKey);

	// ── leveling ──
	// Fire and forget, and deliberately AFTER the reply: both players have already
	// seen the outcome, so nothing about the award can change what the duel looked
	// like, and awardXp never throws by contract. A coin duel cannot tie, which the
	// VersusResult union already guarantees, so "tie" only ever reaches here from the
	// dice branch.
	awardTwoPlayerResult({
		client: interaction.client,
		guildId: interaction.guildId,
		channelId: interaction.channelId,
		game: flip === "coin" ? "coinflip" : "diceroll",
		challenger: interaction.user,
		opponent,
		winner: result.winner,
	});
}

// ── private ────────────────────────────────────────────────────────────────

// Which art the payoff embed carries. A tie gets its own image so the flattest
// outcome still reads as an outcome rather than a missing winner. Coin duels
// cannot tie, which the VersusResult union already guarantees, so the tie branch
// is only reachable from dice.
function assetKeyFor(result: VersusResult): GameAssetKey {
	if (result.flip === "coin") return "coinFlip";
	return result.winner === "tie" ? "diceTie" : "diceRoll";
}
