import { existsSync } from "node:fs";
import { join } from "node:path";
import { AttachmentBuilder, type RepliableInteraction } from "discord.js";
import { beginAnswerInPlace, beginChannelAnswer, type ChannelAnswer } from "@utils/answerInChannel.js";
import { showErrorNotice } from "@utils/textModal.js";
import { buildDeroImageAttachment } from "@base/copy/brand.js";
import { rollFortune, fortuneLuck, EXPECTED_FORTUNE_LUCK, PITY_THRESHOLD } from "./rollFortune.js";
import { recordFortuneReading } from "@features/ratings/luckStats.js";
import { buildFortuneEmbed, FORTUNE_ORB_FILE, FORTUNE_ORB_REF } from "./fortuneEmbed.js";
import { verdictSlug } from "./fortunes.js";
import { fortuneCopy } from "./fortuneCopy.js";
import { fortuneBuffStore } from "@db/stores/fortuneBuffStore.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { awardXp } from "@features/leveling/awardXp.js";
import { attachListenRow } from "@features/voice/listenButton.js";
import { avatarRequestFor, isRenderPayload, withRenderFallback } from "@features/renderer/index.js";
import { FORTUNE_SCENE_AVATAR_SIZE, renderFortuneScene } from "./fortuneSceneRenderer.js";
import { claimFortuneSlot, releaseFortuneSlot } from "./fortuneCooldown.js";

// ── respondWithFortune ──────────────────────────────────────────────────────
// The single fortune-reading path. Both the slash command and the button funnel
// through here so the cooldown, tier roll, embed, and mention
// safety are each defined exactly once (the interaction is a RepliableInteraction,
// which both a ChatInputCommandInteraction and a ButtonInteraction satisfy). The
// cooldown is one reading per member per server every FORTUNE_COOLDOWN_HOURS,
// persisted and shared by both entries (fortuneCooldown.ts, 2026-10 item 254), so
// a member cannot bypass it by alternating between them or by waiting for a deploy.
//   • question: echoed (with mention parsing disabled) when provided; the button
//     passes none, since a button cannot take text input without a modal.
//   • isPrivate: the reading posts in 💬dero-commands instead of where it was asked
//     (2026-10 item 257 Phase 5; privately only where that channel does not exist).
//     The button always takes it so it never clutters the 🕹️games intro it sits on;
//     the command honours its own private toggle.
export async function respondWithFortune(
	interaction: RepliableInteraction,
	options: { question?: string | null; isPrivate?: boolean } = {}
): Promise<void> {
	// ① The slot is claimed BEFORE the roll, atomically, so two presses at once cannot
	// both read. It runs ahead of the defer on purpose: a refusal is then the first
	// answer, a notice only the member sees, rather than a public "thinking" that
	// turns into a refusal. One indexed upsert fits Discord's three second window.
	const claim = await claimFortuneSlot(interaction.guildId, interaction.user.id);
	if (!claim.ok) {
		await showErrorNotice(interaction, fortuneCopy.cooldownMessage(claim.readyAt));
		return;
	}
	try {
		await readFortune(interaction, options);
	} catch (error) {
		// ② The reading never reached the member, so the slot goes back and they can
		// try again at once. Rethrown so the interaction listener still logs it.
		await releaseFortuneSlot(claim.slot);
		throw error;
	}
}

// The reading itself, once the member's slot is claimed: defer, roll, draw and
// reply, then the side effects (pity, luck board, xp) that follow a reading that
// reached the member.
async function readFortune(interaction: RepliableInteraction, options: { question?: string | null; isPrivate?: boolean }): Promise<void> {
	// Acknowledge within Discord's 3-second window BEFORE the DB read and the orb
	// upload, either of which can exceed it (a cold Mongo query, a multi-MB gif).
	// A public reading defers in place; a private one opens with the notice naming
	// 💬dero-commands. Without this the interaction token expires mid-reply and
	// Discord returns error 10062 (Unknown interaction).
	const answer = options.isPrivate ? await beginChannelAnswer(interaction, "member") : await beginAnswerInPlace(interaction);

	// Trim only, the command caps length via setMaxLength(200), and the question
	// is rendered ONLY inside an embed with mention parsing disabled below, so it
	// can never ping even if it contains @everyone.
	const question = options.question ? options.question.trim() : null;

	// Per-user luck state, read after the cooldown gate so a refused press never reads it.
	// weight is the buff a redeemed code granted (undefined = the 0.03 base); dryStreak
	// is the pity counter. Pity: once the streak reaches PITY_THRESHOLD, force a gold
	// this reading (weight 1) so nobody stays cold forever. Read live each time, so a
	// code redeemed seconds ago already counts.
	const { weight, dryStreak } = await fortuneBuffStore.stateFor(interaction.user.id);
	const pity = dryStreak >= PITY_THRESHOLD;
	const { tier, verdict, flavor } = rollFortune(Math.random, pity ? 1 : weight);

	// The scene card (the asker, the orb with this verdict, Dero's hand) takes the
	// image slot when it draws (2026-10 item 243 Phase 4). When it does not, the
	// reading falls back to exactly what it was before: the matching orb animation
	// if it has been rendered (the file is named by the verdict's slug, foldered by
	// tier), or a text-only reading when that file is missing too, so the command
	// never breaks on an unrendered verdict.
	const scene = await withRenderFallback(
		() =>
			renderFortuneScene({
				tier,
				verdict,
				displayName: interaction.user.globalName ?? interaction.user.username,
				avatar: avatarRequestFor(interaction.user, FORTUNE_SCENE_AVATAR_SIZE),
			}),
		() => null
	);
	const orbPath = join(process.cwd(), "assets", "fortune", "orbs", tier, `${verdictSlug(verdict)}.gif`);
	const hasOrb = !isRenderPayload(scene) && existsSync(orbPath);
	let imageRef: string | undefined;
	if (isRenderPayload(scene)) imageRef = scene.ref;
	else if (hasOrb) imageRef = FORTUNE_ORB_REF;
	const embed = buildFortuneEmbed(flavor, tier, question, imageRef);

	// Embeds never ping, and both ways of answering send with all mention parsing off,
	// so an echoed question can never smuggle a mass ping.
	const reading: ChannelAnswer = { embeds: [embed] };
	// Attach the scene or the orb (the embed image) and, on ultra, the bundled Dero
	// avatar its thumbnail points at. All must ride the same reply for the
	// references to resolve.
	const files: AttachmentBuilder[] = [];
	if (isRenderPayload(scene)) files.push(scene.attachment);
	if (hasOrb) files.push(new AttachmentBuilder(orbPath, { name: FORTUNE_ORB_FILE }));
	if (tier === "ultra") files.push(buildDeroImageAttachment());
	if (files.length > 0) reading.files = files;

	const place = await answer.send(reading);

	// ── Listen ──
	// Dero's voice can read the reading aloud, but ONLY a reading with no typed
	// question: the embed echoes the member's question word for word, and a Listen
	// on it would let anyone put their own words in the owner's cloned voice
	// (owner decision, 2026-10-14). Attached after the reply and fire and forget,
	// so the voice config read can never delay or break the reading itself.
	if (!question) {
		void attachListenRow(interaction.guildId, (components) => (place.channelId ? place.message.edit({ components }) : interaction.editReply({ components })));
	}
	// Advance the pity streak: reset to 0 on a gold, increment otherwise. Fire and
	// forget: the reading has reached the member, so a failed write here must not
	// give the cooldown slot back and hand out a second reading.
	void fortuneBuffStore.recordRoll(interaction.user.id, tier === "ultra").catch((error: unknown) =>
		console.error(`[fortune] recording the pity streak of ${interaction.user.id} failed`, error)
	);

	// ── leveling ──
	// ⚠️ THE AWARD LIVES HERE, NOT IN fortuneHandler.ts, and that is the whole
	// point of this function existing. The `powerup:member:fortune` button in
	// PowerUps.ts calls respondWithFortune DIRECTLY, bypassing the command
	// handler, so an award placed in the handler would leave the button path
	// silently earning nothing.
	//
	// Fortune has no opponent and no way to lose, so the award is small, flat, and
	// has no win bonus to chase, even at one reading a day. The fortuneReadings counter rides along because the hidden dero-knows
	// achievement reads it and nothing else increments it.
	if (interaction.guildId) {
		// ── the luck board (2026-10 item 250 Phase 5) ──
		// Here for the same reason as the award: the guide's Fortune button reaches this
		// function without the command. Counted above the average reading, so reading the
		// 8 ball over and over nets zero on average. Fire and forget.
		void recordFortuneReading({
			guildId: interaction.guildId,
			userId: interaction.user.id,
			luckAboveAverage: fortuneLuck(tier, verdict) - EXPECTED_FORTUNE_LUCK,
		});
		void awardXp({
			client: interaction.client,
			guildId: interaction.guildId,
			userId: interaction.user.id,
			username: interaction.user.globalName ?? interaction.user.username,
			amount: BOT_CONSTANTS.LEVELING.FORTUNE_XP,
			source: "game",
			counters: { fortuneReadings: 1 },
			channelId: interaction.channelId,
		});
	}
}
