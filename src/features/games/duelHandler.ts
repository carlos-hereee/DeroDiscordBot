import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { errorEmbed } from "@utils/embedBuilder.js";
import { CooldownManager } from "@utils/cooldownManager.js";
import { gamesCopy } from "./gamesCopy.js";
import { resolveGameAsset, type GameAssetKey } from "./gamesAssets.js";
import { buildDuelResultEmbed } from "./gamesEmbeds.js";
import { issueChallenge } from "./challengeFlow.js";
import { resolveDuel, type DuelFlip, type DuelResult } from "./duelResolve.js";

// ── /mini-game duel ────────────────────────────────────────────────────────
// What:  the thin Discord facing half of the duel. Every guard, prompt, button,
//        and timeout belongs to challengeFlow; every odds decision belongs to
//        duelResolve. This file only reads options, gates spam, and renders.
// Who:   MINI_GAME_HANDLERS in src/commands/fun/mini-game.ts.
// When:  every /mini-game duel invocation.
// Where: the first game to consume the Phase 1 engine, so it is also the proof
//        the engine's contract is usable without modification.
// How:   ① gate on this game's OWN cooldown before anything posts, ② hand the
//        challenge to the engine and bail on any outcome but "accepted",
//        ③ resolve purely and reply to the ACCEPT click with the result.

// One duel per challenger every 15 seconds. This is a per game instance on
// purpose: a shared /mini-game cooldown would mean starting a duel blocks a
// fortune reading, which would be a behavior regression on a shipped feature.
// Longer than fortune's 10s because a duel posts a public message and pings a
// second member, so the cost of spamming it lands on someone else.
const DUEL_COOLDOWN_MS = 15_000;
const cooldown = new CooldownManager(DUEL_COOLDOWN_MS);

export async function runDuel(interaction: ChatInputCommandInteraction): Promise<void> {
	// Both required and both validated by Discord before this runs: the builder
	// declares opponent as a required user option and flip as a required string
	// with exactly two choices, so neither can arrive missing or malformed and
	// the cast below cannot be wrong.
	const opponent = interaction.options.getUser("opponent", true);
	const flip = interaction.options.getString("flip", true) as DuelFlip;

	// ── ① spam gate, before any public message ──
	// Checked here rather than inside the engine because the window belongs to
	// this game, and checked BEFORE issueChallenge so a rate limited challenger
	// never pings their target. Recorded only after a full successful round, so a
	// declined or timed out challenge does not burn the challenger's window.
	const cooldownKey = `${interaction.guildId ?? "dm"}:${interaction.user.id}`;
	const gate = cooldown.check(cooldownKey);
	if (gate.onCooldown) {
		await interaction.reply({
			embeds: [errorEmbed(gamesCopy.duel.cooldownMessage(Math.ceil(gate.remainingMs / 1000)))],
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
		kind: "duel",
		gameLabel: gamesCopy.duel.label,
	});
	if (outcome.status !== "accepted") return;

	// ── ③ resolve and render ──
	// Pure, synchronous, no rng passed so production takes Math.random. The
	// accept click comes back deliberately unacknowledged (rps needs that), and
	// duel has no secret step, so duel is the one that acknowledges it, by
	// replying publicly with the result. Discord allows three seconds to respond
	// to that click and this path does no I/O before it, so the window is safe.
	const result = resolveDuel(flip);
	const art = resolveGameAsset(assetKeyFor(result));

	await outcome.accept.reply({
		embeds: [buildDuelResultEmbed(interaction.user.id, opponent.id, result, art.ref)],
		files: [art.attachment],
		// The result names both players. They were already pinged by the challenge,
		// so pinging again on the payoff would be noise; mentions inside an embed
		// do not notify, and this pins that shut for the message as a whole.
		allowedMentions: { parse: [] },
	});

	cooldown.record(cooldownKey);
}

// ── private ────────────────────────────────────────────────────────────────

// Which art the payoff embed carries. A tie gets its own image so the flattest
// outcome still reads as an outcome rather than a missing winner. Coin duels
// cannot tie, which the DuelResult union already guarantees, so the tie branch
// is only reachable from dice.
function assetKeyFor(result: DuelResult): GameAssetKey {
	if (result.flip === "coin") return "duelCoin";
	return result.winner === "tie" ? "duelTie" : "duelDice";
}
