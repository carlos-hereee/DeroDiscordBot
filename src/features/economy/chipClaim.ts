import {
	StringSelectMenuBuilder,
	type ButtonInteraction,
	type ChatInputCommandInteraction,
	type ColorResolvable,
	type ModalSubmitInteraction,
	type StringSelectMenuInteraction,
} from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { COLORS } from "@base/copy/brand.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { registerModal, registerSelectMenu } from "@handlers/interactionRegistry.js";
import { gameRoomsCopy } from "@features/game-rooms/gameRoomsCopy.js";
import { pickedValues, showPicker } from "@features/game-rooms/pickerModal.js";
import { buildRpsRevealEmbed } from "@features/games/gamesEmbeds.js";
import { resolveGameAsset, type GameAssetKey } from "@features/games/gamesAssets.js";
import { gamesCopy } from "@features/games/gamesCopy.js";
import { renderRpsCard } from "@features/games/rpsRenderer.js";
import { RPS_CHOICES, type RpsChoice, type RpsOutcome } from "@features/games/rpsWinner.js";
import { resolveSoloLuck, type SoloLuckOutcome } from "@features/games/soloLuck.js";
import { isRenderPayload, withRenderFallback, type RenderPayload } from "@features/renderer/index.js";
import { infoEmbed } from "@utils/embedBuilder.js";
import { answerChannelId, answerInChannel } from "@utils/answerInChannel.js";
import { acknowledgeTextModal, showErrorNotice, showNotice } from "@utils/textModal.js";
import { nextUtcDayStart } from "@utils/utcMonthKey.js";
import { claimChips, isChipEconomyOn, readWallet } from "./chipWallet.js";
import { awardForClaim, hasClaimedCoinsToday } from "./deroCoins.js";
import { economyCopy } from "./economyCopy.js";

// ── chipClaim ────────────────────────────────────────────────────────
// What:  the daily claim as a round of rock paper scissors against Dero (2026-10 item
//        257, Phase 3a, owner decision 11). The press opens a modal with one throw
//        select; on Submit Dero throws, and a win pays the daily claim twice, a draw one
//        and a half times and a loss once, on BOTH currencies: chips (per server, only
//        where chips are on) and Dero coins (global). The drawn reveal card with the
//        payout posts in 💬dero-commands.
// Who:   the Claim daily rewards button (PowerUps, `powerup:member:claim`) and /claim
//        (commands/fun/claim.ts) call runChipClaim; main.ts registers the round's modal
//        and its fallback select once at boot (registerClaimRoundHandlers).
// Does NOT: own an amount or a cooldown. claimChips (chipWallet.ts) owns the chips and
//        their 24 hour cooldown, awardForClaim (deroCoins.ts) the coins and their one
//        claim per UTC day per server; this module plays the round and words it.
//
// ⚠️ THE ROUND NEVER TOUCHES THE LUCK BOARD: no recordLuckResult and no XP here. A daily
// claim is not a match, and every member playing it once a day would swamp the board.
//
// With chips off everyone, admins included, plays the round for coins only, and the
// card's chips off line names the command that switches chips on (owner decision of
// 2026-10-27, replacing Phase 1b's routing of an admin's press to the arcade panel: a
// modal opens only one thing, so that routing left an admin who keeps chips off with no
// way to claim at all).

const copy = economyCopy.claim;
const roundCopy = economyCopy.round;

type GuildConfigRow = Awaited<ReturnType<typeof guildConfigStore.findByGuildId>>;

// The round's interactionRegistry prefix: its modal and its fallback select share it.
const CLAIM_ROUND_PREFIX = "dailyclaim";
const CLAIM_ROUND_ID = `${CLAIM_ROUND_PREFIX}:throw`;

// The member is the challenger and Dero the opponent, on the embed and on the card alike.
const EMBED_OUTCOME: Record<SoloLuckOutcome, RpsOutcome> = { won: "challenger", lost: "opponent", tie: "tie" };
const CARD_WINNER: Record<SoloLuckOutcome, "left" | "right" | "tie"> = { won: "left", lost: "right", tie: "tie" };

/** The press: the throw modal, after the chips switch and the cooldown are read. Never throws. */
export async function runChipClaim(interaction: ButtonInteraction | ChatInputCommandInteraction): Promise<void> {
	const guildId = interaction.guildId;
	if (!guildId) {
		await showErrorNotice(interaction, copy.notInGuild);
		return;
	}

	let config: GuildConfigRow = null;
	try {
		config = await guildConfigStore.findByGuildId(guildId);
		const chipsOn = isChipEconomyOn(config);
		// Read before the modal so a member never throws for nothing; the Submit reads it
		// again, because the claim itself is what decides.
		const wait = await claimWaitText(guildId, interaction.user.id, chipsOn, new Date());
		if (wait) {
			await showNotice(interaction, { title: copy.title, sections: [wait] });
			return;
		}
	} catch (error) {
		console.error(`[economy] opening the daily claim for ${interaction.user.id} in guild ${guildId} failed`, error);
		await showErrorNotice(interaction, copy.failed, config);
		return;
	}

	await showPicker(interaction, {
		route: { modalId: CLAIM_ROUND_ID, selectId: CLAIM_ROUND_ID },
		title: roundCopy.modalTitle,
		prompt: roundCopy.prompt,
		label: roundCopy.selectLabel,
		// toJSON validates the select, customId included, before showPicker swaps in the
		// modal field's id, so it carries the round's id from the start.
		select: new StringSelectMenuBuilder()
			.setCustomId(CLAIM_ROUND_ID)
			.setPlaceholder(gameRoomsCopy.games.rpsPlaceholder)
			.setMinValues(1)
			.setMaxValues(1)
			.addOptions(RPS_CHOICES.map((choice) => ({ label: gameRoomsCopy.games.rpsLabel(choice), value: choice }))),
	});
}

// When the claim is not open yet, the words saying when it opens; null when it is open.
// With chips on, the chip wallet's 24 hour cooldown decides (it always spans a UTC day,
// so the coins are open whenever the chips are); with chips off, the coins' UTC day does.
async function claimWaitText(guildId: string, userId: string, chipsOn: boolean, now: Date): Promise<string | null> {
	if (chipsOn) {
		const wallet = await readWallet({ guildId, userId });
		if (wallet.nextClaimAt && wallet.nextClaimAt.getTime() > now.getTime()) return copy.cooldown(wallet.balance, wallet.nextClaimAt);
		return null;
	}
	return (await hasClaimedCoinsToday(guildId, userId, now)) ? roundCopy.coinsCooldown(nextUtcDayStart(now)) : null;
}

// ── the Submit ──

/**
 * The round's Submit, from its modal or its fallback select: re-read the cooldown, let
 * Dero throw, pay both currencies, then post the reveal in 💬dero-commands. Every answer,
 * a cooldown or a failure too, posts there (2026-10 item 257 Phase 5). Never throws.
 */
export async function playClaimRound(interaction: ModalSubmitInteraction | StringSelectMenuInteraction, rng: () => number = Math.random): Promise<void> {
	const guildId = interaction.guildId;
	if (!guildId) {
		await showErrorNotice(interaction, copy.notInGuild);
		return;
	}
	const memberThrow = parseThrow(pickedValues(interaction)[0]);
	if (!memberThrow) {
		await showErrorNotice(interaction, copy.failed);
		return;
	}

	await acknowledgeSubmit(interaction);
	const userId = interaction.user.id;
	let config: GuildConfigRow = null;
	try {
		config = await guildConfigStore.findByGuildId(guildId);
		const chipsOn = isChipEconomyOn(config);
		const now = new Date();
		const wait = await claimWaitText(guildId, userId, chipsOn, now);
		if (wait) {
			await answerInChannel(interaction, "member", { content: wait }, { config });
			return;
		}

		// The solo rps resolver, so Dero's throw has one set of odds wherever he plays. An rps
		// play always resolves as rps; the check only narrows the union for the compiler.
		const round = resolveSoloLuck({ game: "rps", memberThrow }, rng);
		if (round.game !== "rps") return;
		const multiplier = BOT_CONSTANTS.ECONOMY.CLAIM_ROUND_MULTIPLIERS[round.outcome];

		// ① Chips first, only where chips are on (risk R11): its conditional write is the
		// claim, so a second Submit racing this one lands on the cooldown and pays nothing.
		let chipsPaid: number | null = null;
		if (chipsOn) {
			const claimed = await claimChips({ guildId, userId }, now, multiplier);
			if (claimed.kind === "cooldown") {
				await answerInChannel(interaction, "member", { content: copy.cooldown(claimed.balance, claimed.nextClaimAt) }, { config });
				return;
			}
			chipsPaid = claimed.amount;
		}
		// ② Then the coins, whose own unique claim key pays them once a day in this server.
		const coinsPaid = await awardForClaim({ guildId, userId, multiplier, now });

		const payout = [roundCopy.payout({ userId, chipsPaid, coinsPaid, multiplier }), chipsOn ? null : roundCopy.chipsOff].filter(Boolean).join("\n\n");
		await postRound(interaction, { config, memberThrow, deroThrow: round.deroThrow, outcome: round.outcome, payout });
	} catch (error) {
		console.error(`[economy] the daily claim round for ${userId} in guild ${guildId} failed`, error);
		await answerInChannel(interaction, "member", { content: copy.failed }, { config });
	}
}

const parseThrow = (value: string | undefined): RpsChoice | null => (RPS_CHOICES as readonly string[]).includes(value ?? "") ? (value as RpsChoice) : null;

// The Submit is acknowledged at once, before the reads and the draw, so the round never
// misses Discord's three second window, and it leaves no message of its own: the modal
// closes as a text modal does (an update for one opened from the 🕹️games button, a defer
// deleted at once for one opened by /claim), and the fallback select is deferred as an
// update. Swallowed and logged: a failed acknowledgement must not stop the round.
async function acknowledgeSubmit(interaction: ModalSubmitInteraction | StringSelectMenuInteraction): Promise<void> {
	if (interaction.isModalSubmit()) {
		await acknowledgeTextModal(interaction);
		return;
	}
	await interaction.deferUpdate().catch((error: unknown) => console.warn("[economy] acknowledging the daily claim's select failed", { interactionId: interaction.id, error }));
}

interface PlayedRound {
	config: GuildConfigRow;
	memberThrow: RpsChoice;
	deroThrow: RpsChoice;
	outcome: SoloLuckOutcome;
	payout: string;
}

// The drawn reveal (item 254 Phase 5a's card) with the payout under it, posted in
// 💬dero-commands mentioning the member without a ping. A server with no commands
// channel yet (setup not rerun) gets the same card privately, with the reason.
async function postRound(interaction: ModalSubmitInteraction | StringSelectMenuInteraction, round: PlayedRound): Promise<void> {
	const userId = interaction.user.id;
	const art = await revealArt(interaction, round);
	const embed = buildRpsRevealEmbed(userId, round.memberThrow, interaction.client.user.id, round.deroThrow, EMBED_OUTCOME[round.outcome], art.ref);
	embed.setDescription(`${embed.data.description ?? ""}\n\n${round.payout}`);
	const hasCommandsChannel = answerChannelId(round.config, "member") !== null;
	const embeds = hasCommandsChannel ? [embed] : [embed, infoEmbed(copy.title, roundCopy.noCommandsChannel, COLORS.ARCADE as ColorResolvable)];
	await answerInChannel(interaction, "member", { embeds, files: [art.attachment] }, { config: round.config });
}

// The drawn card when it draws, the winning throw's static art (or the tie's) when not.
async function revealArt(interaction: ModalSubmitInteraction | StringSelectMenuInteraction, round: PlayedRound): Promise<RenderPayload> {
	const memberName = interaction.inCachedGuild() ? interaction.member.displayName : (interaction.user.globalName ?? interaction.user.username);
	const card = await withRenderFallback(
		() =>
			renderRpsCard({
				left: { name: memberName, choice: round.memberThrow, isDero: false },
				right: { name: gamesCopy.soloLuck.deroName, choice: round.deroThrow, isDero: true },
				winner: CARD_WINNER[round.outcome],
			}),
		() => null
	);
	if (isRenderPayload(card)) return card;
	const winningThrow = round.outcome === "lost" ? round.deroThrow : round.memberThrow;
	const key = round.outcome === "tie" ? "rpsTie" : (`rps${winningThrow.charAt(0).toUpperCase()}${winningThrow.slice(1)}` as GameAssetKey);
	return resolveGameAsset(key);
}

/** Register the round's modal Submit and its fallback select. Called once at boot from main.ts. */
export function registerClaimRoundHandlers(): void {
	registerModal(CLAIM_ROUND_PREFIX, (interaction) => playClaimRound(interaction));
	registerSelectMenu(CLAIM_ROUND_PREFIX, (interaction) => playClaimRound(interaction));
}
