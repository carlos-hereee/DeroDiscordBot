import { ButtonBuilder, ButtonStyle, type ButtonInteraction } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { awardReleaseGift } from "@features/economy/deroCoins.js";
import { economyCopy } from "@features/economy/economyCopy.js";
import { registerButton } from "@handlers/interactionRegistry.js";
import { showNotice } from "@utils/textModal.js";

// ── releaseCoinGift ──────────────────────────────────────────────────
// What:  the Claim button on a release announcement: the owner's way of saying sorry for a
//        hotfix with Dero coins, once per member across every server.
// Who:   postFeatureAnnouncement puts the button on the public post while
//        DERO_COINS.CURRENT_RELEASE_GIFT names a gift; main.ts registers the press at boot.
// Does NOT: know an amount or guard a payment. deroCoins.awardReleaseGift owns both.
//
// The gift key rides the customId, so a button on an older post keeps paying its own gift
// after a later release names a new one.

const RELEASE_GIFT_PREFIX = "relgift";
const words = economyCopy.releaseGift;

/** The Claim button for one gift, or null when no gift is on offer. */
export function buildReleaseGiftButton(giftKey: string | null): ButtonBuilder | null {
	if (!giftKey) return null;
	return new ButtonBuilder().setCustomId(`${RELEASE_GIFT_PREFIX}:${giftKey}`).setLabel(words.buttonLabel).setEmoji("🪙").setStyle(ButtonStyle.Success);
}

/** One press of Claim: pays the member or says why not, privately. */
export async function handleReleaseGiftClaim(interaction: ButtonInteraction): Promise<void> {
	const giftKey = interaction.customId.split(":")[1] ?? "";
	const outcome = await awardReleaseGift({ guildId: interaction.guildId ?? BOT_CONSTANTS.ECONOMY.GLOBAL_CHIP_WALLET_ID, userId: interaction.user.id, giftKey, now: new Date() });
	await showNotice(interaction, { title: words.title, sections: [answerFor(outcome)] });
}

function answerFor(outcome: Awaited<ReturnType<typeof awardReleaseGift>>): string {
	if (outcome.status === "paid") return words.paid(outcome.amount);
	if (outcome.status === "already") return words.already;
	return outcome.status === "unknown" ? words.closed : words.failed;
}

/** Register the Claim press. Called once at boot from main.ts. */
export function registerReleaseGiftHandlers(): void {
	registerButton(RELEASE_GIFT_PREFIX, handleReleaseGiftClaim);
}
