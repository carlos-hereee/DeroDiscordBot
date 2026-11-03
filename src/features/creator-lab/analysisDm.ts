import type { EmbedBuilder } from "discord.js";
import { infoEmbed } from "@utils/embedBuilder.js";
import { analysisDmCopy, SENTIMENT_WORDS } from "./creatorLabCopy.js";

// ── Creator Lab analysis DM (2026-11 item 283 Phase 4) ──
// What:  checks the summary nexious-server sends to POST /api/creator-lab/dm and draws it as one
//        embed: the video, how much Dero read, and up to three themes with their sentiment and a line
//        each. The body is the Platform to bot contract's Creator Lab DM shape (both CLAUDE.md copies;
//        the server half is buildAnalysisSummary in features/dero-creator-lab/analysisNotice.ts).
// Why parse by hand: a signed body is still a trust boundary, and a drifted server must cost one DM,
//        never a crash; the bot carries no schema library, so this is a small explicit guard.
// Never: carries a viewer's comment or handle; the server sends none and nothing here would show one.

const THEME_LIMIT = 3;
// Discord's own embed limits: title 256, field name 256, field value 1024.
const TITLE_MAX = 256;
const FIELD_NAME_MAX = 256;
const FIELD_VALUE_MAX = 1024;

export interface AnalysisDmTheme {
	label: string;
	summary: string;
	sentiment: string;
}

export interface AnalysisDmSummary {
	platform: string;
	videoTitle: string;
	commentCount: number;
	commentSource: string;
	themes: AnalysisDmTheme[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const parseTheme = (value: unknown): AnalysisDmTheme | null => {
	if (!isRecord(value)) return null;
	const { label, summary, sentiment } = value;
	if (typeof label !== "string" || label.trim() === "" || typeof summary !== "string" || typeof sentiment !== "string") return null;
	return { label, summary, sentiment };
};

/** The summary when the body carries every field the DM needs, else null. */
export function parseAnalysisSummary(value: unknown): AnalysisDmSummary | null {
	if (!isRecord(value)) return null;
	const { platform, videoTitle, commentCount, commentSource, themes } = value;
	if (typeof platform !== "string" || typeof videoTitle !== "string" || typeof commentSource !== "string") return null;
	if (typeof commentCount !== "number" || !Number.isFinite(commentCount) || !Array.isArray(themes)) return null;
	const parsedThemes = themes.map(parseTheme);
	if (parsedThemes.length === 0 || parsedThemes.some((theme) => theme === null)) return null;
	return { platform, videoTitle, commentCount, commentSource, themes: (parsedThemes as AnalysisDmTheme[]).slice(0, THEME_LIMIT) };
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function buildAnalysisDmEmbed(summary: AnalysisDmSummary): EmbedBuilder {
	return infoEmbed(clip(analysisDmCopy.title(summary.videoTitle), TITLE_MAX), analysisDmCopy.intro(summary.commentCount, summary.platform, summary.commentSource))
		.addFields(
			summary.themes.map((theme) => ({
				name: clip(theme.label, FIELD_NAME_MAX),
				value: clip(`${SENTIMENT_WORDS[theme.sentiment] ?? SENTIMENT_WORDS.mixed}. ${theme.summary}`, FIELD_VALUE_MAX),
				inline: false,
			}))
		)
		.setFooter({ text: analysisDmCopy.footer });
}
