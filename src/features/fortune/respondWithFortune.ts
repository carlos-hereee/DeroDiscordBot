import { existsSync } from "node:fs";
import { join } from "node:path";
import { AttachmentBuilder, MessageFlags, type InteractionEditReplyOptions, type RepliableInteraction } from "discord.js";
import { errorEmbed } from "@utils/embedBuilder.js";
import { CooldownManager } from "@utils/cooldownManager.js";
import { buildDeroImageAttachment } from "@base/copy/brand.js";
import { rollFortune, PITY_THRESHOLD } from "./rollFortune.js";
import { buildFortuneEmbed, FORTUNE_ORB_FILE, FORTUNE_ORB_REF } from "./fortuneEmbed.js";
import { verdictSlug } from "./fortunes.js";
import { fortuneCopy } from "./fortuneCopy.js";
import { fortuneBuffStore } from "@db/stores/fortuneBuffStore.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { awardXp } from "@features/leveling/awardXp.js";
import { attachListenRow } from "@features/voice/listenButton.js";
import { avatarRequestFor, isRenderPayload, withRenderFallback } from "@features/renderer/index.js";
import { FORTUNE_SCENE_AVATAR_SIZE, renderFortuneScene } from "./fortuneSceneRenderer.js";

// One reading per user every 10 seconds, SHARED across every entry point: the
// /fortune slash command and the #command-center invite-card button both call
// respondWithFortune, so a user cannot bypass the gate by alternating between
// them. Module-scope Map persists for the life of the process.
const FORTUNE_COOLDOWN_MS = 10_000;
const cooldown = new CooldownManager(FORTUNE_COOLDOWN_MS);

// ── respondWithFortune ──────────────────────────────────────────────────────
// The single fortune-reading path. Both the slash command and the button funnel
// through here so the cooldown, tier roll, embed, and mention
// safety are each defined exactly once (the interaction is a RepliableInteraction,
// which both a ChatInputCommandInteraction and a ButtonInteraction satisfy).
//   • question: echoed (with mention parsing disabled) when provided; the button
//     passes none, since a button cannot take text input without a modal.
//   • isPrivate: ephemeral reply. The button is always private so it never
//     clutters the read-only #command-center guide; the command honours its own
//     private toggle.
export async function respondWithFortune(
	interaction: RepliableInteraction,
	options: { question?: string | null; isPrivate?: boolean } = {}
): Promise<void> {
	// Per-user cooldown, guild-scoped key (falls back to "dm"). Checked before the
	// roll; recorded only after a successful reply, so a thrown reply leaves the
	// user free to retry.
	const cooldownKey = `${interaction.guildId ?? "dm"}:${interaction.user.id}`;
	const gate = cooldown.check(cooldownKey);
	if (gate.onCooldown) {
		await interaction.reply({
			embeds: [errorEmbed(fortuneCopy.cooldownMessage(Math.ceil(gate.remainingMs / 1000)))],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	// Acknowledge within Discord's 3-second window BEFORE the DB read and the orb
	// upload, either of which can exceed it (a cold Mongo query, a multi-MB gif).
	// deferReply reserves the reply and locks in visibility here; editReply below
	// fills it in with up to 15 minutes. Without this the interaction token expires
	// mid-reply and Discord returns error 10062 (Unknown interaction).
	await interaction.deferReply(options.isPrivate ? { flags: MessageFlags.Ephemeral } : undefined);

	// Trim only, the command caps length via setMaxLength(200), and the question
	// is rendered ONLY inside an embed with mention parsing disabled below, so it
	// can never ping even if it contains @everyone.
	const question = options.question ? options.question.trim() : null;

	// Per-user luck state, read after the cooldown gate so spammers never hit the DB.
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

	const editOptions: InteractionEditReplyOptions = {
		embeds: [embed],
		// Belt-and-suspenders: embeds never ping, but disabling all mention parsing
		// guarantees an echoed question can never smuggle a mass ping.
		allowedMentions: { parse: [] },
	};
	// Attach the scene or the orb (the embed image) and, on ultra, the bundled Dero
	// avatar its thumbnail points at. All must ride the same reply for the
	// references to resolve.
	const files: AttachmentBuilder[] = [];
	if (isRenderPayload(scene)) files.push(scene.attachment);
	if (hasOrb) files.push(new AttachmentBuilder(orbPath, { name: FORTUNE_ORB_FILE }));
	if (tier === "ultra") files.push(buildDeroImageAttachment());
	if (files.length > 0) editOptions.files = files;

	// Visibility was already locked in at deferReply, so editReply carries no flags.
	await interaction.editReply(editOptions);

	// ── Listen ──
	// Dero's voice can read the reading aloud, but ONLY a reading with no typed
	// question: the embed echoes the member's question word for word, and a Listen
	// on it would let anyone put their own words in the owner's cloned voice
	// (owner decision, 2026-10-14). Attached after the reply and fire and forget,
	// so the voice config read can never delay or break the reading itself.
	if (!question) {
		void attachListenRow(interaction.guildId, (components) => interaction.editReply({ components }));
	}
	// Advance the pity streak: reset to 0 on a gold, increment otherwise.
	await fortuneBuffStore.recordRoll(interaction.user.id, tier === "ultra");
	cooldown.record(cooldownKey);

	// ── leveling ──
	// ⚠️ THE AWARD LIVES HERE, NOT IN fortuneHandler.ts, and that is the whole
	// point of this function existing. The `powerup:member:fortune` button in
	// PowerUps.ts calls respondWithFortune DIRECTLY, bypassing the command
	// handler, so an award placed in the handler would leave the button path
	// silently earning nothing.
	//
	// Fortune is the most farmable award in the feature: a 10 second cooldown, no
	// opponent, and no way to lose. So it is small, flat, and has no win bonus to
	// chase. The fortuneReadings counter rides along because the hidden dero-knows
	// achievement reads it and nothing else increments it.
	if (interaction.guildId) {
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
