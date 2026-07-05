import { EmbedBuilder } from "discord.js";
import { AUTHOR, COLORS, DERO_IMAGE_REF } from "@base/copy/brand.js";
import { fortuneCopy } from "./fortuneCopy.js";
import type { FortuneTier } from "./fortunes.js";

// The fortune orb is attached to each reply under a fixed name, so the embed can
// point at it regardless of which verdict's file it actually is. respondWithFortune
// attaches assets/fortune/orbs/<tier>/<verdict-slug>.gif AS this name.
export const FORTUNE_ORB_FILE = "orb.gif";
export const FORTUNE_ORB_REF = `attachment://${FORTUNE_ORB_FILE}`;

// ── buildFortuneEmbed ──────────────────────────────────────────────────────
// A self-contained fortune embed. It does NOT reuse embedBuilder.base() on
// purpose: base() resolves branding through getPluginCopy(guildConfig), which
// couples a caller to the pluginId copy-pack system. /fortune is a plain
// command (not a plugin), so it pulls the Dero author + colors straight from
// brand.ts — exactly the "non pack-aware call site" path brand.ts documents.
//
// orbRef, when passed, sets the embed's main image to the attached orb animation.
// The ultra tier also sets a thumbnail pointing at the bundled Dero avatar; the
// caller must attach both files to the same reply for the references to resolve
// (see respondWithFortune). The assets ship in the bot's assets/ dir, so they
// render without depending on the web app deploy.
export function buildFortuneEmbed(
	answer: string,
	tier: FortuneTier,
	question: string | null,
	orbRef?: string
): EmbedBuilder {
	const isUltra = tier === "ultra";

	const embed = new EmbedBuilder()
		.setTimestamp()
		.setAuthor({ name: AUTHOR.name, iconURL: AUTHOR.iconURL })
		.setTitle(isUltra ? fortuneCopy.ultraTitle : fortuneCopy.title)
		.setColor(isUltra ? COLORS.FORTUNE_ULTRA : COLORS.FORTUNE)
		.setDescription(question ? `${fortuneCopy.questionLabel(question)}\n\n${answer}` : answer)
		.setFooter({ text: fortuneCopy.disclaimerFooter });

	if (orbRef) embed.setImage(orbRef);
	if (isUltra) embed.setThumbnail(DERO_IMAGE_REF);
	return embed;
}
