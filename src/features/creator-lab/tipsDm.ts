import type { EmbedBuilder } from "discord.js";
import { infoEmbed } from "@utils/embedBuilder.js";
import { tipsDmCopy } from "./creatorLabCopy.js";

// ── Creator Lab weekly tips DM (2026-11 item 283 Phase 5) ──
// What:  checks the tips nexious-server sends to POST /api/creator-lab/tips-dm and draws them as one
//        embed: why Dero is sending tips rather than a read, then each tip as a numbered field. The
//        body is the Platform to bot contract's Creator Lab tips shape (both CLAUDE.md copies; the
//        server half is buildTipsDmBody in features/dero-creator-lab/weeklyTipsNotice.ts).
// Why parse by hand: the analysisDm.ts reasoning; a signed body is still a trust boundary and a
//        drifted server must cost one DM, never a crash.
// Who calls it: the weekly job on the server, about once a week per paid, linked, low signal creator.

// The server sends one to three tips a week (its CREATOR_LAB_WEEKLY_TIP_COUNT); more is a drifted body.
const MAX_TIPS = 3;
// Discord's own embed limit for a field value.
const FIELD_VALUE_MAX = 1024;

export interface TipsDm {
	niche: string;
	items: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isNonEmptyText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/** The tips when the body carries a niche and one to three non empty lines, else null. */
export function parseTipsDm(value: unknown): TipsDm | null {
	if (!isRecord(value)) return null;
	const { niche, items } = value;
	if (!isNonEmptyText(niche) || !Array.isArray(items)) return null;
	if (items.length === 0 || items.length > MAX_TIPS || !items.every(isNonEmptyText)) return null;
	return { niche, items };
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function buildTipsDmEmbed(tips: TipsDm): EmbedBuilder {
	return infoEmbed(tipsDmCopy.title, tipsDmCopy.intro(tips.niche))
		.addFields(tips.items.map((item, index) => ({ name: tipsDmCopy.tipName(index), value: clip(item, FIELD_VALUE_MAX), inline: false })))
		.setFooter({ text: tipsDmCopy.footer });
}
